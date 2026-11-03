import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const name = 'turn-resumer';
const inject = ['agents', 'sessionQuery', 'sessionController', 'sessionPersistence'];
const SOURCE_KIND = 'turn-resumer';
const STREAM_ERROR_PROMPT = '上次运行因大模型上游 upstream stream interrupted 暂时中断，这是自动重试。请先核对已有回复、工具调用和文件的实际状态，避免重复执行已完成的操作，再继续完成用户上次的任务。如果存在长期 Goal，请恢复该 Goal 后继续；若仍要求人工授权，明确说明并等待授权。';
const DEFAULT_PROMPT = '继续上次任务。进程中断期间已完成重启/恢复，无需再执行任何 systemctl stop/start——如果你此前正在重启服务，视为重启已生效，只需用 systemctl status 或日志核验结果。先核对中断时工具调用和文件的实际状态，不要重复执行已完成的操作（尤其是停止或再次重启服务的命令），再继续完成剩余任务。如果存在长期 Goal，请恢复该 Goal 后继续；若它仍要求人工授权，明确说明并停下等待授权。';
// 状态文件默认落在 DSH_HOME(未设则 ~/.dsh)下,避免绑定任何特定机器的路径;
// 显式传 stateFile 配置可覆盖。
const defaultStateFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.turn-resumer-state.json');
const DEFAULTS = {
  enabled: true,
  scanIntervalMs: 30_000,
  initialDelayMs: 5_000,
  maxEventAgeMs: 86_400_000,
  maxScanSessions: 0, // 0 = scan all; persistence order is not activity order.
  maxAttempts: 3,
  retryDelayMs: 60_000,
  streamErrorSince: 0, // Optional activation cutoff; avoids retrying failures from before rollout.
  streamErrorMaxRetries: 2,
  streamErrorRetryDelayMs: 10_000,
  streamErrorPrompt: STREAM_ERROR_PROMPT,
  ignoredSessionIdPrefixes: ['lark-', 'feishu-'],
  stateFile: defaultStateFile,
  prompt: DEFAULT_PROMPT,
  // 防自循环:一次插件续接后的 turn 若再次中断(典型=续接的 agent 又停掉了宿主进程),
  // 默认不再自动续接,交给人工处理。设为 0 = 完全禁用插件自动续接。
  maxResumeChain: 1,
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

/** How many of the trailing uninterrupted chain links were opened by our own resume prompts. */
function resumeChainDepth(events, limit = 1) {
  // Count trailing turns that (a) were started by our resume message and (b) ended interrupted,
  // with no human input in between. Once a resume chain of `limit` such turns exists, the
  // interruption we are looking at is the loop-guard boundary: resuming it again would
  // re-trigger whatever killed the process last time (e.g. `systemctl stop dsh-web`).
  let depth = 0;
  let end = events.length - 1;
  while (end >= 0 && depth < limit) {
    if (events[end]?.type !== 'turn/end' || events[end].data?.reason?.kind !== 'interrupted') return depth;
    let start = end - 1;
    while (start >= 0 && events[start]?.type !== 'turn/start' && events[start]?.type !== 'turn/end') start -= 1;
    if (start < 0 || events[start].type !== 'turn/start') return depth;
    const inputs = events.slice(start + 1, end).filter((event) => event.type === 'user/message' &&
      (event.data?.source?.kind === SOURCE_KIND || event.data?.source?.kind === 'user'));
    let opener = inputs[0];
    if (!opener) {
      // Older logs/fixtures admitted the initiating message before turn/start.
      let previous = start - 1;
      while (previous >= 0 && !['user/message', 'turn/end', 'turn/start'].includes(events[previous]?.type)) previous -= 1;
      if (events[previous]?.type === 'user/message') { opener = events[previous]; start = previous; }
    }
    if (opener?.data?.source?.kind !== SOURCE_KIND || inputs.some((event) => event.data?.source?.kind === 'user')) return depth;
    depth += 1;
    end = start - 1;
  }
  return depth;
}

function isStreamError(event) {
  return event?.type === 'turn/end' && event.data?.reason?.kind === 'error' &&
    /\bupstream\s+(?:response\s+)?stream\s+(?:was\s+)?interrupted\b/i.test(event.data.reason.error?.message ?? '');
}
function recoverableEnd(event) {
  return event?.type === 'turn/end' && (event.data?.reason?.kind === 'interrupted' || isStreamError(event));
}

// Count accepted retries from the durable log, across plugin reloads and process restarts.
// A human message or a non-retryable terminal result starts a new budget.
function streamRetryDepth(events) {
  let depth = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'turn/end' && !isStreamError(event)) break;
    if (event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source?.kind === 'user' || source?.kind === undefined) break;
    if (source.kind !== SOURCE_KIND) continue; // runtime context, skills and other synthetic input.
    if (source.retryKind !== 'stream-error') break;
    depth += 1;
  }
  return depth;
}

/** Fold the latest recoverable ending and whether later input already recovered it. */
function interruptedTail(events) {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  let candidate;
  let recovered = false;
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq)) return undefined;
    if (recoverableEnd(event)) {
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
function resumableInterruptedEvent(events, { now = Date.now(), maxEventAgeMs = DEFAULTS.maxEventAgeMs, maxResumeChain = DEFAULTS.maxResumeChain, streamErrorMaxRetries = DEFAULTS.streamErrorMaxRetries, streamErrorSince = DEFAULTS.streamErrorSince } = {}) {
  const tail = interruptedTail(events);
  if (tail === undefined || tail.recovered) return undefined;
  const candidate = tail.event;
  if (!Number.isFinite(candidate.time) || now - candidate.time > maxEventAgeMs || candidate.time - now > 60_000) return undefined;
  if (isStreamError(candidate)) return candidate.time >= streamErrorSince && streamRetryDepth(events) < streamErrorMaxRetries ? candidate : undefined;
  if (maxResumeChain <= 0) return undefined; // process auto-resume disabled.
  if (resumeChainDepth(events, maxResumeChain) >= maxResumeChain) return undefined; // self-restart loop guard.
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
    maxResumeChain: supplied.maxResumeChain === 0 ? 0 : positiveInt(supplied.maxResumeChain, DEFAULTS.maxResumeChain),
    streamErrorMaxRetries: supplied.streamErrorMaxRetries === 0 ? 0 : positiveInt(supplied.streamErrorMaxRetries, DEFAULTS.streamErrorMaxRetries),
    streamErrorRetryDelayMs: positiveInt(supplied.streamErrorRetryDelayMs, DEFAULTS.streamErrorRetryDelayMs),
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
    if (isStreamError(event)) {
      const waitMs = event.time + cfg.streamErrorRetryDelayMs - Date.now();
      if (waitMs > 0) {
        // Idle Agent.cancel() emits no session event. Observe the live cancel entry
        // only while waiting, so the normal Stop action also cancels our pending retry.
        const liveAgent = ctx.agents.get(sessionId);
        const originalCancel = liveAgent?.cancel;
        let cancellation;
        const cancel = function (cause, ...args) {
          if (cause?.kind === 'user') cancellation = track(mark(key, {
            sessionId, seq: event.seq, turn: event.data.turn,
            status: 'external', outcome: 'user-cancelled',
          }));
          return originalCancel.call(this, cause, ...args);
        };
        const restore = () => { if (liveAgent?.cancel === cancel) liveAgent.cancel = originalCancel; };
        if (typeof originalCancel === 'function') liveAgent.cancel = cancel;
        lifecycle.signal.addEventListener('abort', restore, { once: true });
        try { await delay(waitMs, undefined, { signal: lifecycle.signal }); }
        catch (error) { if (!lifecycle.signal.aborted) throw error; }
        finally {
          restore();
          lifecycle.signal.removeEventListener('abort', restore);
          await cancellation;
        }
      }
      if (lifecycle.signal.aborted) return { action: 'aborted' };
    }
    const existing = state.records[key];
    if (existing?.status === 'sent' || existing?.status === 'sending' || existing?.status === 'external' ||
      existing?.status === 'failed' && (existing.attempts >= cfg.maxAttempts || existing.nextAttemptAt > Date.now())) {
      stats.skipped += 1;
      return { action: 'dedup', status: existing.status };
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'sending', attempts });
    let followupCalled = false;
    let streamRetryAttempt;
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
        fingerprints.delete(sessionId);
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
          if (isStreamError(event) && streamRetryDepth(observation.events) >= cfg.streamErrorMaxRetries) {
            await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'external', outcome: `stream-retry-limit:${cfg.streamErrorMaxRetries}`, attempts });
            return { action: 'stream-retry-limit' };
          }
          if (!isStreamError(event) && resumeChainDepth(observation.events, cfg.maxResumeChain) >= cfg.maxResumeChain) {
            // Do not auto-resume into a restart loop: the previous resume's turn got
            // interrupted again (typically by stopping the very process running this plugin).
            await mark(key, { sessionId, seq: event.seq, turn: event.data.turn, status: 'external', outcome: `resume-chain-limit:${cfg.maxResumeChain}`, attempts });
            ctx.logger.warn(`${name}: resume chain limit (${cfg.maxResumeChain}) reached for session ${sessionId}, interrupted turn ${event.data.turn}; requires human input to continue`);
            return { action: 'resume-chain-limit' };
          }
          delete state.records[key];
          await persist();
          stats.skipped += 1;
          return { action: 'stale' };
        }
        if (isStreamError(event)) streamRetryAttempt = streamRetryDepth(observation.events) + 1;
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
        content: [{ type: 'text', text: isStreamError(event) ? cfg.streamErrorPrompt : cfg.prompt }],
        source: {
          kind: SOURCE_KIND, recoveredTurn: event.data.turn, recoveredEventSeq: event.seq,
          ...(isStreamError(event) ? { retryKind: 'stream-error', retryAttempt: streamRetryAttempt } : {}),
        },
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
    const retryPending = Object.values(state.records).some((record) => record.sessionId === sessionId && record.status === 'failed' && record.attempts < cfg.maxAttempts);
    if (revision !== undefined && fingerprints.get(sessionId) === revision && !retryPending) return;
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
      state.runtime = { pluginVersion: '0.4.1', streamErrorSince: cfg.streamErrorSince, streamErrorMaxRetries: cfg.streamErrorMaxRetries, streamErrorRetryDelayMs: cfg.streamErrorRetryDelayMs, lastScanAt: stats.lastScanAt, scanned, errors: stats.errors };
      await persist();
      return { scanned };
    } finally { scanning = false; }
  }

  stateReady = readState(cfg.stateFile).then((loaded) => { state = loaded; });
  ctx.effect(function* () {
    ctx.on('session/event', (session, event) => {
      if (recoverableEnd(event)) {
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

export { apply, inject, name, resumableInterruptedEvent, recoveryAfter, resumeChainDepth, DEFAULT_PROMPT, SOURCE_KIND };
