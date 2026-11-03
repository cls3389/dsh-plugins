/**
 * 幂等键全生命周期测试:提交 → 同 key 重放 → 按 key 查终态记录 → 撤单核销
 * 价格用跌停价(不可能成交)。这是"返回 pending 后必须对账"这条语义的实证。
 */
import { apply } from './index.js';

const API_KEY = process.env.XIADAN_KEY;
const tools = new Map();
apply({
	tools: { register: (d) => tools.set(d.name, d) },
	logger: { warn: (m) => console.error('[warn]', m), info() {} },
	on: () => () => {}, effect: (f) => f(),
}, {
	watchEnabled: false,
	xiadanApiKey: API_KEY, xiadanBaseUrl: 'http://192.168.5.11:18710',
});
const exec = { signal: new AbortController().signal };
const call = (n, a) => tools.get(n).execute(a, exec);

const B = 'http://192.168.5.11:18710';
const H = {
	Authorization: `Bearer ${API_KEY}`,
	'Content-Type': 'application/json',
};
async function rawGet(path, key) {
	const r = await fetch(`${B}${path}`, { headers: { ...H, 'X-Xiadan-Idempotency-Key': key } });
	const body = await r.json().catch(() => null);
	return { status: r.status, body };
}

const q = (await call('ths_quote', { securities: ['003021'], fields: [5, 6, 10] })).quotes['003021'];
const limitDown = Math.round(q.preClose * 0.9 * 100) / 100;
const key = `idem-probe-${Date.now().toString(36)}`;
console.log('幂等键:', key, '| 跌停价:', limitDown);

const put = await call('ths_order_submit', {
	code: '003021', side: 'buy', price: limitDown, quantity: 100, idempotency_key: key,
});
console.log('\n1) 首次提交:', JSON.stringify(put.order));

const again = await call('ths_order_submit', {
	code: '003021', side: 'buy', price: limitDown, quantity: 100, idempotency_key: key,
});
console.log('2) 同 key 重放:', JSON.stringify(again.order));

const rec = await rawGet('/api/v1/trading/orders/idempotency', key);
console.log('3) 按 key 查终态:', rec.status, JSON.stringify(rec.body?.data ?? rec.body?.error));

const cv = await call('ths_account', { kind: 'cancelable' });
const list = Object.values(cv.cancelable.result.data.order ?? {}).flat();
console.log('4) 可撤:', JSON.stringify(list.map((o) => ({ htbh: o.htbh, zqdm: o.zqdm, wtjg: o.wtjg }))));

for (const o of list) {
	const c = await call('ths_cancel_submit', { entrust_no: String(o.htbh), idempotency_key: `idem-probe-cancel-${o.htbh}` });
	console.log(`5) 撤 ${o.htbh}:`, JSON.stringify({ ok: c.cancel.ok, cancelEffective: c.cancel.cancelEffective }));
}
const cv2 = await call('ths_account', { kind: 'cancelable' });
console.log('6) 撤后剩余:', Object.values(cv2.cancelable.result.data.order ?? {}).flat().length);
