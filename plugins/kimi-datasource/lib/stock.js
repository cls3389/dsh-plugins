"use strict";

const path = require("node:path");

const MAX_TICKERS = 3;
const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_BATCH_CONCURRENCY = 3;

const STOCK_API_PREFIX = "stock_finance_data";

// 股票专用工具映射：工具名 → 底层 API 名（不带数据源前缀）
const STOCK_TOOL_APIS = {
  stock_info: "get_stock_info",
  stock_price: "get_price",
  stock_finance: "get_financial_statements",
  stock_financial_index: "get_stock_financial_index",
  stock_holders: "get_holder_info",
  stock_forecast: "get_forecast",
  stock_business_segmentation: "get_stock_business_segmentation",
  stock_announcements: "get_stock_announcement",
};

function splitTickers(ticker, max = MAX_TICKERS) {
  if (typeof ticker !== "string") return [];
  const list = ticker
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeTickerSuffix(s));
  const chunks = [];
  for (let index = 0; index < list.length; index += max) {
    chunks.push(list.slice(index, index + max).join(","));
  }
  return chunks;
}

function normalizeTickerSuffix(ticker) {
  // 无后缀的纯字母代码（如 NVDA、AAPL）默认为美股，自动补 .US
  if (/^[A-Za-z]+$/.test(ticker)) return `${ticker.toUpperCase()}.US`;
  return ticker;
}

function buildStockFilePath(filesDir, apiName, ticker) {
  const safeTicker = String(ticker).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeApi = String(apiName).replace(/[^A-Za-z0-9._-]+/g, "_");
  const filename = `${safeApi}_${safeTicker || "stock"}_${Date.now()}.csv`;
  return path.join(filesDir, filename);
}

function normalizeStockApiName(apiName) {
  // 允许传入带前缀或不带前缀的 API 名
  const prefix = `${STOCK_API_PREFIX}_`;
  if (typeof apiName !== "string") return "";
  if (apiName.startsWith(prefix)) return apiName;
  return `${STOCK_API_PREFIX}_${apiName}`;
}

function buildStockCallParams(toolName, params, filesDir) {
  const apiShortName = STOCK_TOOL_APIS[toolName];
  if (!apiShortName) {
    throw new Error(`Unknown stock tool: ${toolName}`);
  }
  const apiName = normalizeStockApiName(apiShortName);
  const ticker = params.ticker || "";
  const tickerChunks = splitTickers(ticker, DEFAULT_BATCH_SIZE);
  const result = [];
  for (const chunk of tickerChunks) {
    const callParams = { ...params, ticker: chunk };
    if (!callParams.file_path) {
      callParams.file_path = buildStockFilePath(filesDir, apiShortName, chunk);
    }
    result.push({ apiName, params: callParams, tickerChunk: chunk });
  }
  return result;
}

module.exports = {
  MAX_TICKERS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_BATCH_CONCURRENCY,
  STOCK_API_PREFIX,
  STOCK_TOOL_APIS,
  splitTickers,
  buildStockFilePath,
  normalizeStockApiName,
  buildStockCallParams,
};
