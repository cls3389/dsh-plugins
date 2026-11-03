/**
 * @dsh-friends/ths-favorites — 同花顺自选股 DSH 薄壳。
 *
 * 2026-11-02 重构：所有 THS 协议、cookie 编解码、protobuf、行情富化、
 * 登录流程全部在 ths-data-hub(Go) 实现。本文件只做：
 *   1. Cordis 工具注册（名称/schema/描述）；
 *   2. 会话身份解析 exec.agent → u_xxx；
 *   3. 带身份头把调用转发给中心，错误原样透传。
 * 用户 cookie/登录态由中心按用户目录(users/<u_xxx>/config/)管理，JS 零状态。
 */

import { identityOf, principalKey } from "../feishu-principal/index.js";
import fs from "node:fs";
import crypto from "node:crypto";

const name = "ths-favorites";
const inject = ["tools"];

const CONFIG_DEFAULTS = {
  dataHubBaseUrl: "",
  dataHubToken: "",
  dataHubTokenFile: "",
  dataHubTimeoutMs: 20000,
  defaultAppId: "",
  // 仅 Web 单用户（无飞书身份）用 owner 中心账号；飞书用户一律按各自 u_xxx。
  defaultAgentId: "",
  syncTableEnabled: false,
  syncTableBaseUrl: "http://127.0.0.1:39871",
  syncTimeoutMs: 300000,
};

function readToken(cfg) {
  const direct = String(cfg.dataHubToken ?? "").trim();
  if (direct) return direct;
  if (!cfg.dataHubTokenFile) return "";
  try { return fs.readFileSync(cfg.dataHubTokenFile, "utf8").trim(); }
  catch { return ""; }
}

/** 会话身份 → 中心用户身份。飞书用户用身份簇 u_xxx；Web owner 返回 null（走中心 owner 账号）。 */
function resolveUserId(exec, cfg) {
  const identity = identityOf(exec?.agent);
  const openId = exec?.agent?.larkUser?.openId ?? identity?.subjectId;
  if (typeof openId === "string" && openId.startsWith("ou_")) {
    const appId = exec?.agent?.larkUser?.appId ?? identity?.appId;
    return principalKey(openId, appId, cfg.defaultAppId);
  }
  return null; // Web owner：中心 owner 账号（军的 L2 权限账号）
}

/** 统一中心调用：解析身份，加 Bearer + 用户头，解 {ok,data}，错误透传。 */
async function hubCall(exec, cfg, method, path, { body, query, userScoped = true, binary = false } = {}) {
  const base = String(cfg.dataHubBaseUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("dataHubBaseUrl 未配置");
  const token = readToken(cfg);
  const userId = userScoped ? resolveUserId(exec, cfg) : null;
  let url = base + path;
  if (query) url += "?" + new URLSearchParams(query).toString();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (userId) headers["X-THS-User-Id"] = userId;
  const resp = await fetch(url, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Number(cfg.dataHubTimeoutMs ?? 20000)),
  });
  if (binary) {
    if (!resp.ok) throw new Error(`数据中心 HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    const err = new Error(data?.error || `数据中心 HTTP ${resp.status}`);
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}

/** 用户态路径：飞书用户走 /api/user/*（带身份头），owner 走 /api/*（owner 账号）。 */
/** Web(无飞书身份)与飞书用户统一走用户态端点：中心把空 X-THS-User-Id 映射到
 *  HUB_OWNER_USER_ID(军)，所以 Web 和军飞书共用同一份登录态，扫一次通两处。
 *  不再区分 /api vs /api/user —— 差异只在中心，插件无分支。 */
function scopePath(path) {
  return `/api/user${path}`;
}

/** 登录路径不 scope：中心 /api/login/* 已按 X-THS-User-Id 归属隔离 cookie 落盘。 */
function loginPath(path) {
  return `/api${path}`;
}

function authErrorMessage(err) {
  if (err?.statusCode === 401) return "同花顺登录态已过期或未登录，请重新调用 ths_login 注入 Cookie，或 ths_qr_login 扫码登录";
  return err?.message ?? String(err);
}

const anyJsonOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => {
    const text = JSON.stringify(value, null, 1);
    return [{ type: "text", text: text.length > 20000 ? `${text.slice(0, 20000)}\n…(已截断,共 ${text.length} 字符)` : text }];
  },
};

// Display large lists as labelled tuples; execution results retain full objects.
const favoriteColumns = ['code', 'market_abbr', 'name', 'price', 'changePercent', 'open', 'high', 'low', 'volume', 'amount', 'quote_status'];
const favoritesOutput = {
  schema: anyJsonOutput.schema,
  render: (_args, value) => {
    const rows = (items) => (items ?? []).map(item => favoriteColumns.map(key => key === 'quote_status' ? item.quote_status ?? null : item[key] ?? null));
    const display = { ...value, columns: favoriteColumns, display_format: 'columns/rows; complete execution result retains full objects' };
    if (Array.isArray(value.items)) { delete display.items; display.rows = rows(value.items); }
    if (value.groups?.items) {
      display.groups = { ...value.groups, items: value.groups.items.map(group => {
        const { items, ...meta } = group; return { ...meta, rows: rows(items) };
      }) };
    }
    const text = JSON.stringify(display);
    return [{ type: 'text', text }];
  },
};

// ── 二维码图片：中心二进制 → 本地文件，供 feishu_send_image 发送 ──
/** QR 图片路径必须命中 feishu_send_image 的 isQr 规则（扫码目录 + qr-<hex>.png）。 */
function qrImagePath() {
  const hex = crypto.randomBytes(8).toString("hex"); // [a-f0-9]+
  return `/tmp/openclaw-ths-qr/qr-${hex}.png`;
}

async function saveQrImage(buffer) {
  const path = qrImagePath();
  await fs.promises.mkdir(`/tmp/openclaw-ths-qr`, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path, buffer, { mode: 0o600 });
  return path;
}

function apply(ctx, config) {
  const cfg = { ...CONFIG_DEFAULTS, ...config };

  const register = (def) => ctx.tools.register({ ...def, output: def.output ?? anyJsonOutput });

  // Login validation never accepts credentials or replaces the saved login.
  register({
    name: "ths_login_status",
    description: "无损检查当前用户自选股或问财的登录状态，不导入凭据、不覆盖已保存登录。channel=main检查自选股，wencai检查问财；上游暂不可达应报告unknown，不能当作未登录。登录失效时使用对应扫码工具；证券交易连接用ths_account单独查询。",
    parameters: { type: "object", additionalProperties: false, properties: {
      channel: { type: "string", enum: ["main", "wencai"], description: "main=同花顺自选股；wencai=问财，默认main" },
    } },
    async execute(args, exec) {
      try {
        const data = await hubCall(exec, cfg, "GET", loginPath("/login/status"), { query: { channel: args?.channel ?? "main" } });
        return data.data ?? data;
      } catch (err) { return { error: authErrorMessage(err) }; }
    },
  });

  // ── ths_qr_login（扫码，中心后台自动轮询落 cookie）──
  register({
    name: "ths_qr_login",
    description: "当前用户的同花顺自选股扫码登录（主站域），不登录问财，也不连接证券交易账户。action=create 返回二维码图片，飞书中调用 feishu_send_image 发送后结束本轮；中心自动轮询，手机确认后保存。action=check 仅在需要时主动查询一次状态。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "check", "poll"], description: "create=生成二维码；check=查一次状态；poll=兼容保留" },
        qrid: { type: "string", description: "action=check/poll 时必填" },
      },
      required: ["action"],
    },
    async execute(args, exec) {
      try {
        if (args.action === "create") {
          const created = await hubCall(exec, cfg, "POST", loginPath("/login/start") + "?channel=main", { body: {} });
          const qrid = created.data?.qrid ?? created.qrid;
          const img = await hubCall(exec, cfg, "GET", loginPath("/login/qrimg"), { query: { qrid }, binary: true });
          const savePath = await saveQrImage(img);
          return {
            status: "ok", action: "create", qrid, output: savePath, media: savePath,
            mediaUrls: [savePath], trustedLocalMedia: true,
            message: `登录二维码已生成，请立即把图片发送给用户（有效期约 120 秒）。图片路径：${savePath}`,
            instructions: `只调用一次 feishu_send_image(path=${JSON.stringify(savePath)}) 发送二维码，然后结束本轮。中心自动轮询，用户扫完手机确认即可，无需再回复。`,
          };
        }
        if (args.action === "check" || args.action === "poll") {
          if (!args.qrid) return { error: "缺少 qrid 参数" };
          const data = await hubCall(exec, cfg, "GET", loginPath("/login/poll"), { query: { qrid: args.qrid } });
          const state = data.data?.state ?? data.state;
          if (state === "done") return { status: "ok", action: args.action, message: "扫码登录成功，Cookie 已更新到数据中心" };
          if (state === "error") return { error: `登录失败: ${data.data?.error ?? data.error ?? "未知错误"}` };
          return { status: "pending", action: args.action, state, message: "尚未确认，等待用户在手机上确认登录" };
        }
        return { error: "action 必须是 create 或 check" };
      } catch (err) { return { error: authErrorMessage(err) }; }
    },
  });

  // ── ths_list_groups ──
  register({
    name: "ths_list_groups",
    output: favoritesOutput,
    description: "查看当前用户自选股分组和成员，批量补充公共名称与行情，失败显式标明。include_self_stocks可包含「我的自选」；成员归属按用户隔离。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { include_self_stocks: { type: "boolean", description: "是否包含「我的自选」，默认 false", default: false } },
    },
    async execute(args, exec) {
      try {
        const data = await hubCall(exec, cfg, "GET", scopePath("/favorites/groups"), { query: { include_self: args?.include_self_stocks === true ? "true" : "false" } });
        const groups = data.data ?? {};
        return { status: "ok", count: Array.isArray(groups.items) ? groups.items.length : Object.keys(groups).length, groups };
      } catch (err) { return { error: authErrorMessage(err) }; }
    },
  });

  // ── ths_get_self_stocks ──
  register({
    name: "ths_get_self_stocks",
    output: favoritesOutput,
    description: "查询当前用户「我的自选」成员，批量用共享行情补全名称、价格、涨跌幅及量额；成员列表按用户隔离。补全失败仍保留代码、市场并标明quote状态；行情采集时间不等于交易源时间。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      try {
        const data = await hubCall(exec, cfg, "GET", scopePath("/favorites/self"));
        const group = data.data ?? {};
        return { status: "ok", count: (group.items ?? []).length, items: group.items ?? [], quote_enrichment: group.quote_enrichment, quote_freshness: group.quote_freshness };
      } catch (err) { return { error: authErrorMessage(err) }; }
    },
  });

  // ── 写操作统一助手 ──
  const writeOp = (fn) => async (args, exec) => {
    try { return await fn(args, exec); }
    catch (err) { return { error: authErrorMessage(err) }; }
  };

  register({
    name: "ths_add_stock",
    description: "添加股票到指定分组（支持批量）。「我的自选」用自选股接口。A/H 股支持 600000.SH、00700.HK 等格式。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        group: { type: "string", description: "分组名称" },
        symbols: { type: "array", items: { type: "string" }, description: "股票代码数组" },
      },
      required: ["group", "symbols"],
    },
    execute: writeOp(async (args, exec) => {
      if (!args?.group) return { error: "缺少分组名称" };
      if (!Array.isArray(args?.symbols) || args.symbols.length === 0) return { error: "缺少股票代码" };
      const data = await hubCall(exec, cfg, "POST", scopePath("/favorites/items"), { body: { group: args.group, symbols: args.symbols, action: "add" } });
      return { status: "ok", ...data.data };
    }),
  });

  register({
    name: "ths_remove_stock",
    description: "从指定分组删除股票（支持批量）。「我的自选」用自选股接口。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        group: { type: "string", description: "分组名称" },
        symbols: { type: "array", items: { type: "string" }, description: "股票代码数组" },
      },
      required: ["group", "symbols"],
    },
    execute: writeOp(async (args, exec) => {
      if (!args?.group) return { error: "缺少分组名称" };
      if (!Array.isArray(args?.symbols) || args.symbols.length === 0) return { error: "缺少股票代码" };
      const data = await hubCall(exec, cfg, "POST", scopePath("/favorites/items"), { body: { group: args.group, symbols: args.symbols, action: "remove" } });
      return { status: "ok", ...data.data };
    }),
  });

  register({
    name: "ths_add_group",
    description: "新建一个自选股分组。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string", description: "新分组名称" } },
      required: ["name"],
    },
    execute: writeOp(async (args, exec) => {
      if (!args?.name) return { error: "缺少分组名称" };
      const data = await hubCall(exec, cfg, "POST", scopePath("/favorites/group"), { body: { name: args.name } });
      return { status: "ok", result: data.data };
    }),
  });

  register({
    name: "ths_delete_group",
    description: "删除一个自选股分组。需要提供分组名称。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { group: { type: "string", description: "要删除的分组名称" } },
      required: ["group"],
    },
    execute: writeOp(async (args, exec) => {
      if (!args?.group) return { error: "缺少分组名称" };
      const data = await hubCall(exec, cfg, "DELETE", scopePath("/favorites/group"), { body: { name: args.group } });
      return { status: "ok", result: data.data };
    }),
  });

  register({
    name: "ths_share_group",
    description: "分享自选股分组并生成短期有效链接。需要提供分组名称和有效时间（秒）。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        group: { type: "string", description: "要分享的分组名称" },
        valid_time: { type: "number", description: "链接有效时间（秒）" },
      },
      required: ["group", "valid_time"],
    },
    execute: writeOp(async (args, exec) => {
      if (!args?.group) return { error: "缺少分组名称" };
      if (args?.valid_time === undefined || args?.valid_time === null) return { error: "缺少有效时间" };
      const data = await hubCall(exec, cfg, "POST", scopePath("/favorites/share"), { body: { group: args.group, valid_time: Number(args.valid_time) } });
      return { status: "ok", result: data.data };
    }),
  });

  register({
    name: "ths_sort_group",
    description: "重新排列指定分组内的股票顺序。通过 blockstock 协议全量上传实现排序。不支持「我的自选」虚拟分组。未在排序列表中出现的股票将按原顺序追加到末尾。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        group: { type: "string", description: "分组名称" },
        ordered_symbols: { type: "array", items: { type: "string" }, description: "按目标顺序排列的股票代码数组" },
      },
      required: ["group", "ordered_symbols"],
    },
    execute: writeOp(async (args, exec) => {
      if (!args?.group) return { error: "缺少分组名称" };
      if (!Array.isArray(args?.ordered_symbols) || args.ordered_symbols.length === 0) return { error: "缺少排序后的股票代码列表" };
      const data = await hubCall(exec, cfg, "POST", scopePath("/favorites/sort"), { body: { group: args.group, ordered_symbols: args.ordered_symbols } });
      return { status: "ok", ...data.data };
    }),
  });

  // ── ths_sync_table（可选，运维批量刷多维表，不属于自选常规能力）──
  if (cfg.syncTableEnabled === true) {
    register({
      name: "ths_sync_table",
      description: "触发 fuyao-feishu-sync 服务，从同花顺扶摇金融数据 API 拉取最新行情更新到飞书多维表。非交易日默认跳过；force=true 强制执行；dry_run=true 只生成计划不写入。",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          force: { type: "boolean", description: "非交易日也强制执行，默认 false" },
          dry_run: { type: "boolean", description: "只生成更新计划不实际写入，默认 false" },
        },
      },
      async execute(args) {
        const baseUrl = String(cfg.syncTableBaseUrl ?? "").replace(/\/+$/, "");
        try {
          const resp = await fetch(`${baseUrl}/sync`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: Boolean(args?.force), dry_run: Boolean(args?.dry_run) }),
            signal: AbortSignal.timeout(Number(cfg.syncTimeoutMs ?? 300000)),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) return { error: `同步失败（HTTP ${resp.status}）: ${data?.error || "未知错误"}` };
          return { status: "ok", ...data };
        } catch (err) {
          return { error: `同步服务不可达（${baseUrl}）: ${err.message}` };
        }
      },
    });
  }

  ctx.logger.info("[ths-favorites] active: 薄壳模式，业务在 ths-data-hub");
  return () => {};
}

export { apply, inject, name, qrImagePath };
