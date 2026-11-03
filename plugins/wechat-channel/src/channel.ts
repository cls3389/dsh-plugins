import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { filterMarkdown } from './protocol/markdown.js';
import { createILinkClient, ILinkClient } from './protocol/client.js';
import { WeixinStateStore } from './protocol/state.js';
import type { WeixinAccount, WeixinInboundEvent } from './protocol/types.js';
import { attachSessionToGlobalRegistry } from './workspace-registry.js';
import type { Config } from './config.js';
import type { SessionStore } from './session-store.js';

export interface ChannelLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface ActiveTurn {
  readonly chatId: string;
  readonly subjectId: string;
  readonly sessionId: string;
  readonly contextToken?: string;
  readonly agent: Agent;
  readonly done: Promise<void>;
  settle: () => void;
  committedText: string;
  liveAnswer: string;
  closed: boolean;
}

export interface WeixinChannelOptions {
  readonly config: Config;
  readonly state: WeixinStateStore;
  readonly sessions: SessionStore;
  readonly resolveAgent: (sessionId: string, cwd: string) => Promise<Agent>;
  readonly logger: ChannelLogger;
  /** Fallback credentials from config/refs when no stored account exists. */
  readonly tokenFallback?: string;
  readonly botIdFallback?: string;
  readonly baseUrlFallback?: string;
  readonly clientFactory?: (account: WeixinAccount) => ILinkClient;
  readonly fetchImpl?: typeof fetch;
  /** Optional pairing-reply hook used by wechat_bind (6-digit code verification). */
  readonly pairingReply?: (message: WeixinInboundEvent) => Promise<{ handled: boolean; reply?: string }>;
  /** Optional Weixin-side /bind command handler (reverse bind to a Feishu identity). */
  readonly onBindCommand?: (message: WeixinInboundEvent) => Promise<{ ok: boolean; reply: string }>;
  /** Optional post-bind hook: remap live session cwds to the merged identity. */
  readonly onIdentityBound?: (subjectId: string) => void;
}

const POLL_BACKOFF_MS = 2_000;
const POLL_MAX_FAILURES = 3;
const POLL_BACKOFF_LONG_MS = 30_000;

/**
 * One Weixin bot account driving DSH agents over the iLink long-poll protocol.
 *
 * Delivery semantics (V1): every inbound message is deduplicated durably before
 * dispatch; the get_updates cursor commits only after the whole batch finished
 * dispatching, so a crash replays unprocessed messages while dedup suppresses
 * the already-processed ones.
 */
export class WeixinChannel {
  private readonly abort = new AbortController();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeByChat = new Map<string, ActiveTurn>();
  private readonly activeBySession = new Map<string, ActiveTurn>();
  private client?: ILinkClient;
  private running = false;

  constructor(private readonly options: WeixinChannelOptions) {}

  /** Attach the wechat_bind pairing-reply hook (called once by the plugin entry). */
  setPairingReply(handler: NonNullable<WeixinChannelOptions['pairingReply']>): void {
    (this.options as { pairingReply?: WeixinChannelOptions['pairingReply'] }).pairingReply = handler;
  }

  /** Attach the Weixin-side /bind handler (called once by the plugin entry). */
  setOnBindCommand(handler: NonNullable<WeixinChannelOptions['onBindCommand']>): void {
    (this.options as { onBindCommand?: WeixinChannelOptions['onBindCommand'] }).onBindCommand = handler;
  }

  /** Send a system-level text directly (pairing prompts, not a turn reply). */
  async sendDirect(subjectId: string, text: string): Promise<void> {
    await this.sendTo(subjectId, text);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const account = await this.loadAccount();
    if (!account) {
      this.options.logger.warn(
        `[wechat] account ${this.options.config.accountId ?? 'default'} has no credentials; run scripts/login.mjs first`,
      );
      return;
    }
    this.client = this.options.clientFactory?.(account) ?? createILinkClient({ account, ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}) });
    this.options.sessions.setIdentity(
      this.options.config.agentId ?? 'default',
      account.botId || this.options.botIdFallback || this.options.config.accountId || 'default',
    );
    await this.options.sessions.load();
    await this.options.sessions.save();
    this.running = true;
    this.options.logger.info(`[wechat] polling started account=${account.accountId} baseUrl=${account.baseUrl}`);
    void this.loop().catch((error) => this.options.logger.error(`[wechat] poll loop crashed: ${String(error)}`));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    for (const turn of this.activeByChat.values()) {
      turn.agent.cancel({ kind: 'user' }, { keepInbox: true });
      turn.closed = true;
      turn.settle();
    }
    this.activeByChat.clear();
    this.activeBySession.clear();
    await this.options.sessions.save();
  }

  private async loadAccount(): Promise<WeixinAccount | undefined> {
    const stored = await this.options.state.loadAccount();
    const accountId = this.options.config.accountId ?? 'default';
    if (stored && stored.token) return { ...stored, accountId };
    const token = this.options.tokenFallback;
    if (!token) return undefined;
    const botId = this.options.botIdFallback ?? stored?.botId ?? accountId;
    const baseUrl = stored?.baseUrl ?? this.options.baseUrlFallback ?? 'https://ilinkai.weixin.qq.com';
    const account: WeixinAccount = { accountId, botId, token, baseUrl, ...(stored?.userId ? { userId: stored.userId } : {}) };
    await this.options.state.saveAccount(account);
    return account;
  }

  private async loop(): Promise<void> {
    let cursor = await this.options.state.loadCursor();
    let failures = 0;
    while (this.running && !this.abort.signal.aborted) {
      if (!this.client) return;
      try {
        const batch = await this.client.pollBatch(cursor, this.abort.signal);
        failures = 0;
        for (const message of batch.messages) {
          await this.deliver(message);
        }
        if (batch.nextCursor && batch.nextCursor !== cursor) {
          await this.options.state.commitCursor(batch.nextCursor);
          cursor = batch.nextCursor;
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        failures += 1;
        this.options.logger.warn(
          `[wechat] getUpdates failed (${failures}/${POLL_MAX_FAILURES}): ${String(error)}`,
        );
        const delay = failures >= POLL_MAX_FAILURES ? POLL_BACKOFF_LONG_MS : POLL_BACKOFF_MS;
        failures = failures >= POLL_MAX_FAILURES ? 0 : failures;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          this.abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }).catch(() => {});
      }
    }
  }

  /** Dedup, persist context token, and hand the message to its chat queue. */
  async deliver(message: WeixinInboundEvent): Promise<void> {
    if (!(await this.options.state.rememberMessage(message.messageId))) {
      this.options.logger.info(`[wechat] duplicate message suppressed: ${message.messageId}`);
      return;
    }
    if (message.contextToken) {
      await this.options.state.setContextToken(message.subjectId, message.contextToken);
    }
    // 白名单 = 配置 allowedUsers ∪ 扫码登录绑定的 allowlist（扫码者即账号主人）。
    const allowed = new Set([...(this.options.config.allowedUsers ?? []), ...(await this.options.state.loadAllowlist())]);
    if (allowed.size > 0 && !allowed.has(message.subjectId)) {
      this.options.logger.info(`[wechat] sender not allowed, dropping: ${message.subjectId}`);
      return;
    }
    if (!message.text.trim()) {
      this.options.logger.info(`[wechat] non-text message ignored: ${message.messageId}`);
      return;
    }
    // 配对回复优先于普通对话：6 位数字命中进行中的 wechat_bind 即完成关联。
    const pairing = this.options.pairingReply;
    if (pairing) {
      const result = await pairing(message);
      if (result.handled) {
        await this.send(message, result.reply ?? '已处理。');
        return;
      }
    }
    const previous = this.queues.get(message.conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.dispatch(message));
    this.queues.set(message.conversationId, next);
    await next;
  }

  private async dispatch(message: WeixinInboundEvent): Promise<void> {
    const text = message.text.trim();
    if (text === '/help') {
      const active = this.activeByChat.has(message.conversationId);
      await this.send(message, [
        '可用指令：',
        '/help — 显示本帮助',
        '/status — 查看通道与会话状态',
        '/new — 重开会话（清空上下文）',
        '/stop — 中止当前正在执行的任务',
        '/bind — 关联引导（配对请用 /bind + 6位数字）',
        '',
        '其他消息直接对话即可；当前任务执行中时新消息会被拒绝，先 /stop。',
        active ? '（当前状态：任务执行中）' : '',
      ].filter(Boolean).join('\n'));
      return;
    }
    if (text === '/stop') {
      await this.stopActive(message.conversationId);
      return;
    }
    if (text === '/new') {
      this.options.sessions.reset(message.conversationId, message.subjectId);
      await this.options.sessions.save();
      await this.send(message, '已开启新的 DSH 会话。');
      return;
    }
    if (text === '/status') {
      const active = this.activeByChat.has(message.conversationId);
      await this.send(message, `微信通道运行中。当前会话任务：${active ? '执行中' : '空闲'}。`);
      return;
    }
    if (text === '/bind') {
      const handler = this.options.onBindCommand;
      if (!handler) {
        await this.send(message, '当前配置未启用微信侧关联。');
        return;
      }
      const result = await handler(message);
      await this.send(message, result.reply);
      return;
    }
    if (this.activeByChat.has(message.conversationId)) {
      await this.send(message, '当前任务仍在执行，请发送 /stop 中止后再继续。');
      return;
    }
    const binding = this.options.sessions.get(message.conversationId, message.subjectId);
    await mkdir(binding.cwd, { recursive: true, mode: 0o700 });
    await this.options.sessions.save();
    const agent = await this.options.resolveAgent(binding.sessionId, binding.cwd);
    // 新会话入全局注册表：Web 工作区树的会话列表以它为权威源。
    void attachSessionToGlobalRegistry({
      userPath: binding.cwd,
      sessionId: binding.sessionId,
      title: `用户 ${binding.userId.slice(0, 10)} · ${this.options.config.agentId}`,
    }).catch((error) => this.options.logger.warn(`[wechat] 全局注册表同步失败(不影响对话): ${String(error)}`));
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const turn: ActiveTurn = {
      chatId: message.conversationId,
      subjectId: message.subjectId,
      sessionId: binding.sessionId,
      agent,
      done,
      settle,
      committedText: '',
      liveAnswer: '',
      closed: false,
      ...(message.contextToken ? { contextToken: message.contextToken } : {}),
    };
    this.activeByChat.set(message.conversationId, turn);
    this.activeBySession.set(binding.sessionId, turn);
    this.options.logger.info(`[wechat] delivering ${message.messageId} session=${binding.sessionId}`);
    try {
      agent.followup({
        id: randomUUID() as UserMessage['id'],
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      } satisfies UserMessage);
      await done;
    } catch (error) {
      if (!turn.closed) {
        turn.closed = true;
        this.cleanupTurn(turn);
        await this.send(message, `任务执行失败：${errorMessage(error)}`);
      }
    }
  }

  /** Fold live assistant deltas; the reply is sent once at turn end. */
  assistantFrame(sessionId: string, frame: AssistantStreamFrame): void {
    const turn = this.activeBySession.get(sessionId);
    if (!turn || turn.closed) return;
    if (frame.type === 'start' || frame.type === 'end') {
      turn.liveAnswer = '';
      return;
    }
    if (frame.chunk.type === 'text-delta') turn.liveAnswer += frame.chunk.text;
  }

  async sessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const turn = this.activeBySession.get(sessionId);
    if (!turn || turn.closed) return;
    if (event.type === 'assistant/message') {
      const committed = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (committed) turn.committedText += (turn.committedText ? '\n\n' : '') + committed;
      turn.liveAnswer = '';
      return;
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason;
      await this.finishTurn(turn, reason.kind, 'error' in reason ? reason.error.message : undefined);
    }
  }

  private async finishTurn(turn: ActiveTurn, kind: string, error?: string): Promise<void> {
    if (turn.closed) return;
    turn.closed = true;
    this.cleanupTurn(turn);
    try {
      if (kind === 'error') {
        await this.sendTo(turn.subjectId, `任务执行失败：${error ?? '未知错误'}`, turn.contextToken);
      } else if (kind === 'completed') {
        const final = [turn.committedText, turn.liveAnswer].filter(Boolean).join('\n\n');
        if (final.trim()) await this.sendTo(turn.subjectId, filterMarkdown(final), turn.contextToken);
      }
    } finally {
      this.options.logger.info(`[wechat] turn finished chat=${turn.chatId} kind=${kind}`);
      turn.settle();
    }
  }

  private cleanupTurn(turn: ActiveTurn): void {
    this.activeByChat.delete(turn.chatId);
    this.activeBySession.delete(turn.sessionId);
  }

  private async stopActive(chatId: string): Promise<void> {
    const turn = this.activeByChat.get(chatId);
    if (!turn) {
      await this.sendTo(chatId, '当前没有执行中的任务。');
      return;
    }
    turn.closed = true;
    turn.agent.cancel({ kind: 'user' }, { keepInbox: true });
    this.cleanupTurn(turn);
    turn.settle();
    await this.sendTo(chatId, '已中止当前任务。');
  }

  private async send(message: WeixinInboundEvent, text: string): Promise<void> {
    await this.sendTo(message.subjectId, text, message.contextToken);
  }

  private async sendTo(subjectId: string, text: string, contextToken?: string): Promise<void> {
    if (!this.client) return;
    const token = contextToken ?? (await this.options.state.getContextToken(subjectId));
    await this.client.sendText({ to: subjectId, text, ...(token ? { contextToken: token } : {}) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
