/**
 * 飞书多维表客户端：tenant token 获取（自动续期）+ 记录 CRUD + 字段读取。
 *
 * 鉴权模式 tenant：自建应用凭据换取 tenant_access_token，
 * 应用需在开发者后台开通 bitable:app（或 bitable:app:readonly）权限，
 * 并被添加为目标多维表的协作者（可编辑）。
 */

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const TOKEN_TTL_MARGIN_MS = 5 * 60 * 1000; // 过期前 5 分钟主动续期

export class BitableClient {
  constructor({ appId, appSecret, appToken, fetchImpl, logger, timeoutMs = 20000 }) {
    if (!appId || !appSecret) throw new Error('feishu-bitable-sync 缺少 appId/appSecret 配置');
    if (!appToken) throw new Error('feishu-bitable-sync 缺少 appToken（多维表 app_token）配置');
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.logger = logger ?? console;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpireAt = 0;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const token = await this.ensureToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`飞书接口超时(${this.timeoutMs}ms): ${path}`)), this.timeoutMs);
    try {
      const resp = await this.fetch(`${FEISHU_BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || (data.code !== undefined && data.code !== 0)) {
        const msg = data.msg ?? data.error?.message ?? `HTTP ${resp.status}`;
        throw new Error(`飞书多维表接口失败 ${path}: ${msg} (code=${data.code ?? resp.status})`);
      }
      return data.data ?? data;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpireAt) return this.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('token 请求超时')), this.timeoutMs);
    try {
      const resp = await this.fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`tenant_access_token 获取失败: ${data.msg ?? `HTTP ${resp.status}`} (code=${data.code})`);
      }
      this.token = data.tenant_access_token;
      this.tokenExpireAt = Date.now() + (data.expire ?? 3600) * 1000 - TOKEN_TTL_MARGIN_MS;
      return this.token;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 指定表的所有字段定义（校验列名存在性） */
  fields(tableId) {
    return this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=100`, {})
      .then((d) => d.items ?? []);
  }

  /** 分页拉全表记录；filterBody 为服务端过滤（GET records 的 filter query 参数，JSON 字符串），
   *  被服务端拒绝（InvalidFilter 1254018 等）时自动降级为全表读取，由调用方内存过滤兜底 */
  async listRecords(tableId, filterBody = null) {
    let filter = filterBody;
    for (let attempt = 0; ; attempt++) {
      try {
        const records = [];
        let pageToken = null;
        do {
          const params = new URLSearchParams({ page_size: '500', ...(pageToken ? { page_token: pageToken } : {}) });
          if (filter) params.set('filter', JSON.stringify(filter));
          const d = await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${params}`);
          records.push(...(d.items ?? []));
          pageToken = d.page_token ?? null;
        } while (pageToken);
        return records;
      } catch (err) {
        // InvalidFilter / field validation：降级为无 filter 全表读取
        if (filter && attempt === 0 && /(1254018|field validation|InvalidFilter|invalid filter)/i.test(err.message)) {
          this.logger.warn?.(`[bitable-sync] 服务端 filter 被拒（${err.message.slice(0, 80)}），降级全表读取`);
          filter = null;
          continue;
        }
        throw err;
      }
    }
  }

  /** 批量创建（每批 ≤ 500，内部自动分批） */
  async createRecords(tableId, fieldsList, batchDelayMs = 300) {
    let ok = 0;
    for (let i = 0; i < fieldsList.length; i += 500) {
      const batch = fieldsList.slice(i, i + 500).map((fields) => ({ fields }));
      const d = await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_create`, {
        method: 'POST', body: { records: batch },
      });
      ok += (d.records ?? []).length;
      if (i + 500 < fieldsList.length) await sleep(batchDelayMs);
    }
    return ok;
  }

  /** 批量更新（records: [{record_id, fields}]，每批 ≤ 500） */
  async updateRecords(tableId, records, batchDelayMs = 300) {
    let ok = 0;
    for (let i = 0; i < records.length; i += 500) {
      const batch = records.slice(i, i + 500);
      const d = await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_update`, {
        method: 'POST', body: { records: batch },
      });
      ok += (d.records ?? []).length;
      if (i + 500 < records.length) await sleep(batchDelayMs);
    }
    return ok;
  }

  /** 批量删除（record_id 列表，每批 ≤ 500） */
  async deleteRecords(tableId, recordIds, batchDelayMs = 300) {
    let ok = 0;
    for (let i = 0; i < recordIds.length; i += 500) {
      const batch = recordIds.slice(i, i + 500);
      const d = await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_delete`, {
        method: 'POST', body: { records: batch },
      });
      ok += (d.records ?? []).length;
      if (i + 500 < recordIds.length) await sleep(batchDelayMs);
    }
    return ok;
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 日期(YYYY-MM-DD) → 飞书日期字段毫秒时间戳（Asia/Shanghai 零点） */
export function dateToMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600 * 1000);
}
