import { relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Config } from './config.js';

export interface TrustedUser {
  readonly subjectId: string;
  readonly chatId: string;
  readonly accountId: string;
  readonly appId: string;
  readonly agentId: string;
  readonly userId: string;
}

export interface ResolveExtras {
  readonly userForSession: (sessionId: string) => TrustedUser | undefined;
}

interface BoundAgent extends Agent {
  identity?: {
    channel: 'wechat';
    agentId: string;
    appId: string;
    subjectId: string;
    userId: string;
    context: { chatId: string; accountId: string };
  };
}

const FENCED_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'glob', 'read_image']);
const PATH_ARGS: Record<string, string[]> = {
  read: ['file_path'], write: ['file_path'], edit: ['file_path'], read_image: ['file_path'], grep: ['path'], glob: ['path'],
};
const restricted = new WeakMap<Agent, () => void>();

function toolMatches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

function bindIdentity(agent: Agent, user: TrustedUser): void {
  (agent as BoundAgent).identity = {
    channel: 'wechat',
    agentId: user.agentId,
    appId: user.appId,
    subjectId: user.subjectId,
    userId: user.userId,
    context: { chatId: user.chatId, accountId: user.accountId },
  };
}

function agentOptions(ctx: Context, config: Config): AgentOptions | undefined {
  const defaultSelection = (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined)?.currentSelection?.();
  const provider = config.provider ?? config.manifest?.model?.provider ?? defaultSelection?.provider;
  const model = config.model ?? config.manifest?.model?.name ?? defaultSelection?.model;
  const reasoningEffort = config.reasoningEffort ?? config.manifest?.model?.reasoningEffort;
  if (!provider && !model && !reasoningEffort) return undefined;
  const effort = reasoningEffort as AgentOptions['reasoningEffort'] | undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

function restrictTools(ctx: Context, config: Config, agent: Agent, cwd: string): void {
  const patterns = config.agentToolAllow;
  if (!patterns?.length) return;
  const tools = agent.ctx.get('tools') as {
    schemas(agent?: Agent): Array<{ name: string }>;
    restrict(input: { allow: string[] }): () => void;
    guard(input: (exec: { name: string; arguments?: Record<string, unknown> }) => string | undefined): () => void;
  } | undefined;
  if (!tools) return;
  restricted.get(agent)?.();
  const allowed = tools.schemas(undefined).map((tool) => tool.name).filter((name) => patterns.some((pattern) => toolMatches(name, pattern)));
  const removeRestriction = tools.restrict({ allow: allowed });
  const removeGuard = tools.guard((exec) => {
    if (!patterns.some((pattern) => toolMatches(exec.name, pattern))) return `tool "${exec.name}" is not available through the Weixin channel`;
    if (!FENCED_TOOLS.has(exec.name)) return undefined;
    for (const key of PATH_ARGS[exec.name] ?? []) {
      const value = exec.arguments?.[key];
      if (typeof value !== 'string' || !value) continue;
      const target = resolve(cwd, value);
      const rel = relative(cwd, target);
      if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) !== target && rel === '') return `tool "${exec.name}" path escapes the Weixin workspace`;
    }
    return undefined;
  });
  restricted.set(agent, () => { removeRestriction(); removeGuard(); });
}

async function syncCwd(ctx: Context, agent: Agent, cwd: string): Promise<void> {
  const service = ctx.get('workingDirectory') as { get(session: Agent['session']): string | undefined; set(agent: Agent, path: string): Promise<string> } | undefined;
  if (service && service.get(agent.session) !== cwd) await service.set(agent, cwd);
}

export async function resolveAgent(ctx: Context, config: Config, sessionId: string, cwd: string, extras: ResolveExtras): Promise<Agent> {
  const agents = ctx.get('agents');
  if (!agents) throw new Error('DSH agents service is unavailable');
  const user = extras.userForSession(sessionId);
  if (!user) throw new Error('trusted Weixin identity is unavailable');
  const setup: AgentSetup = (_agentCtx, agent) => ({ commit: () => bindIdentity(agent, user) });
  const options = agentOptions(ctx, config);
  const existing = agents.get(sessionId as SessionId);
  if (existing) {
    bindIdentity(existing, user);
    await syncCwd(ctx, existing, cwd);
    restrictTools(ctx, config, existing, cwd);
    return existing;
  }
  try {
    const resumed = await agents.resume({ resumeSessionId: sessionId as SessionId, ...(options ? { agentOptions: options } : {}), setup });
    bindIdentity(resumed.agent, user);
    await syncCwd(ctx, resumed.agent, cwd);
    restrictTools(ctx, config, resumed.agent, cwd);
    return resumed.agent;
  } catch (error) {
    const concurrent = agents.get(sessionId as SessionId);
    if (concurrent) {
      bindIdentity(concurrent, user);
      await syncCwd(ctx, concurrent, cwd);
      restrictTools(ctx, config, concurrent, cwd);
      return concurrent;
    }
    const created = await agents.create({
      sessionId: sessionId as SessionId,
      meta: { cwd },
      ...(options ? { agentOptions: options } : {}),
      setup,
    });
    bindIdentity(created.agent, user);
    await syncCwd(ctx, created.agent, cwd);
    restrictTools(ctx, config, created.agent, cwd);
    return created.agent;
  }
}
