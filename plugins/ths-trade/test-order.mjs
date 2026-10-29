/**
 * ths_order_submit / ths_cancel_submit 离线回归测试(mock fetch,不打真实网关)
 * 覆盖:请求体构造、camelCase 撤单字段、幂等键走 header、Intent 头、解包、业务失败抛错、参数缺失。
 */
import assert from 'node:assert/strict';
import { apply } from './index.js';

const tools = new Map();
const ctx = {
	tools: { register: (d) => tools.set(d.name, d) },
	logger: { warn() {}, info() {} },
	on: (event) => {
		assert.notEqual(event, 'tools/pre-execute', '真实交易工具不得注册审批门');
		return () => {};
	},
	effect: (fn) => fn(),
};
apply(ctx, {
	watchEnabled: false,
	xiadanApiKey: 'test-key',
	xiadanBaseUrl: 'http://xiadan.test',
});

const calls = [];
let nextResponse = () => ({ ok: true, body: { ok: true, data: { accepted: true, pending: false, orderId: '999', htbh: '2007' } } });

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
	const { ok, status = 200, body } = nextResponse();
	return { ok, status, text: async () => JSON.stringify(body) };
};

function assertLossless(v) {
	if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite: ${v}`);
	else if (Array.isArray(v)) v.forEach(assertLossless);
	else if (v && typeof v === 'object') Object.values(v).forEach(assertLossless);
}

const exec = { signal: new AbortController().signal };
const submit = tools.get('ths_order_submit');
const cancel = tools.get('ths_cancel_submit');
assert.ok(submit, 'ths_order_submit 未注册');
assert.ok(cancel, 'ths_cancel_submit 未注册');

try {
	/* 1. 买入:quantity 形态,幂等键走 header,REST body 不含幂等键 */
	calls.length = 0;
	const buy = await submit.execute(
		{ code: '003021', side: 'buy', price: 82.56, quantity: 100, idempotency_key: 'k-buy-1' }, exec);
	assert.equal(calls[0].url, 'http://xiadan.test/api/v1/trading/orders');
	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[0].headers['Authorization'], 'Bearer test-key');
	assert.equal(calls[0].headers['X-Xiadan-Intent'], 'real-trade');
	assert.equal(calls[0].headers['X-Xiadan-Idempotency-Key'], 'k-buy-1');
	assert.deepEqual(calls[0].body, { code: '003021', side: 'buy', price: 82.56, quantity: 100 });
	assert.equal(buy.order.orderId, '999');
	assertLossless(buy);

	/* 2. 买入:amount 形态 + reduce_only 透传 */
	calls.length = 0;
	await submit.execute(
		{ code: '510300', side: 'buy', price: 3.75, amount: 100000, reduce_only: true, idempotency_key: 'k-buy-2' }, exec);
	assert.deepEqual(calls[0].body, { code: '510300', side: 'buy', price: 3.75, amount: 100000, reduce_only: true });

	/* 3. 卖出:不传 quantity/amount 时不写空字段 */
	calls.length = 0;
	await submit.execute({ code: '003021', side: 'sell', price: 96.0, idempotency_key: 'k-sell-1' }, exec);
	assert.deepEqual(calls[0].body, { code: '003021', side: 'sell', price: 96.0 });

	/* 4. 撤单:entrust_no → camelCase entrustNo(历史上的 bug 点) */
	calls.length = 0;
	nextResponse = () => ({ ok: true, body: { ok: true, data: { cancelEffective: true, commandRetcode: 0 } } });
	const canceled = await cancel.execute({ entrust_no: '2007', idempotency_key: 'k-c-1' }, exec);
	assert.equal(calls[0].url, 'http://xiadan.test/api/v1/trading/cancels');
	assert.deepEqual(calls[0].body, { entrustNo: '2007' });
	assert.equal(calls[0].headers['X-Xiadan-Idempotency-Key'], 'k-c-1');
	assert.equal(canceled.cancel.cancelEffective, true);

	/* 5. 撤单:scope=code + code */
	calls.length = 0;
	await cancel.execute({ code: '003021', scope: 'code', idempotency_key: 'k-c-2' }, exec);
	assert.deepEqual(calls[0].body, { code: '003021', scope: 'code' });

	/* 6. 业务失败(HTTP200 + ok:false)必须抛错,不能当成功 */
	nextResponse = () => ({ ok: true, body: { ok: false, data: null, error: { code: 'upstream_reject', message: '涨跌停限制' } } });
	await assert.rejects(
		() => submit.execute({ code: '003021', side: 'buy', price: 82.56, quantity: 100, idempotency_key: 'k-bad-1' }, exec),
		/upstream_reject 涨跌停限制/,
	);

	/* 7. 网关 HTTP 非 2xx → 抛错带状态码 */
	nextResponse = () => ({ ok: false, status: 422, body: { ok: false, error: { message: 'quantity invalid' } } });
	await assert.rejects(
		() => submit.execute({ code: '003021', side: 'buy', price: 82.56, quantity: 0, idempotency_key: 'k-bad-2' }, exec),
		/HTTP 422/,
	);

	/* 8. 成功受理:不该被误标为未确认 */
	nextResponse = () => ({ ok: true, body: { ok: true, data: { accepted: true, pending: false, ok: true, htbh: '25' } } });
	const done = await submit.execute({ code: '003021', side: 'buy', price: 82.56, quantity: 100, idempotency_key: 'k-ok-1' }, exec);
	assert.equal(done.outcome, undefined, '成功受理不应出现 outcome 标记');
	assert.equal(done.order.htbh, '25');

	/* 9. pending + ok:false(实测上游真实返回形态)→ 必须显式标记待对账并给指引 */
	nextResponse = () => ({
		ok: true,
		body: { ok: true, data: { accepted: true, pending: true, ok: false, orderId: '', errorCode: 'upstream_no_receipt', failureCategory: 'unknown' } },
	});
	const pend = await submit.execute({ code: '003021', side: 'buy', price: 82.56, quantity: 100, idempotency_key: 'k-p-1' }, exec);
	assert.equal(pend.order.pending, true);
	assert.equal(pend.order.errorCode, 'upstream_no_receipt');
	assert.equal(pend.outcome, 'accepted_but_unconfirmed', 'pending 必须显式标记,防误判为失败重发');
	assert.match(pend.nextAction, /不得重复下单/);
	assert.match(pend.nextAction, /k-p-1/);
	assertLossless(pend);

	/* 10. 请求超时:AbortController 生效(不能无限挂) */
	globalThis.fetch = async (url, init) => new Promise((_, reject) => {
		init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
	});
	await assert.rejects(
		() => submit.execute({ code: '003021', side: 'buy', price: 82.56, quantity: 100, idempotency_key: 'k-t-1' }, exec),
		/aborted|超时|abort/i,
	);
} finally {
	globalThis.fetch = originalFetch;
}

console.log('ths-trade: order/cancel regression tests passed');
