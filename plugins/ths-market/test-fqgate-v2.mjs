import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeV2Quote, fetchV2Quotes, normalizeV2SearchItems, quoteRoute, toV2Security, v2QuoteFields, v2SecurityTarget } from './fqgate-v2.js';

const security = (market, code) => ({ market, code });

test('converts legacy THS identities to V2 without losing Hong Kong leading zeros', () => {
  assert.deepEqual(toV2Security(security('USHA', '600519')), { market: 'XSHG', code: '600519', assetType: 'equity' });
  assert.deepEqual(toV2Security(security('USHJ', '510300')), { market: 'XSHG', code: '510300', assetType: 'fund' });
  assert.deepEqual(toV2Security(security('USHI', '1A0001')), { market: 'XSHG', code: '1A0001', assetType: 'index' });
  assert.deepEqual(toV2Security(security('UHKM', 'HK0700')), { market: 'XHKG', code: '00700', assetType: 'equity' });
  assert.equal(quoteRoute(security('UHKM', 'HK0700')), '/v2/market/quotes/hong-kong');
  assert.equal(quoteRoute(security('UFII', 'IXIC')), null);
  assert.deepEqual(toV2Security(security('XSHG', '600519')), { market: 'XSHG', code: '600519', assetType: 'equity' });
});

test('routes convertible bonds through the V2 bonds endpoint', () => {
  // 2026-11-01:欧通转债 123241 曾被误投 quotes/mainland 报 HTTP 400;实测 bonds 路由可用。
  assert.deepEqual(toV2Security(security('USZB', '123241')), { market: 'XSHE', code: '123241', assetType: 'bond' });
  assert.deepEqual(toV2Security(security('USHB', '110092')), { market: 'XSHG', code: '110092', assetType: 'bond' });
  assert.equal(quoteRoute(security('USZB', '123241')), '/v2/market/quotes/bonds');
  assert.equal(quoteRoute(security('USHB', '110092')), '/v2/market/quotes/bonds');
  assert.deepEqual(v2SecurityTarget(security('USZB', '123241')), { market: 'XSHE', code: '123241' });
  // decodeV2Quote 对 bonds 返回(asset_type: bond)要还原成 USZB/USHB 前缀,与 parseSecurity 往返一致。
  const row = decodeV2Quote({ security: { market: 'XSHE', code: '123241' }, asset_type: 'bond', latest: 447, previous_close: 480.003, security_name: '欧通转债' });
  assert.equal(row.code, 'USZB123241');
  assert.equal(row.price, 447);
  assert.ok(Math.abs(row.changePercent - (447 - 480.003) / 480.003 * 100) < 0.001);
  // 搜索结果无 asset_type 时按号段归到债券市场,ths_code 可直接回传 ths_quote。
  assert.deepEqual(
    normalizeV2SearchItems({ items: [{ security: { market: 'XSHE', code: '123241' }, name: '欧通转债' }] }),
    [{ name: '欧通转债', code: '123241', market: 'USZB', ths_code: 'USZB123241' }],
  );
});

test('maps legacy field ids and standard field names', () => {
  assert.deepEqual(v2QuoteFields([5, 6, 7, 10, 13, 19, 55]), ['previous_close', 'open', 'latest', 'volume', 'transaction_amount', 'security_name']);
  assert.deepEqual(v2QuoteFields(['latest', 'change_percent']), ['latest', 'change_percent']);
  assert.throws(() => v2QuoteFields([999]), /不支持旧字段/);
});

test('keeps existing quote keys while using V2 standard fields', () => {
  const row = decodeV2Quote({ security: { market: 'XSHG', code: '600519' }, asset_type: 'equity', latest: 1392.05, previous_close: 1354, security_name: '贵州茅台' });
  assert.equal(row.code, 'USHA600519');
  assert.equal(row.price, 1392.05);
  assert.equal(row.preClose, 1354);
  assert.equal(row.name, '贵州茅台');
  assert.equal(row.changePercent, 2.8102);
  const hk = decodeV2Quote({ security: { market: 'XHKG', code: '00700' }, asset_type: 'equity', latest: 383.6 });
  assert.equal(hk.code, 'UHKMHK0700');
});

test('splits asset routes and retries single-security V2 requests without V1', async () => {
  const calls = [];
  const client = { async post(path, body) {
    calls.push({ path, body });
    if (body.securities.length > 1 && path.endsWith('/funds')) throw new Error('only one supported');
    const [target] = body.securities;
    return { code: 0, data: { items: [{ security: target, asset_type: target.code === '510300' ? 'fund' : 'equity', latest: 1 }] } };
  } };
  const rows = await fetchV2Quotes(client, [security('USHA', '600519'), security('USZA', '000001'), security('USHJ', '510300'), security('USZJ', '159915')], ['latest']);
  assert.equal(rows.length, 4);
  assert.deepEqual(calls.map((call) => call.path).sort(), ['/v2/market/quotes/funds', '/v2/market/quotes/funds', '/v2/market/quotes/mainland', '/v2/market/quotes/mainland']);
  assert.ok(calls.every((call) => call.path.startsWith('/v2/')));
});

test('does not silently fall back to V1 when a V2 security fails', async () => {
  await assert.rejects(() => fetchV2Quotes({ async post() { throw new Error('V2 unavailable'); } }, [security('USHA', '600519')], ['latest']), /V2 unavailable/);
});

test('normalizes V2 search identity to stable THS identifiers', () => {
  assert.deepEqual(normalizeV2SearchItems({ items: [{ security: { market: 'XSHG', code: '600519' }, name: '贵州茅台' }] }), [{ name: '贵州茅台', code: '600519', market: 'USHA', ths_code: 'USHA600519' }]);
});
