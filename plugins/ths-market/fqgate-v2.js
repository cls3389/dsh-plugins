/**
 * FQGate 2.0 protocol adapter.
 *
 * Tool inputs keep the existing THS identifiers; this module is the only place
 * that translates them to ISO markets, standard fields and asset quote routes.
 */

const STANDARD_MARKETS = {
  USHA: 'XSHG', USHJ: 'XSHG', USHI: 'XSHG', USHB: 'XSHG',
  USZA: 'XSHE', USZJ: 'XSHE', USZI: 'XSHE', USZB: 'XSHE',
  USJB: 'XBEI', UHKM: 'XHKG', UHKI: 'XHKG',
  UNQQ: 'XNAS', UFII: 'XNAS', UNYN: 'XNYS',
  XSHG: 'XSHG', XSHE: 'XSHE', XBEI: 'XBEI', XHKG: 'XHKG',
  XNAS: 'XNAS', XNYS: 'XNYS', XLON: 'XLON', XXXX: 'XXXX',
};

export const DEFAULT_V2_QUOTE_FIELDS = [
  'previous_close', 'open', 'high', 'low', 'latest',
  'volume', 'transaction_amount', 'security_name',
];
// tonghuashun-plugin currently accepts this additive quote subscription subset.
export const DEFAULT_V2_SUBSCRIPTION_FIELDS = [
  'previous_close', 'latest', 'volume', 'security_name',
];

const FIELD_NAMES = {
  5: 'code', 6: 'previous_close', 7: 'open', 8: 'high', 9: 'low',
  10: 'latest', 12: 'current_volume', 13: 'volume', 18: 'turnover_rate',
  19: 'transaction_amount', 45: 'volume', 48: 'change_percent_5m', 55: 'security_name',
};
const OUTPUT_FIELDS = {
  previous_close: 'preClose', latest: 'price', transaction_amount: 'amount',
  security_name: 'name', current_volume: 'tickVolume', turnover_rate: 'turnoverRate',
  change_percent: 'changePercent', change_percent_5m: 'momentum',
  float_market_cap: 'floatMarketCap', market_cap: 'marketCap',
  transaction_count: 'transactionCount', limit_up: 'limitUp', limit_down: 'limitDown',
};

export function toV2Security(security) {
  const market = STANDARD_MARKETS[security.market];
  if (!market) throw new Error(`FQGate 2.0 暂不支持该市场: ${security.market}${security.code}`);
  let code = security.code;
  if (security.market === 'UHKM') code = code.replace(/^HK/i, '').padStart(5, '0');
  const assetType = ['USHI', 'USZI', 'UHKI', 'UFII'].includes(security.market) ? 'index'
    : ['USHJ', 'USZJ'].includes(security.market) ? 'fund'
    : ['USHB', 'USZB'].includes(security.market) ? 'bond' : 'equity';
  return { market, code, assetType };
}

export function v2SecurityTarget(security) {
  const { market, code } = toV2Security(security);
  return { market, code };
}

export function quoteRoute(security) {
  if (['USHI', 'USZI'].includes(security.market)) return '/v2/market/quotes/indices';
  if (['USHJ', 'USZJ'].includes(security.market)) return '/v2/market/quotes/funds';
  if (['USHB', 'USZB'].includes(security.market)) return '/v2/market/quotes/bonds';
  if (['USHA', 'USZA', 'USJB'].includes(security.market)) return '/v2/market/quotes/mainland';
  if (security.market === 'UHKM') return '/v2/market/quotes/hong-kong';
  if (['UNQQ', 'UNYN'].includes(security.market)) return '/v2/market/quotes/united-states';
  // V2 currently has no Hong Kong/global-index quote route. This narrowly
  // scoped V1 compatibility path is intentional, never a V2 failure fallback.
  return null;
}

export function v2QuoteFields(fields) {
  if (!fields?.length) return DEFAULT_V2_QUOTE_FIELDS;
  return [...new Set(fields.map((field) => {
    const name = typeof field === 'number' ? FIELD_NAMES[field] : field;
    if (!name) throw new Error(`FQGate 2.0 不支持旧字段编号/名称: ${field}`);
    if (name === 'code') return null;
    if (!DEFAULT_V2_QUOTE_FIELDS.includes(name) && ![
      'change_amount', 'change_percent', 'turnover_rate', 'amplitude', 'volume_ratio',
      'transaction_count', 'limit_up', 'limit_down', 'current_volume', 'five_day_volume',
      'market_cap', 'float_market_cap', 'change_percent_5m',
    ].includes(name)) throw new Error(`FQGate 2.0 不支持旧字段编号/名称: ${field}`);
    return name;
  }).filter(Boolean))];
}

function legacySymbol(security, assetType = 'equity') {
  const { market, code } = security;
  if (market === 'XSHG') {
    const prefix = assetType === 'index' || /^1[AB]/.test(code) ? 'USHI'
      : assetType === 'bond' || /^(100|110|111|113|118)\d{3}$/.test(code) ? 'USHB'
      : assetType === 'fund' || /^[45]/.test(code) ? 'USHJ' : 'USHA';
    return `${prefix}${code}`;
  }
  if (market === 'XSHE') {
    const prefix = assetType === 'index' || /^399/.test(code) ? 'USZI'
      : assetType === 'bond' || /^(120|123|127|128)\d{3}$/.test(code) ? 'USZB'
      : assetType === 'fund' || /^1[56]/.test(code) ? 'USZJ' : 'USZA';
    return `${prefix}${code}`;
  }
  if (market === 'XBEI') return `USJB${code}`;
  if (market === 'XHKG') return /^\d+$/.test(code)
    ? `UHKMHK${code.padStart(5, '0').slice(1)}` : `UHKI${code}`;
  if (market === 'XNAS') return `${assetType === 'index' ? 'UFII' : 'UNQQ'}${code}`;
  if (market === 'XNYS') return `${assetType === 'index' ? 'UFII' : 'UNYN'}${code}`;
  return `${market}${code}`;
}

export function decodeV2Quote(item) {
  const security = item?.security;
  if (!security?.market || !security?.code) throw new Error('FQGate 2.0 quote 缺少 security.market/code');
  const code = legacySymbol(security, item.asset_type);
  const row = { code, assetType: item.asset_type ?? null };
  for (const [field, value] of Object.entries(item)) {
    if (['security', 'asset_type', 'change_percent', 'amplitude'].includes(field) || value == null) continue;
    row[OUTPUT_FIELDS[field] ?? field] = value;
  }
  if (Number.isFinite(item.change_percent)) row.changePercent = item.change_percent;
  else if (Number.isFinite(row.price) && Number.isFinite(row.preClose) && row.preClose > 0) {
    row.changePercent = Math.round((row.price - row.preClose) / row.preClose * 100 * 10000) / 10000;
  }
  if (Number.isFinite(item.amplitude)) row.amplitude = item.amplitude;
  else if (Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.preClose) && row.preClose > 0) {
    row.amplitude = Math.round((row.high - row.low) / row.preClose * 100 * 10000) / 10000;
  }
  return row;
}

/** Batch by V2 route/market. If a source only accepts one security, retry in V2 alone. */
export async function fetchV2Quotes(client, securities, fields) {
  const groups = new Map();
  for (const security of securities) {
    const route = quoteRoute(security);
    if (!route) throw new Error(`${security.market}${security.code} 需要显式 V1 兼容路径，不能混入 V2 批量查询`);
    const standard = toV2Security(security);
    const key = `${route}:${standard.market}`;
    if (!groups.has(key)) groups.set(key, { route, standard, securities: [] });
    groups.get(key).securities.push(standard);
  }
  const rows = [];
  const byIdentity = new Map();
  for (const { route, standard, securities: targets } of groups.values()) {
    const requestGroup = async (list) => {
      const raw = await client.post(route, {
        securities: list.map(({ market, code }) => ({ market, code })), fields,
      });
      const returned = new Set();
      for (const item of raw?.data?.items ?? []) {
        const row = decodeV2Quote(item);
        rows.push(row);
        returned.add(`${item.security.market}:${item.security.code}`);
        byIdentity.set(`${item.security.market}:${item.security.code}`, row);
      }
      // V2 may return partial coverage without an HTTP error. Request missing
      // members individually so multi-asset watch rules never silently lapse.
      const missing = list.filter(({ market, code }) => !returned.has(`${market}:${code}`));
      for (const target of missing) {
        const rawSingle = await client.post(route, {
          securities: [{ market: target.market, code: target.code }], fields,
        });
        for (const item of rawSingle?.data?.items ?? []) {
          const row = decodeV2Quote(item);
          rows.push(row);
          byIdentity.set(`${item.security.market}:${item.security.code}`, row);
        }
      }
    };
    const query = async (list) => {
      if (list.length === 0) return;
      try {
        await requestGroup(list);
      } catch (error) {
        if (list.length === 1) {
          error.message = `${standard.market}/${list[0].code}: ${error.message}`;
          throw error;
        }
        // V2 documents that some THS protocols accept only one security.
        await query([list[0]]);
        await query(list.slice(1));
      }
    };
    await query(targets);
  }
  return rows;
}

export function normalizeV2SearchItems(data) {
  return (data?.items ?? []).map((item) => {
    const symbol = legacySymbol(item.security, item.asset_type);
    return {
      name: item.name, code: symbol.slice(4), market: symbol.slice(0, 4), ths_code: symbol,
      ...(item.asset_type ? { asset_type: item.asset_type } : {}),
    };
  });
}

export function normalizeV2LargeOrder(item) {
  return {
    ...item,
    code: legacySymbol(item.security, 'equity').slice(4),
    amount: item.transaction_amount,
    volume: item.transaction_volume,
    side: item.direction,
  };
}
