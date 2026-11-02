import { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { registerSessionController, resolveAgent } from '../src/agent-resolver.js';
import type { Config } from '../src/config.js';
import { ModelSelectionRegistry } from '../src/model-selection.js';

describe('Lark Agent compatibility services', () => {
  it('provides a sessionController that restores persisted Lark sessions', async () => {
    const ctx = new Context();
    const agent = { session: { id: 'lark-session' } } as Agent;
    const resume = vi.fn(async () => ({ agent, dispose: async () => {} }));
    const create = vi.fn();
    const agents = { get: () => undefined, resume, create };
    const config = { appId: 'app', appSecret: 'secret', provider: 'test', model: 'test' } as Config;
    ctx.provide('agents', agents);
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default', model: 'default' }),
    });
    const runtime = await ctx.plugin((ctx) => registerSessionController(ctx, config, '/workspace'));
    const controller = ctx.get('sessionController') as {
      resolveAgent(id: SessionId): Promise<{ agent: Agent }>;
    };
    await expect(controller.resolveAgent('lark-session' as SessionId)).resolves.toEqual({ agent });
    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: 'lark-session',
      agentOptions: { provider: 'test', model: 'test' },
      setup: expect.any(Function),
    });
    expect(create).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('binds the trusted sender rather than deriving identity from prompt text', async () => {
    const ctx = new Context();
    const agent = {
      session: { id: 'lark-session' },
      ctx: { get: () => undefined },
    } as unknown as Agent;
    ctx.provide('agents', {
      get: () => agent,
      resume: vi.fn(),
      create: vi.fn(),
    });
    const openId = `ou_${'a'.repeat(32)}`;
    const resolved = await resolveAgent(ctx, {} as Config, 'lark-session', '/workspace', {
      userForSession: () => ({ openId, chatId: 'oc_group' }),
    });
    // 双载体:兼容期 larkUser 保留 + 基座 identity 写入(userId 为身份簇键)。
    expect((resolved as Agent & { larkUser?: unknown }).larkUser).toEqual({
      openId,
      chatId: 'oc_group',
    });
    expect((resolved as Agent & { identity?: unknown }).identity).toMatchObject({
      channel: 'feishu',
      subjectId: openId,
      userId: expect.stringMatching(/^u_[a-z0-9]+$/),
      context: { chatId: 'oc_group' },
    });
  });

  it('binds no identity carriers when no trusted sender is on record', async () => {
    const ctx = new Context();
    const agent = {
      session: { id: 'lark-session' },
      ctx: { get: () => undefined },
    } as unknown as Agent;
    ctx.provide('agents', { get: () => agent, resume: vi.fn(), create: vi.fn() });
    const resolved = await resolveAgent(ctx, {} as Config, 'lark-session', '/workspace', {
      userForSession: () => undefined,
    });
    expect((resolved as Agent & { larkUser?: unknown }).larkUser).toBeUndefined();
    expect((resolved as Agent & { identity?: unknown }).identity).toBeUndefined();
  });

  it('reuses a concurrently resumed agent and never recreates an existing session', async () => {
    const ctx = new Context();
    const agent = {
      session: { id: 'lark-session' },
      ctx: { get: () => undefined },
    } as unknown as Agent;
    let published = false;
    const create = vi.fn();
    ctx.provide('agents', {
      get: () => (published ? agent : undefined),
      resume: async () => {
        published = true;
        throw Object.assign(new Error('session already exists'), {
          name: 'SessionAlreadyExistsError',
        });
      },
      create,
    });
    await expect(resolveAgent(ctx, {} as Config, 'lark-session', '/workspace')).resolves.toBe(
      agent,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('inherits global tools, adds sender extras, and refreshes group speaker policy', async () => {
    const ctx = new Context();
    const restrictions: string[][] = [];
    let disposed = 0;
    const tools = {
      schemas: () => [
        { name: 'web_search' },
        { name: 'ths_account' },
        { name: 'feishu_fetch_doc' },
      ],
      restrict: ({ allow }: { allow: string[] }) => {
        restrictions.push(allow);
        return () => {
          disposed++;
        };
      },
      guard: () => () => {},
    };
    const agent = {
      session: { id: 'lark-session' },
      ctx: { get: () => tools },
    } as unknown as Agent;
    ctx.provide('agents', { get: () => agent, resume: vi.fn(), create: vi.fn() });
    let extra: string[] = [];
    ctx.provide('feishuPrincipal', {
      toolsFor: (_id: string, defaults: string[]) => [...defaults, ...extra],
    });
    const config = { agentToolAllow: ['web_search'] } as Config;
    const extras = {
      userForSession: () => ({ openId: `ou_${'a'.repeat(32)}`, chatId: 'oc_group' }),
    };
    await resolveAgent(ctx, config, 'lark-session', '/workspace', extras);
    expect(restrictions).toEqual([['web_search']]);
    extra = ['ths_account', 'feishu_*'];
    await resolveAgent(ctx, config, 'lark-session', '/workspace', extras);
    expect(restrictions[1]).toEqual(['web_search', 'ths_account', 'feishu_fetch_doc']);
    expect(disposed).toBe(1);
    await resolveAgent(ctx, config, 'lark-session', '/workspace', extras);
    expect(restrictions).toHaveLength(2);
  });

  it('applies the guest workspace tools before publishing the agent catalog', async () => {
    const ctx = new Context();
    const visible: string[][] = [];
    const tools = {
      schemas: () => [{ name: 'bash' }, { name: 'read' }, { name: 'ths_account' }, { name: 'web_search' }],
      restrict: ({ allow }: { allow: string[] }) => { visible.push(allow); return () => {}; },
      guard: () => () => {},
    };
    const agent = { session: { id: 'lark-session' }, ctx: { get: () => tools } } as unknown as Agent;
    let setup: AgentSetup | undefined;
    ctx.provide('agents', {
      get: () => undefined,
      resume: async (options: { setup?: AgentSetup }) => { setup = options.setup; return { agent, dispose: async () => {} }; },
      create: vi.fn(),
    });
    await resolveAgent(ctx, { manifest: { proto: 'guest' } } as Config, 'lark-session', '/workspace');
    const prepared = await setup?.({} as never, agent);
    prepared?.commit();
    expect(visible[0]).toEqual(['bash', 'read', 'web_search']);
    expect(visible[0]).not.toContain('ths_account');
  });

  it('threads the model-selection setup through resume', async () => {
    const ctx = new Context();
    const agent = { session: { id: 'lark-session' } } as Agent;
    let captured: unknown;
    const resume = vi.fn(async (options: { setup?: unknown }) => {
      captured = options.setup;
      return { agent, dispose: async () => {} };
    });
    const create = vi.fn();
    const agents = { get: () => undefined, resume, create };
    const config = {} as Config;
    ctx.provide('agents', agents);
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'cpa', model: 'deepseek-v4-flash' }),
    });
    const registry = new ModelSelectionRegistry(vi.fn());

    await resolveAgent(ctx, config, 'lark-session', '/workspace', {
      selections: registry,
      modelOverride: () => ({ provider: 'cpa', model: 'kimi-k3' }),
    });

    expect(captured).toBeTypeOf('function');
    const prepared = await (captured as (ctx: unknown, agent: Agent) => Promise<{ commit(): void }>)(
      { effect: vi.fn() },
      { id: 'lark-session' } as unknown as Agent,
    );
    prepared.commit();
    expect(registry.ref('lark-session')?.current).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
    });
    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: 'lark-session',
      agentOptions: { provider: 'cpa', model: 'deepseek-v4-flash' },
      setup: expect.any(Function),
    });
  });

  it('mounts the default agent preset inside the resume setup', async () => {
    const ctx = new Context();
    const agent = { session: { id: 'lark-session' } } as Agent;
    let captured: unknown;
    const resume = vi.fn(async (options: { setup?: unknown }) => {
      captured = options.setup;
      return { agent, dispose: async () => {} };
    });
    ctx.provide('agents', { get: () => undefined, resume, create: vi.fn() });
    const mount = vi.fn(async () => ({ id: 'member' }));
    ctx.provide('agentPresets', { defaultId: 'member', mount });

    await resolveAgent(ctx, {} as Config, 'lark-session', '/workspace');
    expect(mount).not.toHaveBeenCalled();
    const prepared = await (captured as (ctx: unknown, agent: Agent) => Promise<unknown>)(
      {} as never,
      agent,
    );
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'member');
    expect(prepared).toEqual({ commit: expect.any(Function) });
  });

  it('records the mounted preset on newly created session metadata', async () => {
    const ctx = new Context();
    const agent = { session: { id: 'lark-session' } } as Agent;
    const resume = vi.fn(async () => {
      throw Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' });
    });
    // The create stub awaits setup (which mounts the preset) before returning,
    // mirroring agents.create()'s contract. The resolver builds meta before
    // setup runs, so the header carries cwd only; the mounted id stays
    // reconstructible from the agentPreset projection and this re-mount path.
    const create = vi.fn(async (options: { setup?: unknown; meta?: Record<string, unknown> }) => {
      await (options.setup as ((a: unknown, b: unknown) => Promise<unknown>) | undefined)?.({} as never, agent);
      return { agent, dispose: async () => {} };
    });
    ctx.provide('agents', { get: () => undefined, resume, create });
    const mount = vi.fn(async (_ctx: unknown, _id: string | undefined) => ({ id: 'member' }));
    ctx.provide('agentPresets', { defaultId: 'member', mount });

    const created = await resolveAgent(ctx, {} as Config, 'lark-session', '/workspace');
    expect(created).toBe(agent);
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'member');
    expect(create).toHaveBeenCalledWith({
      sessionId: 'lark-session',
      agentOptions: {},
      meta: { cwd: '/workspace' },
      setup: expect.any(Function),
    });
  });

  it('skips preset mounting gracefully when the presets service is absent', async () => {
    const ctx = new Context();
    const agent = { session: { id: 'lark-session' } } as Agent;
    let captured: unknown;
    const resume = vi.fn(async (options: { setup?: unknown }) => {
      captured = options.setup;
      return { agent, dispose: async () => {} };
    });
    ctx.provide('agents', { get: () => undefined, resume, create: vi.fn() });

    await resolveAgent(ctx, {} as Config, 'lark-session', '/workspace');
    const prepared = await (captured as (ctx: unknown, agent: Agent) => Promise<unknown>)(
      {} as never,
      agent,
    );
    expect(prepared).toEqual({ commit: expect.any(Function) });
  });
});
