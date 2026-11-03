import z from "@deepseek-ai/schemastery";
import { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import { Context } from "@deepseek-ai/cordis";
import { SessionEvent } from "@deepseek-ai/dsh-session";

//#region src/config.d.ts
/** Identity-manifest fields loaded from agents/<agentId>/manifest.yml. */
interface AgentManifest {
  readonly proto?: 'guest' | 'companion' | 'owner';
  readonly displayName?: string;
  readonly model?: {
    readonly provider?: string;
    readonly name?: string;
    readonly reasoningEffort?: string;
  };
}
/** Clean DSH configuration for the official Lark channel. */
interface Config {
  readonly appId?: string;
  /** Optional display-name override; the bot name is discovered by default. */
  readonly appName?: string;
  readonly appSecret?: string;
  /** 环境变量名,从中读取 appSecret(密钥不落 patch 明文)。 */
  readonly appSecretEnv?: string;
  readonly domain?: 'feishu' | 'lark';
  readonly defaultCwd?: string;
  /** Identity root directory (agents/<agentId> tier); derived from DSH_HOME when omitted. */
  readonly workspaceRoot?: string;
  readonly dataDir?: string;
  readonly provider?: string;
  readonly model?: string;
  /** Adapter-owned reasoning effort pinned for this account's agents (e.g. "max"). */
  readonly reasoningEffort?: string;
  readonly allowedChats?: string[];
  readonly allowedUsers?: string[];
  readonly groupMentionMode?: 'always' | 'never' | 'ambient';
  readonly replyMode?: 'streaming';
  readonly tools?: {
    readonly deny?: string[];
  };
  /** false disables all; 'messages' keeps only current-chat text/image messaging tools. */
  readonly officialTools?: boolean | 'messages';
  /** Allowlist for the complete DSH tool catalog exposed through this channel. */
  readonly agentToolAllow?: string[];
  readonly mcpEndpoint?: string;
  /** Additional Feishu applications sharing this DSH runtime; default remains the primary bot. */
  readonly bots?: BotConfig[];
  /** Identity directory name under the agents root: the config host for tools/persona/model. */
  readonly agentId?: string;
  /** Resolved identity manifest (proto/model) loaded during resolveBots. */
  readonly manifest?: AgentManifest;
  /** Resolved agents root attached by resolveBots so manifest edits hot-apply per agent mount. */
  readonly agentsRoot?: string;
  /** Local secret-bearing JSON array used instead of embedding all bot credentials in YAML. */
  readonly botsFile?: string;
  /** Account used by this channel instance; the primary bot uses "default". */
  readonly accountId?: string;
}
type BotConfig = Omit<Config, 'bots'> & {
  readonly accountId: string;
  readonly appId: string;
  readonly appSecret: string;
};
declare const Config: z<Config>;
//#endregion
//#region src/runtime-config.d.ts
/** Minimal config shape consumed by the official Lark implementation. */
interface LarkRuntimeConfig {
  readonly channels: {
    readonly feishu: Record<string, unknown>;
  };
}
//#endregion
//#region src/streaming.d.ts
interface NotificationCardState {
  cardMessageId: string | null;
  cardKitCardId: string | null;
  cardKitSequence: number;
}
interface NotificationStreamOptions {
  uuid: string;
  state?: NotificationCardState;
  checkpoint(state: NotificationCardState): void;
}
interface OfficialTurnController {
  readonly cardMessageId: string | null;
  readonly currentPhase: string;
  ensureCardCreated(): Promise<void>;
  onPartialReply(payload: {
    text: string;
  }): Promise<void>;
  onReasoningStream(payload: {
    text: string;
  }): Promise<void>;
  onDeliver(payload: {
    text: string;
  }): Promise<void>;
  onToolStart(payload: {
    name: string;
    phase: 'start';
  }): Promise<void>;
  onToolPayload(payload: {
    text: string;
  }): Promise<void>;
  onIdle(): Promise<void>;
  onError(error: unknown, info: {
    kind: string;
  }): Promise<void>;
  abortCard(): Promise<void>;
  markFullyComplete(): void;
}
type OfficialTurnControllerFactory = (deps: {
  cfg: LarkRuntimeConfig;
  agentId: string;
  sessionKey: string;
  accountId: string | undefined;
  chatId: string;
  replyToMessageId: string | undefined;
  notification?: NotificationStreamOptions;
  replyInThread: false;
  toolUseDisplay: {
    mode: 'on';
    showToolUse: true;
    showToolResultDetails: false;
    showFullPaths: false;
  };
  resolvedFooter: {
    status: false;
    elapsed: false;
    tokens: false;
    cache: false;
    context: false;
    model: false;
  };
}) => OfficialTurnController;
/** One official CardKit turn. No legacy card builder or legacy fallback exists here. */
declare class OfficialTurnStream {
  private readonly sessionKey;
  private readonly controller;
  private queue;
  constructor(sessionKey: string, chatId: string, replyToMessageId: string | undefined, cfg: LarkRuntimeConfig, factory?: OfficialTurnControllerFactory, accountId?: string, notification?: NotificationStreamOptions);
  get phase(): string;
  get messageId(): string | null;
  start(): Promise<void>;
  text(snapshot: string): Promise<void>;
  reasoning(_snapshot: string): Promise<void>;
  toolStart(input: {
    name: string;
    callId: string | undefined;
    params: Record<string, unknown> | undefined;
  }): Promise<void>;
  toolEnd(input: {
    name: string;
    callId: string | undefined;
    params: Record<string, unknown> | undefined;
    result?: unknown;
    error: string | undefined;
    durationMs: number | undefined;
  }): Promise<void>;
  complete(answer: string): Promise<void>;
  fail(error: unknown): Promise<void>;
  abort(): Promise<void>;
  private enqueue;
}
//#endregion
//#region src/notifications.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    schedule: {
      kind: 'schedule';
    };
  }
}
interface FeishuNotificationInput {
  sessionId: string;
  ownerOpenId: string;
  ownerAppId: string;
  text: string;
  eventId: string;
}
interface PreviousSessionInput {
  sessionId: string;
  previousSessionId: string;
  ownerOpenId: string;
  ownerAppId: string;
}
interface NotificationRecord {
  input: FeishuNotificationInput;
  inputHash?: string;
  chatId: string;
  currentSessionId: string;
  status: 'accepted' | 'running' | 'completed';
  acceptedAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  card?: NotificationCardState;
  claimedTurn?: number;
  result?: {
    kind: string;
    text: string;
    error?: string;
  };
  completedAt?: number;
  lastError?: string;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/types.d.ts
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Messaging type definitions for the Lark/Feishu channel plugin.
 *
 * Pure shape types for inbound message events, normalised message context,
 * mention targets, and media metadata.
 */
interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}
//#endregion
//#region src/model-selection.d.ts
/** Chat-pinned model override persisted in the Lark session store. */
interface ChatModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}
//#endregion
//#region src/session-store.d.ts
interface SessionBinding {
  readonly sessionId: string;
  readonly previousSessionIds?: readonly string[];
  readonly chatType?: 'p2p' | 'group';
  readonly cwd: string;
  /** Chat-pinned model override; absent means follow sticky/default routing. */
  readonly model?: ChatModelSelection;
  readonly openId?: string;
  /** 飞书 union_id：跨应用人标识，用于身份簇归并（同一人换 bot 不换身份）。 */
  readonly unionId?: string;
  readonly displayName?: string | undefined;
}
/** Durable one-chat-to-one-DSH-session registry, independent of legacy state. */
declare class SessionStore {
  private readonly bindings;
  private readonly path;
  private readonly workspacePath;
  private readonly agentsRoot;
  private cwd;
  private readonly userNames;
  /** openId → union_id：注册表/恢复会话时按人（而非按应用）解析身份簇。 */
  private readonly userUnionIds;
  private readonly recoveredUsers;
  private identity?;
  private loaded;
  constructor(dataDir: string, defaultCwd: string, agentsRoot?: string);
  /** Set the identity (agent) tier; user archives live under agents/<agentId>/users/<userId>. */
  setAgentIdentity(agentId: string | undefined, displayName?: string, appId?: string, botName?: string): void;
  /**
   * Identity-center rebind (2026-10-30): after setAgentIdentity, remap every
   * openId-bound session cwd to the current identity path — bindings loaded
   * from pre-migration files keep stale app-era paths otherwise, and save()
   * alone would just persist them back.
   */
  rebindCwd(): void;
  load(): Promise<void>;
  /** Existing scoped identity lookup; display-name reads must never enroll a user. */
  private existingUserId;
  /** Admin-configured name: current users.<userId>, with legacy app/openId fallbacks. */
  private configuredDisplayName;
  private cwdFor;
  get(chatId: string, openId?: string, displayName?: string, unionId?: string): SessionBinding;
  reset(chatId: string, openId?: string): SessionBinding;
  /** Read-only lookup: never creates a binding or resolves a new identity. */
  notificationTarget(sessionId: string): {
    chatId: string;
    binding: SessionBinding;
  } | undefined;
  setChatType(chatId: string, chatType: 'p2p' | 'group'): void;
  addPreviousSession(sessionId: string, previousSessionId: string, openId: string): void;
  /** Chat-pinned override for one DSH session, when stored. */
  overrideFor(sessionId: string): ChatModelSelection | undefined;
  setModel(chatId: string, model: ChatModelSelection): void;
  clearModel(chatId: string): void;
  save(): Promise<void>;
  private freshId;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/lark-ticket.d.ts
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Request-level ticket for the Feishu plugin.
 *
 * Uses Node.js AsyncLocalStorage to propagate a ticket (message_id,
 * chat_id, account_id) through the entire async call chain without passing
 * parameters explicitly.  Call {@link withTicket} at the event entry point
 * (monitor.ts) and use {@link getTicket} anywhere downstream.
 */
interface LarkTicket {
  messageId: string;
  chatId: string;
  accountId: string;
  startTime: number;
  senderOpenId?: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
}
//#endregion
//#region src/tools.d.ts
/** LarkTicket + 发送者 union_id（飞书跨应用人标识，用于身份簇归并）。 */
type FeishuLarkTicket = LarkTicket & {
  readonly senderUnionId?: string;
};
/** Session-scoped Feishu identity used by user-token and proactive tools. */
declare class OfficialToolContexts {
  private readonly sessions;
  /** Remember the latest accepted inbound message for one DSH session. */
  bind(sessionId: string, ticket: FeishuLarkTicket): void;
  /** Resolve a session binding for the tool adapter. */
  get(sessionId: string): FeishuLarkTicket | undefined;
  /** Drop all bindings when the surface is disposed. */
  clear(): void;
}
//#endregion
//#region src/channel.d.ts
interface ChannelLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
interface LarkChannelOptions {
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
  readonly models?: {
    handle(chatId: string, text: string): Promise<string>;
  };
}
/** Official Lark events directly driving DSH agents and official streaming cards. */
declare class LarkChannel {
  private readonly options;
  private readonly dedup;
  private readonly abort;
  private readonly activeByChat;
  private readonly activeBySession;
  private readonly queues;
  private client?;
  private readonly notifications;
  constructor(options: LarkChannelOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Parse and queue one raw Feishu message; exposed for offline contract tests. */
  receive(event: FeishuMessageEvent): Promise<void>;
  get appId(): string | undefined;
  /** Resolve only existing owner/app/chat bindings and durably accept before returning. */
  deliverNotification(input: FeishuNotificationInput): Promise<void>;
  notificationStatus(eventId?: string): NotificationRecord[];
  rebindPreviousSession(input: PreviousSessionInput): Promise<void>;
  /** Startup replay runs after SessionStore identity initialization, before the WS lifetime await. */
  startNotifications(): void;
  private notificationTarget;
  private enqueue;
  private dispatchNotification;
  /** Fold DSH live model deltas directly into the official controller. */
  assistantFrame(sessionId: string, frame: AssistantStreamFrame): void;
  /** Fold durable tool and turn events into the official controller. */
  sessionEvent(sessionId: string, event: SessionEvent): Promise<void>;
  private admit;
  private dispatch;
  private finishTurn;
  private isModelCommand;
  private stopActive;
  private messageContent;
  private send;
}
//#endregion
//#region src/index.d.ts
declare const name = "feishu-channel";
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, type FeishuNotificationInput, LarkChannel, type NotificationRecord, OfficialTurnStream, type PreviousSessionInput, apply, name };