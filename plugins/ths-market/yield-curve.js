const TREASURY_BASE_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates';
const TENORS = [
  ['1M', '1 Mo', 1 / 12, '1个月'], ['1.5M', '1.5 Month', 1.5 / 12, '1.5个月'],
  ['2M', '2 Mo', 2 / 12, '2个月'], ['3M', '3 Mo', 3 / 12, '3个月'],
  ['4M', '4 Mo', 4 / 12, '4个月'], ['6M', '6 Mo', 6 / 12, '6个月'],
  ['1Y', '1 Yr', 1, '1年'], ['2Y', '2 Yr', 2, '2年'], ['3Y', '3 Yr', 3, '3年'],
  ['5Y', '5 Yr', 5, '5年'], ['7Y', '7 Yr', 7, '7年'], ['10Y', '10 Yr', 10, '10年'],
  ['20Y', '20 Yr', 20, '20年'], ['30Y', '30 Yr', 30, '30年'],
];

/** US Treasury publication date, rather than the caller's market/time zone. */
export function treasuryToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date 必须为 YYYY-MM-DD');
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`无效日期: ${value}`);
  return value;
}

/** Small RFC-4180 parser: quoted headers, CRLF and escaped quotes are supported. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i <= input.length; i++) {
    const char = input[i] ?? '\n';
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('财政部 CSV 引号未闭合');
  return rows;
}

export function parseTreasuryCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2 || rows[0][0] !== 'Date') throw new Error('财政部响应不是有效的收益率曲线 CSV');
  const headers = rows[0];
  for (const column of ['2 Yr', '10 Yr', '30 Yr']) {
    if (!headers.includes(column)) throw new Error(`财政部收益率 CSV 缺少 ${column} 列`);
  }
  const observations = rows.slice(1).map((cells) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    const match = row.Date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) throw new Error(`财政部收益率日期格式异常: ${row.Date}`);
    const date = `${match[3]}-${match[1]}-${match[2]}`;
    const curve = TENORS.map(([tenor, column, years, label]) => ({
      tenor, years, label,
      ratePercent: row[column] === undefined || row[column] === '' || row[column] === 'N/A' ? null : Number(row[column]),
    }));
    if (curve.some((point) => point.ratePercent !== null && (!Number.isFinite(point.ratePercent) || point.ratePercent < -10 || point.ratePercent > 100))) {
      throw new Error(`财政部 ${date} 收益率数值异常`);
    }
    return { date, curve };
  });
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

function shapeObservation(observation, previous, requestedDate, source) {
  const yields = Object.fromEntries(observation.curve.map((point) => [point.tenor, point.ratePercent]));
  const previousYields = Object.fromEntries((previous?.curve ?? []).map((point) => [point.tenor, point.ratePercent]));
  const changesBp = Object.fromEntries(observation.curve.filter((point) => point.ratePercent !== null && Number.isFinite(previousYields[point.tenor]))
    .map((point) => [point.tenor, Math.round((point.ratePercent - previousYields[point.tenor]) * 10000) / 100]));
  return {
    date: observation.date, requestedDate: requestedDate ?? null,
    isLatestRequested: requestedDate === undefined,
    yields, curve: observation.curve, previousDate: previous?.date ?? null, changesBp,
    ...source,
  };
}

/** Fetch official nominal daily par yields; date selects the latest publication on/before it. */
export async function readTreasuryYieldCurve(options = {}) {
  const requestedDate = options.date === undefined ? undefined : parseDate(options.date);
  const today = treasuryToday(options.now);
  if (requestedDate && requestedDate > today) throw new Error(`date 不能晚于美国财政部当前日期 ${today}`);
  const endDate = requestedDate ?? today;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const baseUrl = options.baseUrl ?? TREASURY_BASE_URL;
  const observations = [];
  const seenYears = new Set();
  // A year can have no publications yet (New Year / holiday): look back up to two years.
  for (let year = Number(endDate.slice(0, 4)); year >= Number(endDate.slice(0, 4)) - 2; year--) {
    if (seenYears.has(year)) continue;
    seenYears.add(year);
    const url = `${baseUrl}/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    const response = await fetchImpl(url, { headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`美国财政部收益率接口 HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('美国财政部收益率响应超过 2MB 安全上限');
    observations.push(...parseTreasuryCsv(text));
    if (observations.some((item) => item.date <= endDate)) break;
  }
  const eligible = observations.filter((item) => item.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
  const current = eligible.at(-1);
  if (!current) throw new Error(`美国财政部未发布 ${endDate} 及之前的收益率数据`);
  const yearUrl = `${baseUrl}/daily-treasury-rates.csv/${current.date.slice(0, 4)}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${current.date.slice(0, 4)}&page&_format=csv`;
  return shapeObservation(current, eligible.at(-2), requestedDate, {
    source: '美国财政部 Daily Treasury Par Yield Curve Rates', sourceUrl: yearUrl,
    frequency: 'daily_publication', rateType: 'nominal_par_yield', unit: 'percent',
    note: '美国财政部官方每日名义国债收益率（%），发布日期见 date；不是实时盘中利率，不能用国债 ETF 价格替代。',
  });
}
