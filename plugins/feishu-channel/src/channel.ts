import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { LarkClient } from '../vendor/openclaw-lark/dist/core/lark-client.js';
import { MessageDedup } from '../vendor/openclaw-lark/dist/messaging/inbound/dedup.js';
import { parseMessageEvent } from '../vendor/openclaw-lark/dist/messaging/inbound/parse.js';
import { resolveUserName } from '../vendor/openclaw-lark/dist/messaging/inbound/user-name-cache.js';
import { downloadMessageResourceFeishu } from '../vendor/openclaw-lark/dist/messaging/outbound/media.js';
import { sendMessageFeishu } from '../vendor/openclaw-lark/dist/messaging/outbound/send.js';
import type {
  FeishuMessageEvent,
  MessageContext,
} from '../vendor/openclaw-lark/dist/messaging/types.js';
import { handleCardAction } from '../vendor/openclaw-lark/dist/tools/auto-auth.js';
import type { Config } from './config.js';
import { agentsRootDefault, dataDirectory, effectiveManifest } from './config.js';
import { pdfMessageContent } from './pdf.js';
// syncIdentitySkills 不再需要：身份级技能目录已在围栏中直接放行。
import { DedupStore } from './dedup-store.js';
import { NotificationQueue, notificationUuid, validateNotification, type FeishuNotificationInput, type NotificationRecord, type PreviousSessionInput } from './notifications.js';
import type { LarkRuntimeConfig } from './runtime-config.js';
import type { SessionStore } from './session-store.js';
import { type OfficialTurnControllerFactory, OfficialTurnStream } from './streaming.js';
import type { OfficialToolContexts } from './tools.js';

export interface ChannelLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface ActiveTurn {
  readonly chatId: string;
  readonly sessionId: string;
  readonly agent: Agent;
  readonly stream: OfficialTurnStream;
  readonly done: Promise<void>;
  settle: () => void;
  committedText: string;
  liveAnswer: string;
  liveReasoning: string;
  closed: boolean;
  notification?: NotificationRecord;
  expectedTurn?: number;
  completionError?: unknown;
  readonly tools: Map<
    string,
    { name: string; params: Record<string, unknown> | undefined; startedAt: number }
  >;
}

export interface LarkChannelOptions {
  readonly config: Config;
  readonly officialConfig: LarkRuntimeConfig;
  readonly sessions: SessionStore;
  readonly toolContexts: OfficialToolContexts;
  readonly resolveAgent: (sessionId: string, cwd: string) => Promise<Agent>;
  /** Identity root (agents/), used to locate agents/<agentId>/.dsh/skills. */
  readonly agentsRoot: string;
  readonly logger: ChannelLogger;
  readonly streamFactory?: OfficialTurnControllerFactory;
  /** /model and /effort slash commands; omitted disables model switching. */
  readonly models?: { handle(chatId: string, text: string): Promise<string> };
}

/** Official Lark events directly driving DSH agents and official streaming cards. */
export class LarkChannel {
  private readonly dedup: MessageDedup;
  private readonly abort = new AbortController();
  private readonly activeByChat = new Map<string, ActiveTurn>();
  private readonly activeBySession = new Map<string, ActiveTurn>();
  private readonly queues = new Map<string, Promise<void>>();
  private client?: LarkClient;
  private readonly notifications: NotificationQueue;

  constructor(private readonly options: LarkChannelOptions) {
    this.notifications = new NotificationQueue(join(dataDirectory(options.config), 'notifications.json'),
      (record) => this.enqueue(record.chatId, () => this.dispatchNotification(record)),
      (message) => options.logger.warn(message));
    this.dedup = new MessageDedup({
      persistence: new DedupStore(join(dataDirectory(options.config), 'message-dedup.json')),
    });
  }

  async start(): Promise<void> {
    const client = LarkClient.fromCfg(this.options.officialConfig, this.options.config.accountId ?? 'default');
    this.client = client;
    const probe = await client.probe();
    if (client.account.appId || this.options.config.agentId) {
      // 身份显示名:manifest.displayName(身份的稳定名,聚合身份必备) > bot 名 > agentId。
      // guests 等 12 bot 共享身份时,身份条目名恒为 manifest 名,不随首个 bot 漂移。
      const identityName = effectiveManifest(this.options.config)?.displayName
        ?? this.options.config.appName ?? probe.botName
        ?? this.options.config.agentId;
      const botName = this.options.config.appName ?? probe.botName;
      this.options.sessions.setAgentIdentity(
        this.options.config.agentId,
        identityName,
        client.account.appId ?? this.options.config.appId,
        botName,
      );
    }
    await this.options.sessions.load();
    if (client.account.appId || this.options.config.agentId) {
      this.options.sessions.rebindCwd();
      await this.options.sessions.save();
      this.options.logger.info(
        `workspace identity agent=${this.options.config.agentId ?? '(unset)'} app=${client.account.appId ?? this.options.config.appId ?? '?'} name=${this.options.config.appName ?? probe.botName ?? '飞书应用'}`,
      );
    }
    this.startNotifications();
    await client.startWS({
      handlers: {
        'im.message.receive_v1': (event) => this.receive(event as FeishuMessageEvent),
        // 授权引导卡片（"去申请"/"已完成"按钮）的回调。缺了这个 handler，
        // SDK 会打 "no card.action.trigger handle" 警告并丢弃回调，飞书端
        // 收不到 3 秒内的响应，客户端弹 "出错了，请稍后重试 code: 200672"。
        // （as unknown 与 monitor.ts 一致：WS handlers 表类型为 Promise<void>，
        //  但 card action 回调需要把 toast/card 返回值带回给飞书。）
        'card.action.trigger': ((data: unknown) =>
          handleCardAction(data, this.options.officialConfig, this.options.config.accountId ?? 'default')) as unknown as (
          data: unknown,
        ) => Promise<void>,
      },
      abortSignal: this.abort.signal,
      autoProbe: false,
    });
  }

  async stop(): Promise<void> {
    this.notifications.stop();
    this.abort.abort();
    this.client?.disconnect();
    this.dedup.dispose();
    for (const turn of this.activeByChat.values()) {
      turn.agent.cancel({ kind: 'user' }, { keepInbox: true });
      await turn.stream.abort();
      turn.settle();
    }
    this.activeByChat.clear();
    this.activeBySession.clear();
    await this.options.sessions.save();
  }

  /** Parse and queue one raw Feishu message; exposed for offline contract tests. */
  async receive(event: FeishuMessageEvent): Promise<void> {
    if (!this.dedup.tryRecord(event.message.message_id, this.options.config.accountId ?? 'default')) {
      this.options.logger.info(`duplicate inbound message suppressed: ${event.message.message_id}`);
      return;
    }
    const message = await parseMessageEvent(event, this.client?.botOpenId, {
      cfg: this.options.officialConfig,
      accountId: this.options.config.accountId ?? 'default',
    });
    if (!this.admit(message)) return;
    this.options.logger.info(
      `inbound message ${message.messageId} chat=${message.chatId} type=${message.chatType}`,
    );
    if (message.content.trim() === '/stop') {
      await this.stopActive(message.chatId);
      return;
    }
    // Model commands answer immediately, bypassing the per-chat turn queue:
    // installModelSelection is designed for concurrent switches and applies at
    // the next step boundary even while a turn is running.
    if (this.options.models && this.isModelCommand(message.content.trim())) {
      try {
        await this.send(
          message.chatId,
          await this.options.models.handle(message.chatId, message.content.trim()),
        );
      } catch (error) {
        await this.send(message.chatId, `命令执行失败：${errorMessage(error)}`);
      }
      return;
    }
    // 飞书开放平台:sender_id 同时给 open_id(应用内唯一)与 union_id(同开发者跨应用唯一)。
    // 身份簇以 union_id 归并,才能做到「一个飞书账号=一个身份」,换 bot 聊天不用重新登录。
    const senderUnionId = event.sender?.sender_id?.union_id;
    await this.enqueue(message.chatId, () => this.dispatch(message, senderUnionId));
  }

  get appId(): string | undefined { return this.options.config.appId; }

  /** Resolve only existing owner/app/chat bindings and durably accept before returning. */
  async deliverNotification(input: FeishuNotificationInput): Promise<void> {
    validateNotification(input);
    await this.options.sessions.load();
    const target = this.notificationTarget(input);
    this.notifications.accept(input, { chatId: target.chatId, currentSessionId: target.binding.sessionId });
  }

  notificationStatus(eventId?: string): NotificationRecord[] { return this.notifications.status(eventId); }

  async rebindPreviousSession(input: PreviousSessionInput): Promise<void> {
    await this.options.sessions.load();
    this.notificationTarget({ ...input, text: 'alias', eventId: 'alias' });
    this.options.sessions.addPreviousSession(input.sessionId, input.previousSessionId, input.ownerOpenId);
    await this.options.sessions.save();
  }

  /** Startup replay runs after SessionStore identity initialization, before the WS lifetime await. */
  startNotifications(): void { this.notifications.start(); }

  private notificationTarget(input: FeishuNotificationInput) {
    if (!input.ownerAppId || input.ownerAppId !== this.appId) throw new Error('Notification application mismatch');
    const target = this.options.sessions.notificationTarget(input.sessionId);
    if (!target || target.binding.openId !== input.ownerOpenId) throw new Error('Notification session owner mismatch');
    return target;
  }

  private enqueue(chatId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(chatId, next);
    void next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId); }).catch(() => {});
    return next;
  }

  private async dispatchNotification(record: NotificationRecord): Promise<void> {
    let target = this.notificationTarget(record.input);
    if (target.chatId !== record.chatId) throw new Error('Notification chat binding changed');
    const binding = target.binding;
    this.options.toolContexts.bind(binding.sessionId, {
      messageId: `notification:${record.input.eventId}`, chatId: target.chatId,
      accountId: this.options.config.accountId ?? 'default', startTime: Date.now(),
      senderOpenId: binding.openId!, ...(binding.unionId ? { senderUnionId: binding.unionId } : {}),
      ...(binding.chatType ? { chatType: binding.chatType } : {}),
    });
    const agent = await this.options.resolveAgent(binding.sessionId, binding.cwd);
    // External schedules may already own this Agent. Never consume their terminal event.
    if (agent.status === 'running') await agent.whenIdle();
    target = this.notificationTarget(record.input);
    if (target.binding.sessionId !== binding.sessionId || target.chatId !== record.chatId) throw new Error('Notification binding changed while waiting');
    const stream = new OfficialTurnStream(binding.sessionId, target.chatId, undefined,
      this.options.officialConfig, this.options.streamFactory, this.options.config.accountId ?? 'default', {
        uuid: notificationUuid(record.input.eventId), ...(record.card ? { state: record.card } : {}),
        checkpoint: (card) => this.notifications.checkpoint(record, { card }),
      });
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const turn: ActiveTurn = { chatId: target.chatId, sessionId: binding.sessionId, agent, stream, done, settle,
      committedText: '', liveAnswer: '', liveReasoning: '', closed: false, tools: new Map(), notification: record };
    this.activeByChat.set(target.chatId, turn);
    this.activeBySession.set(binding.sessionId, turn);
    try {
      await stream.start();
      if (!stream.messageId) throw new Error('Notification card creation did not produce a message id');
      this.notifications.checkpoint(record, { currentSessionId: binding.sessionId });
      if (record.result) {
        turn.committedText = record.result.text;
        await this.finishTurn(turn, record.result.kind, record.result.error);
      } else {
        const history = agent.session.snapshotEvents?.() ?? [];
        const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].find((message) => message.id === record.input.eventId);
        const seen = notificationClaimed(history, record.input.eventId);
        if (pending) {
          turn.expectedTurn = nextTurn(history);
          // The runtime has no wake-only API. Move the same durable identified item
          // into followup without producing a second pending copy.
          agent.inbox.remove(pending.id);
          agent.followup(pending);
          await done;
        } else if (seen || record.claimedTurn !== undefined) {
          const recovered = recoverNotification(history, record.input.eventId, record.claimedTurn);
          if (!recovered) throw new Error('Notification was submitted; waiting for its durable turn outcome');
          this.notifications.checkpoint(record, { result: recovered });
          turn.committedText = recovered.text;
          await this.finishTurn(turn, recovered.kind, recovered.error);
        } else {
          // No await between the idle check and followup reservation.
          if (agent.status === 'running') throw new Error('Notification agent became busy');
          turn.expectedTurn = nextTurn(history);
          agent.followup({ id: record.input.eventId as UserMessage['id'], role: 'user',
            content: [{ type: 'text', text: record.input.text }], source: { kind: 'schedule' } } as UserMessage);
          await done;
        }
      }
      if (turn.completionError) throw turn.completionError;
      if (!record.result) throw new Error('Notification turn was interrupted before durable settlement');
    } finally {
      this.activeByChat.delete(turn.chatId);
      this.activeBySession.delete(turn.sessionId);
      turn.closed = true;
      turn.settle();
    }
  }

  /** Fold DSH live model deltas directly into the official controller. */
  assistantFrame(sessionId: string, frame: AssistantStreamFrame): void {
    const turn = this.activeBySession.get(sessionId);
    if (!turn || turn.closed) return;
    if (turn.notification && turn.expectedTurn === undefined) return;
    if (frame.type === 'start') {
      // A new attempt replaces only its own transient publication. Earlier
      // assistant/message steps remain the committed prefix of this turn.
      turn.liveAnswer = '';
      turn.liveReasoning = '';
      return;
    }
    if (frame.type === 'end') {
      // Committed text was already folded by its durable event. Abandoned
      // attempt text must never contaminate a retry or the final transcript.
      turn.liveAnswer = '';
      turn.liveReasoning = '';
      return;
    }
    if (frame.chunk.type === 'text-delta') {
      turn.liveAnswer += frame.chunk.text;
      void turn.stream
        .text(turnText(turn))
        .catch((error) => this.options.logger.warn(String(error)));
    } else if (frame.chunk.type === 'reasoning-delta') {
      turn.liveReasoning += frame.chunk.text;
      void turn.stream
        .reasoning(turn.liveReasoning)
        .catch((error) => this.options.logger.warn(String(error)));
    }
  }

  /** Fold durable tool and turn events into the official controller. */
  async sessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const turn = this.activeBySession.get(sessionId);
    if (!turn || turn.closed) return;
    if (turn.notification) {
      if (event.type === 'turn/start' && turn.expectedTurn === event.data.turn) return;
      if (event.type === 'user/message' && event.data.id === turn.notification.input.eventId) {
        this.notifications.checkpoint(turn.notification, { claimedTurn: turn.expectedTurn! });
        return;
      }
      if (turn.expectedTurn === undefined) return;
      if ('turn' in event.data && event.data.turn !== turn.expectedTurn) return;
    }
    if (event.type === 'assistant/message') {
      const committed = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (committed) {
        turn.committedText += (turn.committedText ? '\n\n' : '') + committed;
      }
      turn.liveAnswer = '';
      return;
    }
    if (event.type === 'tool/call') {
      const callId = event.data.callId;
      const name = event.data.name;
      this.options.logger.info(`tool call session=${sessionId} name=${name} call=${callId}`);
      const params = parseParams(event.data.arguments);
      turn.tools.set(callId, { name, params, startedAt: Date.now() });
      await turn.stream.toolStart({ name, callId, params });
      return;
    }
    if (event.type === 'tool/result') {
      const result = event.data.message;
      const callId = result.source.callId;
      this.options.logger.info(
        `tool result session=${sessionId} call=${callId} error=${result.isError === true}`,
      );
      const started = turn.tools.get(callId);
      await turn.stream.toolEnd({
        name: started?.name ?? 'tool',
        callId,
        params: started?.params,
        result: result.content,
        error: result.isError ? (event.data.error?.reason ?? 'Tool failed') : undefined,
        durationMs: started ? Date.now() - started.startedAt : undefined,
      });
      turn.tools.delete(callId);
      return;
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason;
      await this.finishTurn(
        turn,
        reason.kind,
        'error' in reason ? reason.error.message : undefined,
      );
    }
  }

  private admit(message: MessageContext): boolean {
    const { allowedChats, allowedUsers, groupMentionMode = 'always' } = this.options.config;
    if (
      message.senderIsBot ||
      (this.client?.botOpenId && message.senderId === this.client.botOpenId)
    ) {
      return false;
    }
    if (allowedChats?.length && !allowedChats.includes(message.chatId)) return false;
    if (allowedUsers?.length && !allowedUsers.includes(message.senderId)) return false;
    if (message.chatType !== 'group') return true;
    const mentioned = message.mentionAll || message.mentions.some((mention) => mention.isBot);
    if (groupMentionMode === 'always') return mentioned;
    if (groupMentionMode === 'ambient') {
      return mentioned || !message.mentions.some((mention) => !mention.isBot);
    }
    return true;
  }

  private async dispatch(message: MessageContext, senderUnionId?: string): Promise<void> {
    const text = message.content.trim();
    if (text === '/new') {
      this.options.sessions.reset(message.chatId, message.senderId);
      await this.options.sessions.save();
      await this.send(message.chatId, 'Started a new DSH session.');
      return;
    }
    if (text === '/status') {
      const active = this.activeByChat.has(message.chatId);
      await this.send(
        message.chatId,
        `Official Lark streaming is ready. Active turn: ${active ? 'yes' : 'no'}.`,
      );
      return;
    }
    if (this.activeByChat.has(message.chatId)) {
      await this.send(
        message.chatId,
        'The current turn is still running. Use /stop before sending a new turn.',
      );
      return;
    }
    let resolvedName: string | undefined;
    if (message.senderId && this.client) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        resolvedName = (await Promise.race([
          resolveUserName({ account: this.client.account, openId: message.senderId, log: (line) => this.options.logger.debug(String(line)) }),
          new Promise<{ name?: string }>((resolve) => {
            timeout = setTimeout(() => resolve({}), 1500);
          }),
        ])).name;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    const binding = this.options.sessions.get(message.chatId, message.senderId, resolvedName, senderUnionId);
    this.options.sessions.setChatType(message.chatId, message.chatType);
    await mkdir(binding.cwd, { recursive: true, mode: 0o700 });
    // 身份级技能目录（agents/<agentId>/.dsh/skills/）已在围栏中放行，无需复制到用户工作区。
    await this.options.sessions.save();
    this.options.toolContexts.bind(binding.sessionId, {
      messageId: message.messageId,
      chatId: message.chatId,
      accountId: this.options.config.accountId ?? 'default',
      startTime: message.createTime ?? Date.now(),
      senderOpenId: message.senderId,
      ...(senderUnionId !== undefined ? { senderUnionId } : {}),
      chatType: message.chatType,
      ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
    });
    const agent = await this.options.resolveAgent(binding.sessionId, binding.cwd);
    const stream = new OfficialTurnStream(
      binding.sessionId,
      message.chatId,
      message.messageId,
      this.options.officialConfig,
      this.options.streamFactory,
      this.options.config.accountId ?? 'default',
    );
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const turn: ActiveTurn = {
      chatId: message.chatId,
      sessionId: binding.sessionId,
      agent,
      stream,
      done,
      settle,
      committedText: '',
      liveAnswer: '',
      liveReasoning: '',
      closed: false,
      tools: new Map(),
    };
    this.activeByChat.set(message.chatId, turn);
    this.activeBySession.set(binding.sessionId, turn);
    try {
      await stream.start();
      if (turn.closed) return;
      this.options.logger.info(
        `official streaming started chat=${message.chatId} phase=${stream.phase} message=${stream.messageId ?? 'pending'}`,
      );
      const content = await this.messageContent(message, binding.cwd, agent);
      if (turn.closed) return;
      this.options.logger.info(
        `delivering message ${message.messageId} session=${binding.sessionId}`,
      );
      agent.followup({
        id: randomUUID() as UserMessage['id'],
        role: 'user',
        content,
        source: { kind: 'user' },
      } satisfies UserMessage);
      await done;
    } catch (error) {
      if (!turn.closed) {
        turn.closed = true;
        await stream.fail(error).catch(() => {});
        this.activeByChat.delete(message.chatId);
        this.activeBySession.delete(binding.sessionId);
        settle();
      }
      await this.send(message.chatId, `Turn failed: ${errorMessage(error)}`);
    }
  }

  private async finishTurn(turn: ActiveTurn, kind: string, error?: string): Promise<void> {
    if (turn.closed) return;
    turn.closed = true;
    try {
      if (turn.notification) this.notifications.checkpoint(turn.notification, { result: { kind, text: turnText(turn), ...(error ? { error } : {}) } });
      if (kind === 'aborted') {
        await turn.stream.abort();
      } else if (kind === 'error') {
        await turn.stream.fail(error ?? 'Turn failed');
      } else {
        await turn.stream.complete(turnText(turn));
        if (!turn.stream.messageId && turnText(turn).trim()) {
          await this.send(turn.chatId, turnText(turn));
        }
      }
    } catch (error) {
      turn.completionError = error;
      if (!turn.notification) throw error;
    } finally {
      this.activeByChat.delete(turn.chatId);
      this.activeBySession.delete(turn.sessionId);
      turn.settle();
      this.options.logger.info(`official streaming finished chat=${turn.chatId} kind=${kind}`);
    }
  }

  private isModelCommand(text: string): boolean {
    return (
      text === '/model' ||
      text.startsWith('/model ') ||
      text === '/effort' ||
      text.startsWith('/effort ')
    );
  }

  private async stopActive(chatId: string): Promise<void> {
    const turn = this.activeByChat.get(chatId);
    if (!turn) {
      await this.send(chatId, 'No active turn.');
      return;
    }
    if (turn.notification) {
      turn.agent.cancel({ kind: 'user' }, { keepInbox: true });
      await this.finishTurn(turn, 'aborted');
      return;
    }
    turn.closed = true;
    turn.agent.cancel({ kind: 'user' }, { keepInbox: true });
    this.activeByChat.delete(chatId);
    this.activeBySession.delete(turn.sessionId);
    turn.settle();
    await turn.stream.abort();
  }

  private async messageContent(message: MessageContext, cwd: string, agent: Agent): Promise<ContentBlock[]> {
    const parts = [message.content];
    const blocks: ContentBlock[] = [];
    for (const resource of message.resources) {
      try {
        const downloaded = await downloadMessageResourceFeishu({
          cfg: this.options.officialConfig,
          messageId: message.messageId,
          fileKey: resource.fileKey,
          type: resource.type === 'image' ? 'image' : 'file',
          accountId: this.options.config.accountId ?? 'default',
        });
        const directory = join(cwd, '.dsh_lark', 'attachments', sanitize(message.chatId));
        await mkdir(directory, { recursive: true });
        const name = sanitize(
          resource.fileName ??
            downloaded.fileName ??
            `${resource.fileKey}${extension(downloaded.contentType)}`,
        );
        const path = join(directory, basename(name));
        await writeFile(path, downloaded.buffer);
        parts.push(`[Attachment: ${path}]`);
        const pdf = await pdfMessageContent(agent, name, downloaded.buffer, this.options.logger, downloaded.contentType);
        if (pdf) blocks.push(...pdf);
      } catch (error) {
        parts.push(
          `[Attachment ${resource.fileKey} could not be downloaded: ${errorMessage(error)}]`,
        );
      }
    }
    return [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }, ...blocks];
  }

  private async send(chatId: string, text: string): Promise<void> {
    await sendMessageFeishu({ cfg: this.options.officialConfig, to: chatId, text, accountId: this.options.config.accountId ?? 'default' });
  }
}

function notificationClaimed(events: readonly SessionEvent[], id: string): boolean {
  const pending = new Map<string, string[]>();
  for (const event of events) {
    if (event.type === 'user/message' && event.data.id === id) return true;
    if (event.type !== 'agent/inbox/spliced') continue;
    const list = pending.get(event.data.target) ?? [];
    pending.set(event.data.target, list);
    const removed = list.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted.map((message) => message.id));
    if (removed.includes(id) && event.data.outcome !== 'canceled') return true;
  }
  return false;
}

function nextTurn(events: readonly SessionEvent[]): number {
  return events.reduce((max, event) => event.type === 'turn/start' ? Math.max(max, event.data.turn) : max, 0) + 1;
}

function recoverNotification(events: readonly SessionEvent[], id: string, expected?: number): NotificationRecord['result'] {
  let current = 0;
  let target = expected;
  const texts: string[] = [];
  const pending: string[] = [];
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') {
      const removed = pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted.map((message) => message.id));
      if (removed.includes(id) && event.data.outcome !== 'canceled' && current > 0) target = current;
    }
    if (event.type === 'turn/start') current = event.data.turn;
    if (event.type === 'user/message' && event.data.id === id) target = current;
    if (target === undefined || current !== target) continue;
    if (event.type === 'assistant/message') texts.push(event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''));
    if (event.type === 'turn/end' && event.data.turn === target) return { kind: event.data.reason.kind, text: texts.filter(Boolean).join('\n\n'), ...('error' in event.data.reason ? { error: event.data.reason.error.message } : {}) };
  }
  return undefined;
}

function turnText(turn: ActiveTurn): string {
  return [turn.committedText, turn.liveAnswer].filter(Boolean).join('\n\n');
}

function parseParams(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extension(contentType: string | undefined): string {
  const types: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return types[contentType?.split(';')[0] ?? ''] ?? '.bin';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
