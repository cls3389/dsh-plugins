// @dsh-friends/idle-compaction — 闲置会话自动压缩。
//
// 闲置判定是事件驱动的：任何 session host 在进程里产生的 session/event、
// agent/assistant-stream、agent/created 都会刷新对应会话的 lastActivity，
// 因此本插件对飞书 bot、Web GUI 等所有会话一视同仁。
// 巡检周期内对「闲置超过 idleMinutes 且仍常驻」的会话调用 compaction.compactNow；
// 历史不足时返回 null（安全空操作），非 resident 会话直接清理记录。
//
// 配置（profile 的 cordis.patch.yml，机器相关值不进插件）:
//   idleMinutes: 60          # 闲置阈值，<=0 关闭
//   sweepIntervalMinutes: 5  # 巡检周期（分钟，最小 1）
//   timeoutMs: 180000        # 单次压缩超时
//   dryRun: false            # 观察模式：只记日志不真压
//
// 日志走 console.error（部分 profile 的 ctx.logger.info 不落 journalctl）：
//   journalctl -u <unit> | grep idle-compaction

export const name = 'idle-compaction';

const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_SWEEP_MINUTES = 5;
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 可测试核心：不触碰 cordis，依赖全部注入。
 *
 * @param {object} options
 * @param {number}  [options.idleMinutes=60]    闲置阈值（分钟）
 * @param {boolean} [options.dryRun=false]      只记日志不真压
 * @param {number}  [options.timeoutMs=180000]  单次压缩超时
 * @param {() => number} [options.now]          时钟（测试注入）
 * @param {() => { compactNow?: Function, getAgent?: Function }} [options.resolveServices]
 * @param {(message: string) => void} [options.log]
 */
export function createIdleCompaction(options = {}) {
  const {
    idleMinutes = DEFAULT_IDLE_MINUTES,
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => Date.now(),
    resolveServices = () => ({}),
    log = (message) => console.error(`[idle-compaction] ${message}`),
  } = options;

  const lastActivity = new Map();
  const sweeping = new Set();

  const touch = (sessionId) => {
    if (typeof sessionId === 'string' && sessionId) lastActivity.set(sessionId, now());
  };

  const sweep = async () => {
    const { compactNow, getAgent } = resolveServices();
    if (typeof compactNow !== 'function' || typeof getAgent !== 'function') return;
    const cutoff = now() - idleMinutes * 60_000;
    for (const [sessionId, ts] of [...lastActivity]) {
      if (ts > cutoff || sweeping.has(sessionId)) continue;
      const agent = getAgent(sessionId);
      if (!agent) {
        // 不再常驻：清理记录，等它复活后由新事件重新计时。
        lastActivity.delete(sessionId);
        continue;
      }
      if (dryRun) {
        log(`dry-run: would compact ${sessionId} (idle ${Math.round((now() - ts) / 60_000)}min)`);
        continue;
      }
      sweeping.add(sessionId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await compactNow(agent, controller.signal, `idle-compaction-${sessionId}-${now()}`);
        if (result) {
          log(`${sessionId} shadowed ${result.shadowedSeqs?.length ?? 0} items (~${result.shadowedTokenCount ?? 0} tokens)`);
        }
      } catch (error) {
        log(`failed for ${sessionId}: ${String(error)}`);
      } finally {
        clearTimeout(timer);
        sweeping.delete(sessionId);
        // 巡检处理过即重置闲置时钟：成功/空转/失败都等下一个完整闲置窗口，
        // 避免同一会话被连续多轮巡检反复尝试。
        lastActivity.set(sessionId, now());
      }
    }
  };

  return { touch, sweep, lastActivity, sweeping };
}

export function apply(ctx, config = {}) {
  const idleMinutes = Number(config.idleMinutes ?? DEFAULT_IDLE_MINUTES);
  const sweepMinutes = Number(config.sweepIntervalMinutes ?? DEFAULT_SWEEP_MINUTES);
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const dryRun = config.dryRun === true;
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    console.error('[idle-compaction] disabled: idleMinutes <= 0');
    return;
  }

  const core = createIdleCompaction({
    idleMinutes,
    dryRun,
    timeoutMs,
    resolveServices: () => ({
      compactNow: ctx.get('compaction')?.compactNow?.bind(ctx.get('compaction')),
      getAgent: ctx.get('agents')?.get?.bind(ctx.get('agents')),
    }),
  });

  ctx.on('session/event', (session) => core.touch(session?.id));
  ctx.on('agent/assistant-stream', ({ agent }) => core.touch(agent?.session?.id));
  ctx.on('agent/created', ({ agent }) => core.touch(agent?.session?.id));

  const timer = setInterval(() => {
    void core.sweep();
  }, Math.max(1, sweepMinutes) * 60_000);
  timer.unref?.();
  console.error(`[idle-compaction] enabled: idle>${idleMinutes}min sweep=${sweepMinutes}min${dryRun ? ' (dry-run)' : ''}`);

  return () => {
    clearInterval(timer);
  };
}
