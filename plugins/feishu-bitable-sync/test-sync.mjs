import assert from 'node:assert/strict';
import test from 'node:test';
import { intervalChanges, SyncEngine } from './sync-engine.js';
import { dateToMs } from './feishu-bitable.js';
import { createScheduler } from './scheduler.js';
import { DataCenterClient, FqgateClient } from './data-sources.js';

const RICH_FIELDS = '涨停原因[20261030]';
function richRow(code, sealMoney, continueDays = 1) {
  return {
    股票代码: code, 股票简称: `测试${code}`, [RICH_FIELDS]: '测试原因',
    '连续涨停天数[20261030]': continueDays, '涨停封单额[20261030]': sealMoney,
    '首次涨停时间[20261030]': '09:30:00', '最新涨跌幅': 10,
  };
}

function richPoolDc() {
  const stocks = Array.from({ length: 13 }, (_, i) => richRow(`00000${i + 1}.SZ`, 120000000 + i * 1000));
  const dc = new DataCenterClient({ baseUrl: 'http://unused', apiKey: 'test', logger: { warn() {} } });
  const queries = [];
  let active = 0;
  let maxActive = 0;
  dc.post = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    active--;
    return { answer: '', tables: [{ row_count: 13, rows: stocks }] };
  };
  return { dc, queries, get maxActive() { return maxActive; } };
}

test('FQGate hub client retains injected API key and sends Bearer authorization', async () => {
  let authorization = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    authorization = opts.headers.Authorization;
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await new FqgateClient({ baseUrl: 'http://hub.test', apiKey: 'test-token' }).post('/v2/market/quotes/mainland', {});
    assert.equal(authorization, 'Bearer test-token');
  } finally { globalThis.fetch = originalFetch; }
});

test('FQGate hub read retries one transient gateway timeout only', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 502 });
    return new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 });
  };
  try {
    assert.deepEqual(await new FqgateClient({ baseUrl: 'http://hub.test', apiKey: 'test' }).post('/v2/market/quotes/mainland', {}), { ok: true });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('intervalChanges computes 5/10/20-day changes with window guard', () => {
  // 21 个交易日 100..120:5 日涨跌=(120-115)/115,20 日=(120-100)/100
  const closes = Array.from({ length: 21 }, (_, i) => 100 + i);
  const changes = intervalChanges(closes);
  assert.equal(changes.size, 3);
  assert.ok(Math.abs(changes.get(5) - 5 / 115) < 1e-9);
  assert.ok(Math.abs(changes.get(20) - 20 / 100) < 1e-9);
  // 数据不足时不给窗口
  assert.equal(intervalChanges([1, 2, 3]).size, 0);
  assert.equal(intervalChanges([]).size, 0);
});

test('dateToMs produces Asia/Shanghai midnight epoch millis', () => {
  // 2026-10-30 00:00 +08:00 == 2026-10-29T16:00:00Z
  assert.equal(dateToMs('2026-10-30'), Date.UTC(2026, 9, 29, 16, 0, 0));
});

test('syncHoldings computes updates from snapshots and closes cache', async () => {
  const fields = [];
  const records = [
    { record_id: 'r1', fields: { 证券代码: '600519.SH', 现价: 1390, 涨跌幅: 0.02 } },
    { record_id: 'r2', fields: { 证券代码: '000001.SZ' } },           // 无旧值 → 全字段写入
    { record_id: 'r3', fields: { 证券代码: '999999.SH' } },           // 无行情 → 跳过
  ];
  const bitable = {
    listRecords: async () => records,
    updateRecords: async (_t, ups) => { fields.push(...ups); return ups.length; },
  };
  const fqgate = {
    snapshots: async () => ({
      '600519.SH': { thscode: '600519.SH', price: 1392.05, preClose: 1354, changePercent: 2.8102, amount: 100 },
      '000001.SZ': { thscode: '000001.SZ', price: 11.64, preClose: 11.54, changePercent: 0.8669, amount: 200 },
    }),
    historicalCloses: async () => ({
      '600519.SH': Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, close: 100 + i })),
      '000001.SZ': Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, close: 10 + i })),
    }),
  };
  const engine = new SyncEngine({
    cfg: {
      holdingsTableId: 'tbl1', codeField: '证券代码', stateDir: '/tmp/bitable-sync-test',
      fieldMap: { lastPrice: '现价', changeRatio: '涨跌幅', change5d: '5日涨跌', change10d: '10日涨跌', change20d: '20日涨跌' },
      batchDelayMs: 0,
    },
    bitable, fqgate, dc: {}, logger: { info() {}, warn() {} },
  });
  // 干净缓存目录
  const { rm, mkdir } = await import('node:fs/promises');
  await rm('/tmp/bitable-sync-test', { recursive: true, force: true });
  await mkdir('/tmp/bitable-sync-test', { recursive: true });

  const result = await engine.syncHoldings({ dryRun: false, intraday: false, todayStr: '2026-10-30' });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 2);          // r1(涨跌幅变了) + r2(全新)
  assert.equal(result.skipped, 1);          // r3
  // r1: 现价 1392.05 与旧值 1390 不同 → 更新；涨跌幅 0.028102 vs 0.02 → 更新；5/10/20 日涨跌来自重建缓存
  const r1 = fields.find((u) => u.record_id === 'r1');
  assert.ok(r1.fields.现价 > 1391);
  assert.ok(Math.abs(r1.fields.涨跌幅 - 0.0281) < 0.001);
  assert.ok(r1.fields['5日涨跌'] != null);
});

test('upsert semantics via syncSentiment detail table', async () => {
  const dateMs = dateToMs('2026-10-30');
  const existing = [
    { record_id: 'e1', fields: { 日期: dateMs, 股票代码: '001219.SZ', 类型: '涨停', 连板数: 5 } }, // 将被更新（连板数变）
    { record_id: 'e2', fields: { 日期: dateMs, 股票代码: '600202.SH', 类型: '涨停', 连板数: 2 } }, // 已不在涨停池 → 删除
  ];
  const ops = { creates: [], updates: [], deletes: [] };
  const bitable = {
    listRecords: async () => existing,
    createRecords: async (_t, rows) => { ops.creates.push(...rows); return rows.length; },
    updateRecords: async (_t, rows) => { ops.updates.push(...rows); return rows.length; },
    deleteRecords: async (_t, ids) => { ops.deletes.push(...ids); return ids.length; },
  };
  const engine = new SyncEngine({
    cfg: {
      detailTableId: 'tblD', overviewTableId: '', stateDir: '/tmp/bitable-sync-test2', batchDelayMs: 0,
      sentimentIndexCodes: {},
    },
    bitable,
    fqgate: {
      snapshots: async () => ({ '001219.SZ': { price: 19.94, preClose: 18.13, amount: 5e8, changePercent: 9.98 } }),
      historicalCloses: async () => ({}),  // 测试标的缓存必重建时返回空 → 涨跌窗口为空,不写 5/10/20 列
      indexSnapshots: async () => ({ '000001.SH': { changePercent: -1.43, turnover: 7642e8 }, '399001.SZ': { changePercent: -2.1, turnover: 4541e8 } }),
    },
    dc: {
      limitUpPoolComplete: async () => ({ '001219.SZ': { thscode: '001219.SZ', name: '青岛食品', reason: '青啤拟入主', continueDays: 6, sealMoney: 57075239, firstTime: '2026-10-30 09:30:16', changePercent: 9.98 } }),
      breakPoolComplete: async () => ({}),
      changeDistribution: async () => ({ up_num: 892, down_num: 4602, limit_up_cnt: 49, limit_down_cnt: 86, limit_up_open_board_cnt: 31 }),
      limitUpPremiumPercent: async () => -0.68,
    },
    logger: { info() {}, warn() {} },
  });
  const { rm, mkdir } = await import('node:fs/promises');
  await rm('/tmp/bitable-sync-test2', { recursive: true, force: true });
  await mkdir('/tmp/bitable-sync-test2', { recursive: true });

  const out = await engine.syncSentiment({ dryRun: false, intraday: false, todayStr: '2026-10-30' });
  assert.equal(out.detail.updated, 1);   // 001219 连板数 5→6
  assert.equal(out.detail.deleted, 1);   // 600202 消失
  assert.equal(out.detail.created, 0);
  assert.equal(ops.deletes[0], 'e2');
  assert.ok(ops.updates[0].fields.连板数 === 6);
});

test('complete pools use limit-stocks full roster and wencai only as enrichment', async () => {
  const dc = new DataCenterClient({ baseUrl: 'http://unused', apiKey: 'test', logger: { warn() {} } });
  dc.limitStocks = async () => ({
    limit_up: [{ stock: '603703', first_time: 1793323500000 }, { stock: '000001', first_time: null }],
    open_plate: [{ stock: '600202' }, { stock: '300750' }],
  });
  dc.limitUpPoolRich = async () => ({ '603703.SH': { thscode: '603703.SH', reason: '测试原因' } });
  dc.breakPoolRich = async () => ({});
  const up = await dc.limitUpPoolComplete('2026-10-30');
  const br = await dc.breakPoolComplete('2026-10-30');
  assert.deepEqual(Object.keys(up).sort(), ['000001.SZ', '603703.SH']);
  assert.deepEqual(Object.keys(br).sort(), ['300750.SZ', '600202.SH']);
  assert.equal(up['603703.SH'].reason, '测试原因');
  assert.equal(up['603703.SH'].firstTime, '2026-10-30 09:25:00');
});

test('wencai serializes concurrent callers and bisect retains open-ended high-seal tail', async () => {
  const harness = richPoolDc();
  const { dc } = harness;
  const [pool] = await Promise.all([
    dc.limitUpPoolRich('2026-10-30'),
    dc.wencai('2026-10-30 昨日涨停表现', 1),
  ]);
  assert.equal(harness.maxActive, 1, '问财请求必须串行');
  assert.equal(Object.keys(pool).length, 13, '大于 1 亿的尾部也必须保留');
});

test('scheduler fires intraday slots aligned to session start', async () => {
  const fired = [];
  let virtualNow = new Date('2026-11-02T09:14:30+08:00');
  const engine = {
    isTradingDay: async () => true,
    runAll: async (opts) => { fired.push([virtualNow.toTimeString().slice(0, 8), opts]); },
  };
  const scheduler = createScheduler({
    engine, logger: { info() {}, error() {} },
    dailyRunAt: '15:30', intradayEnabled: true, intradayIntervalMinutes: 5,
    now: () => virtualNow,
    timerImpl: () => 0,  // 禁真实 timer;测试用 tickNow 显式驱动
  });
  scheduler.start();
  // 快进虚拟时钟:9:15 槽 → 9:16(同槽不重复) → 9:20 新槽 → 15:31 全量
  for (const t of ['09:15:01', '09:16:00', '09:20:30', '15:31:00']) {
    virtualNow = new Date(`2026-11-02T${t}+08:00`);
    await scheduler.tickNow();
  }
  scheduler.stop();
  const intradayFires = fired.filter(([, o]) => o.intraday).length;
  const dailyFires = fired.filter(([, o]) => !o.intraday).length;
  assert.equal(intradayFires, 2, `盘中触发次数 ${intradayFires}（9:15 与 9:20 两个槽,9:16 同槽去重）`);
  assert.equal(dailyFires, 1, `全量触发次数 ${dailyFires}`);
});
