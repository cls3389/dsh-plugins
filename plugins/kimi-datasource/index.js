// @dsh-friends/kimi-datasource — Kimi 专业数据库（dsh 移植版，2026-10-30）。
// 源自 openclaw 扩展 kimi-datasource（lib/ 原样复用），只注册精选工具面：
//   kimi_datasource_query_stock  实时行情（A股/港股/美股，自动分批）
//   kimi_tyc_search              天眼查企业搜索（不知道全称时的兜底）
//   kimi_tyc_company             天眼查工商信息（固定调用已验证接口）
// openclaw 版其余工具族（kimi_stock_* 12 个财务工具、tyc_apis/tyc_query）
// 按需再开——精选面避免 258 工具淹没上下文的老问题。
//
// 端点配置（profile patch，最多 2 个公网端点做 failover；不设任何内网默认）：
//   endpoints:
//     - apiUrl: https://agent-gw.kimi.com/coding/v1/tools
//       apiKeyRef: KIMI_DS_KEY_PRIMARY
//     - apiUrl: https://api.kimi.com/coding/v1/tools
//       apiKeyRef: KIMI_DS_KEY_SECONDARY

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const { KimiAuth, AuthError } = require('./lib/auth');
const { KimiDatasourceClient, InputError, VALID_STOCK_QUERY_TYPES } = require('./lib/client');

const DEFAULT_FILES_DIR = () => path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'cache', 'kimi-datasource', 'files');

export const inject = ['tools'];

function sanitize(message) {
  return String(message ?? '')
    .replace(/sk-[A-Za-z0-9-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+\S+/g, 'Bearer ***')
    .replace(/\/home\/[^\s]+/g, '/home/***')
    .replace(/\/Users\/[^\s]+/g, '/Users/***');
}

async function readEndpoints(config, ctx) {
  const raw = (Array.isArray(config.endpoints) ? config.endpoints : [])
    .filter((ep) => ep && typeof ep.apiUrl === 'string' && ep.apiUrl && !/10\.3\.1\./.test(ep.apiUrl))
    .slice(0, 2);
  const resolveKey = async (ref) => {
    if (!ref) return '';
    // credentials 服务未挂载的 profile(如 feishu)直读 $DSH_HOME/.credentials.yaml
    // 的 refs 段(与 media-tools 同款兜底),再退环境变量。
    const credentials = ctx.get('credentials');
    if (credentials?.resolve) {
      try {
        const hit = await credentials.resolve(ref);
        if (typeof hit?.value === 'string' && hit.value) return hit.value;
      } catch { /* fallthrough */ }
    }
    try {
      const base = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
      const text = fs.readFileSync(path.join(base, '.credentials.yaml'), 'utf8');
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = text.match(new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`, 'm'));
      if (match?.[1] && !match[1].startsWith('"')) return match[1];
    } catch { /* fallthrough */ }
    return process.env[ref] ?? '';
  };
  const resolved = [];
  for (const ep of raw) {
    const apiKey = ep.apiKeyRef ? await resolveKey(ep.apiKeyRef) : (typeof ep.apiKey === 'string' ? ep.apiKey : '');
    if (ep.apiUrl && apiKey) resolved.push({ apiUrl: ep.apiUrl, apiKey });
  }
  return resolved;
}

export async function apply(ctx, config = {}) {
  const logger = ctx.get('logger') ?? console;
  const endpoints = await readEndpoints(config, ctx);
  if (endpoints.length === 0) {
    logger.warn?.('[kimi-datasource] no usable endpoints configured; tools stay unregistered');
    return;
  }

  const dataDir = path.resolve(DEFAULT_FILES_DIR(), '..');
  const auth = new KimiAuth({
    dataDir,
    apiKey: endpoints[0].apiKey,
    timeoutSeconds: Number(config.timeoutSeconds ?? 30),
    proxy: typeof config.proxy === 'string' ? config.proxy : '',
  });
  const client = new KimiDatasourceClient(auth, {
    endpoints,
    apiUrl: endpoints[0].apiUrl,
    timeoutSeconds: Number(config.timeoutSeconds ?? 30),
    proxy: typeof config.proxy === 'string' ? config.proxy : '',
    responseParseMode: 'official',
    filesDir: DEFAULT_FILES_DIR(),
    failoverCooldownSeconds: Number(config.failoverCooldownSeconds ?? 60),
    authFailoverCooldownSeconds: Number(config.authFailoverCooldownSeconds ?? 300),
    logger,
  });

  const toolError = (type, message) => ({ ok: false, error: { type, message } });
  const runTool = (factory, toolName, params) => factory().catch((error) => {
    logger.warn?.(`[kimi-datasource] [tool=${toolName}] failed: ${sanitize(error?.message ?? error)}`);
    if (error instanceof AuthError) return toolError('auth_error', `Kimi 认证失败: ${sanitize(error)}`);
    if (error instanceof InputError) return toolError('input_error', `参数错误: ${sanitize(error?.message)}`);
    return toolError('upstream_error', `Kimi datasource 调用失败: ${sanitize(error)}`);
  });
  const anyJsonOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };

  ctx.tools.register({
    name: 'kimi_datasource_query_stock',
    description: '查询股票实时价格（Kimi 专业数据库：A股/港股/美股）。支持逗号分隔多只代码，超过 3 只自动分批合并；返回结构化 JSON。例如 600519.SH、0700.HK。历史行情/财务等深度数据暂未迁移，请用 ths 系工具。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ticker: { type: 'string', description: '股票代码列表，逗号分隔，例如 600519.SH 或 0700.HK' },
        type: { type: 'string', enum: [...VALID_STOCK_QUERY_TYPES], description: '查询类型' },
        time: { type: 'string', description: '可选时间参数，仅部分实时接口支持' },
      },
      required: ['ticker'],
    },
    output: anyJsonOutput,
    execute: (params) => runTool(() => client.queryStock(params.ticker, params.type, params.time), 'kimi_datasource_query_stock', params),
  });

  ctx.tools.register({
    name: 'kimi_tyc_search',
    description: '天眼查企业搜索（Kimi）：不知道企业全称/统一社会信用代码/注册号时先用本工具找候选；已知全称请直接用 kimi_tyc_company。返回候选企业 JSON。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        search_keyword: { type: 'string', description: '企业简称、名称、统一社会信用代码或注册号' },
        page_size: { type: 'integer', description: '返回条数 1-20，默认 20' },
        page_num: { type: 'integer', description: '页码，默认 1' },
      },
      required: ['search_keyword'],
    },
    output: anyJsonOutput,
    execute: (params) => runTool(() => client.searchTianyanchaCompanies(params), 'kimi_tyc_search', params),
  });

  ctx.tools.register({
    name: 'kimi_tyc_company',
    description: '天眼查企业工商信息（Kimi）：传企业全称、统一社会信用代码或注册号（不要传简称，不确定先用 kimi_tyc_search）；固定调用已验证的「工商信息-企业基本信息」接口，返回 JSON。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { keyword: { type: 'string', description: '企业全称、统一社会信用代码或注册号' } },
      required: ['keyword'],
    },
    output: anyJsonOutput,
    execute: (params) => runTool(() => client.queryTianyanchaCompanyProfile(params), 'kimi_tyc_company', params),
  });

  logger.info?.(`[kimi-datasource] active: query_stock + tyc_search + tyc_company (${endpoints.length} endpoints)`);
}
