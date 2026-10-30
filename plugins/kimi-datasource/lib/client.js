"use strict";

const path = require("node:path");

const { datasourceHeaders, KIMI_DATASOURCE_VERSION } = require("./identity");
const { parseCsv } = require("./csv");
const { FileCache } = require("./cache");
const { CninfoAnnouncementResolver } = require("./cninfo");
const {
  TIANYANCHA_DATA_SOURCE,
  TIANYANCHA_APIS,
  COMPANY_PROFILE_API,
  buildTianyanchaFilePath,
} = require("./tianyancha");
const {
  splitTickers,
  buildStockFilePath,
  normalizeStockApiName,
} = require("./stock");

const DEFAULT_API_URL = "https://api.kimi.com/coding/v1/tools";
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MiB
const OUTPUT_SCHEMA_VERSION = "kimi-datasource-json-v1";

const VALID_STOCK_QUERY_TYPES = [
  "realtime_price",
];

class DatasourceError extends Error {}
class InputError extends DatasourceError {}

class EndpointSelector {
  constructor(endpoints, options = {}) {
    this._endpoints = endpoints.length > 0 ? endpoints : [{ apiUrl: DEFAULT_API_URL, apiKey: "" }];
    this._cooldownMs = (options.failoverCooldownSeconds || 60) * 1000;
    this._authCooldownMs = (options.authFailoverCooldownSeconds || 300) * 1000;
    this._currentIndex = 0;
    this._cooldowns = new Map(); // index -> expireAt timestamp
  }

  get current() {
    // 主端点冷却恢复后自动回切
    if (this._currentIndex !== 0 && this._isPrimaryReady()) {
      this._currentIndex = 0;
    }
    return this._endpoints[this._currentIndex];
  }

  get currentIndex() { return this._currentIndex; }
  get endpointCount() { return this._endpoints.length; }

  markFailed(isAuthError) {
    const cooldownMs = isAuthError ? this._authCooldownMs : this._cooldownMs;
    this._cooldowns.set(this._currentIndex, Date.now() + cooldownMs);
  }

  rotate() {
    const startIndex = this._currentIndex;
    let next = (startIndex + 1) % this._endpoints.length;
    while (next !== startIndex) {
      if (!this._isCooling(next)) {
        this._currentIndex = next;
        return true;
      }
      next = (next + 1) % this._endpoints.length;
    }
    // 所有端点都在冷却，强制使用下一个
    this._currentIndex = (startIndex + 1) % this._endpoints.length;
    return false;
  }

  _isPrimaryReady() {
    const expireAt = this._cooldowns.get(0);
    return !expireAt || Date.now() >= expireAt;
  }

  _isCooling(index) {
    const expireAt = this._cooldowns.get(index);
    if (!expireAt) return false;
    if (Date.now() >= expireAt) {
      this._cooldowns.delete(index);
      return false;
    }
    return true;
  }
}

class KimiDatasourceClient {
  constructor(auth, options = {}) {
    this.auth = auth;
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this._endpoints = new EndpointSelector(options.endpoints || [], {
      failoverCooldownSeconds: options.failoverCooldownSeconds,
      authFailoverCooldownSeconds: options.authFailoverCooldownSeconds,
    });
    this.timeoutMs = (options.timeoutSeconds || 30) * 1000;
    this.proxy = options.proxy || "";
    this.responseParseMode = options.responseParseMode || "official";
    this.filesDir = path.resolve(options.filesDir || "/tmp/openclaw/kimi-datasource/files");

    // 批量/CSV 配置
    this.stockBatchSize = clampInt(options.stockBatchSize, 1, 10, 3);
    this.stockBatchConcurrency = clampInt(options.stockBatchConcurrency, 1, 10, 3);
    this.csvParseEnabled = options.csvParseEnabled !== false;
    this.csvMaxPreviewRows = clampInt(options.csvMaxPreviewRows, 1, 10000, 100);
    this.csvMaxCellLength = clampInt(options.csvMaxCellLength, 1, 10000, 500);

    // 超时与重试
    this.dataSourceTimeouts = options.dataSourceTimeouts || {};
    this.retryAttempts = clampInt(options.retryAttempts, 0, 10, 1);
    this.retryDelayMs = clampInt(options.retryDelayMs, 0, 60000, 1000);
    this.announcementFetchContent = options.announcementFetchContent === true;

    // 缓存公告索引、巨潮 URL 映射和 API 描述，避免重复查询。
    this.cache = new FileCache({
      enabled: options.cacheEnabled !== false,
      cacheDir: options.cacheDir || path.join(this.filesDir, "cache"),
      defaultTtlSeconds: clampInt(options.announcementCacheTtlSeconds, 60, 86400, 3600),
    });

    this._proxyAgent = this._buildProxyAgent();
    this.cninfoResolver = options.cninfoResolver || new CninfoAnnouncementResolver({
      cache: this.cache,
      timeoutMs: this._resolveTimeout("cninfo"),
      retryAttempts: this.retryAttempts,
      retryDelayMs: this.retryDelayMs,
      proxyAgent: this._proxyAgent,
    });
    this._logger = options.logger || null;
  }

  _log(level, message) {
    this._logger?.[level]?.(message);
  }

  async queryStock(ticker, queryType = "realtime_price", queryTime = "", filePath = "") {
    const tickers = splitTickers(ticker, this.stockBatchSize);
    if (tickers.length === 0) throw new InputError("ticker 不能为空");
    const method = stockQueryMethod(queryType);
    const results = await runInBatches(
      tickers,
      this.stockBatchConcurrency,
      async (chunk) => {
        const params = buildStockParams(
          chunk,
          queryType,
          queryTime,
          filePath || buildStockFilePath(this.filesDir, method, chunk),
          this.filesDir
        );
        return this._callDatasourceMethod(method, params);
      }
    );
    return buildTabularResult("kimi", results, {
      ticker,
      query_type: queryType || "realtime_price",
      time: queryTime || "",
    });
  }

  async queryStockAnnouncements(params) {
    const ticker = params.ticker || "";
    const tickers = splitTickers(ticker, this.stockBatchSize);
    if (tickers.length === 0) throw new InputError("ticker 不能为空");
    assertAnnouncementTickerSupport(tickers);

    const startDate = params.start_date || defaultDateDaysAgo(30);
    const endDate = params.end_date || defaultDateDaysAgo(0);
    const fetchContent = params.fetch_content !== undefined ? params.fetch_content === true : this.announcementFetchContent;
    const maxResults = clampInt(params.max_results, 1, 500, 50);

    const cacheKey = `announcements:v5:${ticker}:${startDate}:${endDate}:${maxResults}`;
    if (this.cache.enabled) {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const results = await runInBatches(
      tickers,
      this.stockBatchConcurrency,
      async (chunk) => {
        const callParams = {
          ticker: chunk,
          start_date: startDate,
          end_date: endDate,
          file_path: buildStockFilePath(this.filesDir, "get_stock_announcement", chunk),
        };
        return this._callDatasourceMethod("call_data_source_tool", {
          data_source_name: "stock_finance_data",
          api_name: normalizeStockApiName("get_stock_announcement"),
          params: callParams,
        });
      }
    );

    const merged = collectTabularResults(results);
    if (merged.successCount === 0) throw new DatasourceError(merged.errors[0] || "公告查询失败");

    let data = merged.rows;
    if (data.length > 0) {
      data = await this.cninfoResolver.resolveRows(data, { ticker, startDate, endDate });
    }
    const output = buildAnnouncementResult(data, {
      ticker,
      startDate,
      endDate,
      fetchContent,
      errors: merged.errors,
    });
    if (this.cache.enabled) {
      await this.cache.set(cacheKey, output).catch(() => {});
    }
    return output;
  }

  async queryStockTool(toolName, params) {
    const { buildStockCallParams } = require("./stock");
    requiredString(params?.ticker, "ticker");
    validateStockToolParams(toolName, params);
    const calls = buildStockCallParams(toolName, params, this.filesDir);
    const results = await runInBatches(
      calls,
      this.stockBatchConcurrency,
      async (call) => this._callDatasourceMethod("call_data_source_tool", {
        data_source_name: "stock_finance_data",
        api_name: call.apiName,
        params: call.params,
      })
    );
    return buildTabularResult("kimi", results, {
      ticker: params.ticker,
      tool: toolName,
    });
  }

  async callDataSourceTool(dataSourceName, apiName, params) {
    requiredString(dataSourceName, "data_source_name");
    requiredString(apiName, "api_name");
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new InputError("params must be an object");
    }
    if (dataSourceName !== TIANYANCHA_DATA_SOURCE) {
      throw new InputError("仅支持天眼查内部调用；股票请使用 kimi_stock_*，其他需求请使用联网搜索工具。");
    }

    const result = await this._callDatasourceMethod("call_data_source_tool", {
      data_source_name: dataSourceName,
      api_name: apiName,
      params,
    });
    return buildTabularResult(dataSourceName, [result], {
      api_name: apiName,
    });
  }

  async searchTianyanchaCompanies(params) {
    requiredString(params?.search_keyword, "search_keyword");
    const pageSize = clampInt(params.page_size, 1, 20, 20);
    const pageNum = clampInt(params.page_num, 1, 1000, 1);
    return this.callDataSourceTool(TIANYANCHA_DATA_SOURCE, TIANYANCHA_APIS.companySearch, {
      search_keyword: params.search_keyword.trim(),
      page_size: pageSize,
      page_num: pageNum,
      file_path: buildTianyanchaFilePath(this.filesDir, TIANYANCHA_APIS.companySearch),
    });
  }

  async searchTianyanchaApis(params) {
    requiredString(params?.query, "query");
    const limit = clampInt(params.limit, 1, 20, 10);
    const result = await this._callDatasourceMethod("call_data_source_tool", {
      data_source_name: TIANYANCHA_DATA_SOURCE,
      api_name: TIANYANCHA_APIS.apiSearch,
      params: {
      query: params.query.trim(),
      limit: String(limit),
      },
    });
    return buildTianyanchaApiSearchResult(result, {
      query: params.query.trim(),
      limit,
    });
  }

  async callTianyanchaApi(params) {
    requiredString(params?.api_call_name, "api_call_name");
    if (!params.api_call_params || typeof params.api_call_params !== "object" || Array.isArray(params.api_call_params)) {
      throw new InputError("api_call_params must be an object");
    }
    return this.callDataSourceTool(TIANYANCHA_DATA_SOURCE, TIANYANCHA_APIS.apiCall, {
      api_call_name: params.api_call_name.trim(),
      api_call_params: params.api_call_params,
      file_path: buildTianyanchaFilePath(this.filesDir, TIANYANCHA_APIS.apiCall),
    });
  }

  async queryTianyanchaCompanyProfile(params) {
    requiredString(params?.keyword, "keyword");
    return this.callTianyanchaApi({
      api_call_name: COMPANY_PROFILE_API,
      api_call_params: { keyword: params.keyword.trim() },
    });
  }

  async _callDatasourceMethod(method, params) {
    const dataSourceName = params?.data_source_name || "";
    const timeoutMs = this._resolveTimeout(dataSourceName);
    const maxAttempts = this._endpoints.endpointCount;

    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ep = this._endpoints.current;
      const apiUrl = ep.apiUrl || this.apiUrl;
      const endpointIndex = this._endpoints.currentIndex;

      // 获取 token：优先使用端点自带 apiKey，否则走 auth
      let accessToken;
      let deviceId;
      if (ep.apiKey) {
        accessToken = ep.apiKey;
        deviceId = await this.auth.getDeviceId();
      } else {
        const tokenResult = await this.auth.ensureFreshToken();
        accessToken = tokenResult.token.accessToken;
        deviceId = tokenResult.deviceId;
      }

      try {
        this._log("info", `[kimi-datasource] endpoint ${endpointIndex} try ${attempt + 1}/${maxAttempts}: ${apiUrl}`);
        const response = await this._post(apiUrl, { method, params }, {
          headers: datasourceHeaders(accessToken, deviceId, KIMI_DATASOURCE_VERSION),
          expectJson: true,
          timeoutMs,
        });
        this._log("info", `[kimi-datasource] endpoint ${endpointIndex} success`);
        const text = extractText(response, this.responseParseMode);
        const files = extractResponseFiles(response);
        return { text, files };
      } catch (err) {
        lastErr = err;
        this._log("warn", `[kimi-datasource] endpoint ${endpointIndex} failed (${err.httpStatus || "network"}): ${err.message}`);
        if (!isFailoverable(err)) throw err;

        const isAuthError = err.httpStatus === 401 || err.httpStatus === 403;
        this._endpoints.markFailed(isAuthError);

        if (attempt < maxAttempts - 1) {
          const rotated = this._endpoints.rotate();
          this._log("warn", `[kimi-datasource] failover ${isAuthError ? "auth" : "network"} cooldown, rotate to endpoint ${this._endpoints.currentIndex} (available=${rotated})`);
          continue;
        }
      }
    }
    throw lastErr;
  }

  _resolveTimeout(dataSourceName) {
    if (dataSourceName && this.dataSourceTimeouts[dataSourceName]) {
      const seconds = Number(this.dataSourceTimeouts[dataSourceName]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }
    return this.timeoutMs;
  }

  async _post(url, payload, { headers, expectJson, timeoutMs }) {
    const effectiveTimeout = timeoutMs || this.timeoutMs;
    const fetchOptions = {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(effectiveTimeout),
    };

    if (this.proxy) {
      fetchOptions.agent = this._proxyAgent;
    }

    let lastErr;
    const attempts = Math.max(1, this.retryAttempts + 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this._postOnce(url, fetchOptions, expectJson);
      } catch (err) {
        lastErr = err;
        const isRetriable = err.message?.includes("timeout") ||
          err.message?.includes("请求失败") ||
          err.message?.includes("不是有效 JSON") ||
          /HTTP 5\d{2}/.test(err.message);
        if (!isRetriable || attempt >= attempts) throw err;
        await sleep(this.retryDelayMs);
      }
    }
    throw lastErr || new DatasourceError("请求失败");
  }

  async _postOnce(url, fetchOptions, expectJson) {
    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
        throw new DatasourceError(`请求超时（${fetchOptions.signal?.timeout || this.timeoutMs}ms）`);
      }
      throw new DatasourceError(`请求失败: ${err.message}`);
    }

    const bodyText = await readTextWithLimit(response, MAX_BODY_SIZE);
    if (!response.ok) {
      let err;
      if (response.status === 401 || response.status === 403) {
        let errBody = null;
        try { errBody = JSON.parse(bodyText); } catch {}
        const errType = errBody?.error?.type || "";
        const errMsg = errBody?.error?.message || "";
        if (errType === "access_terminated_error" || errMsg.includes("usage limit")) {
          err = new DatasourceError(`Kimi 额度已用尽，请前往 https://www.kimi.com/code/console 查看配额或等待计费周期重置。`);
        } else {
          err = new DatasourceError(`Kimi datasource 鉴权失败 (HTTP ${response.status})，请检查 Kimi Code 凭证是否有效。`);
        }
      } else {
        err = new DatasourceError(`Kimi datasource 请求失败 (HTTP ${response.status}): ${bodyText.slice(0, 500)}`);
      }
      err.httpStatus = response.status;
      throw err;
    }

    if (!expectJson) return bodyText;

    try {
      return JSON.parse(bodyText);
    } catch (err) {
      throw new DatasourceError(`响应不是有效 JSON: ${bodyText.slice(0, 200)}`);
    }
  }

  _buildProxyAgent() {
    if (!this.proxy) return undefined;
    try {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      return new HttpsProxyAgent(this.proxy);
    } catch {
      return undefined;
    }
  }

}

function buildStockParams(ticker, queryType, queryTime, filePath, filesDir) {
  requiredString(ticker, "ticker");
  const tickers = ticker.split(",").map((s) => s.trim()).filter(Boolean);
  if (tickers.length === 0) throw new InputError("ticker 不能为空");
  if (tickers.length > 3) throw new InputError("ticker 最多支持 3 个代码，用逗号分隔");

  const type = (queryType || "realtime_price").trim();
  if (!VALID_STOCK_QUERY_TYPES.includes(type)) {
    throw new InputError(`type 必须是 ${VALID_STOCK_QUERY_TYPES.join(", ")} 之一`);
  }

  const params = {
    ticker,
    type,
    file_path: filePath ? filePath.trim() : defaultStockFilePath(ticker, type, filesDir),
  };
  if (queryTime && queryTime.trim()) {
    params.time = queryTime.trim();
  }
  return params;
}

function stockQueryMethod(queryType) {
  const type = (queryType || "realtime_price").trim();
  switch (type) {
    case "realtime_tech": return "get_stock_realtime_tech";
    case "open_summary": return "get_stock_open_summary";
    case "close_summary": return "get_stock_close_summary";
    case "realtime_price":
    default: return "get_stock_realtime_price";
  }
}

function defaultStockFilePath(ticker, queryType, filesDir) {
  const safe = ticker.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return path.join(filesDir || "/tmp", `kimi_datasource_stock_${safe}_${queryType}.csv`);
}

function defaultDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertAnnouncementTickerSupport(tickerChunks) {
  const unsupported = tickerChunks
    .flatMap((chunk) => String(chunk).split(","))
    .filter((ticker) => !/^\d{6}\.(?:SH|SZ|BJ)$/i.test(ticker));
  if (unsupported.length > 0) {
    throw new InputError(
      `公告查询仅支持 A 股代码（6 位数字且后缀为 .SH、.SZ 或 .BJ），不支持: ${unsupported.join(", ")}`
    );
  }
}

function validateStockToolParams(toolName, params) {
  if (toolName === "stock_finance") {
    requiredString(params?.statement, "statement");
    requiredString(params?.financial_parameter, "financial_parameter");
  }
  if (toolName === "stock_financial_index") {
    requiredString(params?.financial_parameter, "financial_parameter");
    requiredString(params?.category, "category");
  }
  if (toolName === "stock_business_segmentation") {
    requiredString(params?.financial_parameter, "financial_parameter");
  }
}

function extractResponseFiles(response) {
  if (!response || typeof response !== "object" || !Array.isArray(response.files)) return [];
  return response.files
    .filter((file) => file && typeof file === "object" && typeof file.content === "string")
    .map((file, index) => ({
      name: String(file.name || `file_${index + 1}`),
      encoding: file.encoding === "base64" ? "base64" : "utf8",
      content: file.content,
    }));
}

function collectTabularResults(results) {
  const rows = [];
  const errors = [];
  const nonTabularFiles = [];
  let successCount = 0;

  for (const result of results || []) {
    if (!result) continue;
    if (result.error) {
      errors.push(String(result.error));
      continue;
    }
    successCount++;
    for (const file of result.files || []) {
      if (isCsvFile(file)) {
        const content = decodeResponseFile(file);
        rows.push(...parseCsv(content));
      } else {
        nonTabularFiles.push({ name: file.name, encoding: file.encoding || "utf8" });
      }
    }
  }
  return { rows, errors, nonTabularFiles, successCount };
}

function buildTabularResult(source, results, meta = {}) {
  const merged = collectTabularResults(results);
  if (merged.successCount === 0) {
    throw new DatasourceError(merged.errors[0] || "数据源没有返回结果");
  }
  const resultMeta = withJsonOutputContract({
    ...omitMetaKeys(meta, ["includeMessage"]),
    row_count: merged.rows.length,
    non_tabular_files: merged.nonTabularFiles,
  });
  if (merged.errors.length > 0) resultMeta.warnings = merged.errors;
  return {
    ok: true,
    source,
    data: merged.rows,
    meta: resultMeta,
  };
}

function buildAnnouncementResult(rows, options) {
  const data = rows.map((row) => ({
    announcement_id: row.cninfo_announcement_id || row.announcementId || row.seq || "",
    date: row.reportDate || row.announcementDate || row.ctime || "",
    stock_code: row.stockCode || row.stock_code || row.secCode || row.thscode || "",
    stock_name: row.secName || row.stockName || row.stock_name || "",
    title: row.reportTitle || row.announcementTitle || row.title || "",
    cninfo_pdf_url: row.cninfo_pdf_url || "",
    cninfo_status: row.cninfo_status || "not_found",
    original_pdf_url: row.original_pdf_url || row.pdfURL || row.pdf_url || row.pdfUrl || "",
  }));
  const matched = data.filter((row) => row.cninfo_status === "matched").length;
  const meta = withJsonOutputContract({
    ticker: options.ticker,
    start_date: options.startDate,
    end_date: options.endDate,
    row_count: data.length,
    cninfo_matched_count: matched,
    cninfo_unmatched_count: data.length - matched,
    fetch_content_ignored: options.fetchContent,
  });
  if (options.errors.length > 0) meta.warnings = options.errors;
  return { ok: true, source: "kimi", data, meta };
}

function buildTianyanchaApiSearchResult(result, options) {
  const data = parseTianyanchaApiSearchText(result?.text || "");
  const nonTabularFiles = (result?.files || [])
    .filter((file) => !isCsvFile(file))
    .map((file) => ({ name: file.name, encoding: file.encoding || "utf8" }));
  return {
    ok: true,
    source: TIANYANCHA_DATA_SOURCE,
    data,
    meta: withJsonOutputContract({
      api_name: TIANYANCHA_APIS.apiSearch,
      query: options.query,
      limit: options.limit,
      row_count: data.length,
      non_tabular_files: nonTabularFiles,
    }),
  };
}

function parseTianyanchaApiSearchText(text) {
  let content = String(text || "").trim();
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed?.data)) return parsed.data;
    if (typeof parsed?.is_success === "string") content = parsed.is_success;
  } catch {}

  const marker = "## Available APIs";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return [];
  const lines = content.slice(markerIndex + marker.length).split("\n");
  const data = [];
  for (const line of lines) {
    const match = line.match(/^\s*\d+\s+(.+?)\s{2,}([A-Za-z][A-Za-z0-9_, ]*)(?:\s{2,}(.*\S))?\s*$/);
    if (!match) continue;
    data.push({
      api_name: match[1].trim(),
      params: match[2].split(",").map((value) => value.trim()).filter(Boolean),
      description: (match[3] || "").trim(),
    });
  }
  return data;
}

function isCsvFile(file) {
  return /\.csv$/i.test(String(file?.name || ""));
}

function decodeResponseFile(file) {
  if (file?.encoding === "base64") return Buffer.from(file.content, "base64").toString("utf8");
  return String(file?.content || "");
}

function omitMetaKeys(value, keys) {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function withJsonOutputContract(meta = {}) {
  return {
    output_schema: OUTPUT_SCHEMA_VERSION,
    output_format: "json",
    csv_handling: "parsed_in_memory",
    local_file_persistence: false,
    ...meta,
  };
}

async function runInBatches(items, concurrency, fn) {
  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map((item) => fn(item).catch((err) => ({ error: err.message }))));
    results.push(...batchResults);
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(response, mode) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return String(response);
  if (response.is_success === false) {
    const message = extractUserText(response.error) || JSON.stringify(response.error);
    // EMPTY_DATA 是数据源的正常空结果，不代表端点或鉴权失效。
    if (isEmptyDataMessage(message)) return "";
    throw new DatasourceError(`Kimi datasource 返回错误: ${message}`);
  }
  const result = response.result;
  const userText = extractRoleText(result, "user");
  const assistantText = extractRoleText(result, "assistant");

  if (mode === "legacy_zip") {
    return assistantText || userText || `调用成功但没有返回文本。原始响应:\n${JSON.stringify(response, null, 2)}`;
  }

  if (userText && !isEmptyDataPreview(userText)) {
    return userText;
  }
  if (assistantText) {
    return assistantText;
  }
  return userText || `调用成功但没有返回文本。原始响应:\n${JSON.stringify(response, null, 2)}`;
}

function isEmptyDataPreview(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed === "") return true;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && parsed.data_preview === null;
  } catch {
    return false;
  }
}

function extractUserText(value) {
  return extractRoleText(value, "user");
}

function isEmptyDataMessage(message) {
  return /\bEMPTY_DATA\b/i.test(String(message || ""));
}

function extractRoleText(value, role) {
  if (!value || typeof value !== "object" || !Array.isArray(value[role])) return null;
  const text = value[role]
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string" && item.text)
    .map((item) => item.text)
    .join("\n\n");
  return text || null;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new InputError(`缺少必填参数: ${field}`);
  }
  return value.trim();
}

function isFailoverable(err) {
  // InputError 不触发 failover（参数错误换端点也解决不了）
  if (err instanceof InputError) return false;
  // DatasourceError（含超时、5xx、401/403、业务错误）触发 failover
  if (err instanceof DatasourceError) return true;
  // 其他未知错误也触发 failover
  return true;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function readTextWithLimit(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new DatasourceError(`响应体超过 ${maxBytes} 字节限制`);
    }
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new DatasourceError(`响应体超过 ${maxBytes} 字节限制`);
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

module.exports = {
  KimiDatasourceClient,
  DatasourceError,
  InputError,
  VALID_STOCK_QUERY_TYPES,
};
