import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelCommands,
  ModelSelectionRegistry,
  type ModelsDefaultModel,
  type ModelsLlm,
} from '../src/model-selection.js';
import { SessionStore } from '../src/session-store.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek v4 Flash' },
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  { id: 'glm-5.3', name: 'GLM 5.3' },
];

const EFFORTS = ['off', 'low', 'medium', 'high', 'max'];

function llm(): ModelsLlm & { resolveCallConfig: ReturnType<typeof vi.fn> } {
  return {
    listProviders: () => [{ id: 'cpa', name: 'cpa' }],
    listModels: async () => MODELS,
    resolveCallConfig: vi.fn(async (config: { provider: string; model: string }) => config),
    resolveModelInfo: async () => ({
      reasoning: { efforts: EFFORTS.map((id) => ({ id })) },
    }),
  };
}

interface Harness {
  commands: ModelCommands;
  registry: ModelSelectionRegistry;
  sessions: SessionStore;
  defaultModel: ModelsDefaultModel & { saveSelection: ReturnType<typeof vi.fn> };
  llm: ReturnType<typeof llm>;
  sessionId: string;
}

async function harness(
  options: { llm?: ReturnType<typeof llm> } = {},
  agents = new Map<string, Agent>(),
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-models-'));
  temporary.push(directory);
  const sessions = new SessionStore(directory, directory);
  await sessions.load();
  const sessionId = sessions.get('oc_chat').sessionId;
  const registry = new ModelSelectionRegistry(vi.fn());
  const defaultModel = {
    currentSelection: () => ({ provider: 'cpa', model: 'deepseek-v4-flash' }),
    saveSelection: vi.fn(async () => {}),
  };
  const service = options.llm ?? llm();
  const commands = new ModelCommands({
    getLlm: () => service,
    getDefaultModel: () => defaultModel,
    getLiveAgent: (id) => agents.get(id),
    resolveAgent: async (id) => {
      const agent = { id } as unknown as Agent;
      agents.set(id, agent);
      return agent;
    },
    registry,
    sessions,
  });
  return { commands, registry, sessions, defaultModel, llm: service, sessionId };
}

/** Publish a live agent + selection ref the way resolveAgent's setup would. */
function publish(harness: Harness, agent: Agent & { session?: unknown }) {
  const context = { effect: vi.fn() } as never;
  const setup = harness.registry.setup(harness.sessions.overrideFor(agent.id as string)) as (
    ctx: never,
    agent: Agent,
  ) => { commit(): void };
  setup(context, agent).commit();
}

describe('model selection registry', () => {
  it('installs a ref seeded from the stored override and registers it on commit', () => {
    const install = vi.fn();
    const observed = new ModelSelectionRegistry(install);
    const agent = { id: 'lark-1' } as unknown as Agent;
    const commit = observed.setup({
      provider: 'cpa',
      model: 'kimi-k3',
      reasoningEffort: 'high',
    }) as (ctx: never, agent: Agent) => { commit(): void };
    commit({ effect: vi.fn() } as never, agent).commit();
    expect(install).toHaveBeenCalledOnce();
    expect(observed.ref('lark-1')?.current).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
      reasoningEffort: 'high',
    });
  });

  it('seeds no selection when no override is stored', () => {
    const observed = new ModelSelectionRegistry(vi.fn());
    const agent = { id: 'lark-2' } as unknown as Agent;
    const commit = observed.setup(undefined) as (ctx: never, agent: Agent) => { commit(): void };
    commit({ effect: vi.fn() } as never, agent);
    expect(observed.ref('lark-2')?.current).toBeUndefined();
  });
});

describe('/model and /effort commands', () => {
  it('switches by unique partial match, persists the override, and mirrors the default', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/model glm');
    expect(reply).toContain('cpa/glm-5.3');
    expect(h.sessions.overrideFor(h.sessionId)).toEqual({ provider: 'cpa', model: 'glm-5.3' });
    expect(h.defaultModel.saveSelection).toHaveBeenCalledOnce();
  });

  it('applies the switch to the live agent selection ref', async () => {
    const h = await harness();
    const agent = { id: h.sessionId } as unknown as Agent;
    publish(h, agent);
    await h.commands.handle('oc_chat', '/model kimi-k3');
    expect(h.registry.ref(h.sessionId)?.current).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
    });
  });

  it('rejects an ambiguous partial match with exact candidates', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/model kimi');
    expect(reply).toContain('多个模型');
    expect(reply).toContain('cpa/kimi-k3');
    expect(reply).toContain('cpa/kimi-k3.1-pro');
    expect(h.defaultModel.saveSelection).not.toHaveBeenCalled();
  });

  it('resolves provider/model routes exactly', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/model cpa/kimi-k3.1-pro');
    expect(reply).toContain('cpa/kimi-k3.1-pro');
    expect(h.sessions.overrideFor(h.sessionId)).toEqual({
      provider: 'cpa',
      model: 'kimi-k3.1-pro',
    });
  });

  it('reports unknown models with the catalog', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/model nope');
    expect(reply).toContain('未找到模型');
    expect(reply).toContain('deepseek-v4-flash');
  });

  it('surfaces route validation failures without applying anything', async () => {
    const h = await harness();
    h.llm.resolveCallConfig.mockRejectedValueOnce(new Error('no adapter for route'));
    const reply = await h.commands.handle('oc_chat', '/model glm-5.3');
    expect(reply).toContain('切换失败');
    expect(h.sessions.overrideFor(h.sessionId)).toBeUndefined();
    expect(h.defaultModel.saveSelection).not.toHaveBeenCalled();
  });

  it('reset clears the override and the live ref', async () => {
    const h = await harness();
    const agent = { id: h.sessionId } as unknown as Agent;
    publish(h, agent);
    await h.commands.handle('oc_chat', '/model glm-5.3');
    const reply = await h.commands.handle('oc_chat', '/model reset');
    expect(reply).toContain('已取消');
    expect(h.sessions.overrideFor(h.sessionId)).toBeUndefined();
    expect(h.registry.ref(h.sessionId)?.current).toBeUndefined();
  });

  it('status shows the effective model with its source', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/model');
    expect(reply).toContain('cpa/deepseek-v4-flash');
    expect(reply).toContain('全局默认');
    expect(reply).toContain('kimi-k3');
  });

  it('sets an advertised reasoning effort on the effective model', async () => {
    const h = await harness();
    const agent = { id: h.sessionId } as unknown as Agent;
    publish(h, agent);
    const reply = await h.commands.handle('oc_chat', '/effort high');
    expect(reply).toContain('high');
    expect(h.sessions.overrideFor(h.sessionId)).toEqual({
      provider: 'cpa',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    });
  });

  it('rejects efforts the model does not advertise', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/effort turbo');
    expect(reply).toContain('不是');
    expect(h.sessions.overrideFor(h.sessionId)).toBeUndefined();
  });

  it('suggests the nearest effort for a typo', async () => {
    const h = await harness();
    const reply = await h.commands.handle('oc_chat', '/effort hight');
    expect(reply).toContain('hight');
    expect(reply).toContain('是不是想输 high');
    expect(h.sessions.overrideFor(h.sessionId)).toBeUndefined();
  });

  it('falls back to gateway validation when effort metadata is unavailable', async () => {
    const bare = llm();
    bare.resolveModelInfo = async () => ({});
    const h = await harness({ llm: bare });
    const agent = { id: h.sessionId } as unknown as Agent;
    publish(h, agent);
    const reply = await h.commands.handle('oc_chat', '/effort low');
    expect(reply).toContain('已设置思考强度：low');
    expect(h.sessions.overrideFor(h.sessionId)).toEqual({
      provider: 'cpa',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'low',
    });

    bare.resolveCallConfig.mockRejectedValueOnce(
      new Error('does not support reasoning effort "turbo"'),
    );
    const rejected = await h.commands.handle('oc_chat', '/effort turbo');
    expect(rejected).toContain('设置失败');
  });

  it('keeps a compatible effort when switching models and drops it otherwise', async () => {
    const h = await harness();
    const agent = { id: h.sessionId } as unknown as Agent;
    publish(h, agent);
    await h.commands.handle('oc_chat', '/effort high');
    await h.commands.handle('oc_chat', '/model glm-5.3');
    expect(h.sessions.overrideFor(h.sessionId)).toEqual({
      provider: 'cpa',
      model: 'glm-5.3',
      reasoningEffort: 'high',
    });

    const strict = llm();
    strict.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low' }] } });
    const h2 = await harness({ llm: strict });
    const agent2 = { id: h2.sessionId } as unknown as Agent;
    publish(h2, agent2);
    // The fresh chat starts on deepseek-v4-flash with no effort override; the
    // strict catalog advertises only "low", so nothing is carried or kept.
    await h2.commands.handle('oc_chat', '/effort high');
    await h2.commands.handle('oc_chat', '/model glm-5.3');
    expect(h2.sessions.overrideFor(h2.sessionId)).toEqual({
      provider: 'cpa',
      model: 'glm-5.3',
    });
  });
});

describe('SessionStore model overrides', () => {
  it('persists overrides across save/load and keeps them through /new resets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-models-'));
    temporary.push(directory);
    const store = new SessionStore(directory, directory);
    await store.load();
    const first = store.get('oc_chat');
    store.setModel('oc_chat', { provider: 'cpa', model: 'kimi-k3', reasoningEffort: 'high' });
    await store.save();

    const restored = new SessionStore(directory, directory);
    await restored.load();
    expect(restored.overrideFor(first.sessionId)).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
      reasoningEffort: 'high',
    });

    const replacement = restored.reset('oc_chat');
    expect(replacement.model).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
      reasoningEffort: 'high',
    });
    expect(restored.overrideFor(replacement.sessionId)).toEqual({
      provider: 'cpa',
      model: 'kimi-k3',
      reasoningEffort: 'high',
    });

    restored.clearModel('oc_chat');
    expect(restored.overrideFor(replacement.sessionId)).toBeUndefined();
  });

  it('ignores malformed model fields when loading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-models-'));
    temporary.push(directory);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(directory, 'sessions.json'),
      JSON.stringify({
        oc_chat: { sessionId: 'lark-1', cwd: directory, model: { provider: 1 } },
      }),
      'utf8',
    );
    const store = new SessionStore(directory, directory);
    await store.load();
    expect(store.overrideFor('lark-1')).toBeUndefined();
  });
});
