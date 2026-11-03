import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { apply, qrImagePath } from './index.js';

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function fakeCtx() {
	const registered = new Map();
	return { registered, tools: { register: (def) => registered.set(def.name, def) } };
}

/** 假数据中心：记录请求并按 handler 回应。 */
function makeHub(t, handler) {
	const seen = [];
	const server = http.createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		const entry = { url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : undefined };
		seen.push(entry);
		handler(entry, res);
	});
	t.after(() => close(server));
	return { server, seen };
}

test('注册问财独立的查询与登录工具（不与行情/自选混）', () => {
	const ctx = fakeCtx();
	apply(ctx, { dataHubBaseUrl: 'http://127.0.0.1:1', dataHubToken: 't' });
	assert.deepEqual([...ctx.registered.keys()].sort(), ['ths_wencai', 'ths_wencai_qr_login']);
});

test('缺 dataHubBaseUrl 时明确报配置错误', async () => {
	const ctx = fakeCtx();
	apply(ctx, {});
	const result = await ctx.registered.get('ths_wencai').execute({ condition: '今日涨停' }, { agent: {} });
	assert.match(result.error, /dataHubBaseUrl 未配置/);
});

test('问财查询经数据中心转发，并解开 data 信封', async (t) => {
	const { server, seen } = makeHub(t, (req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, data: { source: 'data-center', answer: '共 131 只', tables: [] } }));
	});
	await listen(server);
	const ctx = fakeCtx();
	apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${server.address().port}`, dataHubToken: 'tok' });
	const result = await ctx.registered.get('ths_wencai').execute({ condition: '今日涨停', limit: 5 }, { agent: {} });
	assert.equal(seen[0].url, '/api/tools/market/ths_wencai');
	assert.deepEqual(seen[0].body, { arguments: { condition: '今日涨停', limit: 5 } });
	assert.equal(seen[0].headers['x-api-key'], 'tok');
	assert.equal(result.answer, '共 131 只');
});

test('未登录(401) 给出问财扫码引导，不冒充系统故障', async (t) => {
	const { server } = makeHub(t, (req, res) => {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: false, error: '缺少 iwencai cookie，请先登录导入' }));
	});
	await listen(server);
	const ctx = fakeCtx();
	apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${server.address().port}`, dataHubToken: 'tok' });
	const result = await ctx.registered.get('ths_wencai').execute({ condition: '今日涨停' }, { agent: {} });
	assert.match(result.error, /缺少 iwencai cookie/);
	assert.match(result.error, /ths_wencai_qr_login/, '必须引导到问财自己的登录工具');
});

test('问财登录只打 wencai 通道（与自选登录互不影响）', async (t) => {
	const { server, seen } = makeHub(t, (req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, data: { qrid: 'q1' }, qrid: 'q1' }));
	});
	await listen(server);
	const ctx = fakeCtx();
	apply(ctx, { dataHubBaseUrl: `http://127.0.0.1:${server.address().port}`, dataHubToken: 'tok' });
	const tool = ctx.registered.get('ths_wencai_qr_login');
	// 取图步骤会因假响应失败，不影响对 start 调用的断言
	try { await tool.execute({ action: 'create' }, { agent: {} }); } catch { /* ignore */ }
	const startCall = seen.find((s) => s.url?.includes('/login/start'));
	assert.ok(startCall, '必须调用 /api/login/start');
	assert.match(startCall.url, /channel=wencai/, `问财登录必须用 wencai 通道，实际 ${startCall.url}`);
});

test('问财登录二维码路径命中 feishu_send_image 的 isQr 规则', () => {
	for (let i = 0; i < 20; i++) {
		const p = qrImagePath();
		assert.equal(p.startsWith('/tmp/openclaw-ths-qr/') && /\/qr-[a-f0-9]+\.png$/.test(p), true, `路径不合规: ${p}`);
	}
});
