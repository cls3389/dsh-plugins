import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSecurity } from './index.js';

test('parses ths_search index identifiers without misclassifying them as stocks', () => {
  assert.deepEqual(parseSecurity('USHI1A0001'), { market: 'USHI', code: '1A0001' });
  assert.deepEqual(parseSecurity('USZI399001'), { market: 'USZI', code: '399001' });
  assert.deepEqual(parseSecurity('USZI399006'), { market: 'USZI', code: '399006' });
  assert.deepEqual(parseSecurity('ushi1a0001'), { market: 'USHI', code: '1A0001' });
  assert.deepEqual(parseSecurity('SHI1A0001'), { market: 'USHI', code: '1A0001' });
  assert.deepEqual(parseSecurity('SZI399001'), { market: 'USZI', code: '399001' });
  assert.deepEqual(parseSecurity('USHI1B0688'), { market: 'USHI', code: '1B0688' });
  assert.deepEqual(parseSecurity('USHI1B0016'), { market: 'USHI', code: '1B0016' });
  assert.deepEqual(parseSecurity('USHI1B0300'), { market: 'USHI', code: '1B0300' });
});

test('preserves explicit stock and ETF markets', () => {
  assert.deepEqual(parseSecurity('SZ000001'), { market: 'USZA', code: '000001' });
  assert.deepEqual(parseSecurity('SH600519'), { market: 'USHA', code: '600519' });
  assert.deepEqual(parseSecurity('600519'), { market: 'USHA', code: '600519' });
  assert.deepEqual(parseSecurity('300870'), { market: 'USZA', code: '300870' });
  assert.deepEqual(parseSecurity('510300'), { market: 'USHJ', code: '510300' });
  assert.deepEqual(parseSecurity('159915'), { market: 'USZJ', code: '159915' });
  assert.deepEqual(parseSecurity('USHA600519'), { market: 'USHA', code: '600519' });
});

test('disambiguates exchange aliases from explicitly named stock markets', () => {
  assert.deepEqual(parseSecurity('SH000001'), { market: 'USHI', code: '1A0001' });
  assert.deepEqual(parseSecurity('SH000016'), { market: 'USHI', code: '1B0016' });
  assert.deepEqual(parseSecurity('SH000300'), { market: 'USHI', code: '1B0300' });
  assert.deepEqual(parseSecurity('SH000688'), { market: 'USHI', code: '1B0688' });
  assert.deepEqual(parseSecurity('USHA000688'), { market: 'USHA', code: '000688' });
  assert.deepEqual(parseSecurity('USZA000688'), { market: 'USZA', code: '000688' });
  assert.deepEqual(parseSecurity('000688'), { market: 'USHI', code: '1B0688' });
  assert.deepEqual(parseSecurity('USHI000688'), { market: 'USHI', code: '1B0688' });
  assert.deepEqual(parseSecurity('SZ399001'), { market: 'USZI', code: '399001' });
  assert.deepEqual(parseSecurity('SZ399006'), { market: 'USZI', code: '399006' });
  assert.deepEqual(parseSecurity('USZA000001'), { market: 'USZA', code: '000001' });
  assert.deepEqual(parseSecurity('1A0001'), { market: 'USHI', code: '1A0001' });
  assert.throws(() => parseSecurity('SHI'), /无法识别/);
});

test('does not misclassify Shenzhen 000xxx stocks as Shanghai indices', () => {
  assert.deepEqual(parseSecurity('000975'), { market: 'USZA', code: '000975' });
  assert.deepEqual(parseSecurity('000001'), { market: 'USHI', code: '1A0001' });
  assert.deepEqual(parseSecurity('SZ000001'), { market: 'USZA', code: '000001' });
  assert.deepEqual(parseSecurity('USZA000975'), { market: 'USZA', code: '000975' });
});

test('preserves Hong Kong index and stock ths_codes and normalizes aliases', () => {
  assert.deepEqual(parseSecurity('UHKIHSI'), { market: 'UHKI', code: 'HSI' });
  assert.deepEqual(parseSecurity('UHKMHK0700'), { market: 'UHKM', code: 'HK0700' });
  assert.deepEqual(parseSecurity('UHKMHK3330'), { market: 'UHKM', code: 'HK3330' });
  assert.deepEqual(parseSecurity('00700'), { market: 'UHKM', code: 'HK0700' });
  assert.deepEqual(parseSecurity('HK03330'), { market: 'UHKM', code: 'HK3330' });
  assert.deepEqual(parseSecurity('02689.HK'), { market: 'UHKM', code: 'HK2689' });
  assert.deepEqual(parseSecurity('600519.SH'), { market: 'USHA', code: '600519' });
  assert.deepEqual(parseSecurity('000001.SZ'), { market: 'USZA', code: '000001' });
  assert.deepEqual(parseSecurity('000001.SH'), { market: 'USHI', code: '1A0001' });
});
