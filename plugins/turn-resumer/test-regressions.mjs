import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, resumableInterruptedEvent, recoveryAfter, resumeChainDepth, SOURCE_KIND } from './main.js';

const now = Date.now();
const event = (seq, type, data = {}, time = now) => ({ seq, time, type, data });
const interrupted = (seq = 3, turn = 1) => event(seq, 'turn/end', { turn, reason: { kind: 'interrupted' } });
const streamError = (seq = 3, turn = 1, time = Date.now()) => event(seq, 'turn/end', {
  turn, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'upstream stream interrupted' } },
}, time);

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

test('a fresh human interruption is still resumable (guard does not over-block)', () => {
  // Normal case: turn opened by a human message, ended interrupted once.
  const events = [
    event(1, 'user/message', { source: { kind: 'user' } }),
    event(2, 'turn/start', { turn: 1 }),
    interrupted(3, 1),
  ];
  assert.equal(resumeChainDepth(events, 1), 0);
  assert.equal(resumableInterruptedEvent(events)?.seq, 3);
});

test('an interrupted resume turn is a loop and is not resumed again', () => {
  // Loop case: our resume message opened a turn that got interrupted again.
  const events = [
    event(1, 'user/message', { source: { kind: 'user' } }),
    event(2, 'turn/start', { turn: 1 }),
    interrupted(3, 1),
    event(4, 'user/message', { source: { kind: SOURCE_KIND } }),
    event(5, 'turn/start', { turn: 2 }),
    interrupted(6, 2),
  ];
  assert.equal(resumeChainDepth(events, 1), 1);
  assert.equal(resumableInterruptedEvent(events), undefined);
});

test('resume chain limit counts consecutive plugin-opened interruptions only', () => {
  const chain = (n) => {
    const events = [];
    let seq = 1;
    for (let turn = 1; turn <= n; turn += 1) {
      events.push(event(seq++, 'user/message', { source: { kind: turn === 1 ? 'user' : SOURCE_KIND } }));
      events.push(event(seq++, 'turn/start', { turn }));
      events.push(interrupted(seq++, turn));
    }
    return events;
  };
  // Two consecutive plugin-resumed interruptions exceed the default limit of 1.
  assert.equal(resumeChainDepth(chain(3), 1), 1);
  assert.equal(resumableInterruptedEvent(chain(3)), undefined);
  // maxResumeChain=0 disables plugin auto-resume entirely.
  assert.equal(resumableInterruptedEvent([interrupted()], { maxResumeChain: 0 }), undefined);
  // A human reply between interruptions breaks the chain: resumable again.
  const broken = [
    event(1, 'user/message', { source: { kind: 'user' } }),
    event(2, 'turn/start', { turn: 1 }),
    interrupted(3, 1),
    event(4, 'user/message', { source: { kind: SOURCE_KIND } }),
    event(5, 'turn/start', { turn: 2 }),
    interrupted(6, 2),
    event(7, 'user/message', { source: { kind: 'user' } }),
    event(8, 'turn/start', { turn: 3 }),
    interrupted(9, 3),
  ];
  assert.equal(resumeChainDepth(broken, 1), 0);
  assert.equal(resumableInterruptedEvent(broken)?.seq, 9);
});

test('restart guard handles actual turn/start then synthetic context and resume message order', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { source: { kind: 'user' } }), interrupted(3, 1),
    event(4, 'turn/start', { turn: 2 }), event(5, 'step/start'),
    event(6, 'system/message'), event(7, 'user/message', { source: { kind: SOURCE_KIND } }),
    event(8, 'user/message', { source: { kind: 'runtime-context' } }), interrupted(9, 2),
  ];
  assert.equal(resumeChainDepth(events), 1);
  assert.equal(resumableInterruptedEvent(events), undefined);
});

test('sendOnce refuses to re-enter a self-restart loop and records it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interrupted-resumer-'));
  try {
    const f = fixture([
      event(1, 'user/message', { source: { kind: 'user' } }),
      event(2, 'turn/start', { turn: 1 }),
      interrupted(3, 1),
      event(4, 'user/message', { source: { kind: SOURCE_KIND } }),
      event(5, 'turn/start', { turn: 2 }),
      interrupted(6, 2),
    ]);
    const controller = apply(f.ctx, { stateFile: join(root, 'state.json'), initialDelayMs: 100000, maxEventAgeMs: 100000 });
    const result = await controller.sendOnce('fixture', f.store.at(-1));
    assert.equal(result.action, 'resume-chain-limit');
    assert.equal(f.sent.length, 0);
    const record = controller.state().records['fixture:6'];
    assert.equal(record.status, 'external');
    assert.match(record.outcome, /resume-chain-limit/);
  } finally { await new Promise((resolve) => setTimeout(resolve, 10)); await rm(root, { recursive: true, force: true }); }
});

function fixture(events, options = {}) {
  let store = [...events];
  const listeners = new Map();
  const sent = [];
  const cleanups = [];
  const agent = {
    id: 'fixture', status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    cancel() {},
    followup(message) {
      sent.push(message);
      let seq = (store.at(-1)?.seq ?? 0) + 1;
      store.push(event(seq++, 'user/message', message));
      if (options.syntheticContext) {
        store.push(event(seq++, 'user/message', { source: { kind: 'runtime-context' } }));
        store.push(event(seq++, 'user/message', { source: { kind: 'skill' } }));
        store.push(event(seq++, 'developer/message', { source: { kind: 'tool-registry' } }));
      }
    },
  };
  const observe = async () => ({ events: [...store], [Symbol.dispose]() {} });
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(setup) {
      const iterator = setup();
      const step = iterator.next();
      const cleanup = () => { step.value?.(); iterator.return(); };
      cleanups.push(cleanup);
      return cleanup;
    },
    on(name, callback) { listeners.set(name, callback); },
    agents: { get() { return agent; } },
    sessionController: { async resolveAgent() { return { agent }; } },
    sessionQuery: {
      async observeSession() { return observe(); },
    },
    sessionPersistence: { async list() { return [{ header: { id: 'fixture' }, revision: String(store.length) }]; } },
  };
  return { ctx, agent, sent, listeners, store, observe, options, dispose() { for (const cleanup of cleanups) cleanup(); } };
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
    // maxResumeChain=2 explicitly allows one chained auto-resume; the default of 1
    // deliberately stops the chain (see the resume-chain-limit tests above).
    const controller = apply(f.ctx, { stateFile: join(root, 'state.json'), initialDelayMs: 100000, maxEventAgeMs: 100000, maxResumeChain: 2 });
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

test('stream interruption retries twice with a delay and survives reload without resetting budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stream-resumer-'));
  const stateFile = join(root, 'state.json');
  const f = fixture([
    event(1, 'user/message', { source: { kind: 'user' } }),
    event(2, 'turn/start', { turn: 1 }), streamError(),
  ], { syntheticContext: true });
  const config = { stateFile, initialDelayMs: 100000, streamErrorRetryDelayMs: 60 };
  let controller = apply(f.ctx, config);
  try {
    f.agent.status = 'running'; // turn/end is emitted before the loop becomes idle.
    const failed = f.store.at(-1);
    f.listeners.get('session/event')({ id: 'fixture' }, failed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.sent.length, 0);
    f.agent.status = 'idle';
    await controller.scan(); // overlapping live and scan paths must deduplicate.
    await controller.whenIdle();
    assert.ok(Date.now() >= failed.time + 60);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].source.retryAttempt, 1);
    assert.equal(f.sent[0].source.retryKind, 'stream-error');
    assert.match(f.sent[0].content[0].text, /大模型上游/);

    let seq = f.store.at(-1).seq + 1;
    f.store.push(event(seq++, 'turn/start', { turn: 2 }));
    const variant = streamError(seq++, 2);
    variant.data.reason.error.message = 'Upstream response stream was interrupted';
    f.store.push(variant);
    f.dispose();
    controller = apply(f.ctx, config);
    await controller.inspect('fixture');
    await controller.whenIdle();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].source.retryAttempt, 2);
    seq = f.store.at(-1).seq + 1;
    f.store.push(event(seq++, 'turn/start', { turn: 3 }), streamError(seq++, 3));
    assert.equal((await controller.sendOnce('fixture', f.store.at(-1))).action, 'stream-retry-limit');
    await controller.scan();
    await controller.whenIdle();
    assert.equal(f.sent.length, 2);

    seq = f.store.at(-1).seq + 1;
    f.store.push(event(seq++, 'user/message', { source: { kind: 'user' } }), event(seq++, 'turn/start', { turn: 4 }), streamError(seq++, 4));
    await controller.sendOnce('fixture', f.store.at(-1));
    assert.equal(f.sent.length, 3);
    assert.equal(f.sent[2].source.retryAttempt, 1);
  } finally { f.dispose(); await controller.whenIdle(); await rm(root, { recursive: true, force: true }); }
});

test('stream retries cancel on new input, stop, completion or plugin disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stream-resumer-'));
  try {
    for (const kind of ['human', 'developer', 'aborted', 'completed', 'dispose', 'queued', 'idle-cancel']) {
      const f = fixture([streamError()]);
      const controller = apply(f.ctx, { stateFile: join(root, `${kind}.json`), initialDelayMs: 100000, streamErrorRetryDelayMs: 60 });
      f.listeners.get('session/event')({ id: 'fixture' }, f.store.at(-1));
      if (kind === 'idle-cancel') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        f.agent.cancel({ kind: 'user' }, { keepInbox: true });
      }
      else if (kind === 'human') f.store.push(event(4, 'user/message', { source: { kind: 'user' } }));
      else if (kind === 'developer') f.store.push(event(4, 'developer/message'));
      else if (kind === 'dispose') f.dispose();
      else if (kind === 'queued') f.agent.inbox.nextTurn.push({ id: 'human' });
      else f.store.push(event(4, 'turn/end', { turn: 2, reason: { kind } }));
      await controller.whenIdle();
      assert.equal(f.sent.length, 0, kind);
      f.dispose();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recognizes upstream response wording and excludes unrelated interruption errors', () => {
  for (const message of [
    'upstream stream interrupted', 'Upstream response stream was interrupted',
    'Error: Upstream response stream was interrupted (connection reset)',
    'UPSTREAM RESPONSE STREAM INTERRUPTED', 'upstream stream was interrupted',
  ]) {
    const failure = streamError();
    failure.data.reason.error.message = message;
    assert.equal(resumableInterruptedEvent([failure])?.seq, 3, message);
  }
  for (const message of ['user stream interrupted', 'upstream request failed', 'response stream interrupted', 'upstream stream uninterrupted']) {
    const failure = streamError();
    failure.data.reason.error.message = message;
    assert.equal(resumableInterruptedEvent([failure]), undefined, message);
  }
});

test('only the requested stream error is retryable, with independent configuration', () => {
  assert.equal(resumableInterruptedEvent([streamError()])?.seq, 3);
  assert.equal(resumableInterruptedEvent([streamError()], { streamErrorMaxRetries: 0 }), undefined);
  assert.equal(resumableInterruptedEvent([streamError()], { streamErrorSince: Date.now() + 1000 }), undefined);
  assert.equal(resumableInterruptedEvent([streamError()], { maxResumeChain: 0 })?.seq, 3);
  const other = streamError();
  other.data.reason.error.message = 'unauthorized';
  assert.equal(resumableInterruptedEvent([other]), undefined);
  other.data.reason.kind = 'aborted';
  other.data.reason.error.message = 'upstream stream interrupted';
  assert.equal(resumableInterruptedEvent([other]), undefined);
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
