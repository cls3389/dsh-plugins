import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginPath = process.argv[2] ?? new URL('./main.js', import.meta.url).pathname;
const pluginUrl = new URL(`file://${pluginPath}`);
const root = await mkdtemp(join(tmpdir(), 'title-keeper-test-'));
const stateFile = join(root, 'ledger.json');
let nextObservation;
let generated;
let resolveGeneration;
let toolDefinitions;
let context;

function event(seq, type, data) { return { seq, time: seq, type, data }; }
function user(seq, text) { return event(seq, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] }); }
function title(seq, text, kind = 'provider') {
  return event(seq, 'session/title', { title: text, messageSeqs: [1], source: kind === 'user' ? { kind } : { kind } });
}
function makeContext(events, llm) {
  const store = [...events];
  const persistence = { async open() { return {
    async read() { return { events: [...store], eventState: 'owned' }; },
    async append(items) { store.push(...items); }, async flush() {}, async close() {},
  }; } };
  toolDefinitions = [];
  context = {
    logger: { info() {}, warn() {} },
    effect() { return () => {}; }, get: (key) => key === 'sessionPersistence' ? persistence : undefined,
    tools: { register(def) { toolDefinitions.push(def); } },
    sessions: { get() { return undefined; }, async flush() { return true; } },
    sessionQuery: {
      async listSessions() { return [{ header: { id: 'fixture' }, live: false }]; },
      async observeSession() {
        const result = nextObservation?.();
        return { events: result ?? [...store], [Symbol.dispose]() {} };
      },
    },
    llm,
    // 测试观察读取当前快照；需要固定快照时由显式替换实现。
    get currentEvents() { return [...store]; },
  };
  return store;
}

try {
  // Multiline prose must keep only the first nonempty line, never append explanations.
  {
    const store = makeContext([user(1, '修复标题插件')], { async prepareCall() { return {
      config: {}, stream() { return (async function* () {
        yield { type: 'text-delta', text: '项目｜标题｜修复\n这是解释，不应写入标题' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(); },
    }; } });
    const { apply } = await import(`${pluginUrl.href}?multiline=${Date.now()}`);
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0 });
    const result = await toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({});
    assert.equal(result.errors, 0);
    assert.equal(store.at(-1).data.title, '项目｜标题｜修复');
  }

  // A title appended while generation is in flight must never be overwritten.
  {
    const initial = [user(1, '修复竞态'), title(2, '旧标题', 'fallback')];
    const store = makeContext(initial, { async prepareCall() { return {
      config: {}, stream() { return (async function* () {
        await new Promise((resolve) => { resolveGeneration = resolve; });
        yield { type: 'text-delta', text: 'keeper｜旧结果｜写回' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(); },
    }; } });
    const { apply } = await import(`${pluginUrl.href}?race=${Date.now()}`);
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0 });
    nextObservation = () => [...store];
    const run = toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 模拟另一条链路已经追加到同一个日志。
    store.push(title(3, '内置链路刚写入', 'provider'));
    resolveGeneration();
    const result = await run;
    assert.equal(result.updated, 0);
    assert.equal(result.items.length, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.filter((item) => item.type === 'session/title').length, 2);
  }

  console.log('PASS: multiline normalization and concurrent-title protection');

  // Every non-stop terminal response must be rejected, including partial text.
  for (const finish of ['error', 'aborted', 'tool-calls', undefined]) {
    const store = makeContext([user(1, '拒绝不完整输出')], { async prepareCall() { return {
      config: {}, stream() { return (async function* () {
        yield { type: 'text-delta', text: '不应写入' };
        if (finish) yield { type: 'finish', reason: { kind: finish } };
      })(); },
    }; } });
    const { apply } = await import(`${pluginUrl.href}?finish=${finish ?? 'none'}-${Date.now()}`);
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0 });
    const result = await toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({});
    assert.equal(result.updated, 0);
    assert.equal(store.filter((item) => item.type === 'session/title').length, 0);
    assert.equal(result.errors, 1);
  }

  // One failing generation consumes maxPerRun; do not hammer every session.
  {
    let calls = 0;
    const store = makeContext([user(1, '失败预算')], { async prepareCall() { calls++; throw new Error('gateway down'); } });
    const { apply } = await import(`${pluginUrl.href}?budget=${Date.now()}`);
    context.sessionQuery.listSessions = async () => ['a', 'b', 'c'].map((id) => ({ header: { id } }));
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0 });
    await toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({ max: 1 });
    assert.equal(calls, 1);
    assert.equal(store.length, 1);
  }

  // Route preparation must also be bounded by timeoutMs.
  {
    makeContext([user(1, '超时保护')], { prepareCall() { return new Promise(() => {}); } });
    const { apply } = await import(`${pluginUrl.href}?timeout=${Date.now()}`);
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0, timeoutMs: 20 });
    const result = await toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({});
    assert.equal(result.errors, 1);
    assert.match(result.stats.lastError, /超时/);
  }

  // Full JSON framing, not just raw messages, must respect maxInputBytes.
  {
    nextObservation = undefined;
    let requestText;
    makeContext([user(1, '背景'), user(2, 'X'.repeat(2000)), user(3, '最新主题')], { async prepareCall() { return {
      config: {}, stream(options) { requestText = options.messages[0].content[0].text; return (async function* () {
        yield { type: 'text-delta', text: '有界输入｜测试' }; yield { type: 'finish', reason: { kind: 'stop' } };
      })(); },
    }; } });
    const { apply } = await import(`${pluginUrl.href}?input=${Date.now()}`);
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0, maxInputBytes: 500 });
    const result = await toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({});
    assert.equal(result.errors, 0);
    assert.ok(Buffer.byteLength(requestText) <= 500);
    assert.ok(requestText.includes('最新主题'), requestText);
  }

  // Disposal aborts a pending generation and forbids a late commit.
  {
    nextObservation = undefined;
    const store = makeContext([user(1, '热重载取消')], { async prepareCall() { return {
      config: {}, stream() { return (async function* () {
        await new Promise((resolve) => { resolveGeneration = resolve; });
        yield { type: 'text-delta', text: '旧实例标题' }; yield { type: 'finish', reason: { kind: 'stop' } };
      })(); },
    }; } });
    const effects = [];
    context.effect = (setup) => { const dispose = setup(); effects.push(dispose); return dispose; };
    const { apply } = await import(`${pluginUrl.href}?dispose=${Date.now()}`);
    apply(context, { enabled: false, provider: 'cpa', model: 'deepseek-v4-flash', stateFile, paceMs: 0 });
    const run = toolDefinitions.find((tool) => tool.name === 'session_titles_refresh').execute({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all(effects.map((dispose) => dispose()));
    resolveGeneration();
    const result = await run;
    assert.equal(result.updated, 0);
  }
  console.log('PASS: terminal outcomes, failure budget, timeout, byte limit, disposal');
} finally {
  await rm(root, { recursive: true, force: true });
}
