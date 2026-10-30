import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleCompaction, apply } from './index.js';

const MINUTE = 60_000;

function harness({ idleMinutes = 60, dryRun = false, resident = new Set(['s-live']), now } = {}) {
  const calls = [];
  const logs = [];
  const clock = { t: now ?? 1_000_000_000_000 };
  const core = createIdleCompaction({
    idleMinutes,
    dryRun,
    now: () => clock.t,
    resolveServices: () => ({
      compactNow: async (agent, signal, commandId) => {
        calls.push({ sessionId: agent.sessionId, commandId, signal });
        return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 12345 };
      },
      getAgent: (sessionId) => (resident.has(sessionId) ? { sessionId } : undefined),
    }),
    log: (message) => logs.push(message),
  });
  return { core, calls, logs, clock, resident };
}

test('idle resident session gets compacted exactly once per sweep', async () => {
  const h = harness();
  h.core.touch('s-live');
  h.clock.t += 61 * MINUTE;
  await h.core.sweep();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].sessionId, 's-live');
  assert.match(h.logs[0], /shadowed 3 items/);
  // 第二次巡检不重复：touch 后没有新事件
  await h.core.sweep();
  assert.equal(h.calls.length, 1);
});

test('recently active session is skipped', async () => {
  const h = harness();
  h.core.touch('s-live');
  h.clock.t += 5 * MINUTE; // 未到阈值
  await h.core.sweep();
  assert.equal(h.calls.length, 0);
});

test('non-resident session is evicted from tracking', async () => {
  const h = harness();
  h.core.touch('s-dead');
  h.clock.t += 61 * MINUTE;
  await h.core.sweep();
  assert.equal(h.calls.length, 0);
  assert.equal(h.core.lastActivity.has('s-dead'), false);
});

test('dryRun logs intent without compacting', async () => {
  const h = harness({ dryRun: true });
  h.core.touch('s-live');
  h.clock.t += 90 * MINUTE;
  await h.core.sweep();
  assert.equal(h.calls.length, 0);
  assert.match(h.logs[0], /dry-run: would compact s-live/);
});

test('compaction failure is logged and does not throw', async () => {
  const h = harness();
  const broken = createIdleCompaction({
    idleMinutes: 1,
    now: () => 2_000_000_000_000,
    resolveServices: () => ({
      compactNow: async () => { throw new Error('boom'); },
      getAgent: () => ({ sessionId: 's-x' }),
    }),
    log: (m) => { if (m.includes('failed')) throw new Error('log should not throw'); },
  });
  broken.touch('s-x');
  await assert.doesNotReject(() => broken.sweep());
});

test('touch ignores junk identifiers', () => {
  const h = harness();
  h.core.touch(undefined);
  h.core.touch('');
  h.core.touch(42);
  assert.equal(h.core.lastActivity.size, 0);
});

test('apply registers all three activity events and disposes', async () => {
  const handlers = new Map();
  const ctx = {
    on: (topic, fn) => { handlers.set(topic, fn); },
    get: (name) => (name === 'nothing' ? undefined : undefined),
  };
  const dispose = apply(ctx, { idleMinutes: 60, sweepIntervalMinutes: 1 });
  assert.equal(handlers.size, 3);
  for (const topic of ['session/event', 'agent/assistant-stream', 'agent/created']) {
    assert.ok(handlers.has(topic), topic);
  }
  // 事件刷新计时：session/event 带 id
  handlers.get('session/event')({ id: 's-evt' });
  handlers.get('agent/created')({ agent: { session: { id: 's-created' } } });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('apply with idleMinutes<=0 stays disabled and mounts nothing', () => {
  const handlers = [];
  apply({ on: (t, f) => handlers.push([t, f]) }, { idleMinutes: 0 });
  assert.equal(handlers.length, 0);
});
