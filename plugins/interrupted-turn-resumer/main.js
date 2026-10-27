import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const name = 'interrupted-turn-resumer';
const inject = ['agents', 'sessionQuery', 'sessionController', 'sessionPersistence'];
const SOURCE_KIND = 'interrupted-turn-resumer';
const DEFAULT_PROMPT = '继续上次任务。先核对中断时工具调用和文件的实际状态，不要重复执行已完成的操作，再继续完成剩余任务。如果存在长期 Goal，请恢复该 Goal 后继续；若它仍要求人工授权，明确说明并停下等待授权。';
// 状态文件默认落在 DSH_HOME(未设则 ~/.dsh)下,避免绑定任何特定机器的路径;
// 显式传 stateFile 配置可覆盖。
const defaultStateFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.interrupted-turn-resumer-state.json');
const DEFAULTS = {
  enabled: true,
  scanIntervalMs: 30_000,
  initialDelayMs: 5_000,
  maxEventAgeMs: 86_400_000,
  maxScanSessions: 0, // 0 = scan all; persistence order is not activity order.
  maxAttempts: 3,
  retryDelayMs: 60_000,
  ignoredSessionIdPrefixes: ['lark-', 'feishu-'],
  stateFile: defaultStateFile,
  prompt: DEFAULT_PROMPT,
};

function keyOf(sessionId, seq) { return `${sessionId}:${seq}`; }
function ignoredSession(sessionId, cfg) {
  return cfg.ignoredSessionIdPrefixes.some((prefix) => sessionId.startsWith(prefix));
}
function externallyOwned(error) {
  return error?.code === 'session/writer-held' || /already owned by an active write handle|SessionAlreadyOwnedError/.test(error?.message ?? String(error));
}
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Fold the latest interruption and whether later input already recovered it. */
function interruptedTail(events) {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  let candidate;
  let recovered = false;
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq)) return undefined;
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted') {
      // Repeated process restarts can close the same unfinished work again.
      candidate = event;
      recovered = false;
      continue;
    }
    if (candidate === undefined || event.seq <= candidate.seq) continue;
    if (event.type === 'turn/start' || event.type === 'user/message' || event.type === 'developer/message') {
      recovered = true;
    }
    if (event.type === 'turn/end') {
      // A recovered interruption followed by a normal ending is history, not a
      // permanent poison marker. Later interruptions must be eligible again.
      candidate = undefined;
      recovered = false;
    }
  }
  return candidate === undefined ? undefined : { event: candidate, recovered };
}

/** Only a terminal interrupted turn with no subsequent input is resumable. */
function resumableInterruptedEvent(events, { now = Date.now(), maxEventAgeMs = DEFAULTS.maxEventAgeMs } = {}) {
  const tail = interruptedTail(events);
  if (tail === undefined || tail.recovered) return undefined;
  const candidate = tail.event;
  if (!Number.isFinite(candidate.time) || now - candidate.time > maxEventAgeMs || candidate.time - now > 60_000) return undefined;
  return candidate;
}

/** The durable log is the final dedup authority, including a crash after send. */
function recoveryAfter(events, seq) {
  return events.some((event) => {
    if (event.seq <= seq) return false;
    if (event.type === 'turn/start' || event.type === 'developer/message') return true;
    return event.type === 'user/message' && (
      event.data?.source?.kind === SOURCE_KIND || event.data?.source?.kind === 'user'
    );
  });
}

async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return {
      version: 1,
      records: parsed?.version === 1 && parsed.records && typeof parsed.records === 'object'
        ? Object.fromEntries(Object.entries(parsed.records).filter(([key, value]) =>
          typeof key === 'string' && value && Number.isSafeInteger(value.seq) &&
          ['sending', 'sent', 'failed', 'external'].includes(value.status)
        ).map(([key, value]) => [key, externallyOwned(value.error) ? { ...value, status: 'external', outcome: 'not-sent' } : value])) : {},
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, records: {} };
  }
}

function apply(ctx, supplied = {}) {
  const cfg = {
    ...DEFAULTS,
    ...supplied,
    scanIntervalMs: positiveInt(supplied.scanIntervalMs, DEFAULTS.scanIntervalMs),
    initialDelayMs: positiveInt(supplied.initialDelayMs, DEFAULTS.initialDelayMs),
    maxEventAgeMs: positiveInt(supplied.maxEventAgeMs, DEFAULTS.maxEventAgeMs),
    maxScanSessions: supplied.maxScanSessions === 0 ? 0 : positiveInt(supplied.maxScanSessions, DEFAULTS.maxScanSessions),
  };
  const lifecycle = new AbortController();
  const queues = new Map();
  const fingerprints = new Map();
  const jobs = new Set();
  const stats = {
    scans: 0, sent: 0, skipped: 0, errors: 0,
    lastScanAt: null, lastSent: null, lastError: null,
  };
  let state = { version: 1, records: {} };
  let stateReady;
  let stateWrite = Promise.resolve();
  let initialTimer;
  let intervalTimer;
  let scanning = false;

  function track(operation) {
    const promise = Promise.resolve(operation).catch((error) => {
      stats.errors += 1;
      stats.lastError = String(error);
      ctx.logger.warn(`${name}: ${String(error)}`);
    });
    jobs.add(promise);
    promise.finally(() => jobs.delete(promise));
    return promise;
  }

  async function persist() {
    stateWrite = stateWrite.then(async () => {
      await mkdir(dirname(cfg.stateFile), { recursive: true });
      const temporary = `${cfg.stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temporary, cfg.stateFile);
    });
    return stateWrite;
  }

  async function mark(key, record) {
    await stateReady;
    state.records[key] = { ...record, updatedAt: Date.now() };
    // Bound the durable ledger while retaining enough recent crash markers.
    const entries = Object.entries(state.records);
    if (entries.length > 2000) {
      state.records = Object.fromEntries(entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0)).slice(-2000));
    }
    await persist();
  }

  async function sendOnce(sessionId, event, expectedSeq = event.seq) {
    await stateReady;
    if (!cfg.enabled || lifecycle.signal.aborted) return { action: 'disabled' };
    if (ignoredSession(sessionId, cfg)) return { action: 'ignored-session' };
    const key = keyOf(sessionId, event.seq);
    const existing = state.records[key];
    if (existing?.status === 'sent' || existing?.status === 'sending' || existing?.status === 'external' ||
      existing?.status === 'failed' && (existing.attempts >= cfg.maxAttempts || existing.nextAttemptAt > Date.now())) {
      stats.skipped += 1;
      return { action: 'dedup', status: existing.status };
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'sending', attempts });
    let followupCalled = false;
    try {
      if (lifecycle.signal.aborted) return { action: 'aborted' };
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) {
        if (externallyOwned(resolved.error)) {
          await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'external', outcome: 'not-sent', attempts });
          stats.skipped += 1;
          return { action: 'external' };
        }
        throw new Error(resolved.error.message);
      }
      const agent = resolved.agent;
      if (agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
        delete state.records[key];
        await persist();
        stats.skipped += 1;
        return { action: agent.status === 'idle' ? 'queued-input' : 'busy' };
      }
      const observation = await ctx.sessionQuery.observeSession(sessionId, {
        projectionMode: 'none', signal: lifecycle.signal,
      });
      try {
        const current = interruptedTail(observation.events);
        if (current?.event.seq !== expectedSeq) {
          delete state.records[key];
          await persist();
          stats.skipped += 1;
          return { action: 'superseded' };
        }
        if (current.recovered || recoveryAfter(observation.events, expectedSeq)) {
          await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'sent', attempts });
          stats.skipped += 1;
          return { action: 'already-recovered' };
        }
        if (resumableInterruptedEvent(observation.events, cfg) === undefined) {
          delete state.records[key];
          await persist();
          stats.skipped += 1;
          return { action: 'stale' };
        }
      } finally {
        observation[Symbol.dispose]?.();
      }
      if (lifecycle.signal.aborted || agent.status !== 'idle') {
        delete state.records[key];
        await persist();
        return { action: 'aborted-or-busy' };
      }
      followupCalled = true;
      agent.followup({
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: cfg.prompt }],
        source: { kind: SOURCE_KIND, recoveredTurn: event.data.turn, recoveredEventSeq: event.seq },
      });
      await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'sent', attempts });
      stats.sent += 1;
      stats.lastSent = { sessionId, seq: event.seq, turn: event.data.turn, at: Date.now() };
      ctx.logger.info(`${name}: resumed session ${sessionId}, interrupted turn ${event.data.turn}`);
      return { action: 'sent', sessionId, seq: event.seq };
    } catch (error) {
      if (followupCalled) {
        await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'sent', outcome: 'uncertain', attempts, error: String(error) });
      } else {
        await mark(key, {
          sessionId, seq: event.seq, turn: event.data.turn, status: 'failed', outcome: 'not-sent', attempts,
          nextAttemptAt: Date.now() + cfg.retryDelayMs, error: String(error),
        });
      }
      throw error;
    }
  }

  function enqueue(sessionId, event) {
    if (!cfg.enabled || lifecycle.signal.aborted || event === undefined) return;
    const key = keyOf(sessionId, event.seq);
    if (queues.has(key)) return;
    const next = stateReady.then(() => sendOnce(sessionId, event));
    queues.set(key, next);
    track(next.finally(() => { if (queues.get(key) === next) queues.delete(key); }));
  }

  async function inspect(sessionId, revision) {
    await stateReady;
    if (ignoredSession(sessionId, cfg)) return;
    if (revision !== undefined && fingerprints.get(sessionId) === revision) return;
    const observation = await ctx.sessionQuery.observeSession(sessionId, {
      projectionMode: 'none', signal: lifecycle.signal,
    });
    try {
      const tail = interruptedTail(observation.events);
      if (tail !== undefined) {
        const candidate = tail.event;
        const key = keyOf(sessionId, candidate.seq);
        const record = state.records[key];
        if (tail.recovered || recoveryAfter(observation.events, candidate.seq)) {
          if (record?.status === 'sending') await mark(key, { ...record, status: 'sent' });
        } else if (resumableInterruptedEvent(observation.events, cfg) === undefined) {
          // Superseded or outside the configured age window: do not resume.
        } else if (record?.status === 'sending') {
          // No message reached the durable log: the interrupted send was lost.
          delete state.records[key];
          await persist();
          enqueue(sessionId, candidate);
        } else if (record === undefined || record.status === 'failed') enqueue(sessionId, candidate);
      }
    } finally {
      observation[Symbol.dispose]?.();
    }
    if (revision !== undefined) fingerprints.set(sessionId, revision);
  }

  async function scan() {
    await stateReady;
    if (!cfg.enabled || scanning || lifecycle.signal.aborted) return { skipped: 'disabled-or-running' };
    scanning = true;
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    let scanned = 0;
    try {
      const snapshots = await ctx.sessionPersistence.list({ signal: lifecycle.signal });
      const selected = cfg.maxScanSessions === 0 ? snapshots : snapshots.slice(0, cfg.maxScanSessions);
      for (const snapshot of selected) {
        if (lifecycle.signal.aborted) break;
        scanned += 1;
        try { await inspect(snapshot.header.id, snapshot.revision); }
        catch (error) {
          stats.errors += 1;
          stats.lastError = String(error);
          ctx.logger.warn(`${name}: scan ${snapshot.header.id}: ${String(error)}`);
        }
      }
      state.runtime = { pluginVersion: '0.2.1', lastScanAt: stats.lastScanAt, scanned, errors: stats.errors };
      await persist();
      return { scanned };
    } finally { scanning = false; }
  }

  stateReady = readState(cfg.stateFile).then((loaded) => { state = loaded; });
  ctx.effect(function* () {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted') {
        enqueue(session.id, event);
      }
    });
    ctx.on('agent/created', ({ agent, source }) => {
      if (source !== 'resume') return;
      track((async () => {
        await stateReady;
        // Recovery closers are seeded before agent/created and may not re-emit.
        await inspect(agent.id);
      })());
    });
    ctx.on('agent/disposed', ({ agent }) => { fingerprints.delete(agent.id); });
    yield () => {
      lifecycle.abort();
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, `${name}.listeners()`);

  if (cfg.enabled) {
    initialTimer = setTimeout(() => track(scan()), cfg.initialDelayMs);
    intervalTimer = setInterval(() => track(scan()), cfg.scanIntervalMs);
    initialTimer.unref?.();
    intervalTimer.unref?.();
  }

  return {
    scan, inspect, sendOnce, stats, state: () => state,
    async whenIdle() {
      while (jobs.size > 0) await Promise.all([...jobs]);
      await stateWrite;
    },
  };
}

export { apply, inject, name, resumableInterruptedEvent, recoveryAfter, DEFAULT_PROMPT, SOURCE_KIND };
