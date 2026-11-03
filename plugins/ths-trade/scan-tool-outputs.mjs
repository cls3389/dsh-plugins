/**
 * 全工具 lossless-JSON 输出扫描(只读工具真实调用,写操作/交易类跳过)。
 * 用法: node scan-tool-outputs.mjs
 */
import assert from 'node:assert/strict';

const DC_KEY = '3FhQ0BeL6ugz6Ny7_gEJRxIgLJW_ijgN0fV9T3rzYpA';
const ST_TOKEN = '6bfdc08a8956a42385dd8c8ab840b7763fe6c868cd7e69e3bc191c919e85f7c5';

const walk = (v, path, bad) => {
	if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
	if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) bad.push(`${path} (non-finite/-0)`); return; }
	if (typeof v === 'undefined') { bad.push(`${path} (undefined)`); return; }
	if (typeof v !== 'object') { bad.push(`${path} (type=${typeof v})`); return; }
	if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, bad)); return; }
	for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, bad);
};

const { apply } = await import('./index.js');
const tools = new Map();
const ctx = {
	tools: { register: (d) => tools.set(d.name, d) },
	logger: { info: () => {}, warn: () => {} },
	on: () => () => {},
	effect: (fn) => fn(),
	sessionQuery: { listSessions: async () => [{ live: true, header: { id: 'scan' } }] },
	sessions: { flush: async () => {} },
	sessionController: { resolveAgent: async () => ({ agent: { session: { header: { id: 'scan' } }, followup: () => {} } }) },
};
apply(ctx, {
	watchEnabled: true, watchRulesFile: '/tmp/scan-watch-rules.json',
	xiadanApiKey: 'probe', xiadanBaseUrl: 'http://127.0.0.1:9', // 交易网关不可达,交易类预期 error 字段
	fqgateBaseUrl: 'http://192.168.5.111:18000',
	requestTimeoutMs: 10000,
	dataCenterBaseUrl: 'http://172.18.0.1:17890', dataCenterApiKey: DC_KEY,
	signalTraderBaseUrl: 'http://172.18.0.1:8011', signalTraderWebuiToken: ST_TOKEN,
});

// 只读探针参数(真实调用上游);写/交易/危险类跳过真实执行
const PROBES = {
	ths_quote: { securities: ['600519', '003021'] },
	ths_klines: { code: '600519', interval: 'day', count: 3 },
	ths_search: { pattern: '贵州茅台' },
	ths_wencai: { condition: '今日涨停且量比大于2的股票', limit: 3 },
	ths_level2: { kind: 'depth', code: '600519' },
	ths_market_pulse: {},
	ths_sec_kline: { market: 'SZ', code: '003021', time_period: 'sec_5', count: 3 },
	ths_move_detail: {},
	ths_fav_list_groups: {},
	ths_fav_get_self: {},
	ths_signal_status: {},
	ths_signal_explain: { limit: 2 },
	ths_watch_list: {},
};
const SKIP = new Set([
	// 真实资金/写操作,不探测
	'ths_account', 'ths_order_submit', 'ths_cancel_submit', 'ths_cancel_all',
	'ths_fav_add_group', 'ths_fav_delete_group', 'ths_fav_add_stock',
	'ths_fav_remove_stock', 'ths_fav_sort_group', 'ths_fav_share_group',
	'ths_signal_send', 'ths_watch_add', 'ths_watch_remove',
]);

const results = [];
for (const [name, def] of tools) {
	if (SKIP.has(name)) { results.push({ name, skipped: 'write/trade' }); continue; }
	const probe = PROBES[name] ?? {};
	try {
		const out = await def.execute(probe, {});
		const bad = [];
		walk(out, name, bad);
		results.push({ name, ok: bad.length === 0, bad: bad.slice(0, 8), keys: Object.keys(out ?? {}).slice(0, 6) });
	} catch (e) {
		// 工具执行抛错(如网关拒绝)本身是合法错误路径;但错误信息也要 lossless 可序列化
		results.push({ name, execError: String(e?.message ?? e).slice(0, 120) });
	}
}

for (const r of results) {
	if (r.skipped) console.log(`SKIP  ${r.name} (${r.skipped})`);
	else if (r.execError) console.log(`ERR   ${r.name}: ${r.execError}`);
	else if (r.ok) console.log(`OK    ${r.name} keys=[${r.keys.join(',')}]`);
	else console.log(`BAD!! ${r.name}: ${JSON.stringify(r.bad)}`);
}
const badCount = results.filter((r) => r.bad?.length).length;
console.log(`\n=== ${results.length} 工具: ${results.filter(r=>r.ok).length} OK, ${badCount} BAD(输出含非法字段), ${results.filter(r=>r.skipped).length} 跳过, ${results.filter(r=>r.execError).length} 执行错误 ===`);
process.exit(badCount ? 1 : 0);
