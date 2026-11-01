/**
 * 交易时段定时器：交易日 15:30（可配）全量同步 + 盘中整分对齐同步。
 * 模型与旧 fuyao-feishu-sync scheduler 一致：算下一个触发点 sleep 到点执行，不轮询。
 */

const SESSIONS = [[9, 15, 11, 30], [13, 0, 15, 0]];
const MIN_TICK_MS = 30 * 1000;       // 唤醒粒度下限（非盘中长等待时也周期性醒来，日志可观测）
const MAX_SLEEP_MS = 6 * 3600 * 1000;

export function createScheduler({ engine, logger, dailyRunAt = '15:30', intradayEnabled = true, intradayIntervalMinutes = 5, now = () => new Date(), timerImpl = setTimeout }) {
  const [runHour, runMinute] = parseRunAt(dailyRunAt);
  let timer = null;
  let stopped = false;
  let lastDailyDate = null;
  let lastSlotKey = null;

  function inSession(d) {
    const mins = d.getHours() * 60 + d.getMinutes();
    return SESSIONS.some(([sh, sm, eh, em]) => mins >= sh * 60 + sm && mins < eh * 60 + em);
  }

  function lastSlot(d) {
    const mins = d.getHours() * 60 + d.getMinutes();
    let best = null;
    for (const [sh, sm, eh, em] of SESSIONS) {
      const start = sh * 60 + sm; const end = eh * 60 + em;
      if (mins < start) continue;
      const slotBase = start;
      const k = Math.floor((Math.min(mins, end - 1) - slotBase) / intradayIntervalMinutes);
      const slot = slotBase + k * intradayIntervalMinutes;
      if (slot <= mins && (best == null || slot > best)) best = slot;
    }
    return best;
  }

  async function tick() {
    const nowD = now();
    const dateStr = shanghaiDate(nowD);
    const isTrading = await engine.isTradingDay(dateStr).catch(() => true);

    if (isTrading && intradayEnabled && inSession(nowD)) {
      const slot = lastSlot(nowD);
      const slotKey = `${dateStr}T${slot}`;
      if (slot != null && slotKey !== lastSlotKey) {
        lastSlotKey = slotKey;
        logger.info?.(`[bitable-sync] 盘中同步触发 ${nowD.toTimeString().slice(0, 8)}`);
        await engine.runAll({ intraday: true }).catch((e) => logger.error?.(`盘中同步失败: ${e.message}`));
      }
    }

    if (isTrading && lastDailyDate !== dateStr && (nowD.getHours() * 60 + nowD.getMinutes()) >= runHour * 60 + runMinute) {
      logger.info?.('[bitable-sync] 每日全量同步触发');
      await engine.runAll({}).catch((e) => logger.error?.(`每日同步失败: ${e.message}`));
      lastDailyDate = dateStr; // 失败也标记，避免每分钟重跑；明天有全量兜底
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    let delay = MIN_TICK_MS;
    const nowD = now();
    if (!inSession(nowD) && (nowD.getHours() * 60 + nowD.getMinutes()) < runHour * 60 + runMinute - 2) {
      // 盘前长等待：睡到开盘前 10 分钟或每日同步点（取近者），封顶 6 小时
      const openMs = (9 * 60 + 5) * 60000 - (nowD.getHours() * 60 + nowD.getMinutes()) * 60000 - nowD.getSeconds() * 1000;
      const runMs = (runHour * 60 + runMinute) * 60000 - (nowD.getHours() * 60 + nowD.getMinutes()) * 60000;
      delay = Math.min(Math.max(openMs, MIN_TICK_MS), runMs > 0 ? runMs : MAX_SLEEP_MS, MAX_SLEEP_MS);
    }
    timer = timerImpl(tick, delay);
  }

  return {
    start() { if (!timer && !stopped) { logger.info?.(`[bitable-sync] 调度器启动: 每日 ${dailyRunAt}${intradayEnabled ? `, 盘中每 ${intradayIntervalMinutes} 分钟` : ''}`); schedule(); } },
    /** 测试/手动入口：立即评估一次当前时刻（跳过等待） */
    async tickNow() { await tick(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    get running() { return !stopped && timer != null; },
  };
}

function parseRunAt(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) throw new Error(`无效 dailyRunAt 配置: ${JSON.stringify(value)}，应为 HH:MM`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`无效 dailyRunAt 配置: ${value}`);
  return [h, min];
}

function shanghaiDate(d = new Date()) {
  return new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000).toISOString().slice(0, 10);
}
