/**
 * 同步引擎：三张表的同步逻辑（纯逻辑 + 编排，不持有调度状态）。
 *
 * 表 1 标的跟踪：读表 → V2 快照 + 收盘价缓存算 5/10/20 日涨跌 → 差异更新。
 * 表 2 每日情绪总览：涨停池(问财富字段+limit-stocks) + 涨跌分布 + 指数 → 按日 upsert。
 * 表 3 涨停明细：涨停+炸板行，按 (日期,股票代码,类型) upsert，当日多余行删除。
 *
 * 收盘价缓存：stateDir/closes-cache.json，{thscode: [[date,close]...]}，
 * 与旧 fuyao-feishu-sync 语义一致（fresh=最后日期距今 ≤10 天）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dateToMs, sleep } from './feishu-bitable.js';

const CHANGE_WINDOWS = [5, 10, 20];

export class SyncEngine {
  constructor({ cfg, bitable, fqgate, dc, logger }) {
    this.cfg = cfg;
    this.bitable = bitable;
    this.fqgate = fqgate;
    this.dc = dc;
    this.logger = logger;
    this.cachePath = join(cfg.stateDir, 'closes-cache.json');
    this.statusPath = join(cfg.stateDir, 'status.json');
    this.running = false;
    this.lastRun = null;
  }

  /** 交易日判断：数据中心日历失败时按是处理（宁可多跑不静默跳过） */
  async isTradingDay(dateStr) {
    try {
      const days = await this.dc.tradeDates();
      return !Array.isArray(days) || days.length === 0 || days.map(String).includes(dateStr.replaceAll('-', ''));
    } catch { return true; }
  }

  async loadCache() {
    try { return JSON.parse(await readFile(this.cachePath, 'utf8')); } catch { return {}; }
  }
  async saveCache(cache) {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(cache));
  }
  async saveStatus(entry) {
    try {
      await mkdir(dirname(this.statusPath), { recursive: true });
      await writeFile(this.statusPath, JSON.stringify({ lastRun: this.lastRun, ...entry }, null, 1));
    } catch { /* 状态盘仅观测用 */ }
  }

  /** 主入口：一次全量同步（标的表 + 情绪表 + 明细表） */
  async runAll({ dryRun = false, force = false, date = null, intraday = false, holdingsOnly = false, overviewOnly = false } = {}) {
    if (this.running) return { ok: false, error: '同步已在进行中（进程内锁）' };
    this.running = true;
    const t0 = Date.now();
    try {
      const todayStr = date ?? shanghaiDate();
      if (!force && !intraday && !await this.isTradingDay(todayStr)) {
        return { ok: true, skipped: true, reason: `${todayStr} 不是交易日` };
      }
      const results = {};
      if (!overviewOnly) results.holdings = await this.syncHoldings({ dryRun, intraday, todayStr });
      if (!holdingsOnly) results.sentiment = await this.syncSentiment({ dryRun, intraday, todayStr });
      const entry = { at: new Date().toISOString(), date: todayStr, dryRun, intraday, results, ms: Date.now() - t0 };
      this.lastRun = entry;
      await this.saveStatus(entry);
      return { ok: true, ...entry };
    } catch (err) {
      this.logger.error?.(`[bitable-sync] 同步失败: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      this.running = false;
    }
  }

  /** 表 1：标的跟踪 */
  async syncHoldings({ dryRun, intraday, todayStr }) {
    const { holdingsTableId, codeField, fieldMap } = this.cfg;
    if (!holdingsTableId) return { skipped: '未配置 holdingsTableId' };

    const records = await this.bitable.listRecords(holdingsTableId);
    this.logger.info?.(`[bitable-sync] 标的表读取 ${records.length} 行`);
    if (!records.length) return { ok: true, updated: 0 };

    const codes = [...new Set(records.map((r) => normalizeCellCode(r.fields?.[codeField])).filter(Boolean))];
    const snapshots = await this.fqgate.snapshots(codes);

    // 收盘价缓存（fresh = 最后日期 ≤10 天前）
    const cache = await this.loadCache();
    const closesMap = {};
    const rebuild = [];
    for (const code of codes) {
      const cached = cache[code] ?? [];
      const price = snapshots[code]?.price;
      if (isCacheFresh(cached, todayStr) && price != null) {
        closesMap[code] = appendPrice(cached, todayStr, price);
      } else if (isCacheFresh(cached, todayStr)) {
        closesMap[code] = cached;
      } else {
        rebuild.push(code);
      }
    }
    if (rebuild.length) {
      this.logger.info?.(`[bitable-sync] ${rebuild.length} 个标的缓存重建`);
      const rebuilt = await this.fqgate.historicalCloses(rebuild, 40);
      for (const code of rebuild) {
        // FqgateClient 返回 [{date,close}] 对象行,缓存统一存 [date,price] 元组
        let rows = (rebuilt[code] ?? []).filter((k) => k.close != null).map((k) => [k.date, k.close]);
        const price = snapshots[code]?.price;
        if (price != null) rows = appendPrice(rows, todayStr, price);
        closesMap[code] = rows;
      }
    }
    // 回写缓存：盘中模式不落今日临时价（收盘全量会补正式收盘价）
    if (!dryRun && Object.keys(closesMap).length) {
      const toWrite = intraday
        ? Object.fromEntries(Object.entries(closesMap).map(([c, rows]) => [c, rows.filter(([d]) => d !== todayStr)]))
        : closesMap;
      await this.saveCache({ ...cache, ...toWrite }).catch((e) => this.logger.warn?.(`缓存写入失败: ${e.message}`));
    }

    // 差异更新
    const updates = [];
    const skipped = [];
    for (const rec of records) {
      const code = normalizeCellCode(rec.fields?.[codeField]);
      if (!code || (!snapshots[code] && !(closesMap[code] ?? []).length)) { if (code) skipped.push(code); continue; }
      const snap = snapshots[code] ?? {};
      const changes = intervalChanges((closesMap[code] ?? []).map(([, p]) => p));
      const newValues = {};
      if (snap.price != null) newValues[fieldMap.lastPrice] = round2(snap.price);
      if (snap.changePercent != null) newValues[fieldMap.changeRatio] = round4(snap.changePercent / 100);
      for (const n of CHANGE_WINDOWS) {
        const v = changes.get(n);
        if (v != null) newValues[fieldMap[`change${n}d`]] = round4(v);
      }
      const changed = diffFields(rec.fields ?? {}, newValues);
      if (Object.keys(changed).length && rec.record_id) updates.push({ record_id: rec.record_id, fields: changed });
    }
    if (dryRun) return { ok: true, dryRun: true, wouldUpdate: updates.length, skipped: skipped.length, sample: updates.slice(0, 5) };
    const ok = await this.bitable.updateRecords(holdingsTableId, updates, this.cfg.batchDelayMs);
    this.logger.info?.(`[bitable-sync] 标的表更新 ${ok}/${updates.length} 行`);
    return { ok: true, updated: ok, unchanged: records.length - updates.length - skipped.length, skipped: skipped.length };
  }

  /** 表 2 + 表 3：情绪总览 + 涨停明细 */
  async syncSentiment({ dryRun, intraday, todayStr }) {
    const { overviewTableId, detailTableId } = this.cfg;
    if (!overviewTableId && !detailTableId) return { skipped: '未配置情绪表' };
    const out = {};

    // 1) 涨停/炸板池富字段 + 涨跌分布 + 指数
    const [upPool, breakPool, distribution, premiumPct] = await Promise.all([
      this.dc.limitUpPoolComplete(todayStr).catch((e) => { this.logger.warn?.(`涨停池获取失败: ${e.message}`); return {}; }),
      this.dc.breakPoolComplete(todayStr).catch((e) => { this.logger.warn?.(`炸板池获取失败: ${e.message}`); return {}; }),
      this.dc.changeDistribution().catch(() => null),
      this.dc.limitUpPremiumPercent(todayStr),
    ]);
    const upCodes = Object.keys(upPool);
    const breakCodes = Object.keys(breakPool);
    const poolCodes = [...new Set([...upCodes, ...breakCodes])];

    // 2) 池股 5/10/20 日涨跌（缓存 + 快照，口径同标的表）
    const snapshots = poolCodes.length ? await this.fqgate.snapshots(poolCodes) : {};
    const cache = await this.loadCache();
    const closesMap = {};
    const rebuild = [];
    for (const code of poolCodes) {
      const cached = cache[code] ?? [];
      const price = snapshots[code]?.price;
      if (isCacheFresh(cached, todayStr) && price != null) closesMap[code] = appendPrice(cached, todayStr, price);
      else if (isCacheFresh(cached, todayStr)) closesMap[code] = cached;
      else rebuild.push(code);
    }
    if (rebuild.length) {
      const rebuilt = await this.fqgate.historicalCloses(rebuild, 40);
      for (const code of rebuild) {
        // 同标的表:对象行 → [date,price] 元组
        let rows = (rebuilt[code] ?? []).filter((k) => k.close != null).map((k) => [k.date, k.close]);
        const price = snapshots[code]?.price;
        if (price != null) rows = appendPrice(rows, todayStr, price);
        closesMap[code] = rows;
      }
    }
    if (!dryRun && Object.keys(closesMap).length) {
      const toWrite = intraday
        ? Object.fromEntries(Object.entries(closesMap).map(([c, rows]) => [c, rows.filter(([d]) => d !== todayStr)]))
        : closesMap;
      await this.saveCache({ ...cache, ...toWrite }).catch(() => {});
    }

    // 3) 指数快照（四指数 + 深成指）
    const indexCodesMap = this.cfg.sentimentIndexCodes ?? {};
    const wantIdx = [...new Set([...Object.values(indexCodesMap), '399001.SZ'])];
    const indexSnaps = await this.fqgate.indexSnapshots(wantIdx).catch((e) => {
      this.logger.warn?.(`指数快照失败: ${e.message}`); return {};
    });

    // 4) 表 3 涨停明细 upsert
    if (detailTableId) {
      const rows = [];
      const dateMs = dateToMs(todayStr);
      for (const [code, item] of Object.entries(upPool)) {
        const row = { 日期: dateMs, 股票代码: code, 类型: '涨停' };
        if (item.continueDays != null) row.连板数 = item.continueDays;
        if (item.firstTime) row.封板时间 = item.firstTime;
        if (item.reason) row.涨停原因 = item.reason;
        if (item.changePercent != null) row.涨跌幅 = round4(item.changePercent / 100);
        if (item.sealMoney != null) row['封单(亿)'] = round2(item.sealMoney / 1e8);
        const amt = snapshots[code]?.amount;
        if (amt != null) row['成交额(亿)'] = round2(amt / 1e8);
        rows.push(row);
      }
      for (const [code, item] of Object.entries(breakPool)) {
        const row = { 日期: dateMs, 股票代码: code, 类型: '炸板' };
        if (item.reason) row.涨停原因 = item.reason;
        if (item.changePercent != null) row.涨跌幅 = round4(item.changePercent / 100);
        if (item.openTimes != null) row.开板次数 = item.openTimes;
        const amt = snapshots[code]?.amount;
        if (amt != null) row['成交额(亿)'] = round2(amt / 1e8);
        rows.push(row);
      }
      // 5/10/20 日涨跌
      for (const row of rows) {
        const changes = intervalChanges((closesMap[row.股票代码] ?? []).map(([, p]) => p));
        for (const n of CHANGE_WINDOWS) {
          const v = changes.get(n);
          if (v != null) row[`${n}日涨跌`] = round4(v);
        }
      }
      out.detail = await upsertRows({
        bitable: this.bitable, tableId: detailTableId, rows,
        keys: ['日期', '股票代码', '类型'], dryRun, label: '涨停明细',
        deleteScope: { field: '日期', value: dateMs },
        filterBody: { operator: 'is', property_name: '日期', value: ['ExactDate', dateMs] },
        batchDelayMs: this.cfg.batchDelayMs, logger: this.logger,
      });
    }

    // 5) 表 2 情绪总览 upsert
    if (overviewTableId) {
      const fields = { 日期: dateToMs(todayStr) };
      const stCount = Object.values(upPool).filter((i) => (i.name ?? '').includes('ST')).length;
      fields.涨停家数 = upCodes.length;
      fields.ST涨停 = stCount;
      fields.跌停 = distribution?.limit_down_cnt ?? null;
      fields.炸板 = breakCodes.length || distribution?.limit_up_open_board_cnt;
      const contDays = Object.values(upPool).map((i) => i.continueDays ?? 1);
      if (contDays.length) {
        fields.最高连板 = Math.max(...contDays);
        fields.连板家数 = contDays.filter((d) => d >= 2).length;
      }
      // 涨停总成交额（亿）：优先溢价指数成交额拿不到时用涨停池快照求和
      const turnSum = poolCodes.reduce((s, c) => s + (upCodes.includes(c) ? (snapshots[c]?.amount ?? 0) : 0), 0);
      if (turnSum > 0) fields['涨停总成交额(亿)'] = round1(turnSum / 1e8);
      const breakAmt = breakCodes.reduce((s, c) => s + (snapshots[c]?.amount ?? 0), 0);
      if (breakAmt > 0) fields['炸板总成交额(亿)'] = round1(breakAmt / 1e8);
      // 今日溢价：883900 问财口径；回退=0 值时不写（无昨日涨停数据）
      if (premiumPct != null) fields.今日溢价 = round4(premiumPct / 100);
      // 指数涨跌 + 两市成交额
      const sz = indexSnaps['399001.SZ'];
      for (const [label, code] of Object.entries(indexCodesMap)) {
        const snap = indexSnaps[code];
        if (snap?.changePercent != null) fields[label] = round4(snap.changePercent / 100);
      }
      const sh = indexSnaps[indexCodesMap.上证 ?? '000001.SH'];
      if (sh?.turnover != null && sz?.turnover != null) fields['两市(亿)'] = Math.round((sh.turnover + sz.turnover) / 1e8);
      // 涨跌家数（数据中心分布直出）
      if (distribution) {
        fields.上涨家数 = distribution.up_num;
        fields.下跌家数 = distribution.down_num;
        fields.平盘家数 = null; // 分布接口无平盘数，跳过
        delete fields.平盘家数;
      }
      // 过滤 null（缺数据的字段不覆盖表内现值）
      for (const k of Object.keys(fields)) if (fields[k] == null) delete fields[k];
      out.overview = await upsertRows({
        bitable: this.bitable, tableId: overviewTableId, rows: [fields],
        keys: ['日期'], dryRun, label: '情绪总览',
        batchDelayMs: this.cfg.batchDelayMs, logger: this.logger,
      });
    }
    return out;
  }
}

/** 幂等 upsert：按 keys 匹配现值 → 新增缺失 / 更新变化 / 删除指定范围内多余 */
async function upsertRows({ bitable, tableId, rows, keys, dryRun, label, deleteScope = null, filterBody = null, batchDelayMs = 300, logger }) {
  const existing = indexByKeys(await bitable.listRecords(tableId, filterBody), keys);
  logger?.info?.(`[bitable-sync] ${label}: 现有 ${existing.size} 行, 目标 ${rows.length} 行`);
  const creates = [];
  const updates = [];
  const seen = new Set();
  for (const row of rows) {
    const key = JSON.stringify(keys.map((k) => row[k]));
    seen.add(key);
    const rec = existing.get(key);
    if (!rec) { creates.push(row); continue; }
    const changed = diffFields(rec.fields ?? {}, row);
    if (Object.keys(changed).length) updates.push({ record_id: rec.record_id, fields: changed });
  }
  const deleteIds = deleteScope
    ? [...existing.entries()]
        .filter(([key, rec]) => !seen.has(key) && (rec.fields ?? {})[deleteScope.field] === deleteScope.value && rec.record_id)
        .map(([, rec]) => rec.record_id)
    : [];
  logger?.info?.(`[bitable-sync] ${label}: 新增 ${creates.length}, 更新 ${updates.length}, 删除 ${deleteIds.length}`);
  if (dryRun) {
    return { dryRun: true, wouldCreate: creates.length, wouldUpdate: updates.length, wouldDelete: deleteIds.length, sample: creates.slice(0, 3) };
  }
  let failed = 0;
  if (creates.length) await bitable.createRecords(tableId, creates, batchDelayMs).catch((e) => { failed += creates.length; logger?.error?.(`${label} 新增失败: ${e.message}`); });
  if (updates.length) await bitable.updateRecords(tableId, updates, batchDelayMs).catch((e) => { failed += updates.length; logger?.error?.(`${label} 更新失败: ${e.message}`); });
  if (deleteIds.length) await bitable.deleteRecords(tableId, deleteIds, batchDelayMs).catch((e) => { failed += deleteIds.length; logger?.error?.(`${label} 删除失败: ${e.message}`); });
  return { ok: failed === 0, created: creates.length, updated: updates.length, deleted: deleteIds.length, failed };
}

function indexByKeys(records, keys) {
  const map = new Map();
  for (const rec of records) {
    const key = JSON.stringify(keys.map((k) => rec.fields?.[k]));
    if (keys.every((k) => rec.fields?.[k] != null)) map.set(key, rec);
  }
  return map;
}

/** 字段级差异：数值容忍 1e-9；旧值非数值（人工填文本）视为有变化 */
function diffFields(oldFields, newValues) {
  const changed = {};
  for (const [dst, v] of Object.entries(newValues)) {
    if (v == null) continue;
    const old = oldFields[dst];
    let differs;
    if (typeof v === 'number' && !Number.isNaN(Number(old))) differs = Math.abs(Number(old) - v) > 1e-9;
    else differs = old !== v;
    if (differs) changed[dst] = v;
  }
  return changed;
}

/** 多维表单元格代码 → thscode（600519.SH）。兼容纯数字/已带后缀两种 */
function normalizeCellCode(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) raw = raw[0]?.text ?? raw[0];
  if (typeof raw === 'object') raw = raw.text ?? raw.value;
  const code = String(raw ?? '').trim().toUpperCase();
  if (!code) return null;
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6')) return `${code}.SH`;
    if (code.startsWith('0') || code.startsWith('3')) return `${code}.SZ`;
    if (code.startsWith('4') || code.startsWith('8')) return `${code}.BJ`;
  }
  return null;
}

function isCacheFresh(cached, todayStr) {
  if (!Array.isArray(cached) || !cached.length) return false;
  const last = cached[cached.length - 1][0];
  const days = (Date.parse(todayStr) - Date.parse(last)) / 86400000;
  return days <= 10;
}

function appendPrice(rows, dateStr, price) {
  const out = rows.filter(([d]) => d !== dateStr);
  out.push([dateStr, price]);
  return out;
}

/** 收盘价序列 → {5: 涨跌幅, 10: .., 20: ..}（小数） */
export function intervalChanges(closes) {
  const out = new Map();
  if (!closes?.length) return out;
  const last = closes[closes.length - 1];
  for (const n of CHANGE_WINDOWS) {
    if (closes.length > n) {
      const base = closes[closes.length - 1 - n];
      if (base) out.set(n, (last - base) / base);
    }
  }
  return out;
}

export function shanghaiDate() {
  return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000).toISOString().slice(0, 10);
}
function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
