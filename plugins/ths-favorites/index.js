/**
 * @dsh-friends/ths-favorites — 同花顺自选股(每用户独立登录态)
 *
 * 2026-10-29 自 OpenClaw ths-favorite 整体移植:
 *   - 直连同花顺官方接口(ugc/t/cs.10jqka.com.cn,手机端 UA)
 *   - 飞书 sender_open_id 独立 Cookie 缓存与自选操作；换会话仍属于同一用户，
 *     扫码(ths_qr_login)/Cookie(ths_login)/密码(ths_password_login)三种登录
 *   - 12 工具:登录×3 + 分组增删查 + 股票增删排序 + 分享 + 同步表格
 *   - 状态目录默认 /data/dsh/storages/ths-favorites/<agentId>/
 * OpenClaw 原版:api.registerTool 工厂按 ctx.agentId 绑定;DSH 版在 execute
 * 时解析 exec.agent.sessionId,同一身份的 PortfolioManager 复用缓存。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";
import { principalKey, stateForKey } from "../feishu-principal/index.js";

const PLUGIN_ID = "ths-favorite";

// ─── config.py constants ──────────────────────────────────────────────────────
const DEFAULT_HEADERS = {
  "User-Agent":
    "Hexin_Gphone/11.28.03 (Royal Flush) hxtheme/0 innerversion/G037.09.028.1.32 followPhoneSystemTheme/0 userid/000000000 getHXAPPAccessibilityMode/0 hxNewFont/1 isVip/0 getHXAPPFontSetting/normal getHXAPPAdaptOldSetting/0 okhttp/3.14.9",
};
const API_BASE_URL = "https://ugc.10jqka.com.cn";
const SELF_STOCK_V2_BASE_URL = "https://t.10jqka.com.cn";
const SELF_STOCK_V2_LIST_PATH = "/newcircle/group/getSelfStockWithMarket/";
const SELF_STOCK_V2_MODIFY_PATH = "/newcircle/group/modifySelfStock/";
const SELF_STOCK_V1_BASE_URL = "https://ugc.10jqka.com.cn";
const SELF_STOCK_V1_QUERY_PATH = "/optdata/selfstock/open/api/v1/query";
const SELF_STOCK_V1_MODIFY_PATH = "/optdata/selfstock/open/api/v1/modify";
const MULTI_STORAGE_URL = "https://cs.10jqka.com.cn/multiStorage";
const BLOCKSTOCK_APPNAME = "blockstock";
const MULTI_STORAGE_DEFAULT_CLIENTTYPE = "hevo_pc";
const DYNAMIC_PLATE_BASE_URL = "https://apigate.10jqka.com.cn";
const DYNAMIC_PLATE_SELECT_PATH = "/d/platform/dynamicplate/stocks/self/v2/select";
const US_QUOTE_BASE_URL = "https://d.10jqka.com.cn/v2/realhead";
const ENDPOINTS = {
  query_groups: "/optdata/selfgroup/open/api/group/v1/query",
  add_item: "/optdata/selfgroup/open/api/content/v1/add",
  delete_item: "/optdata/selfgroup/open/api/content/v1/delete",
  add_group: "/optdata/selfgroup/open/api/group/v1/add",
  delete_group: "/optdata/selfgroup/open/api/group/v1/delete",
  share_group: "/optdata/sharing_service/open/api/sharing/v1/create",
};
const SELF_STOCK_GROUP_ID = "__selfstock__";
const SELF_STOCK_DEFAULT_NAME = "我的自选";
const DEFAULT_FROM_PARAM = "sjcg_gphone";
const GROUP_QUERY_TYPES = "0,1";
const DEFAULT_HTTP_TIMEOUT = 10000;
const DEFAULT_STATE_DIR = (process.env.DSH_HOME ?? require("node:os").homedir() + "/.dsh") + "/storages/ths-favorites";
const QR_IMAGE_ROOT = "/tmp/openclaw-ths-qr";
const QR_OWNER_TTL_MS = 2 * 60 * 1000;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

// ─── Tool result envelope (tool_call bridge requires content[] + details) ────
function safeStringify(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : String(text);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable tool result]";
    }
  }
}

function wrapToolResult(value) {
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    return value;
  }
  return {
    content: [{ type: "text", text: safeStringify(value) }],
    details: value,
  };
}

function wrapScopedTool(tool) {
  if (tool && typeof tool.execute === "function") {
    const rawExecute = tool.execute;
    tool.execute = async (toolCallId, params) => wrapToolResult(await rawExecute(toolCallId, params));
  }
  return tool;
}

// ─── constant.py market code mapping ──────────────────────────────────────────
const MARKET_CODE = {
  SH: "17", SHETF: "20", ST: "22", SZ: "33", SZETF: "36",
  ZS: "48", CYB: "38", KC: "18", BJ: "71", HK: "55",
  // US ids are exchange-specific (for example NASDAQ=185, NYSE=169).
  // 61 appears in older blockstock data and is resolved again when possible.
  US: "185", FT: "50", QH: "51", QZ: "53", OP: "79",
  JJ: "39", ZQ: "45", XSB: "67",
};
// US market ids are exchange-specific in the current THS protocol. The
// legacy generic US id (61) is retained only when reading old records.
const US_MARKET_ALIASES = { NYSE: "169", NASDAQ: "185" };
const US_MARKET_IDS = new Set([
  ...Object.values(US_MARKET_ALIASES),
  "170", "184", "186", "187", "188", "189", "201", "202",
]);
const MARKET_NAME = {
  ...Object.fromEntries(Object.entries(MARKET_CODE).map(([k, v]) => [v, k])),
  ...Object.fromEntries([...US_MARKET_IDS].map((id) => [id, "US"])),
  "61": "US",
  "151": "BJ",
};

function marketAbbr(marketType) { return MARKET_NAME[String(marketType)] || String(marketType); }
function marketCode(abbr) { return MARKET_CODE[String(abbr).toUpperCase()] || String(abbr); }

// ─── _protobuf.py wire format ─────────────────────────────────────────────────
function encodeVarint(value) {
  const buf = [];
  while (value > 127) { buf.push((value & 0x7f) | 0x80); value >>>= 7; }
  buf.push(value & 0x7f);
  return Buffer.from(buf);
}

function decodeVarint(data, offset) {
  let value = 0, shift = 0;
  while (offset < data.length) {
    const byte = data[offset];
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value, offset };
}

function fieldVarint(fieldNumber, value) {
  const tag = (fieldNumber << 3) | 0; // wire type 0
  return Buffer.concat([encodeVarint(tag), encodeVarint(value)]);
}

function fieldBytes(fieldNumber, payload) {
  const tag = (fieldNumber << 3) | 2; // wire type 2
  return Buffer.concat([encodeVarint(tag), encodeVarint(payload.length), Buffer.from(payload)]);
}

/**
 * Walk a protobuf message buffer, calling cb(tag, wireType, data, offset).
 * For varint fields, data is a number; for length-delimited, data is a Buffer.
 */
function walkProtobuf(buf, offset, end, cb) {
  while (offset < end) {
    const { value: tagVal, offset: o1 } = decodeVarint(buf, offset);
    const fieldNumber = tagVal >>> 3;
    const wireType = tagVal & 0x07;
    offset = o1;
    if (wireType === 0) {
      const { value, offset: o2 } = decodeVarint(buf, offset);
      offset = o2;
      if (cb(fieldNumber, wireType, value, null) === false) return;
    } else if (wireType === 2) {
      const { value: len, offset: o3 } = decodeVarint(buf, offset);
      offset = o3;
      const payload = buf.slice(offset, offset + len);
      offset += len;
      if (cb(fieldNumber, wireType, null, payload) === false) return;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break; // unknown wire type, stop
    }
  }
}

// ─── XML helpers (simple regex-based parsing) ─────────────────────────────────
function parseXmlItems(xml) {
  // Extract <item .../> or <item ...>...</item> attributes
  const results = [];
  const re = /<item\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrsStr = m[1];
    const attrs = {};
    const are = /(\w+)=\"([^\"]*)\"/g;
    let am;
    while ((am = are.exec(attrsStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    results.push(attrs);
  }
  return results;
}

function getXmlAttr(xml, attrName) {
  const items = parseXmlItems(xml);
  for (const item of items) {
    if (item[attrName] !== undefined) return item[attrName];
  }
  return null;
}

function getXmlItem(xml) {
  const items = parseXmlItems(xml);
  return items[0] || {};
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function cookieString(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function httpGet(url, opts = {}) {
  const { headers = {}, cookies = {}, params = {}, timeout = DEFAULT_HTTP_TIMEOUT } = opts;
  const urlObj = new URL(url);
  for (const [k, v] of Object.entries(params)) urlObj.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(urlObj.toString(), {
      method: "GET",
      headers: { Cookie: cookieString(cookies), ...headers },
      signal: controller.signal,
    });
    const text = await resp.text();
    return { resp, text };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPostForm(url, data, opts = {}) {
  const { headers = {}, cookies = {}, timeout = DEFAULT_HTTP_TIMEOUT } = opts;
  const body = new URLSearchParams(data).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieString(cookies), ...headers },
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    return { resp, text };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPostJson(url, data, opts = {}) {
  const { headers = {}, cookies = {}, timeout = DEFAULT_HTTP_TIMEOUT } = opts;
  const body = JSON.stringify(data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieString(cookies), ...headers },
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    return { resp, text };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPostMultipart(url, data, payloadBuffer, opts = {}) {
  const { headers = {}, cookies = {}, timeout = DEFAULT_HTTP_TIMEOUT } = opts;
  const formData = new FormData();
  for (const [k, v] of Object.entries(data)) formData.append(k, String(v));
  formData.append("uploadFile", new Blob([payloadBuffer]), "testFileList");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Cookie: cookieString(cookies), ...headers },
      body: formData,
      signal: controller.signal,
    });
    const text = await resp.text();
    return { resp, text };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPostMultipartBinary(url, data, payloadBuffer, opts = {}) {
  const { headers = {}, cookies = {}, timeout = DEFAULT_HTTP_TIMEOUT } = opts;
  const formData = new FormData();
  for (const [k, v] of Object.entries(data)) formData.append(k, String(v));
  formData.append("uploadFile", new Blob([payloadBuffer]), "testFileList");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Cookie: cookieString(cookies), ...headers },
      body: formData,
      signal: controller.signal,
    });
    const ab = await resp.arrayBuffer();
    return { resp, buffer: Buffer.from(ab) };
  } finally {
    clearTimeout(timer);
  }
}

async function httpGetBinary(url, opts = {}) {
  const { headers = {}, cookies = {}, params = {}, timeout = DEFAULT_HTTP_TIMEOUT } = opts;
  const urlObj = new URL(url);
  for (const [k, v] of Object.entries(params)) urlObj.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(urlObj.toString(), {
      method: "GET",
      headers: { Cookie: cookieString(cookies), ...headers },
      signal: controller.signal,
    });
    const ab = await resp.arrayBuffer();
    return { resp, buffer: Buffer.from(ab) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── blockstock.py: auth params, protobuf encode/decode ──────────────────────

function extractAuthParamsFromCookies(cookies) {
  const params = {};
  if (cookies.userid) params.userid = cookies.userid;

  // The `user` cookie is URL-encoded, then base64-encoded, colon-separated.
  // sessionid is at index 17 per the Python source.
  let sessionid = "";
  if (cookies.user) {
    try {
      const unquoted = decodeURIComponent(cookies.user);
      const decoded = Buffer.from(unquoted, "base64").toString("utf8");
      const parts = decoded.split(":");
      if (parts.length > 17) sessionid = parts[17];
      if (parts.length > 0) params.userid = params.userid || parts[0];
    } catch (_e) { /* ignore decode errors */ }
  }
  if (sessionid) params.sessionid = sessionid;
  else if (cookies.sessionid) params.sessionid = cookies.sessionid;

  // Generate expires (now + 24h, format: YYYY-MM-DD HH:MM:SS)
  const d = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  params.expires = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  return params;
}

// ─── Login: mobile password auth (auth.10jqka.com.cn) ────────────────────────

const AUTH_BASE_URL = "https://auth.10jqka.com.cn";
const UPASS_BASE_URL = "https://upass.10jqka.com.cn";
const AUTH_TA_APPID = "2022021114090152";
const AUTH_IMEI = "ZjI6MDY6NGE6NzI6MjQ6NTA="; // fixed base64 device fingerprint
const AUTH_QSID = "8003";
const AUTH_PRODUCT = "S01";
const AUTH_VERSION = "11.4.1.3";

async function getRsaPublicKey() {
  const url = `${AUTH_BASE_URL}/verify2?reqtype=do_rsa&type=get_pubkey`;
  const { text } = await httpGet(url, { headers: DEFAULT_HEADERS });
  const item = getXmlItem(text);
  const pubkey = item.pubkey;
  const rsaVersion = item.rsa_version;
  if (!pubkey) throw new Error(`获取 RSA 公钥失败: ${text.slice(0, 200)}`);
  return { pubkey, rsaVersion };
}

function rsaEncrypt(plaintext, pubkeyPem) {
  // The pubkey from API is PEM format but may use \r\n; normalize
  const pem = pubkeyPem.replace(/\\r\\n/g, "\n").trim();
  const encrypted = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8")
  );
  return encrypted.toString("base64");
}

async function doMobileLogin(account, password) {
  // Step 1: Get RSA public key
  const { pubkey, rsaVersion } = await getRsaPublicKey();

  // Step 2: Unified login (account + password RSA encrypted)
  const encAccount = rsaEncrypt(account, pubkey);
  const encPassword = rsaEncrypt(password, pubkey);
  const loginUrl = `${AUTH_BASE_URL}/verify2?reqtype=unified_login&account=${encodeURIComponent(encAccount)}&msg=1&passwd=${encodeURIComponent(encPassword)}&rsa_version=${rsaVersion}&ta_appid=${AUTH_TA_APPID}`;
  const { text: loginText } = await httpGet(loginUrl, { headers: DEFAULT_HEADERS });
  const loginItem = getXmlItem(loginText);
  const userid = loginItem.userid;
  const sessionid = loginItem.sessionid;
  if (!userid || !sessionid) throw new Error(`统一登录失败: ${loginText.slice(0, 200)}`);

  // Step 3: Main verify
  const securities = encodeURIComponent("同花顺远航版");
  const mvUrl = `${AUTH_BASE_URL}/verify2?reqtype=mainverify&userid=${userid}&sessionid=${sessionid}&qsid=${AUTH_QSID}&product=${AUTH_PRODUCT}&version=${AUTH_VERSION}&imei=${AUTH_IMEI}&rsa_version=${rsaVersion}&nohqlist=0&securities=${securities}`;
  const { text: mvText } = await httpGet(mvUrl, { headers: DEFAULT_HEADERS });
  const mvItem = getXmlItem(mvText);
  const passport = mvItem.passport;
  if (!passport) throw new Error(`主验证失败: ${mvText.slice(0, 200)}`);
  // passport is a | separated key=value string, extract signvalid
  let signvalid = "";
  for (const pair of passport.split("|")) {
    const [k, v] = pair.split("=");
    if (k === "signvalid") { signvalid = v; break; }
  }
  if (!signvalid) throw new Error(`主验证返回中未找到 signvalid: ${passport.slice(0, 200)}`);

  // Step 4: Exchange for cookies via docookie2.php
  const cookieUrl = `${UPASS_BASE_URL}/docookie2.php?userid=${userid}&sessionid=${sessionid}&signvalid=${signvalid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT);
  let resp;
  try {
    resp = await fetch(cookieUrl, {
      method: "GET",
      headers: { ...DEFAULT_HEADERS },
      redirect: "manual", // don't follow redirects — cookies are in Set-Cookie
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // Parse Set-Cookie headers
  const cookies = {};
  const setCookieHeaders = resp.headers.getSetCookie?.() || [];
  for (const sc of setCookieHeaders) {
    const m = sc.match(/^([^=;]+)=([^;]*)/);
    if (m) cookies[m[1].trim()] = m[2].trim();
  }

  // Fallback: if getSetCookie not available, parse from raw header
  if (Object.keys(cookies).length === 0) {
    const raw = resp.headers.get("set-cookie") || "";
    for (const part of raw.split(/,(?=\s*\w+=)/)) {
      const m = part.match(/^([^=;]+)=([^;]*)/);
      if (m) cookies[m[1].trim()] = m[2].trim();
    }
  }

  if (!cookies.userid) throw new Error(`换取 Cookie 失败，未获取到 userid。Set-Cookie: ${JSON.stringify(setCookieHeaders).slice(0, 300)}`);

  const authParams = extractAuthParamsFromCookies(cookies);
  return { cookies, authParams };
}

// ─── Login: QR code (upass.10jqka.com.cn/scan) ───────────────────────────────

async function createQrCode() {
  const url = `${UPASS_BASE_URL}/scan/creatCode`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${UPASS_BASE_URL}/login`,
      },
      signal: controller.signal,
    });
    const data = await resp.json();
    if (data.errorCode !== 0 || !data.qrid) {
      throw new Error(`生成二维码失败: ${JSON.stringify(data)}`);
    }
    const qrUrl = `http://mobile.10jqka.com.cn/?source=PC&qrid=${data.qrid}`;
    // Download QR code PNG from THS creatImg endpoint (binary buffer for file output)
    const imgController = new AbortController();
    const imgTimer = setTimeout(() => imgController.abort(), DEFAULT_HTTP_TIMEOUT);
    let qrBuffer = null;
    try {
      const imgResp = await fetch(`${UPASS_BASE_URL}/scan/creatImg?qrid=${data.qrid}`, {
        headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], "Referer": `${UPASS_BASE_URL}/login` },
        signal: imgController.signal,
      });
      const candidate = Buffer.from(await imgResp.arrayBuffer());
      // Avoid exposing an HTML/JSON error response as an image attachment.
      if (candidate.length >= 8 && candidate.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        qrBuffer = candidate;
      }
    } catch (_e) { /* best-effort, caller handles fallback */ }
    finally { clearTimeout(imgTimer); }
    return { qrid: data.qrid, qrUrl, qrBuffer };
  } finally {
    clearTimeout(timer);
  }
}

async function pollQrLogin(qrid, timeoutMs = 120000) {
  const startTime = Date.now();
  const intervalMs = 4000;

  while (Date.now() - startTime < timeoutMs || timeoutMs === 0 && startTime === Date.now()) {
    const body = new URLSearchParams({
      qrid,
      state: "1",
      source: "pc_web",
      page_source: "web_screen",
      request_type: "login",
    }).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT);
    let data;
    try {
      const resp = await fetch(`${UPASS_BASE_URL}/scan/getInfoNew`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": DEFAULT_HEADERS["User-Agent"],
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `${UPASS_BASE_URL}/login`,
        },
        body,
        signal: controller.signal,
      });
      data = await resp.json();
    } finally {
      clearTimeout(timer);
    }

    // status=3: scan confirmed → got account + password
    if (data.status === 3 && data.account && data.password) {
      // Use account/password to do mobile login → get cookies
      const { cookies, authParams } = await doMobileLogin(data.account, data.password);
      return { cookies, authParams, account: data.account };
    }

    // expired=0: QR code expired
    if (data.expired === 0) {
      throw new Error("二维码已过期，请重新生成");
    }

    // status=1 or other: single check must return immediately, never schedule another QR.
    if (timeoutMs === 0) throw new Error("尚未检测到扫码确认；请在 App 确认后再次说完成登录。二维码过期时请重新发起登录");
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error("扫码登录超时，请重试");
}

function encodeBlockstockPayload(groupName, groupType, stockList) {
  // stockList: array of { code, market_type }
  const groupIdB64 = Buffer.from(iconv.encode(groupName, "gbk")).toString("base64");
  const codes = stockList.map((e) => e.code).join("|");
  const types = stockList.map((e) => e.market_type).join("|");
  const stockStr = codes + "," + types;

  const groupData = Buffer.concat([
    fieldBytes(1, Buffer.from(groupIdB64, "ascii")),
    fieldBytes(3, Buffer.from(stockStr, "ascii")),
  ]);
  const groupPayload = Buffer.concat([
    fieldBytes(1, fieldVarint(1, groupType)),
    fieldBytes(3, groupData),
  ]);
  const result = fieldBytes(1, groupPayload);
  return result;
}

function parseGroupData(buf) {
  // field 1 (bytes) = group_id (ascii string)
  // field 3 (bytes) = raw stock string "code1|code2,...,type1|type2,..."
  let groupId = "";
  let stockStr = "";
  walkProtobuf(buf, 0, buf.length, (fieldNumber, wireType, varintVal, payload) => {
    if (fieldNumber === 1 && wireType === 2) groupId = payload.toString("ascii");
    if (fieldNumber === 3 && wireType === 2) stockStr = payload.toString("ascii");
  });

  // Decode group_id from base64 + GBK
  let groupName = "";
  try {
    const gbkBuf = Buffer.from(groupId, "base64");
    groupName = iconv.decode(gbkBuf, "gbk");
  } catch (_e) { groupName = groupId; }

  // Parse stock string
  // Format: "code1|code2|...codeN|,type1|type2|...typeN|"
  // Python original uses rfind(',') to split — we do the same to avoid
  // filter(Boolean) mismatch when market_type of last stock is empty.
  const items = [];
  if (stockStr) {
    const commaIdx = stockStr.lastIndexOf(",");
    if (commaIdx >= 0) {
      const codesSeg = stockStr.substring(0, commaIdx);
      const typesSeg = stockStr.substring(commaIdx + 1);
      const codes = codesSeg.split("|").filter(Boolean);
      const types = typesSeg.split("|"); // keep empty strings to preserve alignment
      for (let i = 0; i < codes.length; i++) {
        items.push({ code: codes[i], market_type: types[i] || "" });
      }
    }
  }
  return { group_name: groupName, group_id: groupId, items };
}

function parseGroupPayload(buf) {
  // field 1 (varint or bytes) = group_type
  // field 3 (bytes) = inner group_data → parseGroupData
  let groupType = 0;
  let groupData = null;
  walkProtobuf(buf, 0, buf.length, (fieldNumber, wireType, varintVal, payload) => {
    if (fieldNumber === 1 && wireType === 0) groupType = varintVal;
    if (fieldNumber === 1 && wireType === 2 && payload) {
      // Inner nested: parse varint for group_type
      walkProtobuf(payload, 0, payload.length, (fn2, wt2, vv2) => {
        if (fn2 === 1 && wt2 === 0) groupType = vv2;
      });
    }
    if (fieldNumber === 3 && wireType === 2) groupData = payload;
  });
  if (groupData) {
    const parsed = parseGroupData(groupData);
    return { group_type: groupType, ...parsed };
  }
  return { group_type: groupType, group_name: "", group_id: "", items: [] };
}

function parseBlockstockDownload(buf) {
  // field 1 (varint) = count
  // field 2 (varint) = version
  // field 3 (bytes) = group payload → parseGroupPayload (can repeat)
  let count = 0;
  let version = 0;
  const groups = [];
  walkProtobuf(buf, 0, buf.length, (fieldNumber, wireType, varintVal, payload) => {
    if (fieldNumber === 1 && wireType === 0) count = varintVal;
    if (fieldNumber === 2 && wireType === 0) version = varintVal;
    if (fieldNumber === 3 && wireType === 2 && payload) {
      groups.push(parseGroupPayload(payload));
    }
  });
  return { count, version, groups };
}

async function downloadBlockstock(authParams, cookies) {
  // Match Python blockstock.py exactly: POST with form data, not GET
  const formData = {
    reqtype: "download",
    userid: authParams.userid || cookies.userid || "",
    storepath: "/",
    sessionid: authParams.sessionid || "",
    expires: authParams.expires || "",
    appname: BLOCKSTOCK_APPNAME,
    storetype: "2",
    clienttype: authParams.clienttype || MULTI_STORAGE_DEFAULT_CLIENTTYPE,
    version: "0",
  };
  const body = new URLSearchParams(formData).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT);
  try {
    const resp = await fetch(MULTI_STORAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        Cookie: cookieString(cookies),
      },
      body,
      signal: controller.signal,
    });
    const buffer = Buffer.from(await resp.arrayBuffer());
    return parseBlockstockDownload(buffer);
  } finally {
    clearTimeout(timer);
  }
}

async function uploadBlockstock(authParams, cookies, groupName, groupType, stockList, version) {
  const payload = encodeBlockstockPayload(groupName, groupType, stockList);
  const formData = {
    appname: BLOCKSTOCK_APPNAME,
    reqtype: "upload",
    version: String(version || ""),
    storepath: "/",
    clienttype: authParams.clienttype || MULTI_STORAGE_DEFAULT_CLIENTTYPE,
    compresstype: "none",
    compresstype_upload: "none",
    compresstype_download: "none",
    userid: authParams.userid || cookies.userid || "",
    sessionid: authParams.sessionid || "",
    expires: authParams.expires || "",
  };
  // Python uses requests' files= param which sends multipart/form-data
  const { buffer } = await httpPostMultipartBinary(MULTI_STORAGE_URL, formData, payload, {
    headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] },
    cookies,
  });
  // Python returns parsed protobuf, not JSON
  return parseBlockstockDownload(buffer);
}

// ─── selfstock_v1.py ──────────────────────────────────────────────────────────

async function downloadSelfStocksV1(cookies) {
  const userid = cookies.userid || "";
  const { text } = await httpGet(`${SELF_STOCK_V1_BASE_URL}${SELF_STOCK_V1_QUERY_PATH}`, {
    headers: { ...DEFAULT_HEADERS, userid },
    cookies,
    params: { support_all: "0", from: "thspc_hevo" },
  });
  let resp;
  try { resp = JSON.parse(text); } catch (_e) { throw new Error(`V1 query解析失败: ${text.slice(0, 200)}`); }

  const selfstockStr = resp.data && resp.data.selfstock ? resp.data.selfstock : "";
  let items = [];
  if (selfstockStr) {
    const commaIdx = selfstockStr.lastIndexOf(",");
    if (commaIdx >= 0) {
      const codesSeg = selfstockStr.substring(0, commaIdx);
      const typesSeg = selfstockStr.substring(commaIdx + 1);
      const codes = codesSeg.split("|").filter(Boolean);
      const types = typesSeg.split("|"); // keep empty strings for alignment
      for (let i = 0; i < codes.length; i++) {
        items.push({ code: codes[i], market_type: types[i] || "" });
      }
    }
  }
  const version = resp.data && resp.data.version !== undefined ? resp.data.version : "";
  return { version, items };
}

async function modifySelfStocksV1(cookies, stockList, version) {
  const userid = cookies.userid || "";
  const codes = stockList.map((e) => e.code).join("|");
  const types = stockList.map((e) => e.market_type).join("|");
  const selfstock = codes + "," + types;
  const { text } = await httpPostForm(
    `${SELF_STOCK_V1_BASE_URL}${SELF_STOCK_V1_MODIFY_PATH}`,
    { selfstock, from: "thspc_hevo", version: String(version || ""), num: String(stockList.length) },
    { headers: { ...DEFAULT_HEADERS, userid }, cookies }
  );
  let resp;
  try { resp = JSON.parse(text); } catch (_e) { resp = { raw: text }; }
  return resp;
}

// ─── selfstock_v2.py ──────────────────────────────────────────────────────────

async function downloadSelfStocksV2(cookies) {
  const { text } = await httpGet(`${SELF_STOCK_V2_BASE_URL}${SELF_STOCK_V2_LIST_PATH}`, {
    headers: DEFAULT_HEADERS,
    cookies,
  });
  let resp;
  try { resp = JSON.parse(text); } catch (_e) { throw new Error(`V2列表解析失败: ${text.slice(0, 200)}`); }

  if (resp.errorCode !== 0) {
    throw new Error(`V2列表错误: errorCode=${resp.errorCode}, ${resp.errorMsg || ""}`);
  }

  const result = Array.isArray(resp.result) ? resp.result : [];
  const items = [];
  for (const item of result) {
    let code = String(item.code || "").toUpperCase();
    let marketid = String(item.marketid);
    if (/^[A-Z][A-Z0-9.-]*$/.test(code) && marketid === "61") {
      try { marketid = await resolveUsMarketType(code); } catch (_e) { /* retain legacy id */ }
    }
    // Normalize HK format: "HK3330"/177 → "03330"/55
    if (/^HK\d+$/i.test(code) && marketid === "177") {
      code = code.replace(/^HK/i, "").padStart(5, "0");
      marketid = "55";
    }
    items.push([code, marketid]);
  }
  return { payload: resp, items };
}

async function modifySelfStockV2(cookies, op, stockcode) {
  const { text } = await httpGet(`${SELF_STOCK_V2_BASE_URL}${SELF_STOCK_V2_MODIFY_PATH}`, {
    headers: DEFAULT_HEADERS,
    cookies,
    params: { op, stockcode },
  });
  let resp;
  try { resp = JSON.parse(text); } catch (_e) { resp = { raw: text }; }
  return resp;
}

// ─── dynamicplate.py ──────────────────────────────────────────────────────────

async function queryDynamicPlate(groupName, cookies, num = 1000) {
  const url = `${DYNAMIC_PLATE_BASE_URL}${DYNAMIC_PLATE_SELECT_PATH}`;
  const { text } = await httpGet(url, {
    headers: DEFAULT_HEADERS,
    cookies,
    params: { query: groupName, num },
  });
  let resp;
  try { resp = JSON.parse(text); } catch (_e) { throw new Error(`动态板块解析失败: ${text.slice(0, 200)}`); }

  const codes = resp.data && Array.isArray(resp.data.codes) ? resp.data.codes : [];
  return codes.map((item) => ({ code: item.code, market: String(item.market) }));
}

// ─── selfstock_detail (optional enhancement) ──────────────────────────────────

// 5-minute TTL cache for selfstock_detail (join price/time metadata).
// The cache object belongs to one PortfolioManager and is never shared between
// agents, even when they happen to use the same THS account.
const SELFSTOCK_DETAIL_TTL_MS = 5 * 60 * 1000;

async function downloadSelfstockDetail(userid, cookies, cache) {
  // Return cached data if fresh enough
  if (cache.userid === userid &&
      Date.now() - cache.timestamp < SELFSTOCK_DETAIL_TTL_MS) {
    return cache.data;
  }

  const url = `${API_BASE_URL}/selfstock_detail`;
  const { text } = await httpGet(url, {
    headers: { ...DEFAULT_HEADERS, userid },
    cookies,
    params: { reqtype: "download", app_flag: "0E", userid },
  });
  const item = getXmlItem(text);
  if (!item.selfstock_detail) return {};
  try {
    const decoded = Buffer.from(item.selfstock_detail, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // Each entry has C (code), M (market type), P (price), T (timestamp)
    const detailMap = {};
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e.C) detailMap[e.C] = { price: e.P, added_at: e.T, market_type: String(e.M || "") };
      }
    }
    // Update the caller-owned cache.
    cache.userid = userid;
    cache.timestamp = Date.now();
    cache.data = detailMap;
    return detailMap;
  } catch (_e) {
    return {};
  }
}

// ─── Cookie cache management ──────────────────────────────────────────────────

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function readCookieCache(cachePath, agentId) {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const cache = JSON.parse(raw);
    if (cache?.version !== 1 || cache?.agentId !== agentId || !cache.cookies) return null;
    return cache;
  } catch (_e) {
    return null;
  }
}

function writeCookieCache(cachePath, data) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(cachePath, 0o600);
  } catch (_e) { /* ignore cache write errors */ }
}

function getCachedCookies(cachePath, agentId) {
  // A cache file has exactly one owner and one login state. There is no
  // username or "latest credential" fallback that could cross an agent boundary.
  return readCookieCache(cachePath, agentId);
}

function setCachedCookies(cachePath, agentId, cookies, authParams) {
  writeCookieCache(cachePath, {
    version: 1,
    agentId,
    userid: cookies.userid || "",
    cookies,
    timestamp: Date.now() / 1000,
    auth_params: authParams,
  });
}

function clearCachedCookies(cachePath, agentId) {
  try {
    if (readCookieCache(cachePath, agentId)) fs.rmSync(cachePath, { force: true });
  } catch (_e) { /* ignore cache clear errors */ }
}

// ─── Config helper ────────────────────────────────────────────────────────────

function pickPluginConfig(api) {
  const root = api.config || {};
  const fromEntries = root.plugins?.entries?.["ths-favorite"]?.config;
  if (fromEntries && typeof fromEntries === "object") return fromEntries;
  return root;
}

// ─── PortfolioManager (api.py / service.py) ───────────────────────────────────

class PortfolioManager {
  constructor(config) {
    this.config = config;
    this.agentId = config.agentId;
    this.cookies = null;
    this.authParams = null;
    this._groupsCache = null;
    this._selfstockDetailCache = { userid: null, timestamp: 0, data: {} };
  }

  get cookieCachePath() {
    return this.config.cookieCachePath;
  }

  setCredentials(cookies, authParams) {
    this.cookies = cookies;
    this.authParams = authParams || extractAuthParamsFromCookies(cookies);
  }

  /** Clear in-memory + file cache when the server rejects our cookies. */
  invalidateSession() {
    clearCachedCookies(this.cookieCachePath, this.agentId);
    this.cookies = null;
    this.authParams = null;
    this._groupsCache = null;
  }

  /** Check if an error looks like an auth failure (expired/invalid cookies). */
  isAuthError(err) {
    const msg = String(err?.message || err).toLowerCase();
    // Only match genuine server-side auth rejections, not our own "未登录" thrown locally
    return msg.includes("请先登录") ||
      msg.includes("unauthorized") ||
      msg.includes("login required") ||
      msg.includes("session expired") ||
      msg.includes("cookie expired");
  }

  /**
   * Resolve cookies following the priority:
   * 1. Already cached in this instance
   * 2. This agent's cache file (kept until server rejects)
   * 3. None → throw error
   */
  async ensureAuthenticated() {
    if (this.cookies) return this.cookies;

    // 2. Agent-scoped cookie cache file
    const cached = getCachedCookies(this.cookieCachePath, this.agentId);
    if (cached && cached.cookies) {
      this.cookies = cached.cookies;
      this.authParams = cached.auth_params || extractAuthParamsFromCookies(this.cookies);
      return this.cookies;
    }

    throw new Error("未登录，请先调用 ths_login、ths_qr_login 或 ths_password_login 完成当前 agent 的登录");
  }

  // ─── getAllGroups ──────────────────────────────────────────────────────────
  // 5-second short-lived cache: avoids redundant API calls when agent does
  // consecutive operations (list → add → list → sort → list), while staying
  // fresh enough for real-time use.
  async getAllGroups(includeSelfStocks = false) {
    const cookies = await this.ensureAuthenticated();

    // Return cached data if fresh (< 5s) and same includeSelfStocks flag
    if (this._groupsCache &&
        this._groupsCache.timestamp &&
        Date.now() - this._groupsCache.timestamp < 5000 &&
        this._groupsCache.includeSelfStocks === includeSelfStocks) {
      return this._groupsCache.groups;
    }

    const { text } = await httpGet(`${API_BASE_URL}${ENDPOINTS.query_groups}`, {
      headers: DEFAULT_HEADERS,
      cookies,
      params: { from: DEFAULT_FROM_PARAM, types: GROUP_QUERY_TYPES },
    });
    let resp;
    try { resp = JSON.parse(text); } catch (_e) { throw new Error(`分组查询解析失败: ${text.slice(0, 200)}`); }

    // Check business status code
    if (resp.status_code !== undefined && resp.status_code !== 0) {
      throw new Error(`分组查询失败: ${resp.status_msg || "未知错误"} (code: ${resp.status_code})`);
    }

    const data = resp.data || resp;
    const version = data.version !== undefined ? data.version : "";
    const groupList = Array.isArray(data.group_list) ? data.group_list : [];
    const result = {};

    // Best-effort selfstock detail for price/time metadata
    let detailMap = {};
    try {
      const userid = this.authParams?.userid || cookies.userid;
      if (userid) detailMap = await downloadSelfstockDetail(userid, cookies, this._selfstockDetailCache);
    } catch (_e) { /* best-effort */ }

    for (const grp of groupList) {
      const groupId = String(grp.id);
      const groupName = String(grp.name || "");
      const groupType = String(grp.type || "0");

      // Parse content string: "code1|code2,...,type1|type2,..."
      const items = parseContentString(grp.content || "");
      for (const item of items) {
        if (/^[A-Z][A-Z0-9.-]*$/.test(item.code) && item.market_type === "61") {
          try { item.market_type = await resolveUsMarketType(item.code); } catch (_e) { /* retain legacy id */ }
        }
      }

      // Dynamic groups (id starts with "1_") need queryDynamicPlate
      if (groupId.startsWith("1_")) {
        try {
          const plateStocks = await queryDynamicPlate(groupName, cookies);
          result[groupName] = {
            name: groupName,
            group_id: groupId,
            readonly: true,
            items: plateStocks.map((s) => ({
              code: s.code,
              market: s.market,
              price: detailMap[s.code]?.price,
              added_at: detailMap[s.code]?.added_at,
            })),
          };
        } catch (_e) {
          result[groupName] = { name: groupName, group_id: groupId, readonly: true, items: [] };
        }
      } else {
        result[groupName] = {
          name: groupName,
          group_id: groupId,
          items: items.map((it) => ({
            code: it.code,
            market: it.market_type,
            price: detailMap[it.code]?.price,
            added_at: detailMap[it.code]?.added_at,
          })),
          readonly: false,
        };
      }
    }

    // Optionally include self-stocks
    if (includeSelfStocks) {
      try {
        const selfStocks = await this.getSelfStocks(true);
        result[SELF_STOCK_DEFAULT_NAME] = selfStocks;
      } catch (_e) { /* best-effort */ }
    }

    this._groupsCache = { version, groups: result, timestamp: Date.now(), includeSelfStocks };
    return result;
  }

  // ─── getSelfStocks ─────────────────────────────────────────────────────────
  async getSelfStocks(refresh = false) {
    const cookies = await this.ensureAuthenticated();
    const { items } = await downloadSelfStocksV2(cookies);
    const stockItems = items.map(([code, marketid]) => ({ code, market: marketid, market_type: String(marketid) }));
    let enrichedItems = stockItems;
    try {
      enrichedItems = await enrichSelfStocksWithThsQuotes(stockItems);
    } catch (_e) {
      // Native THS quote enrichment is best-effort. The favorites list itself
      // must remain usable even if the public quote endpoint is unavailable.
    }
    return {
      name: SELF_STOCK_DEFAULT_NAME,
      group_id: SELF_STOCK_GROUP_ID,
      items: enrichedItems,
      readonly: false,
    };
  }

  // ─── findGroupId ───────────────────────────────────────────────────────────
  async findGroupId(group) {
    if (group === SELF_STOCK_DEFAULT_NAME || group === SELF_STOCK_GROUP_ID) {
      return { id: SELF_STOCK_GROUP_ID, name: SELF_STOCK_DEFAULT_NAME, isSelf: true };
    }
    const allGroups = await this.getAllGroups(false);
    // Match by name or id
    for (const [gname, ginfo] of Object.entries(allGroups)) {
      if (gname === group || ginfo.group_id === group) {
        return { id: ginfo.group_id, name: gname, isSelf: false };
      }
    }
    throw new Error(`未找到分组: ${group}`);
  }

  // ─── addItem / addItems ────────────────────────────────────────────────────
  async addItem(group, symbols) {
    return this._modifyItems(group, symbols, "add");
  }

  async addItems(group, symbols) {
    return this._modifyItems(group, symbols, "add");
  }

  // ─── removeItem / removeItems ──────────────────────────────────────────────
  async removeItem(group, symbols) {
    return this._modifyItems(group, symbols, "remove");
  }

  async removeItems(group, symbols) {
    return this._modifyItems(group, symbols, "remove");
  }

  async _modifyItems(group, symbols, action) {
    const cookies = await this.ensureAuthenticated();
    const parsed = [];
    for (const symbol of symbols) {
      parsed.push(await resolveSymbol(symbol));
    }

    // Self-stock group
    if (group === SELF_STOCK_DEFAULT_NAME || group === SELF_STOCK_GROUP_ID) {
      // Always use V2 single-stock API for both add and delete.
      // V1 batch modify can desync from V2's data store.
      const op = action === "add" ? "add" : "del";
      const results = [];
      for (const stock of parsed) {
        const stockcode = buildStockCode(stock);
        const r = await modifySelfStockV2(cookies, op, stockcode);
        results.push(r);
      }
      return { action, group: SELF_STOCK_DEFAULT_NAME, results };
    }

    // Regular group: use content API (single-item, sequential)
    // Even for batch operations, we call the content API one by one to:
    // 1. Avoid blockstock version conflicts and data loss
    // 2. Get per-item error reporting
    // 3. Keep the correct market_type per stock
    const groupInfo = await this.findGroupId(group);
    const groupId = groupInfo.id;
    const endpoint = action === "add" ? ENDPOINTS.add_item : ENDPOINTS.delete_item;

    // For removals, prefer the market id actually stored in the group. Legacy
    // entries may carry ids that differ from what we would resolve today
    // (e.g. BJ stocks stored as 71 vs current 151), and the delete API only
    // matches on the exact stored id.
    let storedItems = null;
    if (action === "remove") {
      try {
        const allGroups = await this.getAllGroups(false);
        const stored = allGroups[groupInfo.name];
        if (stored && Array.isArray(stored.items)) {
          storedItems = new Map(stored.items.map((it) => [it.code, it]));
        }
      } catch (_e) { /* fall back to resolved symbols */ }
    }

    const results = [];
    for (const stock of parsed) {
      let content;
      const stored = storedItems?.get(stock.code);
      if (stored && stored.market) {
        content = `${stock.code},${stored.market}`;
      } else {
        content = buildContent(stock);
      }
      let version = await this.ensureVersion();
      let resp;

      for (let attempt = 0; attempt < 3; attempt++) {
        const { text } = await httpPostForm(
          `${API_BASE_URL}${endpoint}`,
          { id: groupId, content, num: "1", version: String(version), from: DEFAULT_FROM_PARAM },
          { headers: DEFAULT_HEADERS, cookies }
        );
        try { resp = JSON.parse(text); } catch (_e) { resp = { raw: text }; }

        if (resp.status_code === 0) {
          // Success — update local version from response
          if (resp.data && resp.data.version !== undefined) {
            if (this._groupsCache) {
              this._groupsCache.version = resp.data.version;
              this._groupsCache.groups = null;
              this._groupsCache.timestamp = 0;
            } else {
              this._groupsCache = { version: resp.data.version, groups: null, timestamp: 0 };
            }
          }
          break;
        }

        if (isVersionConflict(resp) && attempt < 2) {
          // Version conflict — refresh and retry
          this._groupsCache = null;
          version = await this.ensureVersion();
          continue;
        }
        // Non-retryable error
        break;
      }

      results.push({ stock: `${stock.code}.${stock.market_abbr}`, status_code: resp.status_code, status_msg: resp.status_msg, data: resp.data });

      // If this item failed with a non-version error, skip to next item
      if (resp.status_code !== 0 && !isVersionConflict(resp)) {
        continue;
      }
    }

    const succeeded = results.filter(r => r.status_code === 0).length;
    const failed = results.length - succeeded;
    return {
      action,
      group: groupInfo.name,
      total: parsed.length,
      succeeded,
      failed,
      results,
    };
  }

  /** Ensure we have a valid version from getAllGroups; call it if missing. */
  async ensureVersion() {
    if (this._groupsCache && this._groupsCache.version !== undefined && this._groupsCache.version !== "") {
      return this._groupsCache.version;
    }
    await this.getAllGroups(false);
    if (!this._groupsCache || this._groupsCache.version === undefined || this._groupsCache.version === "") {
      throw new Error("无法获取自选列表版本号，请稍后重试");
    }
    return this._groupsCache.version;
  }

  // ─── sortGroup ─────────────────────────────────────────────────────────────
  /**
   * Reorder stocks within a custom group via blockstock upload.
   * @param group  Group name or id
   * @param orderedSymbols  Array of stock codes in desired order (e.g. ["600519.SH","000001.SZ"])
   */
  async sortGroup(group, orderedSymbols) {
    const cookies = await this.ensureAuthenticated();
    const groupInfo = await this.findGroupId(group);
    if (groupInfo.isSelf) throw new Error("不支持对「我的自选」排序，仅支持自定义分组");

    // Download current blockstock data to get current list + version
    const bsData = await downloadBlockstock(this.authParams, cookies);
    const blockVersion = bsData.version || 0;
    let groupType = 0;
    let currentStocks = [];
    for (const g of bsData.groups) {
      if (g.group_name === groupInfo.name || g.group_id === groupInfo.id) {
        groupType = g.group_type || 0;
        currentStocks = g.items || [];
        break;
      }
    }
    if (!currentStocks.length) throw new Error(`分组「${groupInfo.name}」内没有股票，无需排序`);

    // Build lookup: code -> stock entry (from current list)
    // For HK stocks, blockstock stores "HK3330" but parseSymbol returns "03330"
    // Need to normalize both sides for matching
    function normalizeCode(code, marketType) {
      // HK: "HK3330" → "03330"
      if (/^HK\d+$/i.test(code)) {
        return code.replace(/^HK/i, "").padStart(5, "0");
      }
      return code;
    }
    const lookup = new Map();
    for (const s of currentStocks) {
      const nc = normalizeCode(s.code, s.market_type);
      lookup.set(nc, s);
      // Also store original code as key for exact match
      lookup.set(s.code, s);
    }

    // Build new ordered list from user-provided symbol list
    const ordered = [];
    const used = new Set();
    for (const sym of orderedSymbols) {
      const parsed = parseSymbol(sym);
      const entry = lookup.get(parsed.code);
      if (entry) {
        ordered.push({ code: entry.code, market_type: entry.market_type });
        used.add(parsed.code);
        used.add(entry.code);
      }
    }

    // Append any stocks not in the user's list (preserve original order)
    for (const s of currentStocks) {
      const nc = normalizeCode(s.code, s.market_type);
      if (!used.has(nc) && !used.has(s.code)) {
        ordered.push({ code: s.code, market_type: s.market_type });
      }
    }

    // Upload reordered list
    const uploadResult = await uploadBlockstock(this.authParams, cookies, groupInfo.name, groupType, ordered, blockVersion);
    return { group: groupInfo.name, count: ordered.length, result: uploadResult };
  }

  // ─── addGroup ──────────────────────────────────────────────────────────────
  async addGroup(name) {
    const cookies = await this.ensureAuthenticated();
    let version = await this.ensureVersion();
    let resp;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await httpPostForm(
        `${API_BASE_URL}${ENDPOINTS.add_group}`,
        { name, type: "0", version: String(version), from: DEFAULT_FROM_PARAM },
        { headers: DEFAULT_HEADERS, cookies }
      );
      try { resp = JSON.parse(text); } catch (_e) { resp = { raw: text }; }

      if (isVersionConflict(resp)) {
        this._groupsCache = null;
        version = await this.ensureVersion();
        continue;
      }
      break;
    }

    // Check business status code
    const data = resp.data || resp;
    if (resp.status_code !== undefined && resp.status_code !== 0) {
      throw new Error(`新建分组失败: ${resp.status_msg || "未知错误"} (code: ${resp.status_code})`);
    }
    // Update local version from response, invalidate groups data
    if (data && data.version !== undefined) {
      if (this._groupsCache) { this._groupsCache.version = data.version; this._groupsCache.groups = null; this._groupsCache.timestamp = 0; }
    }
    return data;
  }

  // ─── deleteGroup ───────────────────────────────────────────────────────────
  async deleteGroup(group) {
    const cookies = await this.ensureAuthenticated();
    const groupInfo = await this.findGroupId(group);
    let version = await this.ensureVersion();
    const { text } = await httpPostForm(
      `${API_BASE_URL}${ENDPOINTS.delete_group}`,
      { ids: groupInfo.id, version: String(version), from: DEFAULT_FROM_PARAM },
      { headers: DEFAULT_HEADERS, cookies }
    );
    let resp;
    try { resp = JSON.parse(text); } catch (_e) { resp = { raw: text }; }

    if (isVersionConflict(resp)) {
      this._groupsCache = null;
      version = await this.ensureVersion();
      const { text: t2 } = await httpPostForm(
        `${API_BASE_URL}${ENDPOINTS.delete_group}`,
        { ids: groupInfo.id, version: String(version), from: DEFAULT_FROM_PARAM },
        { headers: DEFAULT_HEADERS, cookies }
      );
      try { resp = JSON.parse(t2); } catch (_e2) { resp = { raw: t2 }; }
    }
    // Update local version from response, invalidate groups data
    const delData = resp.data || resp;
    if (delData && delData.version !== undefined) {
      if (this._groupsCache) { this._groupsCache.version = delData.version; this._groupsCache.groups = null; this._groupsCache.timestamp = 0; }
    }
    return resp;
  }

  // ─── shareGroup ────────────────────────────────────────────────────────────
  async shareGroup(group, validTime) {
    const cookies = await this.ensureAuthenticated();
    const groupInfo = await this.findGroupId(group);
    const groupId = groupInfo.id;

    // Extract biz_suffix from group_id (part after "_")
    const underscoreIdx = groupId.lastIndexOf("_");
    const bizSuffix = underscoreIdx >= 0 ? groupId.substring(underscoreIdx + 1) : groupId;

    const { text } = await httpPostJson(
      `${API_BASE_URL}${ENDPOINTS.share_group}`,
      {
        biz: "selfstock",
        valid_time: Number(validTime),
        biz_key: `userid_${bizSuffix}`,
        name: groupInfo.name,
        url_style: 0,
      },
      { headers: DEFAULT_HEADERS, cookies }
    );
    let resp;
    try { resp = JSON.parse(text); } catch (_e) { resp = { raw: text }; }
    return resp;
  }
}

// ─── Utility functions ────────────────────────────────────────────────────────

function parseCookieString(str) {
  const cookies = {};
  for (const part of String(str).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.substring(0, eq).trim();
    const value = part.substring(eq + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

/**
 * Parse a stock symbol like "600000" or "600000.SH" into { code, market_type, market_abbr }.
 * If no suffix, infer market from the code pattern.
 */
function parseSymbol(symbol) {
  let s = String(symbol).trim();
  if (s.startsWith("$")) s = s.substring(1).trim();
  const dot = s.indexOf(".");
  if (dot >= 0) {
    const code = s.substring(0, dot).trim().toUpperCase();
    const suffix = s.substring(dot + 1).trim().toUpperCase();
    if (US_MARKET_ALIASES[suffix]) {
      return { code, market_type: US_MARKET_ALIASES[suffix], market_abbr: "US" };
    }
    // Support both MU.US and class-share tickers such as BRK.B. The latter
    // has a dot in the ticker, not a market suffix.
    if (!MARKET_CODE[suffix] && !/^\d+$/.test(suffix) && /^[A-Z][A-Z0-9.-]*$/.test(s)) {
      return { code: s.toUpperCase(), market_type: MARKET_CODE.US, market_abbr: "US" };
    }
    const abbr = MARKET_NAME[suffix] || suffix;
    return { code, market_type: /^\d+$/.test(suffix) ? suffix : marketCode(abbr), market_abbr: abbr };
  }
  // Infer market from code pattern
  let code = s.toUpperCase();
  let abbr = "";
  // 港股前缀格式: hk2269, HK02269, hk00700
  const hkMatch = /^hk(\d{4,5})$/i.exec(code);
  if (hkMatch) {
    abbr = "HK";
    code = hkMatch[1].padStart(5, "0");
  }
  // 港股 (4-5位纯数字，如 00700, 09988, 2269, 3330)
  // A股代码固定6位，4-5位纯数字一定是港股
  // 同花顺 API 要求港股代码补足5位前导零 (2269 → 02269)
  else if (/^[0-9]{4,5}$/.test(code)) { abbr = "HK"; code = code.padStart(5, "0"); }
  // 同花顺板块指数 (883xxx, 885xxx)
  else if (/^88[35]/.test(code)) abbr = "ZS";
  // 上海ETF (510xxx, 511xxx, 512xxx, 513xxx, 515xxx, 516xxx, 517xxx, 518xxx, 588xxx)
  else if (/^5[1-8][0-9]/.test(code)) abbr = "SHETF";
  // 深圳ETF (159xxx, 150xxx, 151xxx, 152xxx)
  else if (/^15[0-9]/.test(code)) abbr = "SZETF";
  // A股主板
  else if (/^60[0-9]/.test(code)) abbr = "SH";
  else if (/^00[0-9]/.test(code) || /^002/.test(code) || /^003/.test(code)) abbr = "SZ";
  // 科创板
  else if (/^688/.test(code)) abbr = "SH";
  // 创业板
  else if (/^30[0-9]/.test(code)) abbr = "SZ";
  // 北交所 (83xxxx, 87xxxx, 920xxx, 430xxx)
  else if (/^(83|87|920|430)/.test(code)) abbr = "BJ";
  // US tickers are alphabetic (e.g. MU for Micron). Keep dots for class
  // shares when no explicit market suffix was provided.
  else if (/^[A-Z][A-Z0-9.-]*$/.test(code)) abbr = "US";
  return { code, market_type: abbr ? marketCode(abbr) : "", market_abbr: abbr };
}

const US_MARKET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _usMarketCache = new Map();

function hasExplicitUsMarketId(symbol) {
  const suffix = String(symbol).trim().replace(/^\$/, "").split(".").at(-1)?.toUpperCase() || "";
  return US_MARKET_IDS.has(suffix) || Boolean(US_MARKET_ALIASES[suffix]);
}

function parseUsQuotePayload(text, code) {
  const body = String(text || "").trim();
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  const json = body.startsWith("{") ? body : open >= 0 && close > open ? body.substring(open + 1, close) : "";
  let payload;
  try { payload = JSON.parse(json); } catch (_e) { throw new Error(`未能解析美股 ${code} 的同花顺行情响应`); }

  const items = payload?.items;
  const quoteCode = String(items?.["5"] || "").toUpperCase();
  const marketType = String(items?.marketid || "");
  if (quoteCode !== code || !US_MARKET_IDS.has(marketType)) {
    throw new Error(`未能识别美股 ${code} 的同花顺市场代码`);
  }
  return marketType;
}

async function resolveUsMarketType(code) {
  const cached = _usMarketCache.get(code);
  if (cached && Date.now() - cached.timestamp < US_MARKET_CACHE_TTL_MS) return cached.marketType;

  const { text } = await httpGet(`${US_QUOTE_BASE_URL}/usa_${encodeURIComponent(code)}/last.js`, {
    headers: DEFAULT_HEADERS,
  });
  const marketType = parseUsQuotePayload(text, code);
  _usMarketCache.set(code, { marketType, timestamp: Date.now() });
  return marketType;
}

// THS stores some A-share stocks under market ids that cannot be derived from
// the code prefix alone: BJ stocks live under 151 (not 71) and Shanghai ST /
// *ST stocks under 22 (not 17). Resolve the authoritative market id from the
// quote endpoint, same pattern as the US resolver.
const A_SHARE_QUOTE_BASE_URL = "https://d.10jqka.com.cn/v2/realhead";
const A_SHARE_MARKET_IDS = new Set(["17", "33", "22", "20", "36", "48", "38", "18", "71", "151"]);
const _aShareMarketCache = new Map();

function parseAShareQuotePayload(text) {
  const body = String(text || "").trim();
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  const json = body.startsWith("{") ? body : open >= 0 && close > open ? body.substring(open + 1, close) : "";
  let payload;
  try { payload = JSON.parse(json); } catch (_e) { return null; }
  const marketType = String(payload?.items?.marketid || "");
  return A_SHARE_MARKET_IDS.has(marketType) ? marketType : null;
}

async function resolveAShareMarketType(code) {
  const cached = _aShareMarketCache.get(code);
  if (cached && Date.now() - cached.timestamp < US_MARKET_CACHE_TTL_MS) return cached.marketType;

  const { resp, text } = await httpGet(`${A_SHARE_QUOTE_BASE_URL}/hs_${encodeURIComponent(code)}/last.js`, {
    headers: DEFAULT_HEADERS,
  });
  if (resp && resp.ok === false) throw new Error(`同花顺行情接口返回 HTTP ${resp.status}（${code}）`);
  const marketType = parseAShareQuotePayload(text);
  if (!marketType) throw new Error(`未能识别 A 股 ${code} 的同花顺市场代码`);
  _aShareMarketCache.set(code, { marketType, timestamp: Date.now() });
  return marketType;
}

function hasExplicitNumericMarketId(symbol) {
  const suffix = String(symbol).trim().replace(/^\$/, "").split(".").at(-1) || "";
  return /^\d+$/.test(suffix);
}

const MARKET_RESOLVERS = {
  US: resolveUsMarketType,
  SH: resolveAShareMarketType,
  SZ: resolveAShareMarketType,
  SHETF: resolveAShareMarketType,
  SZETF: resolveAShareMarketType,
  CYB: resolveAShareMarketType,
  KC: resolveAShareMarketType,
  BJ: resolveAShareMarketType,
};

async function resolveSymbol(symbol) {
  const stock = parseSymbol(symbol);
  const resolver = MARKET_RESOLVERS[stock.market_abbr];
  // An explicit numeric market id in the symbol (e.g. "600381.22") always wins.
  // Letter suffixes (.SH/.BJ/...) still go through the quote resolver because
  // BJ and Shanghai ST stocks are stored under ids the prefix rules get wrong.
  if (resolver && !hasExplicitNumericMarketId(symbol)) {
    if (stock.market_abbr === "US") {
      // US market id cannot be guessed from the ticker — let errors propagate.
      stock.market_type = await resolver(stock.code);
    } else {
      // A-share market ids have a prefix-derived fallback; a failed quote
      // lookup (e.g. HTTP 502) keeps the prefix-derived market_type.
      try {
        stock.market_type = await resolver(stock.code);
      } catch (_e) { /* keep prefix-derived market_type */ }
    }
  }
  return stock;
}

function buildStockCode(stock) {
  // For V2 API: Python original uses "code_markettype" format (e.g. "600519_17")
  // HK stocks use a different format in V2: "HK3330_177" (not "03330_55")
  if (stock.market_abbr === "HK") {
    // V2 wants: uppercase "HK" prefix + code without leading zeros + marketid 177
    const hkCode = stock.code.replace(/^0+/, "") || "0";
    return `HK${hkCode}_177`;
  }
  if (stock.market_type) return `${stock.code}_${stock.market_type}`;
  return stock.code;
}

function buildContent(stock) {
  // For content API (group add/remove): "code,market_type"
  // HK stocks use the same format as V2: "HK3330,177" (not "03330,55")
  if (stock.market_abbr === "HK") {
    const hkCode = stock.code.replace(/^0+/, "") || "0";
    return `HK${hkCode},177`;
  }
  return `${stock.code},${stock.market_type}`;
}

function parseContentString(content) {
  // content: "code1|code2|...codeN|,type1|type2|...typeN|"
  if (!content) return [];
  const commaIdx = content.lastIndexOf(",");
  if (commaIdx < 0) return [];
  const codesSeg = content.substring(0, commaIdx);
  const typesSeg = content.substring(commaIdx + 1);
  const codes = codesSeg.split("|").filter(Boolean);
  const types = typesSeg.split("|"); // keep empty strings for alignment
  const items = [];
  for (let i = 0; i < codes.length; i++) {
    let code = codes[i];
    let market_type = types[i] || "";
    if (/^[A-Za-z][A-Za-z0-9.-]*$/.test(code)) {
      code = code.toUpperCase();
    }
    // Normalize HK format: "HK3330"/177 → "03330"/55
    if (/^HK\d+$/i.test(code) && market_type === "177") {
      code = code.replace(/^HK/i, "").padStart(5, "0");
      market_type = "55";
    }
    items.push({ code, market_type });
  }
  return items;
}

function isVersionConflict(resp) {
  if (!resp) return false;
  // THS APIs use status_code for business errors
  const code = resp.status_code ?? resp.code ?? resp.errorCode ?? resp.status;
  const msg = String(resp.status_msg || resp.msg || resp.message || resp.errorMsg || "");
  // Version conflict typically has specific codes or messages
  return code === 409 || /version|版本|冲突|不一致/i.test(msg);
}

// ─── THS native quote enrichment ─────────────────────────────────────────────

const THS_QUOTE_FIELDS = {
  5: "security",
  6: "previous_close",
  7: "open",
  8: "high",
  9: "low",
  10: "price",
  11: "close",
  13: "volume",
  19: "amount",
  199112: "change_percent",
  name: "name",
  marketid: "marketid",
  updateTime: "update_time",
};

function parseThsQuotePayload(text, code) {
  const body = String(text || "").trim();
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  const json = body.startsWith("{") ? body : open >= 0 && close > open ? body.substring(open + 1, close) : "";
  let payload;
  try { payload = JSON.parse(json); } catch (_e) { return null; }
  const items = payload?.items || {};
  if (String(items["5"] || "").toUpperCase() !== String(code).toUpperCase()) return null;
  const quote = {};
  for (const [key, value] of Object.entries(items)) {
    const name = THS_QUOTE_FIELDS[key];
    if (name) quote[name] = value;
  }
  if (!quote.price && !quote.name) return null;
  return quote;
}

function thsQuotePath(item) {
  const code = String(item.code || "").toUpperCase();
  const market = String(item.market ?? item.market_type ?? "");
  // THS uses hs_ for A-shares/ETF, usa_ for US, and hk_HK#### for HK. The HK
  // storage format is the 5-digit code without leading zero prefixed by HK.
  if (US_MARKET_IDS.has(market) || /^[A-Z][A-Z0-9.-]*$/.test(code)) {
    return `usa_${encodeURIComponent(code)}`;
  }
  if (market === "55" || market === "177") {
    return `hk_HK${String(code).replace(/^0+/, "")}`;
  }
  return `hs_${encodeURIComponent(code)}`;
}

async function fetchThsQuote(item) {
  const code = String(item.code || "").toUpperCase();
  const market = String(item.market ?? item.market_type ?? "");
  const path = thsQuotePath(item);
  const { resp, text } = await httpGet(`${A_SHARE_QUOTE_BASE_URL}/${path}/last.js`, {
    headers: DEFAULT_HEADERS,
  });
  if (resp && resp.ok === false) throw new Error(`同花顺行情接口返回 HTTP ${resp.status}（${code}）`);
  // HK endpoints return the canonical THS code (e.g. 02269 -> HK2269), not the
  // five-digit storage code. Validate that form as well.
  const expected = market === "55" || market === "177" ? `HK${String(code).replace(/^0+/, "")}` : code;
  return parseThsQuotePayload(text, expected);
}

function normalizeThsNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function enrichSelfStocksWithThsQuotes(items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  const quotes = await Promise.all(items.map(async (item) => {
    // The native d.10jqka.com.cn endpoint covers A-shares, ETFs, HK, and US.
    // Unsupported or temporarily unavailable symbols are skipped individually.
    try { return await fetchThsQuote(item); } catch (_e) { return null; }
  }));

  return items.map((item, index) => {
    const quote = quotes[index];
    if (!quote) return { ...item };
    const price = normalizeThsNumber(quote.price);
    const previousClose = normalizeThsNumber(quote.previous_close);
    const changePercent = normalizeThsNumber(quote.change_percent);
    return {
      ...item,
      name: quote.name || item.name,
      price,
      previous_close: previousClose,
      change_percent: changePercent,
      open: normalizeThsNumber(quote.open),
      high: normalizeThsNumber(quote.high),
      low: normalizeThsNumber(quote.low),
      volume: normalizeThsNumber(quote.volume),
      amount: normalizeThsNumber(quote.amount),
      update_time: quote.update_time,
    };
  });
}

// ─── Per-agent PortfolioManager instances ─────────────────────────────────────

const _pmInstances = new Map(); // agentId → PortfolioManager
const _qrOwners = new Map(); // qrid → { agentId, createdAt }

function normalizeAgentId(agentId) {
  const normalized = String(agentId || "").trim();
  if (!AGENT_ID_PATTERN.test(normalized)) {
    throw new Error("缺少有效的 agent 上下文，已拒绝访问同花顺账户状态");
  }
  return normalized;
}

function getAgentCookieCachePath(config, agentId) {
  const key = normalizeAgentId(agentId);
  if (!key.startsWith("user-") || !/^[a-f0-9]{32}$/.test(key.slice(5))) throw new Error("非法用户状态目录");
  return path.join(stateForKey(String(config.stateDir || DEFAULT_STATE_DIR), key.slice(5), "ths-favorite"), "cookies.json");
}

function scopedManagerConfig(config, agentId) {
  // Deliberately ignore legacy global credential settings. Credentials can only
  // arrive through this agent's login tools and its private cache file.
  const { cookies: _cookies, cookieCachePath: _cachePath, username: _username, ...safeConfig } = config;
  return {
    ...safeConfig,
    agentId,
    cookieCachePath: getAgentCookieCachePath(safeConfig, agentId),
  };
}

function getPortfolioManager(config, agentId) {
  const key = normalizeAgentId(agentId);
  const agentConfig = scopedManagerConfig(config, key);
  let pm = _pmInstances.get(key);
  if (!pm) {
    pm = new PortfolioManager(agentConfig);
    _pmInstances.set(key, pm);
  } else {
    pm.config = agentConfig;
  }
  return pm;
}

function getQrImagePath(agentId, qrid) {
  return path.join(QR_IMAGE_ROOT, agentId, `qr-${sha256Hex(String(qrid))}.png`);
}

function rememberQrOwner(qrid, agentId) {
  const now = Date.now();
  for (const [existingQrid, entry] of _qrOwners) {
    if (now - entry.createdAt > QR_OWNER_TTL_MS) _qrOwners.delete(existingQrid);
  }
  _qrOwners.set(String(qrid), { agentId, createdAt: now });
}

function assertQrOwner(qrid, agentId) {
  const owner = _qrOwners.get(String(qrid));
  if (!owner || Date.now() - owner.createdAt > QR_OWNER_TTL_MS) {
    _qrOwners.delete(String(qrid));
    throw new Error("二维码已失效或不属于当前 agent，请重新生成二维码");
  }
  if (owner.agentId !== agentId) {
    throw new Error("二维码不属于当前 agent，已拒绝跨 agent 扫码登录");
  }
}

// ─── Plugin register ──────────────────────────────────────────────────────────

function createScopedTools(api, agentId) {
  const log = api.logger;
  const tools = [];

  function getPm() {
    const config = pickPluginConfig(api);
    return getPortfolioManager(config, agentId);
  }

  /** Wrap error handling: auto-invalidate session on auth errors. */
  function handleError(err, action) {
    const pm = getPortfolioManager(pickPluginConfig(api), agentId);
    if (pm.isAuthError(err)) {
      pm.invalidateSession();
      log?.info?.(`[${PLUGIN_ID}] session invalidated due to auth error in ${action}`);
      return { error: `Cookie 已过期或无效，请重新调用 ths_login 注入新的 Cookie（${err.message}）` };
    }
    log?.warn?.(`[${PLUGIN_ID}] ${action} failed: ${err.message}`);
    return { error: err.message };
  }

  // 1. ths_login — Cookie injection
  tools.push({
    name: "ths_login",
    label: "注入同花顺 Cookie",
    description: "为当前 agent 注入同花顺 Cookie 完成登录。用户需先在同花顺手机端或 PC 端正常登录，然后提取 Cookie 注入。Cookie 格式如 'userid=xxx; sessionid=yyy; user=zzz'。登录态仅属于当前 agent，持续复用直到同花顺服务端拒绝时自动清除。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cookies: {
          type: "string",
          description: "同花顺 Cookie 字符串，格式如 'userid=xxx; sessionid=yyy; user=zzz'。可从同花顺客户端抓包获取，或从浏览器开发者工具中复制。",
        },
      },
      required: ["cookies"],
    },
    async execute(_toolCallId, params) {
      try {
        const { cookies: cookieStr } = params;
        if (!cookieStr) return { error: "缺少 cookies 参数" };
        const cookies = parseCookieString(cookieStr);
        if (!cookies.userid) return { error: "Cookie 中缺少 userid 字段，请确认 Cookie 完整性" };
        const authParams = extractAuthParamsFromCookies(cookies);
        const pm = getPm();
        pm.setCredentials(cookies, authParams);
        setCachedCookies(pm.cookieCachePath, agentId, cookies, authParams);
        log?.info?.(`[${PLUGIN_ID}] cookie injection success for agent ${agentId}`);
        return {
          status: "ok",
          message: "Cookie 注入成功，后续调用将自动复用，直到同花顺服务端拒绝为止",
          userid: cookies.userid,
        };
      } catch (err) {
        log?.warn?.(`[${PLUGIN_ID}] login failed: ${err.message}`);
        return { error: `Cookie 注入失败: ${err.message}` };
      }
    },
  });

  // 1b. ths_qr_login — 扫码登录
  tools.push({
    name: "ths_qr_login",
    label: "同花顺扫码登录",
    description: "同花顺扫码登录。用户明确要求登录时 action=create 生成一次二维码，并立即用 feishu_send_image 发送，然后结束对话，不要轮询或自动重发。二维码过期就放弃。只有用户之后明确说已完成扫码/完成登录时，才 action=check 检查一次；不要自动检查。action=poll 仅为兼容保留，禁止主动使用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["create", "check", "poll"],
          description: "create=生成一次二维码；check=用户确认扫码后检查一次；poll=兼容旧调用，不要主动使用",
        },
        qrid: {
          type: "string",
          description: "action=poll 时必填，从 create 返回的 qrid",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId, params) {
      try {
        if (params.action === "create") {
          const { qrid, qrUrl, qrBuffer } = await createQrCode();
          // Save the QR PNG so the message tool can attach it to the current
          // Feishu conversation. A tool result is not sent to the user by
          // itself; the agent must send this path before starting poll.
          const savePath = getQrImagePath(agentId, qrid);
          let output = "";
          if (qrBuffer && qrBuffer.length > 0) {
            await fs.promises.mkdir(path.dirname(savePath), { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(savePath, qrBuffer, { mode: 0o600 });
            output = savePath;
          } else {
            // Fallback: download from THS endpoint if buffer was missing
            try {
              const imgResp = await fetch(`${UPASS_BASE_URL}/scan/creatImg?qrid=${qrid}`, {
                headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], "Referer": `${UPASS_BASE_URL}/login` },
              });
              const fallbackBuf = Buffer.from(await imgResp.arrayBuffer());
              if (fallbackBuf.length >= 8 && fallbackBuf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
                await fs.promises.mkdir(path.dirname(savePath), { recursive: true, mode: 0o700 });
                await fs.promises.writeFile(savePath, fallbackBuf, { mode: 0o600 });
                output = savePath;
              }
            } catch (_e) { /* best-effort */ }
          }
          if (!output) throw new Error("二维码图片下载失败，请重试");
          rememberQrOwner(qrid, agentId);
          return {
            status: "ok",
            action: "create",
            qrid,
            qr_url: qrUrl,
            output,
            media: output,
            mediaUrls: [output],
            trustedLocalMedia: true,
            message: `二维码已生成，请立即把图片发送给用户后再等待扫码（有效期约 120 秒）。图片路径：${output}`,
            instructions: `只调用一次 feishu_send_image(path=${JSON.stringify(output)}) 发送二维码，然后结束本轮并等待用户。不要 poll、不要 check、不要定时器、不要重试、不要重新生成。过期无需处理；用户之后明确说已完成扫码才 action=check qrid=${qrid} 检查一次；用户再次明确要求登录才重新 create。`,
          };
        } else if (params.action === "poll" || params.action === "check") {
          if (!params.qrid) return { error: "缺少 qrid 参数（从 create 步骤获取）" };
          assertQrOwner(params.qrid, agentId);
          const { cookies, authParams, account } = await pollQrLogin(params.qrid, params.action === "check" ? 0 : 120000);
          const pm = getPm();
          pm.setCredentials(cookies, authParams);
          setCachedCookies(pm.cookieCachePath, agentId, cookies, authParams);
          _qrOwners.delete(String(params.qrid));
          log?.info?.(`[${PLUGIN_ID}] QR login success for agent ${agentId}`);
          return {
            status: "ok",
            action: params.action,
            userid: cookies.userid,
            account,
            message: "扫码登录成功，Cookie 已缓存，后续调用自动复用",
          };
        } else {
          return { error: "action 参数必须是 create 或 poll" };
        }
      } catch (err) {
        log?.warn?.(`[${PLUGIN_ID}] qr_login failed: ${err.message}`);
        return { error: `扫码登录失败: ${err.message}` };
      }
    },
  });

  // 1c. ths_password_login — 密码登录
  tools.push({
    name: "ths_password_login",
    label: "同花顺密码登录",
    description: "通过同花顺账号密码为当前 agent 登录（移动端协议，无需验证码）。登录成功后 Cookie 仅缓存到当前 agent。适合新设备首次登录或 Cookie 过期后重新登录。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "同花顺账号（手机号或邮箱）",
        },
        password: {
          type: "string",
          description: "同花顺登录密码（明文，传输时 RSA 加密）",
        },
      },
      required: ["account", "password"],
    },
    async execute(_toolCallId, params) {
      try {
        const { account, password } = params;
        if (!account || !password) return { error: "缺少 account 或 password 参数" };
        const { cookies, authParams } = await doMobileLogin(account, password);
        const pm = getPm();
        pm.setCredentials(cookies, authParams);
        setCachedCookies(pm.cookieCachePath, agentId, cookies, authParams);
        log?.info?.(`[${PLUGIN_ID}] password login success for agent ${agentId}`);
        return {
          status: "ok",
          userid: cookies.userid,
          message: "密码登录成功，Cookie 已缓存，后续调用自动复用",
        };
      } catch (err) {
        log?.warn?.(`[${PLUGIN_ID}] password_login failed: ${err.message}`);
        return { error: `密码登录失败: ${err.message}` };
      }
    },
  });

  // 2. ths_list_groups
  tools.push({
    name: "ths_list_groups",
    label: "查看自选股分组",
    description: "查看所有自选股分组及组内股票。可选择是否包含「我的自选」列表。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_self_stocks: { type: "boolean", description: "是否包含「我的自选」列表，默认 false", default: false },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const pm = getPm();
        const includeSelf = params.include_self_stocks === true;
        const groups = await pm.getAllGroups(includeSelf);
        const groupNames = Object.keys(groups);
        return {
          status: "ok",
          count: groupNames.length,
          groups,
        };
      } catch (err) {
        return handleError(err, "list_groups");
      }
    },
  });

  // 3. ths_get_self_stocks
  tools.push({
    name: "ths_get_self_stocks",
    label: "查看我的自选",
    description: "查看「我的自选」列表中的股票，并用同花顺原生行情接口补全 A股/ETF/港股/美股名称、最新价、涨跌幅、开高低、成交量额。不依赖 FQGate；行情失败时仍返回代码与市场。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute(_toolCallId, _params) {
      try {
        const pm = getPm();
        const result = await pm.getSelfStocks(true);
        return {
          status: "ok",
          count: result.items.length,
          items: result.items,
        };
      } catch (err) {
        return handleError(err, "get_self_stocks");
      }
    },
  });

  // 4. ths_add_stock
  tools.push({
    name: "ths_add_stock",
    label: "添加股票到分组",
    description: "添加股票到指定分组（支持批量）。如果分组是「我的自选」，则使用自选股接口。A/H 股支持 600000.SH、00700.HK 等格式；美股支持 MU、MU.US、CRM.NYSE 等格式，并会按同花顺行情返回的交易所市场码写入。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: { type: "string", description: "分组名称，如「我的自选」或自定义分组名" },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "股票代码数组，如 [\"600000.SH\", \"000001.SZ\"]",
        },
      },
      required: ["group", "symbols"],
    },
    async execute(_toolCallId, params) {
      try {
        const { group, symbols } = params;
        if (!group) return { error: "缺少分组名称" };
        if (!Array.isArray(symbols) || symbols.length === 0) return { error: "缺少股票代码" };
        const pm = getPm();
        const result = await pm.addItem(group, symbols);
        return { status: "ok", ...result };
      } catch (err) {
        return handleError(err, "add_stock");
      }
    },
  });

  // 5. ths_remove_stock
  tools.push({
    name: "ths_remove_stock",
    label: "从分组删除股票",
    description: "从指定分组删除股票（支持批量）。如果分组是「我的自选」，则使用自选股接口。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: { type: "string", description: "分组名称" },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "股票代码数组",
        },
      },
      required: ["group", "symbols"],
    },
    async execute(_toolCallId, params) {
      try {
        const { group, symbols } = params;
        if (!group) return { error: "缺少分组名称" };
        if (!Array.isArray(symbols) || symbols.length === 0) return { error: "缺少股票代码" };
        const pm = getPm();
        const result = await pm.removeItem(group, symbols);
        return { status: "ok", ...result };
      } catch (err) {
        return handleError(err, "remove_stock");
      }
    },
  });

  // 6. ths_add_group
  tools.push({
    name: "ths_add_group",
    label: "新建自选分组",
    description: "新建一个自选股分组。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "新分组名称" },
      },
      required: ["name"],
    },
    async execute(_toolCallId, params) {
      try {
        const { name } = params;
        if (!name) return { error: "缺少分组名称" };
        const pm = getPm();
        const result = await pm.addGroup(name);
        return { status: "ok", result };
      } catch (err) {
        return handleError(err, "add_group");
      }
    },
  });

  // 7. ths_delete_group
  tools.push({
    name: "ths_delete_group",
    label: "删除自选分组",
    description: "删除一个自选股分组。需要提供分组名称。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: { type: "string", description: "要删除的分组名称" },
      },
      required: ["group"],
    },
    async execute(_toolCallId, params) {
      try {
        const { group } = params;
        if (!group) return { error: "缺少分组名称" };
        const pm = getPm();
        const result = await pm.deleteGroup(group);
        return { status: "ok", result };
      } catch (err) {
        return handleError(err, "delete_group");
      }
    },
  });

  // 8. ths_share_group
  tools.push({
    name: "ths_share_group",
    label: "分享分组",
    description: "分享自选股分组并生成短期有效链接。需要提供分组名称和有效时间（秒）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: { type: "string", description: "要分享的分组名称" },
        valid_time: { type: "number", description: "链接有效时间（秒）" },
      },
      required: ["group", "valid_time"],
    },
    async execute(_toolCallId, params) {
      try {
        const { group, valid_time } = params;
        if (!group) return { error: "缺少分组名称" };
        if (valid_time === undefined || valid_time === null) return { error: "缺少有效时间" };
        const pm = getPm();
        const result = await pm.shareGroup(group, valid_time);
        return { status: "ok", result };
      } catch (err) {
        return handleError(err, "share_group");
      }
    },
  });

  // 9. ths_sort_group
  tools.push({
    name: "ths_sort_group",
    label: "分组内股票排序",
    description: "重新排列指定分组内的股票顺序。通过 blockstock 协议全量上传实现排序。不支持「我的自选」虚拟分组。未在排序列表中出现的股票将按原顺序追加到末尾。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: { type: "string", description: "分组名称" },
        ordered_symbols: {
          type: "array",
          items: { type: "string" },
          description: "按目标顺序排列的股票代码数组，如 [\"600519.SH\", \"000001.SZ\", \"000858.SZ\"]",
        },
      },
      required: ["group", "ordered_symbols"],
    },
    async execute(_toolCallId, params) {
      try {
        const { group, ordered_symbols } = params;
        if (!group) return { error: "缺少分组名称" };
        if (!Array.isArray(ordered_symbols) || ordered_symbols.length === 0) return { error: "缺少排序后的股票代码列表" };
        const pm = getPm();
        const result = await pm.sortGroup(group, ordered_symbols);
        return { status: "ok", ...result };
      } catch (err) {
        return handleError(err, "sort_group");
      }
    },
  });

  // 12. ths_sync_table — 标的行情同步到飞书多维表（fuyao-feishu-sync 服务）
  tools.push({
    name: "ths_sync_table",
    label: "同步多维表标的行情",
    description:
      "触发 fuyao-feishu-sync 服务，从同花顺扶摇金融数据 API 拉取最新行情（收盘价、涨跌幅、5/10/20日涨跌），更新到飞书多维表中所有标的行。非交易日默认跳过；force=true 可强制执行；dry_run=true 只生成更新计划不写入。同步约需 1 分钟（175 个标的），工具会等待完成并返回结果。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: {
          type: "boolean",
          description: "非交易日也强制执行，默认 false",
        },
        dry_run: {
          type: "boolean",
          description: "只生成更新计划不实际写入多维表，默认 false",
        },
      },
    },
    async execute(_toolCallId, params) {
      const config = pickPluginConfig(api);
      const baseUrl = String(config.syncTableBaseUrl || "http://172.18.0.1:39871").replace(/\/+$/, "");
      const timeoutMs = Number(config.syncTimeoutMs) > 0 ? Number(config.syncTimeoutMs) : 300000;
      const body = JSON.stringify({
        force: Boolean(params?.force),
        dry_run: Boolean(params?.dry_run),
      });
      try {
        const resp = await fetch(`${baseUrl}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          return { error: `同步失败（HTTP ${resp.status}）: ${data?.error || "未知错误"}` };
        }
        return { status: "ok", ...data };
      } catch (err) {
        log?.warn?.(`[${PLUGIN_ID}] sync_table failed: ${err.message}`);
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          return {
            error: `同步请求超时（${timeoutMs}ms）。同步可能仍在后台执行，可稍后调用 GET 状态确认结果`,
          };
        }
        return { error: `同步服务不可达（${baseUrl}）: ${err.message}` };
      }
    },
  });

  return tools;
}

const SCOPED_TOOL_NAMES = [
  "ths_login",
  "ths_qr_login",
  "ths_password_login",
  "ths_list_groups",
  "ths_get_self_stocks",
  "ths_add_stock",
  "ths_remove_stock",
  "ths_add_group",
  "ths_delete_group",
  "ths_share_group",
  "ths_sort_group",
  "ths_sync_table",
];

/* ── DSH 插件桥(2026-10-29 移植)──────────────────────────────
 * OpenClaw 按工厂 ctx.agentId 绑定工具;DSH 在 execute 时解析
 * exec.agent.sessionId(飞书每 chat 一个稳定会话),同身份复用
 * PortfolioManager 缓存。shimApi 保持 pickPluginConfig 原路径可用。 */
const anyJsonOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => {
    const text = JSON.stringify(value, null, 1);
    return [{ type: "text", text: text.length > 20000 ? `${text.slice(0, 20000)}\n…(已截断,共 ${text.length} 字符)` : text }];
  },
};

function apply(ctx, config) {
  const cfg = { stateDir: DEFAULT_STATE_DIR, ...config };
  const shimApi = {
    logger: ctx.logger,
    config: { plugins: { entries: { "ths-favorite": { config: cfg } } } },
  };
  const scopedCache = new Map();
  const scopedFor = (rawId) => {
    const agentId = normalizeAgentId(rawId);
    if (!scopedCache.has(agentId)) scopedCache.set(agentId, createScopedTools(shimApi, agentId));
    return scopedCache.get(agentId);
  };
  const template = scopedFor("default");
  let registered = 0;
  for (const t of template) {
    if (!SCOPED_TOOL_NAMES.includes(t.name)) continue;
    ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      output: anyJsonOutput,
      async execute(args, exec) {
        const openId = exec?.agent?.larkUser?.openId;
        if (typeof openId !== "string" || !openId.startsWith("ou_")) {
          throw new Error("无法确认飞书用户身份，已拒绝访问同花顺自选；请从飞书私聊或群聊重新发起");
        }
        // open_id 只在同一飞书应用内稳定；默认应用保留原状态，新应用独立状态。
        const agentId = `user-${principalKey(openId, exec?.agent?.larkUser?.appId, cfg.defaultAppId)}`;
        const tool = scopedFor(agentId).find((x) => x.name === t.name);
        if (!tool) return { error: `tool ${t.name} unavailable for ${agentId}` };
        // DSH output must be lossless JSON; absent quote metadata is omitted, not undefined.
        return JSON.parse(JSON.stringify(await tool.execute(undefined, args)));
      },
    });
    registered++;
  }
  ctx.logger.info(`[ths-favorites] active: ${registered} tools using feishu-principal user identity`);
  return () => {};
}

const name = "ths-favorites";
const inject = ["tools"];

export { apply, inject, name };
