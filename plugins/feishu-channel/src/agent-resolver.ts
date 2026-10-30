import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Config } from './config.js';
import type { ChatModelSelection, ModelSelectionRegistry } from './model-selection.js';

/** Optional model-switching wiring passed by the plugin entry. */
export interface ResolveExtras {
  /** Registry whose AgentSetup installs the mutable per-session selection. */
  readonly selections?: ModelSelectionRegistry;
  /** Stored per-chat override looked up by sessionId at resume time. */
  readonly modelOverride?: (sessionId: string) => ChatModelSelection | undefined;
  /** Trusted sender identity for business plugins, never inferred from prompt text. */
  readonly userForSession?: (sessionId: string) => { openId: string; chatId: string; accountId?: string; appId?: string | undefined } | undefined;
}

interface UserBoundAgent extends Agent {
  larkUser?: { openId: string; chatId: string; accountId?: string; appId?: string | undefined };
}

function bindUserIdentity(agent: Agent, extras: ResolveExtras): void {
  const user = extras.userForSession?.(agent.session.id);
  if (user) (agent as UserBoundAgent).larkUser = user;
}

async function syncWorkingDirectory(ctx: Context, agent: Agent, cwd: string): Promise<void> {
  const service = ctx.get('workingDirectory') as {
    get(session: Agent['session']): string;
    set(agent: Agent, path: string): Promise<string>;
  } | undefined;
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
  const provider = config.provider ?? selection?.provider;
  const model = config.model ?? selection?.model;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
}

interface ChannelTools {
  schemas(agent: Agent): Array<{ name: string }>;
  restrict(filter: { allow: string[] }): () => void;
  guard(check: (exec: { name: string }) => string | undefined): () => void;
}
interface PrincipalTools {
  toolsFor(openId: string, defaults?: string[], appId?: string): string[];
}

const restrictedAgents = new WeakMap<Agent, { key: string; dispose: () => void }>();

/** Inherit shared tools, add sender extras, and recalculate on group speaker changes. */
function restrictChannelTools(ctx: Context, config: Config, agent: Agent): void {
  const openId = (agent as UserBoundAgent).larkUser?.openId;
  const principal = ctx.get('feishuPrincipal') as PrincipalTools | undefined;
  const patterns = openId && principal ? principal.toolsFor(openId, config.agentToolAllow, (agent as UserBoundAgent).larkUser?.appId) : config.agentToolAllow;
  const key = `${(agent as UserBoundAgent).larkUser?.appId ?? ''}:${openId ?? ''}:${(patterns ?? []).join('\0')}`;
  const previous = restrictedAgents.get(agent);
  if (previous?.key === key) return;
  previous?.dispose();
  restrictedAgents.delete(agent);
  if (!patterns?.length) return;
  const tools = agent.ctx.get('tools') as ChannelTools | undefined;
  if (!tools) throw new Error('DSH tools service is unavailable');
  const allow = tools.schemas(agent)
    .map((tool) => tool.name)
    .filter((name) => patterns.some((pattern) => toolNameMatches(name, pattern)));
  const removeRestriction = tools.restrict({ allow });
  const removeGuard = tools.guard(({ name }) => patterns.some((pattern) => toolNameMatches(name, pattern))
    ? undefined
    : `tool "${name}" is not available through the Feishu business channel`);
  restrictedAgents.set(agent, { key, dispose: () => { removeRestriction(); removeGuard(); } });
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
    const missing = typeof error === 'object' && error !== null && 'code' in error
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
