import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { apply } from './index.js';

// 薄壳契约：工具注册不变、参数透传到 /api/tools/market/<tool>、身份头注入、错误透传。

function fakeCtx() {
  const registered = new Map();
  return {
    registered,
    logger: { info() {}, warn() {} },
    tools: { register: (def) => {
      if (!def.output?.schema || typeof def.output.render !== 'function') throw new TypeError(`tool "${def.name}" must declare output { schema, render }`);
      registered.set(def.name, def);
    } },
    effect() {},
    get: () => undefined,
  };
}

const EXPECTED_TOOLS = [
  'mkt_quote', 'mkt_yield_curve', 'mkt_klines', 'mkt_kline_analysis', 'mkt_search',
  'mkt_global_futures', 'mkt_market_overview', 'mkt_etf_tracker',
  'mkt_level2', 'mkt_market_pulse', 'mkt_limit_up_pool', 'mkt_sec_kline', 'mkt_move_detail', 'mkt_margin_collateral',
  'watch_add', 'watch_list', 'watch_update', 'watch_remove',
];

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

test('registers market tools and reminder CRUD without trade actions', () => {
  const ctx = fakeCtx();
  apply(ctx, { watchServiceBaseUrl: 'http://127.0.0.1:1', watchServiceToken: 't' });
  assert.deepEqual([...ctx.registered.keys()].sort(), EXPECTED_TOOLS.sort());
});

test('market tool forwards arguments, identity and token; unwraps data', async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { quotes: { USHA600519: { price: 1 } } } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, {
    dataCenterBaseUrl: `http://127.0.0.1:${port}`, dataCenterApiKey: 'tok',
    watchServiceBaseUrl: `http://127.0.0.1:${port}`, watchServiceToken: 'tok',
  });
  const agent = { larkUser: { openId: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', appId: 'cli_aa6ec2fe79f89c00' }, session: { header: { id: 'sess-1' } } };
  const result = await ctx.registered.get('mkt_quote').execute({ securities: ['600519'] }, { agent });
  assert.deepEqual(result, { quotes: { USHA600519: { price: 1 } } });
  // 直传契约：线上路径与注册工具名一致（mkt_*），无兼容映射层。
  assert.equal(seen[0].url, '/api/tools/market/mkt_quote');
  assert.deepEqual(seen[0].body, { arguments: { securities: ['600519'] } });
  assert.equal(seen[0].headers['x-api-key'], 'tok');
  assert.equal(seen[0].headers['x-ths-open-id'], 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(seen[0].headers['x-ths-app-id'], 'cli_aa6ec2fe79f89c00');
  // 每用户凭据归属：飞书身份必须带 u_xxx（问财/自选隔离依据）。
  assert.match(seen[0].headers['x-ths-user-id'] ?? '', /^u_[a-z0-9][a-z0-9_-]{1,62}$/);
  assert.equal(seen[0].headers['x-ths-session-id'], 'sess-1');
});

test('raw klines carries the independent-analysis routing contract without calculating', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { klines: { count: 1, rows: [{ close: 2 }] } } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  apply(ctx, { dataCenterBaseUrl: `http://127.0.0.1:${server.address().port}`, dataCenterApiKey: 'tok' });
  assert.match(ctx.registered.get('mkt_klines').description, /\+08:00 偏移的北京时间，barBoundary=end/);
  assert.match(ctx.registered.get('mkt_kline_analysis').description, /分析结果保留同一时间/);
  const result = await ctx.registered.get('mkt_klines').execute({ code: '002851', interval: '5m', count: 1 }, { agent: {} });
  assert.equal(result.analysisTool, 'mkt_kline_analysis');
  assert.match(result.analysisRule, /禁止将数字抄入bash/);
  assert.equal(result.analysis, undefined);
  assert.equal(result.klines.rows.length, 1);
});

test('kline analysis uses independent API and keeps complete analysis without row duplication', async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: {
      klines: { symbol: 'USZA002851', count: 2, rows: [{ date: '2026-11-04', close: 1 }, { date: '2026-11-05', close: 2 }] },
      analysis: { bars: 2, latest: { close: 2 }, recent_bars: [{ date: '2026-11-04', close: 1 }, { date: '2026-11-05', close: 2 }] },
    } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  apply(ctx, { dataCenterBaseUrl: `http://127.0.0.1:${server.address().port}`, dataCenterApiKey: 'tok' });
  const args = { code: 'USZA002851', interval: 'day', count: 60, adjust: 'forward' };
  const result = await ctx.registered.get('mkt_kline_analysis').execute(args, { agent: {} });
  assert.equal(seen[0].url, '/api/market/kline-analysis');
  assert.deepEqual(seen[0].body, args);
  assert.equal(seen[0].headers['x-api-key'], 'tok');
  assert.equal(result.analysis.bars, 2);
  assert.equal(result.analysis.recent_bars.length, 2);
  assert.equal(result.klines.rows, undefined);
  assert.equal(result.klines.rowsOmitted, 2);
});

test('one public limit-up tool exposes concise summary and full normalized details', async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    seen.push({ path: req.url, body: JSON.parse(text), headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const full = seen.at(-1).body.detail === 'full';
    res.end(JSON.stringify({ ok: true, data: { source: 'eastmoney', enrichmentSource: 'ths_public', status: 'ok', complete: true, count: 1, statistics: { limitUpCount: 1, breakRateFormula: '炸板家数 / (涨停家数 + 炸板家数) × 100%' }, industryCounts: { source: 'eastmoney', items: [{ name: '通用设备', count: 1 }], uncategorized: 0 }, leaders: [{ code: '003033', reason: '机器人' }], ...(full ? { items: [{ code: '003033', name: '征和工业', reason: '机器人', boardType: '换手板', sealFundWan: 330.15 }] } : {}) } }));
  });
  await listen(server); t.after(() => close(server));
  const ctx = fakeCtx();
  apply(ctx, { dataCenterBaseUrl: `http://127.0.0.1:${server.address().port}`, dataCenterApiKey: 'tok' });
  const pool = ctx.registered.get('mkt_limit_up_pool');
  assert.ok(pool, 'single pool tool registered');
  assert.equal(ctx.registered.has('mkt_limit_up_reasons'), false, 'no duplicate Agent entry');
  assert.match(pool.description, /detail=summary/);
  const summary = await pool.execute({ kind: 'limit_up', date: '20261105', detail: 'summary' }, { agent: {} });
  assert.equal(summary.statistics.limitUpCount, 1);
  assert.match(summary.statistics.breakRateFormula, /炸板家数/);
  assert.equal(summary.industryCounts.items[0].name, '通用设备');
  assert.equal(summary.items, undefined);
  const full = await pool.execute({ kind: 'limit_up', date: '20261105', detail: 'full' }, { agent: {} });
  assert.equal(full.items[0].reason, '机器人');
  assert.deepEqual(seen.map((r) => r.path), ['/api/market/limit-up-pool', '/api/market/limit-up-pool']);
  const selected = await pool.execute({ kind: 'limit_up', date: '20261105', code: '003033' }, { agent: {} });
  assert.equal(selected.statistics.limitUpCount, 1);
  assert.deepEqual(seen[2].body, { kind: 'limit_up', date: '20261105', code: '003033' });
  assert.equal(pool.parameters.properties.code.pattern, '^\\d{6}$');
  assert.equal(pool.parameters.properties.industry.maxLength, 64);
  assert.equal(pool.parameters.properties.reason.maxLength, 64);
  assert.match(pool.description, /reason/);
  assert.match(pool.description, /no_data/);
  assert.match(pool.description, /resealed/);
  assert.deepEqual(seen.slice(0, 2).map((r) => r.path), ['/api/market/limit-up-pool', '/api/market/limit-up-pool']);
  assert.deepEqual(seen[0].body, { kind: 'limit_up', date: '20261105', detail: 'summary' });
  assert.equal(seen[0].headers['x-api-key'], 'tok');
  const rendered = pool.output.render({}, full).flat();
  assert.ok(rendered[0].text.includes('330.15'));
});

test('market tool surfaces hub error without wrapping', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '指数历史 K 线不可用' }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { dataCenterBaseUrl: `http://127.0.0.1:${port}`, dataCenterApiKey: 't', watchServiceBaseUrl: `http://127.0.0.1:${port}`, watchServiceToken: 't' });
  await assert.rejects(
    () => ctx.registered.get('mkt_klines').execute({ code: 'USHI1A0001', interval: 'day', count: 3 }, { agent: {} }),
    /指数历史 K 线不可用/,
  );
});

test('toolDeny/toolAllow filters registration', () => {
  const ctx = fakeCtx();
  apply(ctx, { watchServiceBaseUrl: 'http://127.0.0.1:1', watchServiceToken: 't', toolDeny: ['mkt_klines', 'watch_*'] });
  assert.ok(!ctx.registered.has('mkt_klines'));
  assert.ok(!ctx.registered.has('watch_add'));
  assert.ok(ctx.registered.has('mkt_quote'));
});

test('watch add validates before calling service (big_order rejected locally)', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { watchEnabled: true, watchServiceBaseUrl: `http://127.0.0.1:${port}`, watchServiceToken: 't' });
  const tool = ctx.registered.get('watch_add');
  await assert.rejects(
    () => tool.execute({ code: '600519', type: 'big_order', threshold: 1000000 }, { agent: {} }),
    /big_order 大单盯盘依赖/,
  );
  await assert.rejects(
    () => tool.execute({ code: '600519', type: 'price_above', threshold: -1 }, { agent: {} }),
    /threshold 必须是正数/,
  );
});

test('reminder tool does not advertise or forward trade actions', async () => {
  const ctx = fakeCtx();
  apply(ctx, { watchEnabled: true, watchServiceBaseUrl: 'http://127.0.0.1:1', watchServiceToken: 'test' });
  const tool = ctx.registered.get('watch_add');
  assert.equal(tool.parameters.properties.action, undefined);
  await assert.rejects(() => tool.execute({ code: '600519', type: 'price_above', threshold: 100, action: { side: 'buy', quantity: 100 } }, { agent: {} }), /仅支持提醒/);
});

// 回归：慢上游工具必须有专用超时。
// mkt_yield_curve 走美国财政部官网，实测 TTFB 18.6s；沿用 15s 通用超时必然失败
// （2026-11-03 线上真实故障：卡片显示 mkt_yield_curve 15.0s Failed）。
test('mkt_yield_curve 不受通用短超时限制', async (t) => {
  const server = http.createServer((req, res) => {
    // 延迟 1.5s 才响应：通用 requestTimeoutMs=300ms 会超时，yield_curve 专用 45s 不会。
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { curve: [{ tenor: '10Y' }] } }));
    }, 1500);
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  apply(ctx, {
    dataCenterBaseUrl: `http://127.0.0.1:${server.address().port}`,
    dataCenterToken: 'tok',
    requestTimeoutMs: 300,
    defaultAppId: 'cli_aa6ec2fe79f89c00',
  });
  const r = await ctx.registered.get('mkt_yield_curve').execute({}, {
    agent: { larkUser: { openId: 'ou_28b06247944a59edff3e9f059f9c154d', appId: 'cli_aa6ec2fe79f89c00' } },
  });
  assert.deepEqual(r.curve, [{ tenor: '10Y' }]);
});

// 对照：普通工具仍受通用超时约束（确认覆盖只对 yield_curve 生效）。
test('普通工具仍使用通用超时', async (t) => {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { quotes: {} } }));
    }, 1500);
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  apply(ctx, {
    dataCenterBaseUrl: `http://127.0.0.1:${server.address().port}`,
    dataCenterToken: 'tok',
    requestTimeoutMs: 300,
    defaultAppId: 'cli_aa6ec2fe79f89c00',
  });
  await assert.rejects(
    () => ctx.registered.get('mkt_quote').execute({ securities: ['600519'] }, {
      agent: { larkUser: { openId: 'ou_28b06247944a59edff3e9f059f9c154d', appId: 'cli_aa6ec2fe79f89c00' } },
    }),
    /timeout|abort/i,
  );
});
