const KLINE_FIELDS = {
  1: 'date', 7: 'open', 8: 'high', 9: 'low', 11: 'close', 13: 'volume', 19: 'amount',
};
const INTRADAY_INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m', '120m']);
const INDEX_MARKETS = new Set(['USHI', 'USZI', 'UHKI', 'UFII', 'UFIC', 'UFIE', 'UFIX']);
const BROAD_INDEX_CODES = new Set(['USHI1A0001', 'USZI399001', 'USZI399006', 'UHKIHSI', 'UFIIIXIC', 'UFIISPX', 'UFIIDJI']);

function flattenRows(data) {
  if (!Array.isArray(data?.records)) return [];
  return data.records.flatMap((segment) => Array.isArray(segment) ? segment : []);
}

function cellValue(cell) {
  if (!cell || cell.value === undefined || cell.value === null) return undefined;
  if (cell.type === 'invalid') return undefined;
  // FQGate uses signed-int sentinel values for missing fields, not real quotes.
  if (cell.value === -2147483648) return undefined;
  return cell.value;
}

function klineTimestamp(value, interval) {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (INTRADAY_INTERVALS.has(interval) && /^\d{14}$/.test(String(value))) {
    const text = String(value);
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
  }
  if (!INTRADAY_INTERVALS.has(interval) && /^\d{8}$/.test(String(value))) {
    const text = String(value);
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return value;
}

/** Keep every requested bar, but do not leak wire-format type/value wrappers to the model. */
export function decodeKlines(data, options = {}) {
  const rows = flattenRows(data).map((record) => {
    const row = {};
    for (const [id, cell] of Object.entries(record ?? {})) {
      const value = cellValue(cell);
      if (value === undefined) continue;
      const key = KLINE_FIELDS[id] ?? `f${id}`;
      row[key] = id === '1' ? klineTimestamp(value, options.interval) : value;
    }
    return row;
  }).filter((row) => Object.keys(row).length > 0);
  return {
    symbol: `${options.market}${options.code}`, interval: options.interval,
    adjust: options.adjust ?? 'None', count: rows.length,
    requestedCount: options.count ?? null,
    startDate: rows[0]?.date ?? null, endDate: rows.at(-1)?.date ?? null,
    rows, truncatedByTool: false,
    upstream: { dataState: data?.data_state ?? null, rowCount: data?.row_count ?? null, segmentCount: data?.segment_count ?? null },
  };
}

function compactText(text) {
  return String(text ?? '').toLowerCase().replace(/[\s_\-—–·()（）]/g, '').replace(/标准普尔/g, '标普');
}

function isIndex(item) {
  return INDEX_MARKETS.has(item.market) || /指数$/.test(String(item.name ?? ''));
}

/** Stable, transparent ranking: exact matches first, then canonical indices over derivative products. */
export function rankSearchItems(items, pattern) {
  const query = compactText(pattern);
  const broadQuery = query.length >= 2 && !/\d/.test(query) && !/^(?:ths|etf|lof|qfii|rqfii)$/.test(query);
  return items.map((item, index) => {
    const name = String(item.name ?? '');
    const code = String(item.code ?? '');
    const thsCode = String(item.ths_code ?? '');
    const exact = compactText(name) === query || compactText(code) === query || compactText(thsCode) === query;
    const starts = compactText(name).startsWith(query);
    const benchmark = broadQuery && BROAD_INDEX_CODES.has(thsCode);
    const officialIndex = broadQuery && INDEX_MARKETS.has(item.market);
    const namedIndex = broadQuery && isIndex(item);
    const derivative = /etf|lof|结构化|缓冲|收益增强|双向|两倍|三倍|做空|做多|期货|主连|连续|ntr|fund/i.test(`${name} ${code}`);
    // Official index market outranks both an exact company name and index-tracking ETFs.
    const tier = benchmark ? 0 : officialIndex ? 1 : namedIndex && !derivative ? 2 : exact ? 3 : starts ? 4 : 5;
    return { item, index, tier, derivative: derivative ? 1 : 0, length: name.length };
  }).sort((a, b) => a.tier - b.tier || a.derivative - b.derivative || a.length - b.length || a.index - b.index)
    .map(({ item }) => item);
}

const BROAD_INDEX_QUERIES = new Map([
  ['纳斯达克', ['IXIC']], ['纳斯达克综合指数', ['IXIC']], ['纳指', ['IXIC']],
  ['标普500', ['SPX']], ['标准普尔500', ['SPX']], ['标准普尔500指数', ['SPX']],
  ['道琼斯', ['DJI']], ['道琼斯指数', ['DJI']], ['道琼斯工业指数', ['DJI']], ['道琼斯工业平均指数', ['DJI']],
]);

/** Broad Chinese queries can overflow upstream before it returns the official index. */
export function searchRefinements(pattern) {
  const query = String(pattern ?? '').trim();
  if (/^(?:纳斯达克100|纳斯达克100指数|纳指100|ndx)$/i.test(query)) return ['纳斯达克100指数'];
  return BROAD_INDEX_QUERIES.get(query) ?? [];
}

export function mergeSearchItems(primary, supplemental) {
  const seen = new Set();
  return [...primary, ...supplemental].filter((item) => {
    const key = String(item.ths_code ?? `${item.market}${item.code}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatSearchResult(data, pattern) {
  const items = rankSearchItems(Array.isArray(data?.items) ? data.items : [], pattern);
  return {
    pattern, count: items.length, items,
    // Numeric records are wire-format diagnostics, not useful model-facing search results.
    upstream: { dataState: data?.data_state ?? null, itemCount: data?.item_count ?? null },
  };
}

export function quoteFreshness() {
  return {
    sourceTimestampAvailable: false,
    sourceTimestamp: null,
    note: '上游 quote 未提供可靠行情时间；可能是最近收盘/结算快照。收到响应时间不等于行情时间，盘中决策须核对带交易时间的 Level-2 逐笔或其他实时源。',
  };
}
