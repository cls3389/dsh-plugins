import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTreasuryCsv, readTreasuryYieldCurve, treasuryToday } from './yield-curve.js';

const fixture = 'Date,"2 Yr","10 Yr","30 Yr"\r\n10/30/2026,4.50,4.80,5.10\r\n10/29/2026,4.48,4.77,5.07\r\n07/31/2026,4.28,4.75,5.27\r\n';

test('parses official dates, quoted headers and computes daily basis-point changes', () => {
  const rows = parseTreasuryCsv(fixture);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).date, '2026-10-30');
  assert.equal(rows.at(-1).curve.find((point) => point.tenor === '10Y').ratePercent, 4.8);
});

test('selects latest publication on or before a historical date', async () => {
  const result = await readTreasuryYieldCurve({
    date: '2026-07-31', now: new Date('2026-10-31T00:00:00Z'),
    fetchImpl: async () => new Response(fixture, { status: 200 }),
  });
  assert.equal(result.yields['2Y'], 4.28);
  assert.equal(result.yields['10Y'], 4.75);
  assert.equal(result.yields['30Y'], 5.27);
  assert.equal(result.date, '2026-07-31');
  assert.equal(result.previousDate, null);
  assert.equal(result.unit, 'percent');
  assert.equal(result.frequency, 'daily_publication');
});

test('latest query defaults to the Treasury publication day, not browser timezone', async () => {
  const result = await readTreasuryYieldCurve({
    now: new Date('2026-11-01T02:00:00Z'), fetchImpl: async () => new Response(fixture),
  });
  assert.equal(result.date, '2026-10-30');
  assert.equal(result.requestedDate, null);
  assert.equal(result.changesBp['2Y'], 2);
  assert.equal(result.changesBp['10Y'], 3);
});

test('validates calendar dates and rejects future-dated fabricated queries', async () => {
  await assert.rejects(() => readTreasuryYieldCurve({ date: '2026-02-30' }), /无效日期/);
  await assert.rejects(() => readTreasuryYieldCurve({ date: '2027-01-01', now: new Date('2026-10-31Z') }), /不能晚于/);
  assert.match(treasuryToday(new Date('2026-11-01T02:00:00Z')), /^2026-10-31$/);
});
