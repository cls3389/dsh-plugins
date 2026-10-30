import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
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
    const commit = (captured as (ctx: unknown, agent: Agent) => { commit(): void })(
      { effect: vi.fn() },
      { id: 'lark-session' } as unknown as Agent,
    );
    commit.commit();
    expect(registry.ref('lark-session')?.current).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
    });
    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: 'lark-session',
      agentOptions: { provider: 'cpa', model: 'deepseek-v4-flash' },
      setup: captured,
    });
  });
});
