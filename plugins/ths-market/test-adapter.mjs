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
    tools: { register: (def) => registered.set(def.name, def) },
    effect() {},
    get: () => undefined,
  };
}

const EXPECTED_TOOLS = [
  'ths_quote', 'ths_yield_curve', 'ths_klines', 'ths_search',
  'ths_level2', 'ths_market_pulse', 'ths_sec_kline', 'ths_move_detail', 'ths_margin_collateral',
  'ths_watch_add', 'ths_watch_list', 'ths_watch_update', 'ths_watch_remove',
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
  const result = await ctx.registered.get('ths_quote').execute({ securities: ['600519'] }, { agent });
  assert.deepEqual(result, { quotes: { USHA600519: { price: 1 } } });
  assert.equal(seen[0].url, '/api/tools/market/ths_quote');
  assert.deepEqual(seen[0].body, { arguments: { securities: ['600519'] } });
  assert.equal(seen[0].headers['x-api-key'], 'tok');
  assert.equal(seen[0].headers['x-ths-open-id'], 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(seen[0].headers['x-ths-app-id'], 'cli_aa6ec2fe79f89c00');
  // 每用户凭据归属：飞书身份必须带 u_xxx（问财/自选隔离依据）。
  assert.match(seen[0].headers['x-ths-user-id'] ?? '', /^u_[a-z0-9][a-z0-9_-]{1,62}$/);
  assert.equal(seen[0].headers['x-ths-session-id'], 'sess-1');
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
    () => ctx.registered.get('ths_klines').execute({ code: 'USHI1A0001', interval: 'day', count: 3 }, { agent: {} }),
    /指数历史 K 线不可用/,
  );
});

test('toolDeny/toolAllow filters registration', () => {
  const ctx = fakeCtx();
  apply(ctx, { watchServiceBaseUrl: 'http://127.0.0.1:1', watchServiceToken: 't', toolDeny: ['ths_klines', 'ths_watch_*'] });
  assert.ok(!ctx.registered.has('ths_klines'));
  assert.ok(!ctx.registered.has('ths_watch_add'));
  assert.ok(ctx.registered.has('ths_quote'));
});

test('watch add validates before calling service (big_order rejected locally)', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { watchEnabled: true, watchServiceBaseUrl: `http://127.0.0.1:${port}`, watchServiceToken: 't' });
  const tool = ctx.registered.get('ths_watch_add');
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
  const tool = ctx.registered.get('ths_watch_add');
  assert.equal(tool.parameters.properties.action, undefined);
  await assert.rejects(() => tool.execute({ code: '600519', type: 'price_above', threshold: 100, action: { side: 'buy', quantity: 100 } }, { agent: {} }), /仅支持提醒/);
});

// 回归：慢上游工具必须有专用超时。
// ths_yield_curve 走美国财政部官网，实测 TTFB 18.6s；沿用 15s 通用超时必然失败
// （2026-11-03 线上真实故障：卡片显示 ths_yield_curve 15.0s Failed）。
test('ths_yield_curve 不受通用短超时限制', async (t) => {
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
  const r = await ctx.registered.get('ths_yield_curve').execute({}, {
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
    () => ctx.registered.get('ths_quote').execute({ securities: ['600519'] }, {
      agent: { larkUser: { openId: 'ou_28b06247944a59edff3e9f059f9c154d', appId: 'cli_aa6ec2fe79f89c00' } },
    }),
    /timeout|abort/i,
  );
});
