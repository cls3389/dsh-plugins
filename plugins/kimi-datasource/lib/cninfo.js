"use strict";

const CNINFO_ANNOUNCEMENT_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const CNINFO_STATIC_URL = "https://static.cninfo.com.cn";
const CNINFO_SEARCH_PAGE_URL = "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search";
const CNINFO_STOCK_LIST_URL = "https://www.cninfo.com.cn/new/data/szse_stock.json";
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGES = 10;

class CninfoError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CninfoError";
    this.status = options.status;
  }
}

function parseCninfoTicker(ticker) {
  const match = String(ticker || "").trim().toUpperCase().match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (!match) return null;

  const [, code, market] = match;
  return { code, market };
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" || /^\d{13}$/.test(String(value))) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.getTime())) return formatDate(date);
  }

  const text = String(value).trim();
  const match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function pickString(record, keys) {
  if (!record || typeof record !== "object") return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function announcementTitle(record) {
  return pickString(record, ["reportTitle", "announcementTitle", "title", "noticeTitle"]);
}

function announcementDate(record) {
  return normalizeDate(pickString(record, [
    "reportDate",
    "announcementDate",
    "announcementTime",
    "announcement_date",
    "publishDate",
    "ctime",
    "date",
  ]));
}

function announcementCode(record) {
  return pickString(record, ["stockCode", "stock_code", "secCode", "thscode", "code", "ticker"])
    .replace(/\.(SH|SZ|BJ)$/i, "");
}

function announcementCompany(record) {
  return pickString(record, ["stockName", "stock_name", "secName", "companyName", "name"]);
}

function originalPdfUrl(record) {
  return pickString(record, ["pdfURL", "pdf_url", "pdfUrl", "announcementUrl", "url"]);
}

function normalizeTitle(title, companyName = "") {
  let text = String(title || "").normalize("NFKC").toLowerCase().trim()
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const company = String(companyName || "").normalize("NFKC").toLowerCase().trim()
    .replace(/[\s\p{P}\p{S}]/gu, "");
  while (company && text.startsWith(company)) text = text.slice(company.length);
  return text;
}

function buildPdfUrl(adjunctUrl) {
  const relativePath = String(adjunctUrl || "").trim().replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("..") || /^[a-z][a-z\d+.-]*:/i.test(relativePath)) return "";
  return new URL(relativePath, `${CNINFO_STATIC_URL}/`).toString();
}

function cninfoAnnouncement(record) {
  const title = pickString(record, ["announcementTitle", "reportTitle", "title"]);
  const date = normalizeDate(record.announcementTime || record.announcementDate || record.announcement_date);
  const pdfUrl = buildPdfUrl(record.adjunctUrl || record.adjunctURL || record.pdfUrl);
  return {
    code: pickString(record, ["secCode", "stockCode", "code"]),
    companyName: pickString(record, ["secName", "stockName", "companyName"]),
    announcementId: pickString(record, ["announcementId", "id"]),
    title,
    date,
    pdfUrl,
  };
}

class CninfoAnnouncementResolver {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.cache = options.cache;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
    this.retryAttempts = Number.isInteger(options.retryAttempts) ? Math.max(0, options.retryAttempts) : 1;
    this.retryDelayMs = Number(options.retryDelayMs) >= 0 ? Number(options.retryDelayMs) : 1000;
    this.proxyAgent = options.proxyAgent;
    this.cookies = new Map();
    this._sessionPromise = null;
    this._stockDirectoryPromise = null;
  }

  async resolveRows(rows, options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const inputTickers = String(options.ticker || "").split(",").map((item) => parseCninfoTicker(item)).filter(Boolean);
    const byCode = new Map(inputTickers.map((security) => [security.code, security]));
    const soleSecurity = inputTickers.length === 1 ? inputTickers[0] : null;
    if (inputTickers.length === 0) {
      return rows.map((row) => enrichRow(row, { status: "not_supported" }));
    }

    let stockDirectory;
    try {
      stockDirectory = await this._getStockDirectory();
    } catch {
      return rows.map((row) => enrichRow(row, { status: "lookup_failed" }));
    }

    const lookups = new Map();
    await Promise.all(inputTickers.map(async (security) => {
      try {
        const announcements = await this.listAnnouncements(security, {
          stockInfo: stockDirectory.get(security.code),
          startDate: options.startDate,
          endDate: options.endDate,
        });
        lookups.set(security.code, { announcements });
      } catch {
        lookups.set(security.code, { error: true });
      }
    }));

    return rows.map((row) => {
      const security = byCode.get(announcementCode(row)) || soleSecurity;
      const candidateSecurities = security ? [security] : inputTickers;
      const successfulLookups = candidateSecurities
        .map((candidate) => lookups.get(candidate.code))
        .filter((result) => result && !result.error);
      if (successfulLookups.length === 0) {
        return enrichRow(row, { status: "lookup_failed" });
      }

      const candidates = successfulLookups.flatMap((result) => result.announcements);
      const match = findAnnouncementMatch(row, candidates);
      return enrichRow(row, {
        status: match ? "matched" : "not_found",
        cninfoPdfUrl: match?.pdfUrl || "",
        cninfoAnnouncementId: match?.announcementId || "",
      });
    });
  }

  async listAnnouncements(security, options = {}) {
    const startDate = normalizeDate(options.startDate) || "";
    const endDate = normalizeDate(options.endDate) || "";
    const stockInfo = options.stockInfo;
    if (!stockInfo?.orgId) throw new CninfoError(`巨潮股票目录中未找到 ${security.code}`);
    const cacheKey = `cninfo:announcements:${security.code}.${security.market}:${stockInfo.orgId}:${startDate}:${endDate}`;
    if (this.cache?.enabled) {
      const cached = await this.cache.get(cacheKey).catch(() => undefined);
      if (typeof cached === "string") {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Ignore malformed cache entries and request the source again.
        }
      }
    }

    const rows = [];
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const payload = await this._queryPage(security, {
        pageNum,
        stockInfo,
        startDate,
        endDate,
      });
      const pageRows = Array.isArray(payload.announcements) ? payload.announcements.map(cninfoAnnouncement) : [];
      rows.push(...pageRows.filter((row) => row.title && row.pdfUrl));

      const totalPages = Number(payload.totalpages || payload.totalPages);
      if (!payload.hasMore && (!Number.isFinite(totalPages) || pageNum >= totalPages)) break;
      if (Number.isFinite(totalPages) && pageNum >= totalPages) break;
      if (pageRows.length === 0) break;
    }

    if (this.cache?.enabled) {
      await this.cache.set(cacheKey, JSON.stringify(rows)).catch(() => {});
    }
    return rows;
  }

  async _queryPage(security, options) {
    if (typeof this.fetch !== "function") throw new CninfoError("当前运行环境不支持 fetch");
    await this._ensureSession();
    const params = new URLSearchParams({
      pageNum: String(options.pageNum),
      pageSize: String(DEFAULT_PAGE_SIZE),
      // 巨潮以代码和 orgId 识别证券；前端查询接口使用 szse/空 plate 组合覆盖沪深北披露。
      column: "szse",
      tabName: "fulltext",
      plate: "",
      stock: `${security.code},${options.stockInfo.orgId}`,
      searchkey: "",
      secid: "",
      category: "",
      trade: "",
      seDate: options.startDate && options.endDate ? `${options.startDate}~${options.endDate}` : "",
      sortName: "",
      sortType: "",
      isHLtitle: "true",
    });

    let lastError;
    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        const fetchOptions = {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Referer: CNINFO_SEARCH_PAGE_URL,
            Origin: "https://www.cninfo.com.cn",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "User-Agent": cninfoUserAgent(),
            ...(this._cookieHeader() ? { Cookie: this._cookieHeader() } : {}),
          },
          body: params,
          signal: AbortSignal.timeout(this.timeoutMs),
        };
        if (this.proxyAgent) fetchOptions.agent = this.proxyAgent;

        const response = await this._request(CNINFO_ANNOUNCEMENT_URL, fetchOptions);
        const body = await response.text();
        if (!response.ok) {
          throw new CninfoError(`巨潮公告查询失败 (HTTP ${response.status})`, { status: response.status });
        }
        try {
          const parsed = JSON.parse(body);
          if (!parsed || typeof parsed !== "object") throw new Error("empty response");
          return parsed;
        } catch {
          throw new CninfoError(`巨潮公告查询返回了无效 JSON: ${body.slice(0, 200)}`);
        }
      } catch (err) {
        lastError = err instanceof CninfoError ? err : new CninfoError(`巨潮公告查询失败: ${err.message}`);
        const retriable = !lastError.status || lastError.status === 429 || lastError.status >= 500;
        if (!retriable || attempt >= this.retryAttempts) break;
        if (this.retryDelayMs > 0) await delay(this.retryDelayMs);
      }
    }
    throw lastError || new CninfoError("巨潮公告查询失败");
  }

  async _getStockDirectory() {
    if (this._stockDirectoryPromise) return this._stockDirectoryPromise;
    this._stockDirectoryPromise = this._loadStockDirectory().catch((err) => {
      this._stockDirectoryPromise = null;
      throw err;
    });
    return this._stockDirectoryPromise;
  }

  async _loadStockDirectory() {
    const cacheKey = "cninfo:stock-directory:v1";
    if (this.cache?.enabled) {
      const cached = await this.cache.get(cacheKey).catch(() => undefined);
      if (typeof cached === "string") {
        const directory = parseStockDirectory(cached);
        if (directory.size > 0) return directory;
      }
    }

    const response = await this._request(CNINFO_STOCK_LIST_URL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: CNINFO_SEARCH_PAGE_URL,
        "User-Agent": cninfoUserAgent(),
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new CninfoError(`巨潮股票目录查询失败 (HTTP ${response.status})`, { status: response.status });
    }
    const directory = parseStockDirectory(body);
    if (directory.size === 0) throw new CninfoError("巨潮股票目录为空或格式异常");
    if (this.cache?.enabled) {
      await this.cache.set(cacheKey, body).catch(() => {});
    }
    return directory;
  }

  async _ensureSession() {
    if (this._sessionPromise) return this._sessionPromise;
    this._sessionPromise = this._bootstrapSession().catch((err) => {
      this._sessionPromise = null;
      throw err;
    });
    return this._sessionPromise;
  }

  async _bootstrapSession() {
    const response = await this._request(CNINFO_SEARCH_PAGE_URL, {
      method: "GET",
      headers: { "User-Agent": cninfoUserAgent() },
    });
    if (!response.ok) {
      throw new CninfoError(`巨潮会话初始化失败 (HTTP ${response.status})`, { status: response.status });
    }
  }

  async _request(url, options) {
    const requestOptions = {
      ...options,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (this.proxyAgent) requestOptions.agent = this.proxyAgent;
    const response = await this.fetch(url, requestOptions);
    this._storeCookies(response.headers);
    return response;
  }

  _storeCookies(headers) {
    const values = typeof headers?.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers?.get("set-cookie") ? [headers.get("set-cookie")] : [];
    for (const value of values) {
      const match = String(value).match(/^\s*([^=;\s]+)=([^;]*)/);
      if (match) this.cookies.set(match[1], match[2]);
    }
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function parseStockDirectory(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const rows = Array.isArray(parsed?.stockList) ? parsed.stockList : [];
    return new Map(rows
      .filter((row) => row && /^\d{6}$/.test(String(row.code || "")) && row.orgId)
      .map((row) => [String(row.code), {
        orgId: String(row.orgId),
        companyName: String(row.zwjc || ""),
      }])
    );
  } catch {
    return new Map();
  }
}

function cninfoUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

function enrichRow(row, { status, cninfoPdfUrl = "", cninfoAnnouncementId = "" }) {
  return {
    ...row,
    cninfo_pdf_url: cninfoPdfUrl,
    cninfo_status: status,
    cninfo_announcement_id: cninfoAnnouncementId,
    original_pdf_url: originalPdfUrl(row),
  };
}

function findAnnouncementMatch(row, candidates) {
  const title = announcementTitle(row);
  const companyName = announcementCompany(row);
  const titleKey = normalizeTitle(title, companyName);
  const date = announcementDate(row);
  if (!titleKey) return null;

  const titleMatches = candidates.filter((candidate) =>
    normalizeTitle(candidate.title, candidate.companyName) === titleKey
  );
  if (date) return titleMatches.find((candidate) => candidate.date === date) || null;
  return titleMatches.length === 1 ? titleMatches[0] : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CNINFO_ANNOUNCEMENT_URL,
  CNINFO_SEARCH_PAGE_URL,
  CNINFO_STOCK_LIST_URL,
  CninfoAnnouncementResolver,
  CninfoError,
  parseCninfoTicker,
  normalizeDate,
  normalizeTitle,
  findAnnouncementMatch,
  parseStockDirectory,
};
