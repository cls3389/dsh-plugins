import { relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { userKey } from '@dsh-friends/feishu-principal';
import type { Config } from './config.js';
import type { ChatModelSelection, ModelSelectionRegistry } from './model-selection.js';

/** Optional model-switching wiring passed by the plugin entry. */
export interface ResolveExtras {
  /** Registry whose AgentSetup installs the mutable per-session selection. */
  readonly selections?: ModelSelectionRegistry;
  /** Stored per-chat override looked up by sessionId at resume time. */
  readonly modelOverride?: (sessionId: string) => ChatModelSelection | undefined;
  /** Trusted sender identity for business plugins, never inferred from prompt text. */
  readonly userForSession?: (sessionId: string) =>
    | {
        openId: string;
        chatId: string;
        accountId?: string;
        appId?: string | undefined;
        agentId?: string | undefined;
      }
    | undefined;
}

/**
 * 基座身份服务的宿主级数据载体(channel 写入,业务插件经 identityOf 双读):
 * channel/appId/subjectId(渠道内主体 id,飞书=openId)/userId(身份簇键)/context(会话上下文)。
 */
interface AgentIdentity {
  channel: string;
  agentId?: string | undefined;
  appId?: string | undefined;
  subjectId: string;
  userId: string;
  context: { chatId?: string | undefined; accountId?: string | undefined };
}

interface UserBoundAgent extends Agent {
  /** 兼容期旧载体(ths-trade 等仍在读);feishu-principal identityOf 双读的回退源。 */
  larkUser?: {
    openId: string;
    chatId: string;
    accountId?: string;
    appId?: string | undefined;
    agentId?: string | undefined;
  };
  /** 基座化新载体:渠道唯一职责(消息→身份→绑定)的统一产物。 */
  identity?: AgentIdentity;
}

/**
 * 双写身份载体:larkUser(兼容期保留)+ identity(基座契约)。
 * userId 经 feishu-principal userKey 解析身份簇(读写 $DSH_HOME/identities.json)。
 */
function bindUserIdentity(agent: Agent, extras: ResolveExtras): void {
  const user = extras.userForSession?.(agent.session.id);
  if (!user) return;
  const bound = agent as UserBoundAgent;
  bound.larkUser = user;
  bound.identity = {
    channel: 'feishu',
    ...(user.agentId !== undefined ? { agentId: user.agentId } : {}),
    ...(user.appId !== undefined ? { appId: user.appId } : {}),
    subjectId: user.openId,
    userId: userKey(user.openId, user.appId),
    context: {
      chatId: user.chatId,
      ...(user.accountId !== undefined ? { accountId: user.accountId } : {}),
    },
  };
}

async function syncWorkingDirectory(ctx: Context, agent: Agent, cwd: string): Promise<void> {
  const service = ctx.get('workingDirectory') as
    | {
        get(session: Agent['session']): string;
        set(agent: Agent, path: string): Promise<string>;
      }
    | undefined;
  if (service && service.get(agent.session) !== cwd) await service.set(agent, cwd);
}

function agentOptions(
  config: Config,
  ctx: Context,
): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const selection = (
    ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider: string; model: string } }
      | undefined
  )?.currentSelection();
  // 模型三层:显式 bot 字段 > 身份 manifest(agents/<agentId>/manifest.yml) > profile 默认。
  const manifestModel = config.manifest?.model;
  const provider = config.provider ?? manifestModel?.provider ?? selection?.provider;
  const model = config.model ?? manifestModel?.name ?? selection?.model;
  const effort = config.reasoningEffort ?? manifestModel?.reasoningEffort;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

interface GuardedExecution {
  readonly name: string;
  readonly agent?: Agent;
  readonly arguments?: Readonly<Record<string, unknown>>;
}
interface ChannelTools {
  schemas(agent: Agent): Array<{ name: string }>;
  restrict(filter: { allow: string[] }): () => void;
  guard(check: (exec: GuardedExecution) => string | undefined): () => void;
}
interface PrincipalTools {
  toolsFor(openId: string, defaults?: readonly string[], appId?: string): string[];
}

/** Filesystem tools whose path-like arguments must stay inside the user workspace. */
const FENCED_FS_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'glob', 'read_image']);
/** Argument keys that carry a filesystem path, per fenced tool. */
const FENCED_PATH_ARGS: Readonly<Record<string, string[]>> = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  read_image: ['file_path'],
  grep: ['path'],
  glob: ['path'],
};

/**
 * Deny filesystem tools whose path arguments escape the sender's workspace.
 * The workspace root comes from the trusted binding cwd (principal-derived),
 * never from model-controlled input; subagents inherit this guard through the
 * parent scope chain, so delegation cannot widen the fence.
 */
function fenceUserWorkspace(exec: GuardedExecution, root: string): string | undefined {
  if (!FENCED_FS_TOOLS.has(exec.name)) return undefined;
  const keys = FENCED_PATH_ARGS[exec.name];
  if (keys === undefined) return undefined;
  const args = exec.arguments;
  if (args === undefined) return undefined;
  for (const key of keys) {
    const raw = args[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const target = resolvePath(root, raw);
    const relative = relativePath(root, target);
    if (relative === undefined || relative.startsWith(`..${sep}`) || relative === '..') {
      return `tool "${exec.name}" is fenced to the Feishu user workspace ${root} by the business channel`;
    }
  }
  return undefined;
}

const restrictedAgents = new WeakMap<Agent, { key: string; dispose: () => void }>();

/**
 * Proto tool sets per identity archetype (agents/<agentId>/manifest.yml proto).
 * A bot with no explicit agentToolAllow inherits its proto set instead of the
 * patch baseline; an explicit agentToolAllow still wins (backwards compatible).
 * The owner archetype follows the patch baseline (self-use bot with trading).
 */
const AGENT_PROTO_ALLOW: Readonly<Record<string, readonly string[]>> = {
  // 股票助手(朋友 bot):通用能力 + 行情只读工具(搜索/K线/盘口/秒线/问财/大盘脉搏/异动/两融折算率);
  // 无交易/自选/资金类(ths_order/account/cancel/watch/fav/signal)。
  guest: [
    'web_search',
    'web_fetch',
    'browser_*',
    'asr_*',
    'image_generate',
    'image_edit',
    'doc_to_markdown',
    'zread_*',
    'memory_*',
    'feishu_send_image',
    'schedule_*',
    'subagent',
    'subagent_fork',
    'workflow',
    'present',
    'ask_user_question',
    'ths_search',
    'ths_quote',
    'ths_klines',
    'ths_level2',
    'ths_sec_kline',
    'ths_wencai',
    'ths_market_pulse',
    'ths_move_detail',
    'ths_margin_collateral',
  ],
  // 垂直人设 bot:guest + skill 与工作区内文件工具(受 fenceUserWorkspace 围栏)。
  companion: [
    'web_search',
    'web_fetch',
    'browser_*',
    'asr_*',
    'image_generate',
    'image_edit',
    'doc_to_markdown',
    'zread_*',
    'memory_*',
    'feishu_send_image',
    'schedule_*',
    'subagent',
    'subagent_fork',
    'workflow',
    'present',
    'ask_user_question',
    'skill',
    'read',
    'grep',
    'glob',
  ],
};

/** Effective allowlist: explicit bot config wins; otherwise the identity manifest proto set; otherwise the patch baseline. */
function effectiveAllowPatterns(config: Config): readonly string[] | undefined {
  if (config.agentToolAllow !== undefined) return config.agentToolAllow;
  const proto = config.manifest?.proto;
  const protoSet = proto !== undefined ? AGENT_PROTO_ALLOW[proto] : undefined;
  return protoSet ?? config.agentToolAllow;
}

/** Inherit shared tools, add sender extras, and recalculate on group speaker changes. */
function restrictChannelTools(ctx: Context, config: Config, agent: Agent): void {
  const openId = (agent as UserBoundAgent).larkUser?.openId;
  const principal = ctx.get('feishuPrincipal') as PrincipalTools | undefined;
  const base = effectiveAllowPatterns(config);
  const patterns =
    openId && principal
      ? principal.toolsFor(openId, base, (agent as UserBoundAgent).larkUser?.appId)
      : base;
  const key = `${(agent as UserBoundAgent).larkUser?.appId ?? ''}:${openId ?? ''}:${(patterns ?? []).join('\0')}`;
  const previous = restrictedAgents.get(agent);
  if (previous?.key === key) return;
  previous?.dispose();
  restrictedAgents.delete(agent);
  if (!patterns?.length) return;
  const tools = agent.ctx.get('tools') as ChannelTools | undefined;
  if (!tools) throw new Error('DSH tools service is unavailable');
  const allow = tools
    .schemas(agent)
    .map((tool) => tool.name)
    .filter((name) => patterns.some((pattern) => toolNameMatches(name, pattern)));
  const removeRestriction = tools.restrict({ allow });
  const bindingRoot = bindingCwdOf(ctx, agent);
  const removeGuard = tools.guard((exec) => {
    const denied = patterns.some((pattern) => toolNameMatches(exec.name, pattern))
      ? undefined
      : `tool "${exec.name}" is not available through the Feishu business channel`;
    if (denied !== undefined) return denied;
    if (bindingRoot !== undefined) {
      const fenced = fenceUserWorkspace(exec, bindingRoot);
      if (fenced !== undefined) return fenced;
    }
    return undefined;
  });
  restrictedAgents.set(agent, {
    key,
    dispose: () => {
      removeRestriction();
      removeGuard();
    },
  });
}

/** Trusted per-session workspace root from the workingDirectory service. */
function bindingCwdOf(ctx: Context, agent: Agent): string | undefined {
  const service = ctx.get('workingDirectory') as
    | { get(session: Agent['session']): string | undefined }
    | undefined;
  return service?.get(agent.session);
}

export function toolNameMatches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** Resume existing Lark sessions through the same Agent registry as Web hosts. */
export async function resolveAgent(
  ctx: Context,
  config: Config,
  sessionId: string,
  cwd: string,
  extras: ResolveExtras = {},
): Promise<Agent> {
  const agents = ctx.get('agents');
  if (!agents) throw new Error('DSH agents service is unavailable');
  const existing = agents.get(sessionId as SessionId);
  if (existing) {
    bindUserIdentity(existing, extras);
    await syncWorkingDirectory(ctx, existing, cwd);
    restrictChannelTools(ctx, config, existing);
    return existing;
  }
  const options = agentOptions(config, ctx);
  const setup = extras.selections?.setup(extras.modelOverride?.(sessionId));
  const withOptions = <T extends object>(base: T): T => ({
    ...base,
    ...(options ? { agentOptions: options } : {}),
    ...(setup ? { setup } : {}),
  });
  try {
    const resumed = await agents.resume(withOptions({ resumeSessionId: sessionId as SessionId }));
    bindUserIdentity(resumed.agent, extras);
    await syncWorkingDirectory(ctx, resumed.agent, cwd);
    restrictChannelTools(ctx, config, resumed.agent);
    return resumed.agent;
  } catch (error) {
    // A concurrent resume may have published the agent after our initial lookup.
    const concurrent = agents.get(sessionId as SessionId);
    if (concurrent) {
      bindUserIdentity(concurrent, extras);
      await syncWorkingDirectory(ctx, concurrent, cwd);
      restrictChannelTools(ctx, config, concurrent);
      return concurrent;
    }
    const missing =
      typeof error === 'object' && error !== null && 'code' in error
        ? ['SESSION_NOT_FOUND', 'ENOENT', 'NOT_FOUND'].includes(String(error.code))
        : /not found|does not exist|ENOENT/i.test(String(error));
    if (!missing) throw error;
    const created = await agents.create(
      withOptions({ sessionId: sessionId as SessionId, meta: { cwd } }),
    );
    bindUserIdentity(created.agent, extras);
    await syncWorkingDirectory(ctx, created.agent, cwd);
    restrictChannelTools(ctx, config, created.agent);
    return created.agent;
  }
}

/** Host-neutral compatibility for integrations that use Web's sessionController. */
export function registerSessionController(
  ctx: Context,
  config: Config,
  cwd: string,
  extras: ResolveExtras = {},
): void {
  const controller = {
    async resolveAgent(sessionId: SessionId) {
      try {
        return { agent: await resolveAgent(ctx, config, sessionId, cwd, extras) };
      } catch (error) {
        return { error: { code: 'SESSION_UNAVAILABLE', message: String(error) } };
      }
    },
  };
  if (ctx.get('sessionController') !== undefined) {
    ctx.logger.warn('[lark] host sessionController already exists; using existing service');
    return;
  }
  ctx.provide('sessionController', controller);
  ctx.logger.info('[lark] Agent-backed sessionController compatibility enabled');
}
