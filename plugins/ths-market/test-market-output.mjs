import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeKlines, formatSearchResult, quoteFreshness, rankSearchItems } from './market-output.js';

const cell = (value, type = 'float') => ({ type, value });
const wire = {
  data_state: 'rows_returned', row_count: 2, segment_count: 1,
  records: [[
    { 1: cell(20261029, 'integer'), 7: cell(386), 8: cell(386.4), 9: cell(376.8), 11: cell(377.6), 13: cell(20983265), 19: cell(7981520500) },
    { 1: cell(20261030, 'integer'), 7: cell(376.4), 8: cell(387.6), 9: cell(375.2), 11: cell(383.6), 13: cell(22269954), 19: cell(8540915600) },
  ]],
};

test('K-lines expose complete compact OHLCV rows instead of wire wrappers', () => {
  const result = decodeKlines(wire, { market: 'UHKM', code: 'HK0700', interval: 'day', count: 2 });
  assert.equal(result.count, 2);
  assert.equal(result.startDate, '2026-10-29');
  assert.equal(result.endDate, '2026-10-30');
  assert.deepEqual(result.rows[1], { date: '2026-10-30', open: 376.4, high: 387.6, low: 375.2, close: 383.6, volume: 22269954, amount: 8540915600 });
  assert.equal(result.truncatedByTool, false);
  assert.ok(JSON.stringify(result).length < 800);
});

test('intraday timestamps are formatted without claiming a different timezone', () => {
  const data = { records: [[{ 1: cell(20261030103000, 'integer'), 11: cell(10) }]] };
  assert.equal(decodeKlines(data, { interval: '1m' }).rows[0].date, '2026-10-30T10:30:00+08:00');
});

test('canonical indices precede derivative products and exact stock names', () => {
  const items = [
    { code: '513300', market: 'USHJ', name: '纳斯达克ETF华夏', ths_code: 'USHJ513300' },
    { code: 'NDAQ', market: 'UNQQ', name: '纳斯达克', ths_code: 'UNQQNDAQ' },
    { code: 'CPNS', market: 'UNYN', name: '纳斯达克100结构化Alt', ths_code: 'UNYNCPNS' },
    { code: 'IXIC', market: 'UFII', name: '纳斯达克综合指数', ths_code: 'UFIIIXIC' },
  ];
  const ranked = rankSearchItems(items, '纳斯达克');
  assert.equal(ranked[0].ths_code, 'UFIIIXIC');
  assert.equal(ranked[1].ths_code, 'UNQQNDAQ');
  const output = formatSearchResult({ items, item_count: 4 }, '纳斯达克');
  assert.equal(output.items.length, 4);
  assert.equal(output.records, undefined);
});

test('quote freshness never substitutes response time for source trade time', () => {
  const freshness = quoteFreshness();
  assert.equal(freshness.sourceTimestampAvailable, false);
  assert.equal(freshness.sourceTimestamp, null);
  assert.match(freshness.note, /收到响应时间不等于行情时间/);
});
