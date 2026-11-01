import assert from 'node:assert/strict';
import test from 'node:test';
import { dataCenterKlineOptions, decodeDataCenterKlines } from './data-center-klines.js';

test('data-center minute options preserve market and require forward adjustment', () => {
  assert.deepEqual(dataCenterKlineOptions({ market: 'USHA', code: '600519' }, '120m', 'forward'), { market: 'SH', code: '600519', time_period: 'min_120', adjust_type: 'forward' });
  assert.throws(() => dataCenterKlineOptions({ market: 'USHA', code: '600519' }, '1m', 'None'), /仅支持 forward/);
  assert.throws(() => dataCenterKlineOptions({ market: 'UHKM', code: 'HK0700' }, '1m', 'forward'), /仅支持沪深北/);
});

test('data-center decodes ordered fields and UTC millisecond timestamps', () => {
  const result = decodeDataCenterKlines({ quote_data: [{ data_fields: ['1', '7', '8', '9', '11', '13', '19'], value: [[1793343480000, 1389.15, 1389.15, 1389.15, 1389.15, 500, 694400]] }] }, { symbol: 'USHA600519', interval: '1m', count: 1 });
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].close, 1389.15);
  assert.equal(result.rows[0].date, '2026-10-30T06:58:00.000Z');
  assert.equal(result.rows[0].amount, 694400);
  assert.equal(result.upstream.source, 'ths-data-center');
});
