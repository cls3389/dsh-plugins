/** Data-center quota K-lines: period labels and ordered data_fields decoding. */

export function dataCenterKlineOptions(security, interval, adjust) {
  const market = { USHA: 'SH', USHJ: 'SH', USHI: 'SH', USZA: 'SZ', USZJ: 'SZ', USZI: 'SZ', USJB: 'BJ' }[security.market];
  if (!market) throw new Error(`数据中心分钟 K 仅支持沪深北证券，当前 ${security.market}${security.code} 不支持`);
  const adjustment = String(adjust ?? 'forward').toLowerCase();
  if (adjustment === 'backward') throw new Error('数据中心分钟 K 不支持后复权；请使用 FQGate 日线或明确前复权');
  // The upstream returns no rows for adjust_type=none. Keep this explicit so
  // None is never silently represented as an unadjusted series.
  if (adjustment !== 'forward') throw new Error('数据中心分钟 K 仅支持 forward 前复权；none/backward 请使用日线接口');
  const period = { '1m': 'min_1', '5m': 'min_5', '15m': 'min_15', '30m': 'min_30', '60m': 'min_60', '120m': 'min_120' }[interval];
  if (!period) throw new Error(`数据中心不支持分钟周期 ${interval}`);
  return { market, code: security.code, time_period: period, adjust_type: adjustment };
}

export function decodeDataCenterKlines(data, options = {}) {
  const rows = [];
  for (const item of data?.quote_data ?? []) {
    const fields = Array.isArray(item?.data_fields) ? item.data_fields : [];
    const timestampIndex = fields.indexOf('1');
    if (timestampIndex < 0) continue; // Never invent timestamps from index position.
    for (const values of item.value ?? []) {
      if (!Array.isArray(values) || !Number.isFinite(Number(values[timestampIndex]))) continue;
      const at = new Date(Number(values[timestampIndex]));
      if (!Number.isFinite(at.getTime())) continue;
      const row = { date: at.toISOString() };
      const names = { 7: 'open', 8: 'high', 9: 'low', 11: 'close', 13: 'volume', 19: 'amount' };
      for (const [field, name] of Object.entries(names)) {
        const index = fields.indexOf(field);
        if (index >= 0 && values[index] != null) row[name] = values[index];
      }
      rows.push(row);
    }
  }
  return {
    symbol: options.symbol ?? '', interval: options.interval,
    adjust: options.adjust ?? 'forward', count: rows.length,
    requestedCount: options.count ?? null,
    startDate: rows[0]?.date ?? null, endDate: rows.at(-1)?.date ?? null,
    rows, truncatedByTool: false,
    upstream: { source: 'ths-data-center', endpoint: '/api/market/quota/kline', rowCount: rows.length },
  };
}
