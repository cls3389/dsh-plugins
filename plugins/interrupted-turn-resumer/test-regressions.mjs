import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, resumableInterruptedEvent, recoveryAfter, SOURCE_KIND } from './main.js';

const now = Date.now();
const event = (seq, type, data = {}, time = now) => ({ seq, time, type, data });
const interrupted = (seq = 3, turn = 1) => event(seq, 'turn/end', { turn, reason: { kind: 'interrupted' } });

test('selects a terminal interrupted turn, not aborts or errors', () => {
  assert.equal(resumableInterruptedEvent([interrupted()])?.seq, 3);
  for (const kind of ['aborted', 'error', 'completed']) {
    assert.equal(resumableInterruptedEvent([event(1, 'turn/end', { turn: 1, reason: { kind } })]), undefined);
  }
});

test('uses the latest close after repeated process interruptions', () => {
  assert.equal(resumableInterruptedEvent([interrupted(), interrupted(4, 2)])?.seq, 4);
});

test('an old recovered interruption does not poison later interruptions', () => {
  const events = [
    interrupted(3, 1),
    event(4, 'turn/start', { turn: 2 }),
    event(5, 'user/message', { source: { kind: SOURCE_KIND } }),
    event(6, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    event(7, 'turn/start', { turn: 3 }),
    interrupted(8, 3),
  ];
  assert.equal(resumableInterruptedEvent(events)?.seq, 8);
});

test('rejects new turns, human replies, stale and malformed logs', () => {
  assert.equal(resumableInterruptedEvent([interrupted(), event(4, 'turn/start', { turn: 2 })]), undefined);
  assert.equal(resumableInterruptedEvent([interrupted(), event(4, 'user/message', { source: { kind: 'user' } })]), undefined);
  assert.equal(resumableInterruptedEvent([interrupted(), event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]), undefined);
  assert.equal(resumableInterruptedEvent([interrupted()], { now: now + 10, maxEventAgeMs: 1 }), undefined);
});

test('durable source and subsequent turn both prove recovery', () => {
  const accepted = event(4, 'user/message', { source: { kind: SOURCE_KIND } });
  assert.equal(recoveryAfter([interrupted(), accepted], 3), true);
  assert.equal(recoveryAfter([interrupted(), event(4, 'turn/start', { turn: 2 })], 3), true);
  assert.equal(recoveryAfter([accepted, interrupted()], 4), false);
});

function fixture(events, options = {}) {
  let store = [...events];
  const listeners = new Map();
  const sent = [];
  const agent = {
    id: 'fixture', status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) { sent.push(message); store.push(event((store.at(-1)?.seq ?? 0) + 1, 'user/message', message)); },
  };
  const observe = async () => ({ events: [...store], [Symbol.dispose]() {} });
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(setup) {
      const iterator = setup();
      iterator.next();
      return () => iterator.return();
    },
    on(name, callback) { listeners.set(name, callback); },
    agents: { get() { return agent; } },
    sessionController: { async resolveAgent() { return { agent }; } },
    sessionQuery: {
      async observeSession() { return observe(); },
    },
    sessionPersistence: { async list() { return [{ header: { id: 'fixture' }, revision: String(store.length) }]; } },
  };
  return { ctx, agent, sent, listeners, store, observe, options };
}

test('sends exactly once across live event, creation scan and repeated scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const f = fixture([interrupted()]);
    const controller = apply(f.ctx, { stateFile: join(root, 'state.json'), initialDelayMs: 100000, maxEventAgeMs: 100000 });
    await Promise.resolve();
    f.listeners.get('session/event')({ id: 'fixture' }, interrupted());
    await controller.whenIdle();
    f.listeners.get('agent/created')({ agent: f.agent, source: 'resume' });
    await controller.scan();
    await controller.scan();
    await controller.whenIdle();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].source.kind, SOURCE_KIND);
    assert.equal(controller.stats.sent, 1);
  } finally { await new Promise((resolve) => setTimeout(resolve, 10)); await rm(root, { recursive: true, force: true }); }
});

test('a second interruption has a new key and resumes once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const f = fixture([interrupted()]);
    const controller = apply(f.ctx, { stateFile: join(root, 'state.json'), initialDelayMs: 100000, maxEventAgeMs: 100000 });
    await controller.sendOnce('fixture', interrupted());
    f.store.push(event(5, 'turn/start', { turn: 2 }), event(6, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } }));
    await controller.sendOnce('fixture', f.store.at(-1));
    assert.equal(f.sent.length, 2);
  } finally { await new Promise((resolve) => setTimeout(resolve, 10)); await rm(root, { recursive: true, force: true }); }
});

test('does not race queued input or a running agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    for (const busy of ['running', 'queued']) {
      const f = fixture([interrupted()]);
      if (busy === 'running') f.agent.status = 'running';
      else f.agent.inbox.nextTurn.push({ id: 'human' });
      const controller = apply(f.ctx, { stateFile: join(root, `${busy}.json`), initialDelayMs: 100000, maxEventAgeMs: 100000 });
      await controller.sendOnce('fixture', interrupted());
      await controller.sendOnce('fixture', interrupted());
      assert.equal(f.sent.length, 0);
    }
  } finally { await new Promise((resolve) => setTimeout(resolve, 10)); await rm(root, { recursive: true, force: true }); }
});

test('crash marker reconciles from durable log without duplicate send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const stateFile = join(root, 'state.json');
    const first = fixture([interrupted()]);
    const one = apply(first.ctx, { stateFile, initialDelayMs: 100000, maxEventAgeMs: 100000 });
    await one.sendOnce('fixture', interrupted());
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    saved.records['fixture:3'].status = 'sending';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(stateFile, JSON.stringify(saved));
    const second = fixture(first.store);
    const two = apply(second.ctx, { stateFile, initialDelayMs: 100000, maxEventAgeMs: 100000 });
    await two.inspect('fixture');
    assert.equal(second.sent.length, 0);
  } finally { await new Promise((resolve) => setTimeout(resolve, 10)); await rm(root, { recursive: true, force: true }); }
});

test('lost send with sending marker retries only after log reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const stateFile = join(root, 'state.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(stateFile, JSON.stringify({ version: 1, records: { 'fixture:3': { sessionId: 'fixture', seq: 3, status: 'sending' } } }));
    const f = fixture([interrupted()]);
    const controller = apply(f.ctx, { stateFile, initialDelayMs: 100000, maxEventAgeMs: 100000 });
    await controller.inspect('fixture');
    await controller.whenIdle();
    assert.equal(f.sent.length, 1);
  } finally { await new Promise((resolve) => setTimeout(resolve, 10)); await rm(root, { recursive: true, force: true }); }
});

test('pre-send failures are retryable failures, never sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const f = fixture([interrupted()]);
    let resolves = 0;
    f.ctx.sessionController.resolveAgent = async () => {
      resolves += 1;
      if (resolves === 1) throw new Error('temporary restore failure');
      return { agent: f.agent };
    };
    const controller = apply(f.ctx, {
      stateFile: join(root, 'state.json'), initialDelayMs: 100000,
      retryDelayMs: 1, maxAttempts: 3, maxEventAgeMs: 100000,
    });
    await assert.rejects(controller.sendOnce('fixture', interrupted()), /temporary restore failure/);
    assert.equal(f.sent.length, 0);
    assert.equal(controller.state().records['fixture:3'].status, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await controller.sendOnce('fixture', interrupted());
    assert.equal(f.sent.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('foreign writer ownership is a quiet terminal skip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const f = fixture([interrupted()]);
    let resolves = 0;
    f.ctx.sessionController.resolveAgent = async () => {
      resolves += 1;
      return { error: { code: 'session/writer-held', message: 'already owned by an active write handle' } };
    };
    const controller = apply(f.ctx, { stateFile: join(root, 'state.json'), initialDelayMs: 100000, maxEventAgeMs: 100000 });
    assert.equal((await controller.sendOnce('fixture', interrupted())).action, 'external');
    await controller.sendOnce('fixture', interrupted());
    assert.equal(resolves, 1);
    assert.equal(f.sent.length, 0);
    assert.equal(controller.state().records['fixture:3'].status, 'external');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('known cross-instance session prefixes are not scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const f = fixture([interrupted()]);
    const controller = apply(f.ctx, { stateFile: join(root, 'state.json'), initialDelayMs: 100000 });
    await controller.inspect('lark-test');
    assert.equal(controller.stats.errors, 0);
    assert.equal(f.sent.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
