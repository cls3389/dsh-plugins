/**
 * 数据源客户端：FQGate V2（行情/K线/指数）+ 同花顺数据中心（问财/涨停池/涨跌分布/交易日历）。
 * 全部只读；与 ths-market 插件同款端点，协议独立实现避免跨插件依赖。
 */

export class FqgateClient {
  constructor({ baseUrl, timeoutMs = 20000, logger }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.logger = logger ?? console;
  }

  async post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`FQGate 超时: ${path}`)), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.code !== 0) {
        throw new Error(`FQGate ${path}: ${data.message ?? `HTTP ${resp.status}`}`);
      }
      return data.data ?? data;
    } finally { clearTimeout(timer); }
  }

  /** 批量个股/ETF 快照（V2，按市场+资产类型分组：股票→mainland、基金→funds）。返回 {thscode(600519.SH): {price, preClose, changePercent, amount, name}} */
  async snapshots(codes) {
    const groups = new Map();
    for (const raw of codes) {
      const code = normalizeThsCode(raw);
      if (!code) continue;
      const bare = code.split('.')[0];
      // 资产类型：50/51/56/58(沪)、15/16/18(深) 是基金/ETF → V2 funds 路由；其余股票走 mainland
      const isFund = /^([45]\d|1[568])/.test(bare) && (code.endsWith('.SH') || code.endsWith('.SZ'));
      const m = code.endsWith('.SH') ? 'XSHG' : code.endsWith('.BJ') ? 'XBEI' : 'XSHE';
      const route = isFund ? '/v2/market/quotes/funds' : '/v2/market/quotes/mainland';
      const key = `${route}:${m}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ market: m, code: bare, thscode: code, route });
    }
    const out = {};
    const fields = ['previous_close', 'open', 'high', 'low', 'latest', 'volume', 'transaction_amount', 'security_name'];
    await Promise.all([...groups.values()].map(async (list) => {
      for (let i = 0; i < list.length; i += 200) {
        const batch = list.slice(i, i + 200);
        const d = await this.post(batch[0].route, { securities: batch.map(({ market, code }) => ({ market, code })), fields });
        for (const item of d.items ?? []) {
          const bare = item.security.code;
          const thscode = `${item.security.market === 'XSHG' ? bare + '.SH' : item.security.market === 'XSHE' ? bare + '.SZ' : bare + '.BJ'}`;
          const row = {
            thscode,
            name: item.security_name ?? null,
            price: num(item.latest),
            preClose: num(item.previous_close),
            amount: num(item.transaction_amount),
          };
          row.changePercent = row.price != null && row.preClose
            ? round4((row.price - row.preClose) / row.preClose * 100) : null;
          out[thscode] = row;
        }
      }
    }));
    return out;
  }

  /** 指数快照（V2 indices 路由，实测跨市场混批 400——必须按市场分组请求）。入参/返回均用 thscode(000001.SH) */
  async indexSnapshots(codes) {
    const map = { '000001.SH': 'USHI1A0001', '399001.SZ': 'USZI399001', '399006.SZ': 'USZI399006', '000688.SH': 'USHI1B0688' };
    const groups = new Map();
    const lookup = {};
    for (const code of codes) {
      const full = map[code] ?? (code.startsWith('US') ? code : null);
      if (!full) continue;
      const market = full.startsWith('USHI') ? 'XSHG' : 'XSHE';
      const v2code = full.slice(4);
      if (!groups.has(market)) groups.set(market, []);
      groups.get(market).push({ market, code: v2code });
      lookup[`${market}:${v2code}`] = code;
    }
    const out = {};
    await Promise.all([...groups.values()].map(async (securities) => {
      const d = await this.post('/v2/market/quotes/indices', {
        securities,
        fields: ['previous_close', 'latest', 'transaction_amount', 'security_name'],
      });
      for (const item of d.items ?? []) {
        const code = lookup[`${item.security.market}:${item.security.code}`];
        if (!code) continue;
        const price = num(item.latest); const preClose = num(item.previous_close);
        out[code] = {
          thscode: code, price, preClose, turnover: num(item.transaction_amount),
          changePercent: price != null && preClose ? round4((price - preClose) / preClose * 100) : null,
        };
      }
    }));
    return out;
  }

  /** 历史日 K（V2 /v2/market/bars，并发限流）。返回 {thscode: [{date:'YYYY-MM-DD', close, turnover}...]}（升序） */
  async historicalCloses(codes, days = 40, concurrency = 8) {
    const out = {};
    const queue = [...codes];
    const worker = async () => {
      while (queue.length) {
        const raw = queue.shift();
        const code = normalizeThsCode(raw);
        if (!code) continue;
        const bare = code.split('.')[0];
        const market = code.endsWith('.SH') ? 'XSHG' : code.endsWith('.BJ') ? 'XBEI' : 'XSHE';
        try {
          const d = await this.post('/v2/market/bars', {
            security: { market, code: bare }, interval: 'day',
            range: { type: 'count', count: days }, adjustment: 'none',
          });
          out[code] = (d.items ?? []).map((k) => ({
            date: k.trading_date, close: num(k.close), turnover: num(k.transaction_amount),
          })).filter((k) => k.close != null);
        } catch (err) {
          this.logger.warn?.(`[bitable-sync] ${code} 历史 K 获取失败: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, codes.length) }, worker));
    return out;
  }
}

export class DataCenterClient {
  constructor({ baseUrl, apiKey, timeoutMs = 60000, logger }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.logger = logger ?? console;
    // 问财 cookie 会话不是可并行资源：同一数据中心上游并行查询会互相干扰，
    // 实测并行两池时各自只拿到首屏 10 行。所有问财调用统一串行排队。
    this.wencaiQueue = Promise.resolve();
  }

  async get(path) { return this.do('GET', path); }
  async post(path, body) { return this.do('POST', path, body); }

  async do(method, path, body) {
    if (!this.apiKey) throw new Error('feishu-bitable-sync 缺少 dataCenterApiKey 配置');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`数据中心超时: ${path}`)), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method, headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined, signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        throw new Error(`数据中心 ${path}: ${data.detail ?? `HTTP ${resp.status}`}`);
      }
      return data.data ?? data;
    } finally { clearTimeout(timer); }
  }

  /** 交易日历（YYYYMMDD 字符串数组） */
  async tradeDates() { return this.get('/api/market/trade-dates'); }

  /** 涨跌分布：{up_num, down_num, limit_up_cnt, limit_down_cnt, non_linear_board_cnt, limit_up_open_board_cnt} */
  async changeDistribution() { return this.get('/api/market/change-distribution'); }

  /** 涨跌停池（date=YYYY-MM-DD）：{limit_up:[{stock,first_time,...}], limit_down:[], open_plate:[], unis_plate:[]} */
  async limitStocks(date) { return this.get(`/api/market/limit-stocks?date=${date}`); }

  /** 问财查询。返回 tables[0]（columns/rows），rows 的键为列 feKey（含 [YYYYMMDD] 时间戳后缀）。
   * 调用在实例内串行；不得把多个池/桶的 wencai 请求并发发给上游。
   */
  async wencai(query, limit = 200) {
    const run = async () => {
      const d = await this.post('/api/wencai/query2data', { query, limit });
      return { answer: d.answer ?? '', tables: d.tables ?? [] };
    };
    const pending = this.wencaiQueue.then(run, run);
    this.wencaiQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /**
   * 问财涨停池富字段（涨停原因/连板数/封单额/首板时间/开板次数）。
   * cookie 版问财单次最多返回 10 行——超限时按「连板档位 + 封单额区间动态二分」递归聚合：
   * 首层先切连板档位（连板股数量少一步拿全），首板按封单额区间二分直到每桶 ≤10 行；
   * 子桶并行查询，行按 thscode 去重。
   * 返回 {thscode: {reason, continueDays, sealMoney, firstTime, openTimes, changePercent, name}}
   */
  async limitUpPoolRich(date) {
    const dateStr = date.replaceAll('-', '');
    const seen = new Map();
    const query = `${date} 涨停;涨停原因;连续涨停天数;涨停封单额;首次涨停时间;涨停开板次数;最新涨跌幅`;
    const { tables } = await this.wencai(query, 2048);
    const table = tables[0];
    const rows = table?.rows ?? [];
    const rowCount = Number(table?.row_count ?? rows.length);

    const absorb = (list) => {
      for (const row of list) {
        const code = row['股票代码'];
        if (!code || seen.has(code)) continue;
        seen.set(code, {
          thscode: code,
          name: row['股票简称'] ?? null,
          reason: row[`涨停原因[${dateStr}]`] ?? null,
          continueDays: num(row[`连续涨停天数[${dateStr}]`]),
          sealMoney: num(row[`涨停封单额[${dateStr}]`]),
          firstTime: row[`首次涨停时间[${dateStr}]`] ?? null,
          openTimes: num(row[`涨停开板次数[${dateStr}]`]),
          changePercent: num(row['最新涨跌幅']),
        });
      }
    };
    absorb(rows);

    // 截断检测（返回 ≥10 行且 row_count 更大）→ 分桶递归。
    // 问财区间语义（实测）："大于X" / "小于等于Y" / "大于X 小于等于Y" 可用；
    // "大于等于X" 返回 0 行不可用 → 区间统一左开右闭 (lo, hi]。
    const truncated = rows.length >= 10 && rowCount > rows.length;
    if (truncated) {
      await Promise.allSettled([
        // 连板股单独一桶（数量少，通常一步拿全）
        this.limitUpPoolRichSub(date, 1, ' 连续涨停天数大于1', seen),
        // 首板按封单额二分：(0, 1亿] 起步
        this.bisectLimitUp(date, 1, { lo: 0, hi: 100000000 }, seen),
      ]);
    }
    return Object.fromEntries(seen);
  }

  /** 连板股子查询（涨停池专用：额外条件直查，不递归——连板股数量少） */
  async limitUpPoolRichSub(date, depth, extraCond, seen) {
    const dateStr = date.replaceAll('-', '');
    const query = `${date} 涨停${extraCond};涨停原因;连续涨停天数;涨停封单额;首次涨停时间;涨停开板次数;最新涨跌幅`;
    const { tables } = await this.wencai(query, 2048);
    const rows = tables[0]?.rows ?? [];
    const rowCount = Number(tables[0]?.row_count ?? rows.length);
    for (const row of rows) {
      const code = row['股票代码'];
      if (!code || seen.has(code)) continue;
      seen.set(code, {
        thscode: code,
        name: row['股票简称'] ?? null,
        reason: row[`涨停原因[${dateStr}]`] ?? null,
        continueDays: num(row[`连续涨停天数[${dateStr}]`]),
        sealMoney: num(row[`涨停封单额[${dateStr}]`]),
        firstTime: row[`首次涨停时间[${dateStr}]`] ?? null,
        openTimes: num(row[`涨停开板次数[${dateStr}]`]),
        changePercent: num(row['最新涨跌幅']),
      });
    }
    // 连板桶仍截断时按连板档位继续拆（2板/3板/…，每档数量极少）
    if (rows.length >= 10 && rowCount > rows.length && depth < 5) {
      await Promise.allSettled(
        [2, 3, 4, 5, 8].map((d) => this.limitUpPoolRichSub(date, depth + 1, ` 连续涨停天数等于${d}`, seen)),
      );
    }
    return null;
  }

  /**
   * 首板封单额区间二分递归（涨停池专用）。
   * 区间 (lo, hi]：问财条件 = 大于lo 小于等于hi；lo=0 时省略下界（负数封单额不存在）。
   * 截断时对半切：(lo, mid] + (mid, hi]。
   */
  async bisectLimitUp(date, depth, range, seen) {
    if (depth > 8) return null;
    const dateStr = date.replaceAll('-', '');
    const loCond = range.lo > 0 ? ` 涨停封单额大于${range.lo}` : '';
    const hiCond = range.hi != null ? ` 涨停封单额小于等于${range.hi}` : '';
    const query = `${date} 涨停 连续涨停天数为1${loCond}${hiCond};涨停原因;连续涨停天数;涨停封单额;首次涨停时间;涨停开板次数;最新涨跌幅`;
    const { tables } = await this.wencai(query, 2048);
    const rows = tables[0]?.rows ?? [];
    const rowCount = Number(tables[0]?.row_count ?? rows.length);
    for (const row of rows) {
      const code = row['股票代码'];
      if (!code || seen.has(code)) continue;
      seen.set(code, {
        thscode: code,
        name: row['股票简称'] ?? null,
        reason: row[`涨停原因[${dateStr}]`] ?? null,
        continueDays: num(row[`连续涨停天数[${dateStr}]`]),
        sealMoney: num(row[`涨停封单额[${dateStr}]`]),
        firstTime: row[`首次涨停时间[${dateStr}]`] ?? null,
        openTimes: num(row[`涨停开板次数[${dateStr}]`]),
        changePercent: num(row['最新涨跌幅']),
      });
    }
    if (rows.length < 10 || rowCount <= rows.length) return null; // 未截断，收敛
    // hi=null 是开放式尾部；mid 仅用作对半搜索，不能作为下一次递归的 hi 丢掉 >1亿 的尾部。
    const mid = range.hi != null
      ? Math.max(range.lo + 1, Math.floor((range.lo + range.hi) / 2))
      : Math.max(range.lo + 1, 100000000);
    await Promise.allSettled([
      this.bisectLimitUp(date, depth + 1, { lo: range.lo, hi: mid }, seen),
      this.bisectLimitUp(date, depth + 1, { lo: mid, hi: range.hi }, seen),
    ]);
    return null;
  }

  /** 问财炸板池（含涨停原因），分桶递归（最新涨跌幅区间二分，左开右闭）。返回 {thscode: {reason, openTimes, changePercent, name}} */
  async breakPoolRich(date) {
    const dateStr = date.replaceAll('-', '');
    const seen = new Map();
    const absorb = (rows) => {
      for (const row of rows) {
        const code = row['股票代码'];
        if (!code || seen.has(code)) continue;
        seen.set(code, {
          thscode: code,
          name: row['股票简称'] ?? null,
          reason: row[`涨停原因[${dateStr}]`] ?? row['涨停原因类别'] ?? null,
          openTimes: num(row[`涨停开板次数[${dateStr}]`]),
          changePercent: num(row['最新涨跌幅']),
        });
      }
    };
    const { tables } = await this.wencai(`${date} 涨停开板;涨停原因;涨停开板次数;最新涨跌幅`, 2048);
    const rows = tables[0]?.rows ?? [];
    const rowCount = Number(tables[0]?.row_count ?? rows.length);
    absorb(rows);

    // 截断 → 最新涨跌幅区间二分（炸板股涨跌幅 ∈ (-11, 11)；区间左开右闭 (lo, hi]，
    // 但涨跌幅可为负，下界用"大于 lo"）——与封单额桶同款"大于/小于等于"语义
    if (rows.length >= 10 && rowCount > rows.length) {
      const subSplit = async (lo, hi, depth) => {
        if (depth > 8) return;
        const cond = ` 最新涨跌幅大于${lo} 最新涨跌幅小于等于${hi}`;
        const q = `${date} 涨停开板${cond};涨停原因;涨停开板次数;最新涨跌幅`;
        const { tables: t2 } = await this.wencai(q, 2048);
        const rs = t2[0]?.rows ?? [];
        const rc = Number(t2[0]?.row_count ?? rs.length);
        absorb(rs);
        if (rs.length >= 10 && rc > rs.length) {
          const mid = (lo + hi) / 2;
          await Promise.allSettled([subSplit(lo, mid, depth + 1), subSplit(mid, hi, depth + 1)]);
        }
      };
      await Promise.allSettled([subSplit(-11, 0, 1), subSplit(0, 11, 1)]);
    }
    return Object.fromEntries(seen);
  }

  /** 全量涨停/炸板名单为主，问财仅补充能返回的富字段。
   * 问财 cookie 会话首屏只有 10 行，不能作为名单完整性依据；
   * limit-stocks 是全量代码与首封时间的权威来源，杜绝分桶漏股后误删旧行。
   */
  async limitUpPoolComplete(date) {
    const raw = await this.limitStocks(date);
    const rich = await this.limitUpPoolRich(date).catch((e) => { this.logger.warn?.(`涨停富字段补充失败: ${e.message}`); return {}; });
    const out = {};
    for (const item of raw?.limit_up ?? []) {
      const code = normalizeThsCode(item.stock);
      if (!code) continue;
      const extra = rich[code] ?? {};
      out[code] = { ...extra, thscode: code, firstTime: extra.firstTime ?? (item.first_time ? shanghaiDateTime(item.first_time) : null) };
    }
    return out;
  }

  async breakPoolComplete(date) {
    const raw = await this.limitStocks(date);
    const rich = await this.breakPoolRich(date).catch((e) => { this.logger.warn?.(`炸板富字段补充失败: ${e.message}`); return {}; });
    const out = {};
    for (const item of raw?.open_plate ?? []) {
      const code = normalizeThsCode(item.stock);
      if (!code) continue;
      out[code] = { ...(rich[code] ?? {}), thscode: code };
    }
    return out;
  }

  /** 昨日涨停表现指数（883900.TI）当日涨跌幅——问财口径（百分数）。失败返回 null */
  async limitUpPremiumPercent(date) {
    try {
      const { answer } = await this.wencai(`${date} 昨日涨停表现`, 1);
      const m = answer?.match(/(?:下跌|上涨|涨|跌)([0-9.]+)%/);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return answer.includes('下跌') ? -v : v;
    } catch { return null; }
  }
}

function normalizeThsCode(raw) {
  if (typeof raw !== 'string') return null;
  let code = raw.trim().toUpperCase();
  if (!code) return null;
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6')) return `${code}.SH`;
    if (code.startsWith('0') || code.startsWith('3')) return `${code}.SZ`;
    if (code.startsWith('4') || code.startsWith('8')) return `${code}.BJ`;
    return null;
  }
  return /^\d{6}\.(SH|SZ|BJ)$/.test(code) ? code : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function shanghaiDateTime(ms) {
  const d = new Date(Number(ms) + 8 * 3600000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : null;
}
function round4(v) { return Math.round(v * 10000) / 10000; }
