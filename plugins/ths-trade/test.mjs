import assert from 'node:assert/strict';
import { apply } from './index.js';

const tools = new Map();
const ctx = {
	tools: { register: (definition) => tools.set(definition.name, definition) },
	logger: { warn() {}, info() {} },
};
apply(ctx, { watchEnabled: false });

const values = {
	5: 'USHA600519', 6: 1335, 8: 1350, 9: 1324.79, 10: 1349.98, 55: '贵州茅台',
};
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const body = JSON.parse(init.body);
	requests.push({ url, body });
	const record = Object.fromEntries(
		body.fields.map((field) => [field, { type: typeof values[field], value: values[field] }]),
	);
	return {
		ok: true,
		text: async () => JSON.stringify({ data: { row_count: 1, records: [[record]] } }),
	};
};

function assertLossless(value) {
	if (typeof value === 'number') assert.ok(Number.isFinite(value), `non-finite number: ${value}`);
	else if (Array.isArray(value)) value.forEach(assertLossless);
	else if (value && typeof value === 'object') Object.values(value).forEach(assertLossless);
}

const quote = tools.get('ths_quote');
const exec = { signal: new AbortController().signal };
try {
	const subset = await quote.execute({ securities: ['600519'], fields: [5, 6, 10, 55] }, exec);
	const subsetRow = subset.quotes['600519'];
	assert.equal(subsetRow.changePercent, 1.1221);
	assert.ok(!Object.hasOwn(subsetRow, 'amplitude'));
	assertLossless(subset);

	const full = await quote.execute({ securities: ['600519'] }, exec);
	assert.equal(full.quotes['600519'].amplitude, 1.8884);
	assertLossless(full);

	for (const fields of [[5, 6, 8, 10], [5, 6, 9, 10]]) {
		const partial = await quote.execute({ securities: ['600519'], fields }, exec);
		assert.ok(!Object.hasOwn(partial.quotes['600519'], 'amplitude'));
		assertLossless(partial);
	}
	assert.deepEqual(requests[0].body.fields, [5, 6, 10, 55]);

	values[6] = Number.POSITIVE_INFINITY;
	const invalidUpstream = await quote.execute({ securities: ['600519'], fields: [5, 6, 8, 9, 10] }, exec);
	assert.ok(!Object.hasOwn(invalidUpstream.quotes['600519'], 'changePercent'));
	assert.ok(!Object.hasOwn(invalidUpstream.quotes['600519'], 'amplitude'));
	assertLossless(invalidUpstream);
} finally {
	globalThis.fetch = originalFetch;
}

console.log('ths-trade: quote regression tests passed');
