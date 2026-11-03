import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { apply } from './index.js';

// 薄壳契约：工具注册、身份头、用户态 vs owner 路径分流、错误透传。

function fakeCtx() {
  const registered = new Map();
  return {
    registered,
    logger: { info() {}, warn() {} },
    tools: { register: (def) => registered.set(def.name, def) },
  };
}

const EXPECTED = [
  'ths_login_status', 'ths_qr_login', 'ths_list_groups',
  'ths_get_self_stocks', 'ths_add_stock', 'ths_remove_stock', 'ths_add_group',
  'ths_delete_group', 'ths_share_group', 'ths_sort_group',
];

const OU_USER = 'ou_' + 'a'.repeat(32);
const OU_OTHER = 'ou_' + 'b'.repeat(32);

function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', r)); }
function close(s) { return new Promise((r) => s.close(r)); }

function makeHub(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    handler(req, res);
  });
  return { server, seen };
}

const agent = (openId, appId = 'cli_aa6ec2fe79f89c00') => ({ larkUser: { openId, appId }, session: { header: { id: 's1' } } });

test('registers ten favorites tools with QR login only (sync_table off by default)', () => {
  const ctx = fakeCtx();
  apply(ctx, { dataHubBaseUrl: 'http://127.0.0.1:1', dataHubToken: 't' });
  assert.deepEqual([...ctx.registered.keys()].sort(), EXPECTED.sort());
  assert.ok(!ctx.registered.has('ths_sync_table'));
});

test('feishu user calls user-scoped path with X-THS-User-Id identity', async (t) => {
  const { server, seen } = makeHub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { 科技: { name: '科技', items: [] } } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${port}`, dataHubToken: 'tok', defaultAppId: 'cli_aa6ec2fe79f89c00' });
  const result = await ctx.registered.get('ths_list_groups').execute({}, { agent: agent(OU_USER) });
  assert.equal(result.status, 'ok');
  assert.equal(seen[0].url, '/api/user/favorites/groups?include_self=false');
  assert.match(seen[0].headers['x-ths-user-id'], /^u_[a-z0-9_-]+$/);
  assert.equal(seen[0].headers.authorization, 'Bearer tok');
});

test('web owner (no feishu identity) uses user-scoped path and centre maps it to owner', async (t) => {
  const { server, seen } = makeHub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { items: [] } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${port}`, dataHubToken: 'tok', defaultAppId: 'cli_x' });
  await ctx.registered.get('ths_get_self_stocks').execute({}, { agent: {} });
  // Web 也走用户态端点，不带 X-THS-User-Id；中心把它映射到 HUB_OWNER_USER_ID(军)，
  // 于是 Web 与军飞书共用同一份登录态（扫一次通两处）。
  assert.equal(seen[0].url, '/api/user/favorites/self');
  assert.equal(seen[0].headers['x-ths-user-id'], undefined);
});

test('different users resolve different u_xxx identities', async (t) => {
  const { server, seen } = makeHub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${port}`, dataHubToken: 'tok', defaultAppId: 'cli_aa6ec2fe79f89c00' });
  await ctx.registered.get('ths_list_groups').execute({}, { agent: agent(OU_USER) });
  await ctx.registered.get('ths_list_groups').execute({}, { agent: agent(OU_OTHER) });
  const idA = seen[0].headers['x-ths-user-id'];
  const idB = seen[1].headers['x-ths-user-id'];
  assert.notEqual(idA, idB);
  assert.match(idA, /^u_/);
  assert.match(idB, /^u_/);
});

test('login status uses credential-free GET with user identity', async (t) => {
  const { server, seen } = makeHub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { userid: '123' } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${port}`, dataHubToken: 'tok', defaultAppId: 'cli_aa6ec2fe79f89c00' });
  await ctx.registered.get('ths_login_status').execute({ channel: 'wencai' }, { agent: agent(OU_USER) });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/api/login/status?channel=wencai');
  assert.equal(seen[0].body, null);
  assert.equal(ctx.registered.has('ths_login'), false);
  assert.equal(ctx.registered.has('ths_password_login'), false);
  assert.match(seen[0].headers['x-ths-user-id'], /^u_/);
});

test('large favorite groups render every row with labelled columns', () => {
  const ctx = fakeCtx(); apply(ctx, {});
  const items = Array.from({ length: 170 }, (_, i) => ({ code: String(i), name: 'name'+i, price: i+1, market_abbr: 'SZ', quote_status: { status: 'available' }, quote: { price: i+1 } }));
  const rendered = ctx.registered.get('ths_list_groups').output.render({}, { status: 'ok', groups: { items: [{ name: 'group', items }] } });
  const data = JSON.parse(rendered[0].text);
  assert.equal(data.groups.items[0].rows.length, 170);
  assert.equal(data.columns[2], 'name');
  assert.equal(data.groups.items[0].rows[169][2], 'name169');
  assert.ok(rendered[0].text.length < 20000);
});

test('hub 401 surfaces re-login guidance', async (t) => {
  const { server } = makeHub(t, (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '同花顺 Cookie 未配置' }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  const port = server.address().port;
  apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${port}`, dataHubToken: 'tok', defaultAppId: 'cli_x' });
  const result = await ctx.registered.get('ths_list_groups').execute({}, { agent: {} });
  assert.match(result.error, /重新调用 ths_login/);
});

test('write tools validate input before calling hub', async (t) => {
  const ctx = fakeCtx();
  apply(ctx, { dataHubBaseUrl: 'http://127.0.0.1:1', dataHubToken: 't' });
  const add = ctx.registered.get('ths_add_stock');
  assert.deepEqual(await add.execute({ symbols: ['600519'] }, { agent: {} }), { error: '缺少分组名称' });
  assert.deepEqual(await add.execute({ group: 'g', symbols: [] }, { agent: {} }), { error: '缺少股票代码' });
  const sort = ctx.registered.get('ths_sort_group');
  assert.deepEqual(await sort.execute({ group: 'g', ordered_symbols: [] }, { agent: {} }), { error: '缺少排序后的股票代码列表' });
});

test('group count uses items length in the centre items/version envelope', async (t) => {
  const { server, seen } = makeHub(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], version: 7 } }));
  });
  await listen(server);
  t.after(() => close(server));
  const ctx = fakeCtx();
  apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${server.address().port}`, dataHubToken: 'tok', defaultAppId: 'cli_aa6ec2fe79f89c00' });
  const result = await ctx.registered.get('ths_list_groups').execute({}, { agent: agent(OU_USER) });
  assert.equal(result.count, 3);
  assert.equal(result.groups.items.length, 3);
  assert.equal(result.groups.version, 7);
  assert.match(seen[0].headers['x-ths-user-id'], /^u_/);
});

// QR 图片路径必须命中 feishu_send_image 的 isQr 契约（曾回归：qr.png 被拒）。
test('qrImagePath matches feishu_send_image isQr rule', async () => {
  const { qrImagePath } = await import('./index.js');
  for (let i = 0; i < 20; i++) {
    const p = qrImagePath();
    // 与 feishu-channel/src/tools.ts isQr 完全一致的判定。
    const isQr = p.startsWith('/tmp/openclaw-ths-qr/') && /\/qr-[a-f0-9]+\.png$/.test(p);
    assert.equal(isQr, true, `路径不合规: ${p}`);
  }
});
