/**
 * ths_order_submit / ths_cancel_submit 真实网关端到端测试(不成交的安全路径)
 *
 * 安全设计:
 *  - 所有真实委托都用"不可能成交"的价格(跌停价买入 / 涨停价卖出);
 *  - 严禁使用 riskTestMode;不使用市价语义;
 *  - 每笔委托后立刻对账 + 撤单,结束时校验可撤为空。
 */
import { apply } from './index.js';

const API_KEY = process.env.XIADAN_KEY;
if (!API_KEY) throw new Error('need XIADAN_KEY');

const tools = new Map();
const ctx = {
	tools: { register: (d) => tools.set(d.name, d) },
	logger: { warn: (m) => console.error('[warn]', m), info() {} },
	on: () => () => {},
	effect: (fn) => fn(),
};
apply(ctx, {
	watchEnabled: false,
	xiadanApiKey: API_KEY,
	xiadanBaseUrl: 'http://192.168.5.11:18710',
});
const exec = { signal: new AbortController().signal };
const call = (name, args) => tools.get(name).execute(args, exec);

const pad = (n) => String(n).padStart(2, '0');
const t = new Date();
const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
const results = [];
function record(name, detail) {
	results.push({ name, ...detail });
	console.log(`\n### ${name}`, JSON.stringify(detail, null, 1));
}

/* 0. 前置:行情定"不可能成交价",持仓定可卖量 */
const q = (await call('ths_quote', { securities: ['003021'], fields: [5, 6, 8, 9, 10, 55] })).quotes['003021'];
const pos = (await call('ths_account', { kind: 'positions' })).positions.result.data.position['003021'];
const limitDown = Math.round(q.preClose * 0.9 * 100) / 100;
const limitUp = Math.round(q.preClose * 1.1 * 100) / 100;
record('前置快照', {
	name: q.name, price: q.price, preClose: q.preClose,
	limitDown, limitUp, sellable: pos.kyye, holding: pos.gpye,
});

/* 1. 真实买入委托 @ 跌停价(不可能成交)*/
let buyKey = `e2e-buy-${stamp}`;
const buy = await call('ths_order_submit', {
	code: '003021', side: 'buy', price: limitDown, quantity: 100, idempotency_key: buyKey,
});
record('1. 买入委托 @跌停价', buy);

/* 2. 同幂等键重放(必须 replayed,不得重复下单)*/
const replay = await call('ths_order_submit', {
	code: '003021', side: 'buy', price: limitDown, quantity: 100, idempotency_key: buyKey,
});
record('2. 同 key 重放', replay);

/* 3. 对账:当日委托里能否找到这笔 */
const orders = await call('ths_account', { kind: 'orders' });
const flatOrders = [];
const dumpOrders = (node) => {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) { node.forEach(dumpOrders); return; }
	if (node.htbh || node.zqdm) flatOrders.push(node);
	Object.values(node).forEach(dumpOrders);
};
dumpOrders(orders.orders);
const mine = flatOrders.filter((o) => String(o.zqdm) === '003021');
record('3. 当日委托对账', {
	total: flatOrders.length,
	us: mine.slice(-3).map((o) => ({ htbh: o.htbh, zqdm: o.zqdm, cz: o.cz, wtjg: o.wtjg, wtsl: o.wtsl, wtzt: o.wtzt, wtsj: o.wtsj })),
});

/* 4. 可撤清单 + 撤单 */
const cv = await call('ths_account', { kind: 'cancelable' });
const cancels = cv.cancelable.result.data.order ?? {};
const pend = [];
for (const [code, list] of Object.entries(cancels)) for (const o of list ?? []) pend.push({ code, htbh: String(o.htbh) });
record('4. 可撤清单', { count: pend.length, items: pend });

if (pend.length) {
	const first = pend[0];
	const c = await call('ths_cancel_submit', { entrust_no: first.htbh, idempotency_key: `e2e-cancel-${stamp}` });
	record('5. 撤单(entrustNo)', { target: first, result: c });
	const cv2 = await call('ths_account', { kind: 'cancelable' });
	record('6. 撤后剩余可撤', { data: cv2.cancelable.result.data.order });
} else {
	record('5. 撤单', { skipped: '无可撤委托(上游已拒绝或已结束)' });
}

/* 7. 卖出路径 @ 涨停价(不成交),带 reduce_only 超量裁剪 */
const sell = await call('ths_order_submit', {
	code: '003021', side: 'sell', price: limitUp, quantity: 9999, reduce_only: true,
	idempotency_key: `e2e-sell-${stamp}`,
});
record('7. 卖出委托 @涨停价 reduce_only', sell);

/* 8. 撤单 scope=code 清理(若卖出被受理)*/
const clean = await call('ths_cancel_all', {}).catch((e) => ({ error: String(e.message) }));
record('8. 全量撤单清场', clean);

/* 9. 终态复核 */
const [finalCv, finalPos] = await Promise.all([
	call('ths_account', { kind: 'cancelable' }),
	call('ths_account', { kind: 'positions' }),
]);
const finalPend = Object.values(finalCv.cancelable.result.data.order ?? {}).flat().length;
const p = finalPos.positions.result.data.position['003021'];
record('9. 终态复核', {
	cancelableLeft: finalPend,
	holding: p.gpye, sellable: p.kyye, cost: p.cbj,
});

console.log('\n=== 汇总 ===');
console.log(JSON.stringify(results.map((r) => ({ step: r.name, summary: summarize(r) })), null, 1));

function summarize(r) {
	const o = r.order ?? r.cancel;
	if (o) return { accepted: o.accepted, pending: o.pending, ok: o.ok, orderId: o.orderId, errorCode: o.errorCode, error: o.error };
	if (r.error) return { error: r.error };
	return null;
}
