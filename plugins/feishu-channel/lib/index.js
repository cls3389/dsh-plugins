import { createRequire } from "node:module";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import { homedir, tmpdir } from "node:os";
import * as path$1 from "node:path";
import path, { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { URLSearchParams as URLSearchParams$1, fileURLToPath } from "node:url";
import * as fs$1 from "node:fs";
import fs, { createReadStream, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readUsers, userKey, workspaceFor } from "@dsh-friends/feishu-principal";
import * as fsPromises from "node:fs/promises";
import { chmod, cp, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import z from "@deepseek-ai/schemastery";
import { isPdf, readPdf } from "@dsh-friends/pdf-tools/reader";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { imageSize } from "image-size";
//#region vendor/openclaw-lark/dist/messaging/inbound/user-name-cache-store.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Account-scoped cache registry for Feishu user display names.
*
* Stores forward (openId → name + kind) and reverse (normalizedName → Set<openId>)
* indexes for mention resolution. Per-account, LRU + TTL.
*/
const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS$2 = 1800 * 1e3;
const DEFAULT_MAX_CHATS = 200;
function normalizeName(name) {
	return name.trim().toLowerCase();
}
var UserNameCache = class {
	nameByOpenId = /* @__PURE__ */ new Map();
	openIdsByName = /* @__PURE__ */ new Map();
	maxSize;
	ttlMs;
	chatBots = /* @__PURE__ */ new Map();
	chatMembers = /* @__PURE__ */ new Map();
	inFlight = /* @__PURE__ */ new Map();
	maxChats;
	constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS$2, maxChats = DEFAULT_MAX_CHATS) {
		this.maxSize = maxSize;
		this.ttlMs = ttlMs;
		this.maxChats = maxChats;
	}
	has(openId) {
		const entry = this.nameByOpenId.get(openId);
		if (!entry) return false;
		if (entry.expireAt <= Date.now()) {
			this.deleteOpenId(openId);
			return false;
		}
		return true;
	}
	get(openId) {
		const entry = this.nameByOpenId.get(openId);
		if (!entry) return void 0;
		if (entry.expireAt <= Date.now()) {
			this.deleteOpenId(openId);
			return;
		}
		this.nameByOpenId.delete(openId);
		this.nameByOpenId.set(openId, entry);
		return entry.name;
	}
	set(openId, name) {
		this.writeEntry(openId, name, void 0);
	}
	setWithKind(openId, name, kind) {
		this.writeEntry(openId, name, kind);
	}
	lookupByName(name) {
		const key = normalizeName(name);
		const ids = this.openIdsByName.get(key);
		if (!ids || ids.size === 0) return [];
		const matches = [];
		for (const openId of ids) {
			const entry = this.nameByOpenId.get(openId);
			if (!entry) continue;
			if (entry.expireAt <= Date.now()) {
				this.deleteOpenId(openId);
				continue;
			}
			matches.push({
				openId,
				name: entry.name,
				kind: entry.kind
			});
		}
		return matches;
	}
	setMany(entries) {
		for (const [openId, name] of entries) this.writeEntryNoEvict(openId, name, void 0);
		this.evict();
	}
	filterMissing(openIds) {
		return openIds.filter((id) => !this.has(id));
	}
	getMany(openIds) {
		const result = /* @__PURE__ */ new Map();
		for (const id of openIds) if (this.has(id)) result.set(id, this.get(id) ?? "");
		return result;
	}
	recordChatBots(chatId, members) {
		const enriched = members.map((m) => ({
			...m,
			kind: "bot"
		}));
		this.chatBots.delete(chatId);
		this.chatBots.set(chatId, {
			members: enriched,
			expireAt: Date.now() + this.ttlMs
		});
		this.evictChats(this.chatBots);
		for (const m of enriched) if (m.openId) this.writeEntryNoEvict(m.openId, m.name, "bot");
		this.evict();
	}
	recordChatMembers(chatId, members) {
		const enriched = members.slice();
		this.chatMembers.delete(chatId);
		this.chatMembers.set(chatId, {
			members: enriched,
			expireAt: Date.now() + this.ttlMs
		});
		this.evictChats(this.chatMembers);
		for (const m of enriched) if (m.openId) this.writeEntryNoEvict(m.openId, m.name, m.kind);
		this.evict();
	}
	getChatBots(chatId) {
		const entry = this.chatBots.get(chatId);
		if (!entry) return null;
		if (entry.expireAt <= Date.now()) {
			this.chatBots.delete(chatId);
			return null;
		}
		return entry;
	}
	getChatMembers(chatId) {
		const entry = this.chatMembers.get(chatId);
		if (!entry) return null;
		if (entry.expireAt <= Date.now()) {
			this.chatMembers.delete(chatId);
			return null;
		}
		return entry;
	}
	getInflight(key) {
		return this.inFlight.get(key);
	}
	setInflight(key, promise) {
		this.inFlight.set(key, promise);
	}
	clearInflight(key) {
		this.inFlight.delete(key);
	}
	clear() {
		this.nameByOpenId.clear();
		this.openIdsByName.clear();
		this.chatBots.clear();
		this.chatMembers.clear();
		this.inFlight.clear();
	}
	writeEntry(openId, name, kind) {
		this.writeEntryNoEvict(openId, name, kind);
		this.evict();
	}
	writeEntryNoEvict(openId, name, kind) {
		const old = this.nameByOpenId.get(openId);
		if (old) {
			const oldKey = normalizeName(old.name);
			if (oldKey !== normalizeName(name)) this.removeFromReverse(oldKey, openId);
		}
		this.nameByOpenId.delete(openId);
		this.nameByOpenId.set(openId, {
			name,
			kind,
			expireAt: Date.now() + this.ttlMs
		});
		const key = normalizeName(name);
		let bucket = this.openIdsByName.get(key);
		if (!bucket) {
			bucket = /* @__PURE__ */ new Set();
			this.openIdsByName.set(key, bucket);
		}
		bucket.add(openId);
	}
	deleteOpenId(openId) {
		const entry = this.nameByOpenId.get(openId);
		if (!entry) return;
		this.nameByOpenId.delete(openId);
		this.removeFromReverse(normalizeName(entry.name), openId);
	}
	removeFromReverse(key, openId) {
		const bucket = this.openIdsByName.get(key);
		if (!bucket) return;
		bucket.delete(openId);
		if (bucket.size === 0) this.openIdsByName.delete(key);
	}
	evictChats(map) {
		while (map.size > this.maxChats) {
			const oldest = map.keys().next().value;
			if (oldest === void 0) break;
			map.delete(oldest);
		}
	}
	evict() {
		while (this.nameByOpenId.size > this.maxSize) {
			const oldest = this.nameByOpenId.keys().next().value;
			if (oldest === void 0) break;
			this.deleteOpenId(oldest);
		}
	}
};
const registry$2 = /* @__PURE__ */ new Map();
function getUserNameCache(accountId) {
	let c = registry$2.get(accountId);
	if (!c) {
		c = new UserNameCache();
		registry$2.set(accountId, c);
	}
	return c;
}
function clearUserNameCache(accountId) {
	if (accountId !== void 0) {
		registry$2.get(accountId)?.clear();
		registry$2.delete(accountId);
	} else {
		for (const c of registry$2.values()) c.clear();
		registry$2.clear();
	}
}
//#endregion
//#region vendor/openclaw-lark/dist/core/dsh-compat.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Small OpenClaw SDK primitives replaced for the DSH port.
*/
const DEFAULT_ACCOUNT_ID = "default";
/**
* Resolve the default agent id from an OpenClaw-shaped config subset
* (`agents.list[].default`). Used only by the CardKit footer-metrics lookup;
* an absent/default-less config falls back to `main`, mirroring upstream.
* @param cfg - the config object (structural subset).
* @returns the default agent id.
*/
function resolveDefaultAgentId(cfg) {
	const agents = cfg.agents;
	if (agents !== null && typeof agents === "object") {
		const list = agents.list;
		if (Array.isArray(list)) for (const entry of list) {
			if (entry === null || typeof entry !== "object") continue;
			const candidate = entry;
			if (candidate.default !== true) continue;
			if (typeof candidate.id === "string" && candidate.id.trim() !== "") return candidate.id.trim();
		}
		const defaults = agents.defaults;
		if (defaults !== null && typeof defaults === "object") {
			const id = defaults.agentId;
			if (typeof id === "string" && id.trim() !== "") return id.trim();
		}
	}
	return "main";
}
function normalizeAccountId$1(id) {
	return id?.trim().toLowerCase() || void 0;
}
function buildRandomTempFilePath(options = {}) {
	const prefix = options.prefix ?? "feishu-";
	const extension = options.extension ?? "";
	return join(options.directory ?? tmpdir(), `${prefix}${randomUUID()}${extension}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/core/accounts.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Lark multi-account management.
*
* Account overrides live under `cfg.channels.feishu.accounts`.
* Each account may override any top-level Feishu config field;
* unset fields fall back to the top-level defaults.
*/
const normalizeAccountId = typeof normalizeAccountId$1 === "function" ? normalizeAccountId$1 : (id) => id?.trim().toLowerCase() || void 0;
/** Extract the `channels.feishu` section from the top-level config. */
function getLarkConfig(cfg) {
	return cfg?.channels?.feishu;
}
/** Return the per-account override map, if present. */
function getAccountMap(section) {
	return section.accounts;
}
/** Strip the `accounts` key and return the remaining top-level config. */
function baseConfig(section) {
	const { accounts: _ignored, ...rest } = section;
	return rest;
}
/** Merge base config with account override (account fields take precedence).
*  Performs a one-level deep merge for plain-object fields so that partial
*  account overrides (e.g. `footer: { model: false }`) are merged with
*  the base instead of replacing the entire object. */
function mergeAccountConfig(base, override) {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === void 0) continue;
		const baseVal = base[key];
		if (value && typeof value === "object" && !Array.isArray(value) && baseVal && typeof baseVal === "object" && !Array.isArray(baseVal)) result[key] = {
			...baseVal,
			...value
		};
		else result[key] = value;
	}
	return result;
}
/** Coerce a domain string to `LarkBrand`, defaulting to `"feishu"`. */
function toBrand(domain) {
	return domain ?? "feishu";
}
/**
* List all account IDs defined in the Lark config.
*
* Returns `[DEFAULT_ACCOUNT_ID]` when no explicit accounts exist.
*/
function getLarkAccountIds(cfg) {
	const section = getLarkConfig(cfg);
	if (!section) return [DEFAULT_ACCOUNT_ID];
	const accountMap = getAccountMap(section);
	if (!accountMap || Object.keys(accountMap).length === 0) return [DEFAULT_ACCOUNT_ID];
	const accountIds = Object.keys(accountMap);
	if (!accountIds.some((id) => id.trim().toLowerCase() === "default")) {
		const base = baseConfig(section);
		if (base.appId && base.appSecret) return [DEFAULT_ACCOUNT_ID, ...accountIds];
	}
	return accountIds;
}
/**
* Resolve a single account by merging the top-level config with
* account-level overrides.  Account fields take precedence.
*
* Falls back to the default account when `accountId` is omitted or `null`.
*/
function getLarkAccount(cfg, accountId) {
	const requestedId = accountId ? normalizeAccountId(accountId) ?? "default" : DEFAULT_ACCOUNT_ID;
	const section = getLarkConfig(cfg);
	if (!section) return {
		accountId: requestedId,
		enabled: false,
		configured: false,
		brand: "feishu",
		config: {}
	};
	const base = baseConfig(section);
	const accountMap = getAccountMap(section);
	const accountOverride = accountMap && requestedId !== "default" ? accountMap[requestedId] : void 0;
	const merged = accountOverride ? mergeAccountConfig(base, accountOverride) : { ...base };
	const appId = merged.appId;
	const appSecret = merged.appSecret;
	const configured = !!(appId && appSecret);
	const enabled = !!(merged.enabled ?? configured);
	const brand = toBrand(merged.domain);
	if (configured) return {
		accountId: requestedId,
		enabled,
		configured: true,
		name: merged.name ?? void 0,
		appId,
		appSecret,
		encryptKey: merged.encryptKey ?? void 0,
		verificationToken: merged.verificationToken ?? void 0,
		brand,
		config: merged
	};
	return {
		accountId: requestedId,
		enabled,
		configured: false,
		name: merged.name ?? void 0,
		appId: appId ?? void 0,
		appSecret: appSecret ?? void 0,
		encryptKey: merged.encryptKey ?? void 0,
		verificationToken: merged.verificationToken ?? void 0,
		brand,
		config: merged
	};
}
/** Return all accounts that are both configured and enabled. */
function getEnabledLarkAccounts(cfg) {
	const ids = getLarkAccountIds(cfg);
	const results = [];
	for (const id of ids) {
		const account = getLarkAccount(cfg, id);
		if (account.enabled && account.configured) results.push(account);
	}
	return results;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/lark-ticket.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Request-level ticket for the Feishu plugin.
*
* Uses Node.js AsyncLocalStorage to propagate a ticket (message_id,
* chat_id, account_id) through the entire async call chain without passing
* parameters explicitly.  Call {@link withTicket} at the event entry point
* (monitor.ts) and use {@link getTicket} anywhere downstream.
*/
const store = new AsyncLocalStorage();
/**
* Run `fn` within a ticket context.  All async operations spawned inside
* `fn` will inherit the context and can access it via {@link getTicket}.
*/
function withTicket(ticket, fn) {
	return store.run(ticket, fn);
}
/** Return the current ticket, or `undefined` if not inside withTicket. */
function getTicket() {
	return store.getStore();
}
//#endregion
//#region vendor/openclaw-lark/dist/core/runtime-store.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared runtime store for the Feishu plugin.
*
* Allows modules such as the logger to access the plugin runtime without
* importing LarkClient directly, which would otherwise create static cycles.
*/
const RUNTIME_NOT_INITIALIZED_ERROR = "Feishu plugin runtime has not been initialised. Ensure LarkClient.setRuntime() is called during plugin activation.";
let runtime = null;
function setLarkRuntime(nextRuntime) {
	runtime = nextRuntime;
}
function tryGetLarkRuntime() {
	return runtime;
}
function getLarkRuntime() {
	if (!runtime) throw new Error(RUNTIME_NOT_INITIALIZED_ERROR);
	return runtime;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/lark-logger.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Structured logger factory for the Feishu plugin.
*
* Wraps `PluginRuntime.logging.getChildLogger()` with automatic
* LarkTicket injection from AsyncLocalStorage and a console fallback
* when the runtime is not yet initialised.
*
* Usage:
*   const log = larkLogger("card/streaming");
*   log.info("created entity", { cardId, sequence });
*/
const CYAN = "\x1B[36m";
const YELLOW = "\x1B[33m";
const RED = "\x1B[31m";
const GRAY = "\x1B[90m";
const RESET = "\x1B[0m";
function consoleFallback(subsystem) {
	const tag = `feishu/${subsystem}`;
	return {
		debug: (msg, meta) => console.debug(`${GRAY}[${tag}]${RESET}`, msg, ...meta ? [meta] : []),
		info: (msg, meta) => console.log(`${CYAN}[${tag}]${RESET}`, msg, ...meta ? [meta] : []),
		warn: (msg, meta) => console.warn(`${YELLOW}[${tag}]${RESET}`, msg, ...meta ? [meta] : []),
		error: (msg, meta) => console.error(`${RED}[${tag}]${RESET}`, msg, ...meta ? [meta] : [])
	};
}
function resolveRuntimeLogger(subsystem) {
	try {
		const runtime = tryGetLarkRuntime();
		if (!runtime) return null;
		return runtime.logging.getChildLogger({ subsystem: `feishu/${subsystem}` });
	} catch {
		return null;
	}
}
function getTraceMeta() {
	const ctx = getTicket();
	if (!ctx) return null;
	const trace = {
		accountId: ctx.accountId,
		messageId: ctx.messageId,
		chatId: ctx.chatId
	};
	if (ctx.senderOpenId) trace.senderOpenId = ctx.senderOpenId;
	return trace;
}
function enrichMeta(meta) {
	const trace = getTraceMeta();
	if (!trace) return meta ?? {};
	return meta ? {
		...trace,
		...meta
	} : trace;
}
/**
* Build a trace-aware prefix like `feishu[default][msg:om_xxx]:`.
*
* Mirrors the format used by `trace.ts` so log lines are consistent
* across the old and new logging systems.
*/
function buildTracePrefix() {
	const ctx = getTicket();
	if (!ctx) return "feishu:";
	return `feishu[${ctx.accountId}][msg:${ctx.messageId}]:`;
}
/**
* Format message with inline meta for text-based log output.
*
* RuntimeLogger implementations typically ignore the `meta` parameter in
* their text output (gateway.log / console).  To ensure meta is always
* visible, we serialize user-supplied meta into the message string and
* prepend the trace context prefix (accountId + messageId).
*
* Example:
*   formatMessage("card.create response", { code: 0, cardId: "c_xxx" })
*   → "feishu[default][msg:om_xxx]: card.create response (code=0, cardId=c_xxx)"
*/
function formatMessage(message, meta) {
	const prefix = buildTracePrefix();
	if (!meta || Object.keys(meta).length === 0) return `${prefix} ${message}`;
	const parts = Object.entries(meta).map(([k, v]) => {
		if (v === void 0 || v == null) return null;
		if (typeof v === "object") return `${k}=${JSON.stringify(v)}`;
		return `${k}=${v}`;
	}).filter(Boolean);
	return parts.length > 0 ? `${prefix} ${message} (${parts.join(", ")})` : `${prefix} ${message}`;
}
function createLarkLogger(subsystem) {
	let cachedLogger = null;
	let resolved = false;
	function getLogger() {
		if (!resolved) {
			cachedLogger = resolveRuntimeLogger(subsystem);
			if (cachedLogger) resolved = true;
		}
		return cachedLogger ?? consoleFallback(subsystem);
	}
	return {
		subsystem,
		debug(message, meta) {
			getLogger().debug?.(formatMessage(message, meta), enrichMeta(meta));
		},
		info(message, meta) {
			getLogger().info(formatMessage(message, meta), enrichMeta(meta));
		},
		warn(message, meta) {
			getLogger().warn(formatMessage(message, meta), enrichMeta(meta));
		},
		error(message, meta) {
			getLogger().error(formatMessage(message, meta), enrichMeta(meta));
		},
		child(name) {
			return createLarkLogger(`${subsystem}/${name}`);
		}
	};
}
function larkLogger(subsystem) {
	return createLarkLogger(subsystem);
}
/** @internal Called by lark-client.ts at module init time. */
function injectLarkClient(cls) {}
larkLogger("core/chat-info-cache");
const registry$1 = /* @__PURE__ */ new Map();
/** Clear chat-info caches (called from LarkClient.clearCache). */
function clearChatInfoCache(accountId) {
	if (accountId !== void 0) {
		registry$1.get(accountId)?.clear();
		registry$1.delete(accountId);
	} else {
		for (const c of registry$1.values()) c.clear();
		registry$1.clear();
	}
}
//#endregion
//#region vendor/openclaw-lark/dist/core/version.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 插件版本号管理
*
* 从 package.json 读取版本号并生成 User-Agent 字符串。
*/
/** 缓存的版本号 */
let cachedVersion;
/**
* 获取插件版本号（从 package.json 读取）
*
* @returns 版本号字符串，如 "2026.2.28.5"；读取失败返回 "unknown"
*/
function getPluginVersion() {
	if (cachedVersion) return cachedVersion;
	try {
		const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8");
		cachedVersion = JSON.parse(raw).version ?? "unknown";
		return cachedVersion;
	} catch {
		cachedVersion = "unknown";
		return cachedVersion;
	}
}
/**
* 获取当前运行平台名称
*
* @returns `mac` | `linux` | `windows`
*/
function getPlatform() {
	switch (process.platform) {
		case "darwin": return "mac";
		case "win32": return "windows";
		default: return "linux";
	}
}
/**
* 生成 User-Agent 字符串
*
* @returns User-Agent 字符串，格式：`openclaw-lark/{version}/{platform}`
*
* @example
* ```typescript
* getUserAgent() // => "openclaw-lark/2026.2.28.5/mac"
* ```
*/
function getUserAgent() {
	return `openclaw-lark/${getPluginVersion()}/${getPlatform()}`;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/lark-client.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Feishu / Lark SDK client management.
*
* Provides `LarkClient` — a unified manager for Lark SDK client instances,
* WebSocket connections, EventDispatcher lifecycle, and bot identity.
*
* Consumers obtain instances via factory methods:
*   - `LarkClient.fromCfg(cfg, accountId)` — resolve account from config
*   - `LarkClient.fromAccount(account)` — from a pre-resolved account
*   - `LarkClient.fromCredentials(credentials)` — ephemeral instance (not cached)
*/
const log$18 = larkLogger("core/lark-client");
const GLOBAL_LARK_USER_AGENT_KEY = "LARK_USER_AGENT";
function installGlobalUserAgent() {
	globalThis[GLOBAL_LARK_USER_AGENT_KEY] = getUserAgent();
}
installGlobalUserAgent();
Lark.defaultHttpInstance.defaults.proxy = false;
Lark.defaultHttpInstance.interceptors.request.handlers = [];
Lark.defaultHttpInstance.interceptors.request.use((req) => {
	if (req.headers) req.headers["User-Agent"] = getUserAgent();
	return req;
}, void 0, { synchronous: true });
const BRAND_TO_DOMAIN = {
	feishu: Lark.Domain.Feishu,
	lark: Lark.Domain.Lark
};
/** Map a `LarkBrand` to the SDK `domain` parameter. */
function resolveBrand(brand) {
	return BRAND_TO_DOMAIN[brand ?? "feishu"] ?? brand.replace(/\/+$/, "");
}
/** Instance cache keyed by accountId. */
const cache$1 = /* @__PURE__ */ new Map();
/**
* Compare two SecretRef-shaped objects by their identity fields.
* Key-order independent, unlike JSON.stringify.
*/
function secretRefsEqual(a, b) {
	return a.source === b.source && a.provider === b.provider && a.id === b.id;
}
/**
* Compare two credential values that may be strings or SecretRef objects.
*
* - Both strings: direct `===`.
* - Both SecretRef objects: compare `source`, `provider`, `id` explicitly.
* - Mixed (string vs SecretRef): treat as equal — the platform resolves the
*   SecretRef at startup (producing the cached string) but `loadConfig()`
*   returns the raw object on subsequent calls.  Detecting SecretRef identity
*   changes is not useful here because the platform does not re-resolve
*   feishu secrets on reload, so a new SecretRef would be equally unusable.
*/
function credentialsEqual(a, b) {
	if (a === b) return true;
	if (typeof a === "string" && typeof b === "string") return false;
	if (a && b && typeof a === "object" && typeof b === "object") return secretRefsEqual(a, b);
	if (typeof a === "string" && b && typeof b === "object" || typeof b === "string" && a && typeof a === "object") return true;
	return false;
}
var LarkClient = class LarkClient {
	wsFactory;
	account;
	_sdk = null;
	_wsClient = null;
	_botOpenId;
	_botName;
	_lastProbeResult = null;
	_lastProbeAt = 0;
	_wsStopped = false;
	_wsWatchdog = null;
	_wsReconnecting = null;
	_wsBackoffMs = 5e3;
	_wsHandlers = null;
	_wsAbortSignal;
	_wsReconnectDelayMs = 5e3;
	_wsConnectionGeneration = 0;
	/** Attached message deduplicator — disposed together with the client. */
	messageDedup = null;
	/** Persist the runtime instance for later retrieval (activate 阶段调用一次). */
	static setRuntime(runtime) {
		setLarkRuntime(runtime);
	}
	/** Retrieve the stored runtime instance. Throws if not yet initialised. */
	static get runtime() {
		return getLarkRuntime();
	}
	static _globalConfig = null;
	/** Store the original global config (called during monitor startup). */
	static setGlobalConfig(cfg) {
		LarkClient._globalConfig = cfg;
	}
	/** Retrieve the stored global config, or `null` if not yet set. */
	static get globalConfig() {
		return LarkClient._globalConfig;
	}
	constructor(account, wsFactory) {
		this.wsFactory = wsFactory;
		this.account = account;
	}
	/** Shorthand for `this.account.accountId`. */
	get accountId() {
		return this.account.accountId;
	}
	/** Resolve account from config and return a cached `LarkClient`. */
	static fromCfg(cfg, accountId) {
		return LarkClient.fromAccount(getLarkAccount(cfg, accountId));
	}
	/**
	* Get (or create) a cached `LarkClient` for the given account.
	* If the cached instance has stale credentials it is replaced.
	*/
	static fromAccount(account) {
		const existing = cache$1.get(account.accountId);
		if (existing && existing.account.appId === account.appId && credentialsEqual(existing.account.appSecret, account.appSecret)) return existing;
		if (existing) {
			log$18.info(`credentials changed, disposing stale instance`, { accountId: account.accountId });
			existing.dispose();
		}
		const instance = new LarkClient(account);
		cache$1.set(account.accountId, instance);
		return instance;
	}
	/**
	* Create an ephemeral `LarkClient` from bare credentials.
	* The instance is **not** added to the global cache — suitable for
	* one-off probe / diagnose calls that should not pollute account state.
	*/
	static fromCredentials(credentials, options) {
		const base = {
			accountId: credentials.accountId ?? "default",
			enabled: true,
			brand: credentials.brand ?? "feishu",
			config: {}
		};
		return new LarkClient(credentials.appId && credentials.appSecret ? {
			...base,
			configured: true,
			appId: credentials.appId,
			appSecret: credentials.appSecret
		} : {
			...base,
			configured: false,
			appId: credentials.appId,
			appSecret: credentials.appSecret
		}, options?.wsFactory);
	}
	/** Look up a cached instance by accountId. */
	static get(accountId) {
		return cache$1.get(accountId) ?? null;
	}
	/**
	* Dispose one or all cached instances.
	* With `accountId` — dispose that single instance.
	* Without — dispose every cached instance and clear the cache.
	*/
	static async clearCache(accountId) {
		if (accountId !== void 0) {
			cache$1.get(accountId)?.dispose();
			clearUserNameCache(accountId);
			clearChatInfoCache(accountId);
		} else {
			for (const inst of cache$1.values()) inst.dispose();
			clearUserNameCache();
			clearChatInfoCache();
		}
	}
	/** Lazily-created Lark SDK client. */
	get sdk() {
		if (!this._sdk) {
			const { appId, appSecret } = this.requireCredentials();
			this._sdk = new Lark.Client({
				appId,
				appSecret,
				appType: Lark.AppType.SelfBuild,
				domain: resolveBrand(this.account.brand)
			});
		}
		return this._sdk;
	}
	/**
	* Probe bot identity via the `bot/v1/openclaw_bot/ping` API.
	* Results are cached on the instance for subsequent access via
	* `botOpenId` / `botName`.
	*/
	async probe(opts) {
		const maxAge = opts?.maxAgeMs ?? 0;
		if (maxAge > 0 && this._lastProbeResult && Date.now() - this._lastProbeAt < maxAge) return this._lastProbeResult;
		if (!this.account.appId || !this.account.appSecret) return {
			ok: false,
			error: "missing credentials (appId, appSecret)"
		};
		try {
			const needBotInfo = opts?.needBotInfo ?? true;
			const res = await this.sdk.request({
				method: "POST",
				url: "/open-apis/bot/v1/openclaw_bot/ping",
				data: { needBotInfo }
			});
			if (res.code !== 0) {
				const result = {
					ok: false,
					appId: this.account.appId,
					error: `API error: ${res.msg || `code ${res.code}`}`
				};
				this._lastProbeResult = result;
				this._lastProbeAt = Date.now();
				return result;
			}
			const botInfo = res.data?.pingBotInfo;
			this._botOpenId = botInfo?.botID;
			this._botName = botInfo?.botName;
			const result = {
				ok: true,
				appId: this.account.appId,
				botName: this._botName,
				botOpenId: this._botOpenId
			};
			this._lastProbeResult = result;
			this._lastProbeAt = Date.now();
			return result;
		} catch (err) {
			const result = {
				ok: false,
				appId: this.account.appId,
				error: err instanceof Error ? err.message : String(err)
			};
			this._lastProbeResult = result;
			this._lastProbeAt = Date.now();
			return result;
		}
	}
	/** Cached bot open_id (available after `probe()` or `startWS()`). */
	get botOpenId() {
		return this._botOpenId;
	}
	/** Cached bot name (available after `probe()` or `startWS()`). */
	get botName() {
		return this._botName;
	}
	/**
	* Start WebSocket event monitoring.
	*
	* Flow: probe bot identity → EventDispatcher → WSClient → start.
	* Resolves once the current receive connection is ready, or immediately when
	* an already-aborted signal stops it. Reconnects replace only the socket;
	* channel sessions, active agents and durable dedup state stay untouched.
	*/
	async startWS(opts) {
		const { handlers, abortSignal, autoProbe = true } = opts;
		this._wsHandlers = handlers;
		this._wsAbortSignal = abortSignal;
		this._wsStopped = false;
		this._wsBackoffMs = 5e3;
		if (autoProbe) await this.probe();
		const dispatcher = new Lark.EventDispatcher({
			encryptKey: this.account.encryptKey ?? "",
			verificationToken: this.account.verificationToken ?? ""
		});
		dispatcher.register(handlers);
		const { appId, appSecret } = this.requireCredentials();
		if (this._wsClient) {
			log$18.warn(`closing previous WSClient before reconnect`, { accountId: this.accountId });
			try {
				this._wsClient.close({ force: true });
			} catch {}
			this._wsClient = null;
		}
		let attemptSettled = false;
		let attemptReady;
		let attemptFailed;
		const ready = new Promise((resolve, reject) => {
			attemptReady = () => {
				if (attemptSettled) return;
				attemptSettled = true;
				resolve();
			};
			attemptFailed = (error) => {
				if (attemptSettled) return;
				attemptSettled = true;
				reject(error);
			};
		});
		const generation = ++this._wsConnectionGeneration;
		let socket;
		const stale = () => generation !== this._wsConnectionGeneration || this._wsClient !== socket;
		socket = (this.wsFactory ?? ((params) => new Lark.WSClient(params)))({
			appId,
			appSecret,
			domain: resolveBrand(this.account.brand),
			loggerLevel: Lark.LoggerLevel.info,
			autoReconnect: true,
			wsConfig: { pingTimeout: 30 },
			handshakeTimeoutMs: 15e3,
			onReady: () => {
				if (stale()) return;
				this._wsBackoffMs = 5e3;
				attemptReady();
				log$18.info("ws connected", { accountId: this.accountId });
			},
			onReconnecting: () => {
				if (!stale()) log$18.warn("ws reconnecting", {
					accountId: this.accountId,
					attempt: this.wsConnectionStatus?.reconnectAttempts
				});
			},
			onReconnected: () => {
				if (stale()) return;
				this._wsBackoffMs = 5e3;
				log$18.info("ws reconnected", { accountId: this.accountId });
			},
			onError: (error) => {
				if (stale()) return;
				log$18.error("ws terminal error; scheduling a fresh connection", {
					accountId: this.accountId,
					error: String(error)
				});
				attemptFailed(error);
				this.scheduleWsReconnect();
			}
		});
		this._wsClient = socket;
		const wsClientAny = this._wsClient;
		const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
		wsClientAny.handleEventData = (data) => {
			if (data.headers?.find?.((h) => h.key === "type")?.value === "card") return origHandleEventData({
				...data,
				headers: data.headers.map((h) => h.key === "type" ? {
					...h,
					value: "event"
				} : h)
			});
			return origHandleEventData(data);
		};
		this.startWsWatchdog();
		await this.waitForAbort(dispatcher, abortSignal, ready, attemptFailed);
	}
	/** Whether a WebSocket client is currently active. */
	get wsConnected() {
		if (!this._wsClient) return false;
		const status = this._wsClient.getConnectionStatus?.();
		return status ? status.state === "connected" : true;
	}
	/** Exposed for health tests and operational introspection, without app credentials. */
	get wsConnectionStatus() {
		return this._wsClient?.getConnectionStatus?.() ?? null;
	}
	startWsWatchdog() {
		if (this._wsWatchdog) clearInterval(this._wsWatchdog);
		this._wsWatchdog = setInterval(() => {
			if (this._wsStopped || !this._wsClient) return;
			const state = this.wsConnectionStatus?.state;
			if (state === "failed" || state === "idle") {
				log$18.warn("ws receive connection is not healthy; rebuilding", {
					accountId: this.accountId,
					state
				});
				this.scheduleWsReconnect();
			}
		}, 15e3);
		this._wsWatchdog.unref();
	}
	/** One reconnect per bot, bounded backoff; never rebuild a healthy socket or agent. */
	scheduleWsReconnect() {
		if (this._wsStopped || this._wsReconnecting || !this._wsHandlers) return;
		const delay = this._wsReconnectDelayMs;
		this._wsReconnectDelayMs = 5e3;
		this._wsBackoffMs = Math.min(this._wsBackoffMs * 2, 6e4);
		this._wsReconnecting = (async () => {
			await new Promise((resolve) => setTimeout(resolve, delay));
			if (this._wsStopped || !this._wsHandlers) return;
			try {
				const handlers = this._wsHandlers;
				const signal = this._wsAbortSignal;
				this.disconnect();
				await this.startWS({
					handlers,
					abortSignal: signal,
					autoProbe: false
				});
			} catch (error) {
				log$18.error("ws rebuild failed; retrying with backoff", {
					accountId: this.accountId,
					error: String(error)
				});
				this._wsReconnecting = null;
				this.scheduleWsReconnect();
			}
		})().finally(() => {
			this._wsReconnecting = null;
		});
	}
	/** Disconnect WebSocket but keep instance in cache. */
	disconnect() {
		this._wsStopped = true;
		this._wsConnectionGeneration++;
		if (this._wsWatchdog) {
			clearInterval(this._wsWatchdog);
			this._wsWatchdog = null;
		}
		if (this._wsClient) {
			log$18.info(`disconnecting WebSocket`, { accountId: this.accountId });
			try {
				this._wsClient.close({ force: true });
			} catch {}
		}
		this._wsClient = null;
		if (this.messageDedup) {
			log$18.info(`disposing message dedup`, {
				accountId: this.accountId,
				size: this.messageDedup.size
			});
			this.messageDedup.dispose();
			this.messageDedup = null;
		}
	}
	/** Disconnect + remove from cache. */
	dispose() {
		this.disconnect();
		cache$1.delete(this.accountId);
	}
	/** Assert credentials exist or throw. */
	requireCredentials() {
		const appId = this.account.appId;
		const appSecret = this.account.appSecret;
		if (!appId || !appSecret) throw new Error(`LarkClient[${this.accountId}]: appId and appSecret are required`);
		return {
			appId,
			appSecret
		};
	}
	/**
	* Resolve after this attempt is ready. Abort intentionally leaves a pending
	* attempt promise settled only by the fail callback, avoiding unhandled
	* rejections from stale sockets during teardown.
	*/
	waitForAbort(dispatcher, signal, ready, fail) {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				this.disconnect();
				return resolve();
			}
			signal?.addEventListener("abort", () => {
				this.disconnect();
				fail(/* @__PURE__ */ new Error(`Feishu WebSocket disconnected (${this.accountId})`));
				resolve();
			}, { once: true });
			try {
				this._wsClient.start({ eventDispatcher: dispatcher });
				const timer = setTimeout(() => {
					fail(/* @__PURE__ */ new Error(`Feishu WebSocket initial ready timeout (${this.accountId})`));
					this.scheduleWsReconnect();
				}, 2e4);
				ready.then(() => {
					clearTimeout(timer);
					resolve();
				}, (error) => {
					clearTimeout(timer);
					reject(error);
				});
			} catch (err) {
				this.disconnect();
				reject(err);
			}
		});
	}
};
injectLarkClient(LarkClient);
/**
* Returns the best available config for account resolution.
*
* Priority: live config (has `channels.feishu`) > fallback (has
* `channels.feishu`) > live config (last resort).
*
* The `config` object captured in tool-registration closures may be stale
* after a hot-reload, so we prefer the live config from
* `LarkClient.runtime.config.loadConfig()`.  However, `loadConfig()` may
* return `{}` when the runtime config snapshot has been cleared (e.g. in
* isolated cron sessions), so we fall back to the closure-captured config
* when the live result lacks Feishu credentials.
*
* @param fallback - Config to use when the runtime is not yet initialised
*   or when `loadConfig()` returns an incomplete config.
*/
function getResolvedConfig(fallback) {
	try {
		const live = LarkClient.runtime.config.loadConfig();
		if (live?.channels?.feishu) return live;
		if (fallback?.channels?.feishu) {
			log$18.debug(`loadConfig() returned config without channels.feishu, using fallback`);
			return fallback;
		}
		return live;
	} catch {
		return fallback;
	}
}
//#endregion
//#region src/agent-resolver.ts
/**
* 双写身份载体:larkUser(兼容期保留)+ identity(基座契约)。
* userId 经 feishu-principal userKey 解析身份簇(读写 $DSH_HOME/identities.json)。
*/
function bindUserIdentity(agent, extras) {
	const user = extras.userForSession?.(agent.session.id);
	if (!user) return;
	const bound = agent;
	bound.larkUser = user;
	bound.identity = {
		channel: "feishu",
		...user.agentId !== void 0 ? { agentId: user.agentId } : {},
		...user.appId !== void 0 ? { appId: user.appId } : {},
		subjectId: user.openId,
		userId: userKey(user.openId, user.appId),
		context: {
			chatId: user.chatId,
			...user.accountId !== void 0 ? { accountId: user.accountId } : {}
		}
	};
}
async function syncWorkingDirectory(ctx, agent, cwd) {
	const service = ctx.get("workingDirectory");
	if (service && service.get(agent.session) !== cwd) await service.set(agent, cwd);
}
function agentOptions(config, ctx) {
	const selection = ctx.get("agentDefaultModel")?.currentSelection();
	const manifestModel = config.manifest?.model;
	const provider = config.provider ?? manifestModel?.provider ?? selection?.provider;
	const model = config.model ?? manifestModel?.name ?? selection?.model;
	const effort = config.reasoningEffort ?? manifestModel?.reasoningEffort;
	return {
		...provider ? { provider } : {},
		...model ? { model } : {},
		...effort ? { reasoningEffort: effort } : {}
	};
}
/** Filesystem tools whose path-like arguments must stay inside the user workspace. */
const FENCED_FS_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"grep",
	"glob",
	"read_image"
]);
/** Argument keys that carry a filesystem path, per fenced tool. */
const FENCED_PATH_ARGS = {
	read: ["file_path"],
	write: ["file_path"],
	edit: ["file_path"],
	read_image: ["file_path"],
	grep: ["path"],
	glob: ["path"]
};
/**
* Deny filesystem tools whose path arguments escape the sender's workspace.
* The workspace root comes from the trusted binding cwd (principal-derived),
* never from model-controlled input; subagents inherit this guard through the
* parent scope chain, so delegation cannot widen the fence.
*/
function fenceUserWorkspace(exec, root) {
	if (!FENCED_FS_TOOLS.has(exec.name)) return void 0;
	const keys = FENCED_PATH_ARGS[exec.name];
	if (keys === void 0) return void 0;
	const args = exec.arguments;
	if (args === void 0) return void 0;
	for (const key of keys) {
		const raw = args[key];
		if (typeof raw !== "string" || raw.length === 0) continue;
		const relative$1 = relative(root, resolve(root, raw));
		if (relative$1 === void 0 || relative$1.startsWith(`..${sep}`) || relative$1 === "..") return `tool "${exec.name}" is fenced to the Feishu user workspace ${root} by the business channel`;
	}
}
const restrictedAgents = /* @__PURE__ */ new WeakMap();
/**
* Proto tool sets per identity archetype (agents/<agentId>/manifest.yml proto).
* A bot with no explicit agentToolAllow inherits its proto set instead of the
* patch baseline; an explicit agentToolAllow still wins (backwards compatible).
* The owner archetype follows the patch baseline (self-use bot with trading).
*/
const AGENT_PROTO_ALLOW = {
	guest: [
		"web_search",
		"web_fetch",
		"browser_*",
		"asr_*",
		"image_generate",
		"image_edit",
		"doc_to_markdown",
		"pdf_read",
		"zread_*",
		"memory_*",
		"bash",
		"bash_compact",
		"read",
		"write",
		"edit",
		"grep",
		"glob",
		"read_image",
		"working_directory",
		"feishu_send_image",
		"schedule_*",
		"subagent",
		"subagent_fork",
		"workflow",
		"present",
		"ask_user_question",
		"ths_search",
		"ths_quote",
		"ths_klines",
		"ths_yield_curve",
		"ths_level2",
		"ths_sec_kline",
		"ths_wencai",
		"ths_market_pulse",
		"ths_move_detail",
		"ths_margin_collateral"
	],
	companion: [
		"web_search",
		"web_fetch",
		"browser_*",
		"asr_*",
		"image_generate",
		"image_edit",
		"doc_to_markdown",
		"pdf_read",
		"zread_*",
		"memory_*",
		"bash",
		"bash_compact",
		"read",
		"write",
		"edit",
		"grep",
		"glob",
		"read_image",
		"working_directory",
		"feishu_send_image",
		"schedule_*",
		"subagent",
		"subagent_fork",
		"workflow",
		"present",
		"ask_user_question",
		"skill",
		"read",
		"grep",
		"glob"
	]
};
/** Effective allowlist: explicit bot config wins; otherwise the identity manifest proto set; otherwise the patch baseline. */
function effectiveAllowPatterns(config) {
	if (config.agentToolAllow !== void 0) return config.agentToolAllow;
	const proto = config.manifest?.proto;
	return (proto !== void 0 ? AGENT_PROTO_ALLOW[proto] : void 0) ?? config.agentToolAllow;
}
/** Inherit shared tools, add sender extras, and recalculate on group speaker changes. */
function restrictChannelTools(ctx, config, agent) {
	const openId = agent.larkUser?.openId;
	const principal = ctx.get("feishuPrincipal");
	const base = effectiveAllowPatterns(config);
	const patterns = openId && principal ? principal.toolsFor(openId, base, agent.larkUser?.appId) : base;
	const key = `${agent.larkUser?.appId ?? ""}:${openId ?? ""}:${(patterns ?? []).join("\0")}`;
	const previous = restrictedAgents.get(agent);
	if (previous?.key === key) return;
	previous?.dispose();
	restrictedAgents.delete(agent);
	if (!patterns?.length) return;
	const tools = agent.ctx.get("tools");
	if (!tools) throw new Error("DSH tools service is unavailable");
	const allow = tools.schemas(agent).map((tool) => tool.name).filter((name) => patterns.some((pattern) => toolNameMatches(name, pattern)));
	const removeRestriction = tools.restrict({ allow });
	const bindingRoot = bindingCwdOf(ctx, agent);
	const removeGuard = tools.guard((exec) => {
		const denied = patterns.some((pattern) => toolNameMatches(exec.name, pattern)) ? void 0 : `tool "${exec.name}" is not available through the Feishu business channel`;
		if (denied !== void 0) return denied;
		if (bindingRoot !== void 0) {
			const fenced = fenceUserWorkspace(exec, bindingRoot);
			if (fenced !== void 0) return fenced;
		}
	});
	restrictedAgents.set(agent, {
		key,
		dispose: () => {
			removeRestriction();
			removeGuard();
		}
	});
}
/** Trusted per-session workspace root from the workingDirectory service. */
function bindingCwdOf(ctx, agent) {
	return ctx.get("workingDirectory")?.get(agent.session);
}
function toolNameMatches(name, pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`).test(name);
}
/** Resume existing Lark sessions through the same Agent registry as Web hosts. */
async function resolveAgent(ctx, config, sessionId, cwd, extras = {}) {
	const agents = ctx.get("agents");
	if (!agents) throw new Error("DSH agents service is unavailable");
	const existing = agents.get(sessionId);
	if (existing) {
		bindUserIdentity(existing, extras);
		await syncWorkingDirectory(ctx, existing, cwd);
		restrictChannelTools(ctx, config, existing);
		return existing;
	}
	const options = agentOptions(config, ctx);
	const modelSetup = extras.selections?.setup(extras.modelOverride?.(sessionId));
	const setup = (agentCtx, agent) => {
		const delegated = modelSetup?.(agentCtx, agent);
		const commit = () => {
			bindUserIdentity(agent, extras);
			restrictChannelTools(ctx, config, agent);
		};
		if (delegated instanceof Promise) return delegated.then((ready) => ({ commit: () => {
			commit();
			ready?.commit();
		} }));
		return { commit: () => {
			commit();
			delegated?.commit();
		} };
	};
	const withOptions = (base) => ({
		...base,
		...options ? { agentOptions: options } : {},
		setup
	});
	try {
		const resumed = await agents.resume(withOptions({ resumeSessionId: sessionId }));
		bindUserIdentity(resumed.agent, extras);
		await syncWorkingDirectory(ctx, resumed.agent, cwd);
		restrictChannelTools(ctx, config, resumed.agent);
		return resumed.agent;
	} catch (error) {
		const concurrent = agents.get(sessionId);
		if (concurrent) {
			bindUserIdentity(concurrent, extras);
			await syncWorkingDirectory(ctx, concurrent, cwd);
			restrictChannelTools(ctx, config, concurrent);
			return concurrent;
		}
		if (!(typeof error === "object" && error !== null && "code" in error ? [
			"SESSION_NOT_FOUND",
			"ENOENT",
			"NOT_FOUND"
		].includes(String(error.code)) : /not found|does not exist|ENOENT/i.test(String(error)))) throw error;
		const created = await agents.create(withOptions({
			sessionId,
			meta: { cwd }
		}));
		bindUserIdentity(created.agent, extras);
		await syncWorkingDirectory(ctx, created.agent, cwd);
		restrictChannelTools(ctx, config, created.agent);
		return created.agent;
	}
}
/** Host-neutral compatibility for integrations that use Web's sessionController. */
function registerSessionController(ctx, config, cwd, extras = {}) {
	const controller = { async resolveAgent(sessionId) {
		try {
			return { agent: await resolveAgent(ctx, config, sessionId, cwd, extras) };
		} catch (error) {
			return { error: {
				code: "SESSION_UNAVAILABLE",
				message: String(error)
			} };
		}
	} };
	if (ctx.get("sessionController") !== void 0) {
		ctx.logger.warn("[lark] host sessionController already exists; using existing service");
		return;
	}
	ctx.provide("sessionController", controller);
	ctx.logger.info("[lark] Agent-backed sessionController compatibility enabled");
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/dedup.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* FIFO-based message deduplication.
*
* Feishu WebSocket connections may redeliver messages on reconnect.
* This module tracks recently-seen message IDs and filters duplicates.
*
* Design choices:
* - FIFO eviction (not LRU) — message IDs are write-once/check-once,
*   no hot/cold access pattern.  FIFO naturally expires the oldest entry
*   first, which matches the dedup semantics.
* - ES2015 `Map` preserves insertion order, giving us FIFO for free.
* - Periodic sweep leverages FIFO ordering: iterate from oldest and
*   `break` at the first non-expired entry → O(expired), not O(n).
*/
const DEFAULT_TTL_MS$1 = 720 * 60 * 1e3;
const DEFAULT_MAX_ENTRIES = 5e3;
const SWEEP_INTERVAL_MS = 300 * 1e3;
var MessageDedup = class {
	store = /* @__PURE__ */ new Map();
	ttlMs;
	maxEntries;
	persistence;
	sweepTimer;
	constructor(opts = {}) {
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS$1;
		this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.persistence = opts.persistence;
		this.sweep();
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
		this.sweepTimer.unref();
	}
	/**
	* Try to record a message ID.
	*
	* @param id   Unique message identifier (e.g. Feishu `message_id`).
	* @param scope Optional scope prefix (e.g. accountId) to namespace IDs.
	* @returns `true` if the message is **new**; `false` if it is a duplicate.
	*/
	tryRecord(id, scope) {
		const key = scope ? `${scope}:${id}` : id;
		const now = Date.now();
		const existing = this.store.get(key) ?? this.persistence?.get(key);
		if (existing !== void 0) {
			if (now - existing < this.ttlMs) return false;
			this.store.delete(key);
		}
		if (this.store.size >= this.maxEntries) {
			const oldest = this.store.keys().next().value;
			if (oldest !== void 0) this.store.delete(oldest);
		}
		this.store.set(key, now);
		this.persistence?.set(key, now);
		this.persistence?.persist();
		return true;
	}
	/** Current number of tracked entries (for diagnostics). */
	get size() {
		return this.store.size;
	}
	/** Remove all entries and stop the periodic sweep. */
	clear() {
		clearInterval(this.sweepTimer);
		this.store.clear();
	}
	/** Stop the timer and flush message IDs; durable entries survive disposal. */
	dispose() {
		clearInterval(this.sweepTimer);
		this.persistence?.persist();
		this.store.clear();
	}
	/**
	* Sweep expired entries from the front of the map.
	* Because entries are in insertion order (FIFO), we can stop as soon as
	* we hit one that hasn't expired yet.
	*/
	sweep() {
		const now = Date.now();
		for (const [key, ts] of this.store) {
			if (now - ts < this.ttlMs) break;
			this.store.delete(key);
		}
		this.persistence?.sweep?.(now - this.ttlMs, this.maxEntries);
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/core/permission-url.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Permission URL extraction utilities.
*
* Shared functions for extracting and processing permission grant URLs
* from Feishu API error messages.
*/
/**
* Permission priority for sorting.
* Lower number = higher priority.
* - read: 1 (highest)
* - write: 2
* - other / both read+write: 3 (lowest)
*/
function getPermissionPriority(scope) {
	const lowerScope = scope.toLowerCase();
	const hasRead = lowerScope.includes("read");
	const hasWrite = lowerScope.includes("write");
	if (hasRead && !hasWrite) return 1;
	if (hasWrite && !hasRead) return 2;
	return 3;
}
/**
* Extract the highest-priority permission from a scope list.
* Returns the permission with the lowest priority number (read > write > other).
*/
function extractHighestPriorityScope(scopeList) {
	return scopeList.split(",").sort((a, b) => getPermissionPriority(a) - getPermissionPriority(b))[0] ?? "";
}
/**
* Extract permission grant URL from a Feishu error message and optimize it
* by keeping only the highest-priority permission.
*
* @param msg - The error message containing the grant URL
* @returns The optimized grant URL with single permission, or empty string if not found
*/
function extractPermissionGrantUrl(msg) {
	const urlMatch = msg.match(/https:\/\/[^\s]+\/app\/[^\s]+/);
	if (!urlMatch?.[0]) return "";
	try {
		const url = new URL(urlMatch[0]);
		const firstScope = extractHighestPriorityScope(url.searchParams.get("q") ?? "");
		if (firstScope) url.searchParams.set("q", firstScope);
		return url.href;
	} catch {
		return urlMatch[0];
	}
}
/**
* Extract permission scopes from a Feishu error message.
* Looks for scopes in the format [scope1,scope2,...]
*/
function extractPermissionScopes(msg) {
	return msg.match(/\[([^\]]+)\]/)?.[1] ?? "unknown";
}
//#endregion
//#region vendor/openclaw-lark/dist/core/auth-errors.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* auth-errors.ts — 统一错误类型定义。
*
* 所有与认证/授权/scope 相关的错误类型集中在此文件，
* 解除 tool-client ↔ app-scope-checker 循环依赖。
*
* 其他模块应直接 import 此文件，或通过 tool-client / uat-client 的 re-export 使用。
*/
/** 飞书 OAPI 错误码常量，替代各处硬编码的 magic number。 */
const LARK_ERROR = {
	/** 应用 scope 不足（租户维度） */
	APP_SCOPE_MISSING: 99991672,
	/** 用户 token scope 不足 */
	USER_SCOPE_INSUFFICIENT: 99991679,
	/** access_token 无效 */
	TOKEN_INVALID: 99991668,
	/** access_token 已过期 */
	TOKEN_EXPIRED: 99991677,
	/** refresh_token 本身无效（格式非法或来自 v1 API） */
	REFRESH_TOKEN_INVALID: 20026,
	/** refresh_token 已过期（超过 365 天） */
	REFRESH_TOKEN_EXPIRED: 20037,
	/** refresh_token 已被吊销 */
	REFRESH_TOKEN_REVOKED: 20064,
	/** refresh_token 已被使用（单次消费，rotation 场景） */
	REFRESH_TOKEN_ALREADY_USED: 20073,
	/** refresh token 端点服务端内部错误，可重试 */
	REFRESH_SERVER_ERROR: 20050,
	/** 消息已被撤回 */
	MESSAGE_RECALLED: 230011,
	/** 消息已被删除 */
	MESSAGE_DELETED: 231003
};
/** refresh token 端点可重试的错误码集合（服务端瞬时故障）。遇到后重试一次，仍失败则清 token。 */
const REFRESH_TOKEN_RETRYABLE = new Set([LARK_ERROR.REFRESH_SERVER_ERROR]);
/** 消息终止错误码集合（撤回/删除），遇到后应停止对该消息的后续操作。 */
const MESSAGE_TERMINAL_CODES = new Set([LARK_ERROR.MESSAGE_RECALLED, LARK_ERROR.MESSAGE_DELETED]);
/** access_token 失效相关的错误码集合，遇到后可尝试刷新重试。 */
const TOKEN_RETRY_CODES = new Set([LARK_ERROR.TOKEN_INVALID, LARK_ERROR.TOKEN_EXPIRED]);
/**
* Thrown when no valid UAT exists and the user needs to (re-)authorise.
* Callers should catch this and trigger the OAuth flow.
*/
var NeedAuthorizationError = class extends Error {
	userOpenId;
	constructor(userOpenId) {
		super("need_user_authorization");
		this.name = "NeedAuthorizationError";
		this.userOpenId = userOpenId;
	}
};
/**
* 应用缺少 application:application:self_manage 权限，无法查询应用权限配置。
*
* 需要管理员在飞书开放平台开通 application:application:self_manage 权限。
*/
var AppScopeCheckFailedError = class extends Error {
	/** 应用 ID，用于生成开放平台权限管理链接。 */
	appId;
	constructor(appId) {
		super("应用缺少 application:application:self_manage 权限，无法查询应用权限配置。请管理员在开放平台开通该权限。");
		this.name = "AppScopeCheckFailedError";
		this.appId = appId;
	}
};
/**
* 应用未开通 OAPI 所需 scope。
*
* 需要管理员在飞书开放平台开通权限。
*/
var AppScopeMissingError = class extends Error {
	apiName;
	/** OAPI 需要但 APP 未开通的 scope 列表。 */
	missingScopes;
	/** 工具的全部所需 scope（含已开通的），用于应用权限完成后一次性发起用户授权。 */
	allRequiredScopes;
	/** 应用 ID，用于生成开放平台权限管理链接。 */
	appId;
	scopeNeedType;
	/** 触发此错误时使用的 token 类型，用于保持 card action 二次校验一致。 */
	tokenType;
	constructor(info, scopeNeedType, tokenType, allRequiredScopes) {
		if (scopeNeedType === "one") super(`应用缺少权限 [${info.scopes.join(", ")}](开启任一权限即可)，请管理员在开放平台开通。`);
		else super(`应用缺少权限 [${info.scopes.join(", ")}]，请管理员在开放平台开通。`);
		this.name = "AppScopeMissingError";
		this.apiName = info.apiName;
		this.missingScopes = info.scopes;
		this.allRequiredScopes = allRequiredScopes;
		this.appId = info.appId;
		this.scopeNeedType = scopeNeedType;
		this.tokenType = tokenType;
	}
};
/**
* 用户未授权或 scope 不足，需要发起 OAuth 授权。
*
* `requiredScopes` 为 APP∩OAPI 的有效 scope，可直接传给
* `feishu_oauth authorize --scope`。
*/
var UserAuthRequiredError = class extends Error {
	userOpenId;
	apiName;
	/** APP∩OAPI 交集 scope，传给 OAuth authorize。 */
	requiredScopes;
	/** 应用 scope 是否已验证通过。false 时 requiredScopes 可能不准确。 */
	appScopeVerified;
	/** 应用 ID，用于生成开放平台权限管理链接。 */
	appId;
	constructor(userOpenId, info) {
		super("need_user_authorization");
		this.name = "UserAuthRequiredError";
		this.userOpenId = userOpenId;
		this.apiName = info.apiName;
		this.requiredScopes = info.scopes;
		this.appId = info.appId;
		this.appScopeVerified = info.appScopeVerified ?? true;
	}
};
/**
* 服务端报 99991679 — 用户 token 的 scope 不足。
*
* 需要增量授权：用缺失的 scope 发起新 Device Flow。
*/
var UserScopeInsufficientError = class extends Error {
	userOpenId;
	apiName;
	/** 缺失的 scope 列表。 */
	missingScopes;
	constructor(userOpenId, info) {
		super("user_scope_insufficient");
		this.name = "UserScopeInsufficientError";
		this.userOpenId = userOpenId;
		this.apiName = info.apiName;
		this.missingScopes = info.scopes;
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/permission.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Permission error extraction and cooldown tracking for Feishu API calls.
*
* Extracted from bot.ts: PermissionError type, extractPermissionError,
* PERMISSION_ERROR_COOLDOWN_MS, permissionErrorNotifiedAt.
*/
function extractPermissionError(err) {
	if (!err || typeof err !== "object") return null;
	const data = err.response?.data;
	if (!data || typeof data !== "object") return null;
	const feishuErr = data;
	if (feishuErr.code !== LARK_ERROR.APP_SCOPE_MISSING) return null;
	const msg = feishuErr.msg ?? "";
	const grantUrl = extractPermissionGrantUrl(msg);
	if (!grantUrl) return null;
	return {
		code: feishuErr.code,
		message: msg,
		grantUrl
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/user-name-cache.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Account-scoped LRU cache for Feishu user display names.
*
* Provides:
* - `UserNameCache` — per-account LRU Map with TTL
* - `getUserNameCache(accountId)` — singleton registry
* - `batchResolveUserNames()` — batch API via `contact/v3/users/batch`
* - `resolveUserName()` — single-user fallback via `contact.user.get`
* - `clearUserNameCache()` — teardown hook (called from LarkClient.clearCache)
*/
/** Max user_ids per API call (Feishu limit). */
const BATCH_SIZE$1 = 50;
/**
* Batch-resolve user display names.
*
* 1. Check cache → collect misses
* 2. Deduplicate
* 3. Call `GET /open-apis/contact/v3/users/batch` in chunks of 50
* 4. Write results back to cache
* 5. Return full Map<openId, name> (cache hits + API results)
*
* Best-effort: API errors are logged but never thrown.
*/
async function batchResolveUserNames(params) {
	const { account, openIds, log } = params;
	if (!account.configured || openIds.length === 0) return /* @__PURE__ */ new Map();
	const cache = getUserNameCache(account.accountId);
	const result = cache.getMany(openIds);
	const missing = [...new Set(cache.filterMissing(openIds))];
	if (missing.length === 0) return result;
	const client = LarkClient.fromAccount(account).sdk;
	for (let i = 0; i < missing.length; i += BATCH_SIZE$1) {
		const chunk = missing.slice(i, i + BATCH_SIZE$1);
		try {
			const items = (await client.contact.user.batch({ params: {
				user_ids: chunk,
				user_id_type: "open_id"
			} }))?.data?.items ?? [];
			const resolved = /* @__PURE__ */ new Set();
			for (const item of items) {
				const openId = item.open_id;
				if (!openId) continue;
				const name = item.name || item.display_name || item.nickname || item.en_name || "";
				cache.setWithKind(openId, name, "user");
				result.set(openId, name);
				resolved.add(openId);
			}
			for (const id of chunk) if (!resolved.has(id)) {
				cache.setWithKind(id, "", "user");
				result.set(id, "");
			}
		} catch (err) {
			log(`batchResolveUserNames: failed: ${String(err)}`);
		}
	}
	return result;
}
/**
* Create a `batchResolveNames` callback for use in `ConvertContext`.
*
* The returned function calls `batchResolveUserNames` with the given
* account and log function, populating the TAT user-name cache.
*/
function createBatchResolveNames(account, log) {
	return async (openIds) => {
		await batchResolveUserNames({
			account,
			openIds,
			log
		});
	};
}
/** Returns the numeric Feishu API error code from a thrown error, or null. */
function extractApiCode(err) {
	const permErr = extractPermissionError(err);
	if (typeof permErr?.code === "number") return permErr.code;
	if (err && typeof err === "object") {
		const code = err.response?.data?.code;
		if (typeof code === "number") return code;
	}
	return null;
}
/**
* Runs a chat-member prefetch with shared lifecycle:
*
* 1. Skip on unconfigured account or empty chatId.
* 2. Dedup concurrent calls per (tag, chatId) via `cache.inFlight`.
* 3. Skip when an in-TTL snapshot already exists.
* 4. On API error, cache an empty list to short-circuit retries; on
*    transient errors, leave the cache untouched so the next call retries.
*/
async function runChatPrefetch(spec, account, chatId, log) {
	if (!account.configured || !chatId) return;
	const cache = getUserNameCache(account.accountId);
	const key = `${spec.tag}:${chatId}`;
	const existing = cache.getInflight(key);
	if (existing) return existing;
	if (spec.isFresh(cache, chatId)) return;
	const promise = (async () => {
		try {
			const members = ((await LarkClient.fromAccount(account).sdk.request({
				method: "GET",
				url: spec.url(chatId),
				params: spec.params
			}))?.data?.items ?? []).map(spec.parseItem).filter((m) => m !== null);
			spec.record(cache, chatId, members);
		} catch (err) {
			const apiCode = extractApiCode(err);
			if (apiCode != null) {
				log(`prefetchChat${spec.tag}[${chatId}]: API error code=${apiCode}, caching empty`);
				spec.record(cache, chatId, []);
			} else log(`prefetchChat${spec.tag}[${chatId}]: failed: ${String(err)}`);
		} finally {
			cache.clearInflight(key);
		}
	})();
	cache.setInflight(key, promise);
	return promise;
}
const CHAT_BOTS_SPEC = {
	tag: "Bots",
	url: (chatId) => `/open-apis/im/v1/chats/${chatId}/members/bots`,
	params: {},
	parseItem: (raw) => {
		const it = raw;
		const openId = String(it.bot_id ?? it.open_id ?? "");
		if (!openId) return null;
		return {
			openId,
			name: String(it.bot_name ?? it.name ?? "")
		};
	},
	isFresh: (cache, chatId) => cache.getChatBots(chatId) !== null,
	record: (cache, chatId, members) => cache.recordChatBots(chatId, members)
};
function memberTypeToKind(type) {
	return type === "app" ? "bot" : "user";
}
const CHAT_MEMBERS_SPEC = {
	tag: "Members",
	url: (chatId) => `/open-apis/im/v1/chats/${chatId}/members`,
	params: {
		member_id_type: "open_id",
		page_size: 100
	},
	parseItem: (raw) => {
		const it = raw;
		const openId = String(it.member_id ?? it.open_id ?? "");
		if (!openId) return null;
		return {
			openId,
			name: String(it.name ?? ""),
			kind: memberTypeToKind(it.member_type)
		};
	},
	isFresh: (cache, chatId) => cache.getChatMembers(chatId) !== null,
	record: (cache, chatId, members) => cache.recordChatMembers(chatId, members)
};
/**
* Fetches the bot members of a chat via
* `GET /open-apis/im/v1/chats/{chat_id}/members/bots` and writes them
* to the per-account cache.
*/
async function prefetchChatBots(account, chatId, log) {
	return runChatPrefetch(CHAT_BOTS_SPEC, account, chatId, log);
}
/**
* Fetches the human members of a chat via
* `GET /open-apis/im/v1/chats/{chat_id}/members` and writes them to
* the per-account cache.
*/
async function prefetchChatMembers(account, chatId, log) {
	return runChatPrefetch(CHAT_MEMBERS_SPEC, account, chatId, log);
}
/**
* Resolve a single user's display name.
*
* Checks the account-scoped cache first, then falls back to the
* `contact.user.get` API (same as the old `resolveFeishuSenderName`).
*/
async function resolveUserName(params) {
	const { account, openId, log } = params;
	if (!account.configured || !openId) return {};
	const cache = getUserNameCache(account.accountId);
	if (cache.has(openId)) return { name: cache.get(openId) ?? "" };
	try {
		const res = await LarkClient.fromAccount(account).sdk.contact.user.get({
			path: { user_id: openId },
			params: { user_id_type: "open_id" }
		});
		const name = res?.data?.user?.name || res?.data?.user?.display_name || res?.data?.user?.nickname || res?.data?.user?.en_name || "";
		cache.setWithKind(openId, name, "user");
		return { name: name || void 0 };
	} catch (err) {
		const permErr = extractPermissionError(err);
		if (permErr) {
			log(`feishu: permission error resolving user name: code=${permErr.code}`);
			cache.setWithKind(openId, "", "user");
			return { permissionError: permErr };
		}
		log(`feishu: failed to resolve user name for ${openId}: ${String(err)}`);
		return {};
	}
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/utils.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared utilities for content converters.
*/
/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Safely parse a JSON string, returning undefined on failure.
*/
function safeParse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return;
	}
}
/**
* Format a duration in milliseconds to a human-readable string.
*
* Examples: 1500 → "1.5s", 65000 → "65s"
*/
function formatDuration(ms) {
	const seconds = ms / 1e3;
	if (seconds < 1) return `${ms}ms`;
	if (Number.isInteger(seconds)) return `${seconds}s`;
	return `${seconds.toFixed(1)}s`;
}
/**
* Convert a millisecond timestamp to "YYYY-MM-DD HH:mm" in UTC+8 (Beijing time).
*/
function millisToDatetime(ms) {
	const num = Number(ms);
	if (!Number.isFinite(num)) return String(ms);
	const d = new Date(num + 480 * 60 * 1e3);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/content-converter-helpers.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared helper functions for Feishu content converters.
*/
/** 从 mention 的 id 字段提取 open_id（兼容事件推送的对象格式和 API 响应的字符串格式） */
function extractMentionOpenId(id) {
	if (typeof id === "string") return id;
	if (id != null && typeof id === "object" && "open_id" in id) {
		const openId = id.open_id;
		return typeof openId === "string" ? openId : "";
	}
	return "";
}
/**
* Build a {@link ConvertContext} from a raw Feishu API message item.
*
* Extracts the `mentions` array that the IM API returns on each message
* item and maps it into the key→MentionInfo / openId→MentionInfo
* structures the converter system expects.
*/
function buildConvertContextFromItem(item, fallbackMessageId, accountId) {
	const mentions = /* @__PURE__ */ new Map();
	const mentionsByOpenId = /* @__PURE__ */ new Map();
	for (const m of item.mentions ?? []) {
		const openId = extractMentionOpenId(m.id);
		if (!openId) continue;
		const info = {
			key: m.key,
			openId,
			name: m.name ?? "",
			isBot: false
		};
		mentions.set(m.key, info);
		mentionsByOpenId.set(openId, info);
	}
	return {
		mentions,
		mentionsByOpenId,
		messageId: item.message_id ?? fallbackMessageId,
		accountId,
		resolveUserName: accountId ? (openId) => getUserNameCache(accountId).get(openId) : void 0
	};
}
/**
* Resolve mention placeholders in text.
*
* - Bot self-mention + stripBotMentions: leading-only strip. When the
*   self-mention sits at the very start of the message, drop it (the
*   `WasMentioned` envelope field already tells the agent "this message
*   was addressed to you", so the anchor is redundant). When it appears
*   mid-text, render it as plain `@Name` so the surrounding context still
*   reads naturally without leaving an inline anchor the LLM might echo
*   back into its reply.
* - Non-bot mentions: replace the placeholder key with readable `@name`.
*/
function resolveMentions(text, ctx) {
	if (ctx.mentions.size === 0) return text;
	let result = text;
	for (const [key, info] of ctx.mentions) if (info.isBot && ctx.stripBotMentions) {
		result = result.replace(new RegExp(escapeRegExp(key), "g"), `@${info.name}`);
		const leadingPattern = new RegExp(`^\\s*@${escapeRegExp(info.name)}[\\s,，:：]*`);
		result = result.replace(leadingPattern, "").trimStart();
	} else result = result.replace(new RegExp(escapeRegExp(key), "g"), `@${info.name}`);
	return result;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/text.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "text" message type.
*/
const convertText = (raw, ctx) => {
	return {
		content: resolveMentions(safeParse(raw)?.text ?? raw, ctx),
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/post.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "post" (rich text) message type.
*
* Preserves structure as Markdown: links as `[text](href)`,
* images as `![image](key)`, code blocks, and mention resolution.
*/
const log$17 = larkLogger("converters/post");
/** Preferred locale order for multi-language post unwrapping. */
const LOCALE_PRIORITY = [
	"zh_cn",
	"en_us",
	"ja_jp"
];
/**
* Scan token for native markdown: a code region to SKIP, OR an image to intercept.
* Group 1 (code region) matches first so `![alt](key)` inside code is consumed
* verbatim and never intercepted:
*   - fenced block: ```...``` or ~~~...~~~ (multi-line, lazy)
*   - inline span:  ``...`` or `...` (single-line)
* Group 2 (alt) + Group 3 (target) are the image when no code region matched.
*/
const MD_SCAN_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[^`\n]*`)|!\[([^\]]*)\]\(([^)]+)\)/g;
/** Feishu image_key prefix (aligned with markdown-style.ts stripInvalidImageKeys & case 'img'). */
const FEISHU_IMAGE_KEY_RE = /^img_/;
/**
* Inbound native-markdown size ceiling (chars). Guards against pathological
* posts (huge tables / deep nesting) blowing up memory/token before the
* downstream chunker runs. One order above the outbound chunk magnitude
* (outbound default 15000). Tunable; per-account config override is a follow-up.
*/
const MAX_INBOUND_MD_LEN = 1e5;
/**
* Unwrap a parsed post object that may be locale-wrapped.
*
* Feishu post messages come in two shapes:
*   - Flat:   `{ title, content }`
*   - Locale: `{ zh_cn: { title, content }, en_us: { title, content } }`
*/
function unwrapLocale(parsed) {
	if ("title" in parsed || "content" in parsed || "content_v2" in parsed) return parsed;
	for (const locale of LOCALE_PRIORITY) {
		const localeData = parsed[locale];
		if (localeData != null && typeof localeData === "object") return localeData;
	}
	const firstKey = Object.keys(parsed)[0];
	if (firstKey) {
		const firstValue = parsed[firstKey];
		if (firstValue != null && typeof firstValue === "object") return firstValue;
	}
}
const convertPost = (raw, ctx) => {
	const rawParsed = safeParse(raw);
	if (rawParsed == null || typeof rawParsed !== "object") return {
		content: "[rich text message]",
		resources: []
	};
	const parsed = unwrapLocale(rawParsed);
	if (!parsed) return {
		content: "[rich text message]",
		resources: []
	};
	const resources = [];
	const lines = [];
	const seenFileKeys = /* @__PURE__ */ new Set();
	if (parsed.title) lines.push(`**${parsed.title}**`, "");
	const v2 = parsed.content_v2;
	const usedV2 = Array.isArray(v2) && v2.length > 0;
	const contentBlocks = usedV2 ? v2 : parsed.content ?? [];
	log$17.info("post content source selected", {
		messageId: ctx.messageId,
		source: usedV2 ? "content_v2" : "content",
		hasV2: Array.isArray(v2),
		v2Len: Array.isArray(v2) ? v2.length : 0
	});
	for (const paragraph of contentBlocks) {
		if (!Array.isArray(paragraph)) continue;
		let line = "";
		for (const el of paragraph) line += renderElement(el, ctx, resources, seenFileKeys);
		lines.push(line);
	}
	let content = lines.join("\n").trim() || "[rich text message]";
	content = resolveMentions(content, ctx);
	content = capInboundLength(content, resources);
	return {
		content,
		resources
	};
};
function renderElement(el, ctx, resources, seenFileKeys) {
	switch (el.tag) {
		case "text": {
			let text = el.text ?? "";
			text = applyStyle(text, el.style);
			return text;
		}
		case "a": {
			const text = el.text ?? el.href ?? "";
			return el.href ? `[${text}](${el.href})` : text;
		}
		case "at": {
			const userId = el.user_id ?? "";
			if (userId === "all") return "@all";
			const name = el.user_name ?? userId;
			const info = ctx.mentionsByOpenId.get(userId);
			if (info) return info.key;
			return `@${name}`;
		}
		case "img":
			if (el.image_key) {
				resources.push({
					type: "image",
					fileKey: el.image_key
				});
				return `![image](${el.image_key})`;
			}
			return "";
		case "media":
			if (el.file_key) {
				resources.push({
					type: "file",
					fileKey: el.file_key
				});
				return `<file key="${el.file_key}"/>`;
			}
			return "";
		case "md": return renderInlineImages(el.text ?? "", resources, seenFileKeys);
		case "code_block": return `\n\`\`\`${el.language ?? ""}\n${el.text ?? ""}\n\`\`\`\n`;
		case "hr": return "\n---\n";
		default: return el.text ?? "";
	}
}
function applyStyle(text, style) {
	if (!style || style.length === 0) return text;
	let result = text;
	if (style.includes("bold")) result = `**${result}**`;
	if (style.includes("italic")) result = `*${result}*`;
	if (style.includes("underline")) result = `<u>${result}</u>`;
	if (style.includes("lineThrough")) result = `~~${result}~~`;
	if (style.includes("codeInline")) result = `\`${result}\``;
	return result;
}
/**
* Scan native markdown for `![alt](target)` and intercept feishu image_keys.
* - target matches `^img_` → register a downloadable resource (Set-deduped) and
*   normalize the FIRST occurrence to `![image](key)` (the only form
*   substituteMediaPaths can replace); later occurrences of the same key collapse
*   to sanitized alt text so no bare key / un-replaceable marker leaks downstream.
* - everything else (https/http, data:, protocol-relative, relative/anchor) is kept
*   verbatim and never downloaded.
* Image syntax inside a code region (fenced block or inline span) is left verbatim
* and never intercepted — code is shown as-is, not rendered.
*/
function renderInlineImages(md, resources, seen) {
	return md.replace(MD_SCAN_RE, (whole, codeRegion, alt, target) => {
		if (codeRegion !== void 0) return whole;
		if (!FEISHU_IMAGE_KEY_RE.test(target)) return whole;
		if (!seen.has(target)) {
			seen.add(target);
			resources.push({
				type: "image",
				fileKey: target
			});
			return `![image](${target})`;
		}
		return sanitizeAlt(alt);
	});
}
/** Strip nested image syntax and bare feishu keys from alt so it cannot be
*  re-matched by substituteMediaPaths nor inject UGC markers. */
function sanitizeAlt(alt) {
	return alt.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/img_[A-Za-z0-9_-]+/g, "").trim();
}
/**
* Cap inbound text length at a safe boundary (never split an `![image](key)`
* marker), tag `[truncated]`, and drop image resources whose marker fell off the
* end so we never register an orphan download with no in-text marker.
*/
function capInboundLength(content, resources) {
	if (content.length <= MAX_INBOUND_MD_LEN) return content;
	let cut = content.lastIndexOf("\n", MAX_INBOUND_MD_LEN);
	if (cut <= 0) {
		cut = MAX_INBOUND_MD_LEN;
		const markerStart = content.lastIndexOf("![image](", cut);
		if (markerStart !== -1) {
			const markerEnd = content.indexOf(")", markerStart);
			if (markerEnd === -1 || markerEnd >= cut) cut = markerStart;
		}
	}
	const truncated = `${content.slice(0, cut).replace(/\s+$/, "")}\n[truncated]`;
	for (let i = resources.length - 1; i >= 0; i--) {
		const r = resources[i];
		if (r.type === "image" && !truncated.includes(`![image](${r.fileKey})`)) resources.splice(i, 1);
	}
	return truncated;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/image.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "image" message type.
*/
const convertImage = (raw) => {
	const imageKey = safeParse(raw)?.image_key;
	if (!imageKey) return {
		content: "[image]",
		resources: []
	};
	return {
		content: `![image](${imageKey})`,
		resources: [{
			type: "image",
			fileKey: imageKey
		}]
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/file.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "file" message type.
*/
const convertFile = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[file]",
		resources: []
	};
	const fileName = parsed?.file_name ?? "";
	return {
		content: `<file key="${fileKey}"${fileName ? ` name="${fileName}"` : ""}/>`,
		resources: [{
			type: "file",
			fileKey,
			fileName: fileName || void 0
		}]
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/audio.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "audio" message type.
*/
const convertAudio = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[audio]",
		resources: []
	};
	const duration = parsed?.duration;
	return {
		content: `<audio key="${fileKey}"${duration != null ? ` duration="${formatDuration(duration)}"` : ""}/>`,
		resources: [{
			type: "audio",
			fileKey,
			duration: duration ?? void 0
		}]
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/video.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "video" and "media" message types.
*/
const convertVideo = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[video]",
		resources: []
	};
	const fileName = parsed?.file_name ?? "";
	const duration = parsed?.duration;
	const coverKey = parsed?.image_key;
	return {
		content: `<video key="${fileKey}"${fileName ? ` name="${fileName}"` : ""}${duration != null ? ` duration="${formatDuration(duration)}"` : ""}/>`,
		resources: [{
			type: "video",
			fileKey,
			fileName: fileName || void 0,
			duration: duration ?? void 0,
			coverImageKey: coverKey ?? void 0
		}]
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/sticker.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "sticker" message type.
*/
const convertSticker = (raw) => {
	const fileKey = safeParse(raw)?.file_key;
	if (!fileKey) return {
		content: "[sticker]",
		resources: []
	};
	return {
		content: `<sticker key="${fileKey}"/>`,
		resources: [{
			type: "sticker",
			fileKey
		}]
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/interactive/types.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Types and constants for the interactive (card) converter.
*/
const EMOJI_MAP = {
	OK: "👌",
	THUMBSUP: "👍",
	SMILE: "😊",
	HEART: "❤️",
	CLAP: "👏",
	FIRE: "🔥",
	PARTY: "🎉",
	THINK: "🤔"
};
const CHART_TYPE_NAMES = {
	bar: "柱状图",
	line: "折线图",
	pie: "饼图",
	area: "面积图",
	radar: "雷达图",
	scatter: "散点图"
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/interactive/card-utils.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Utility functions for card content conversion.
*/
function escapeAttr(s) {
	return s.replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}
function formatMillisecondsToISO8601(milliseconds) {
	const ms = parseInt(milliseconds, 10);
	if (isNaN(ms)) return "";
	return new Date(ms).toISOString();
}
function normalizeTimeFormat(input) {
	if (!input) return "";
	const num = parseInt(input, 10);
	if (!isNaN(num) && String(num) === input.trim()) {
		if (input.length >= 13) return new Date(num).toISOString();
		else if (input.length >= 10) return (/* @__PURE__ */ new Date(num * 1e3)).toISOString();
	}
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(input)) return input;
	const dtMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)$/.exec(input);
	if (dtMatch) {
		const d = /* @__PURE__ */ new Date(`${dtMatch[1]}T${dtMatch[2]}`);
		if (!isNaN(d.getTime())) return d.toISOString();
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
	if (/^\d{2}:\d{2}(:\d{2})?$/.test(input)) return input;
	return input;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/interactive/card-converter.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*/
const MODE = {
	Concise: 0,
	Detailed: 1
};
const elementConverters = new Map([
	["plain_text", (c, _elem, prop) => c.convertPlainText(prop)],
	["markdown", (c, _elem, prop) => c.convertMarkdown(prop)],
	["markdown_v1", (c, elem, prop) => c.convertMarkdownV1(elem, prop)],
	["text", (c, _elem, prop) => c.convertPlainText(prop)],
	["div", (c, _elem, prop, id) => c.convertDiv(prop, id)],
	["note", (c, _elem, prop) => c.convertNote(prop)],
	["hr", () => "---"],
	["br", () => "\n"],
	["column_set", (c, _elem, prop, _id, depth) => c.convertColumnSet(prop, depth)],
	["column", (c, _elem, prop, _id, depth) => c.convertColumn(prop, depth)],
	["person", (c, _elem, prop, id) => c.convertPerson(prop, id)],
	["person_v1", (c, _elem, prop, id) => c.convertPersonV1(prop, id)],
	["person_list", (c, _elem, prop) => c.convertPersonList(prop)],
	["avatar", (c, _elem, prop, id) => c.convertAvatar(prop, id)],
	["at", (c, _elem, prop) => c.convertAt(prop)],
	["at_all", () => "@所有人"],
	["button", (c, _elem, prop, id) => c.convertButton(prop, id)],
	["actions", (c, _elem, prop) => c.convertActions(prop)],
	["action", (c, _elem, prop) => c.convertActions(prop)],
	["overflow", (c, _elem, prop) => c.convertOverflow(prop)],
	["select_static", (c, _elem, prop, id) => c.convertSelect(prop, id, false)],
	["multi_select_static", (c, _elem, prop, id) => c.convertSelect(prop, id, true)],
	["select_person", (c, _elem, prop, id) => c.convertSelect(prop, id, false)],
	["multi_select_person", (c, _elem, prop, id) => c.convertSelect(prop, id, true)],
	["select_img", (c, _elem, prop, id) => c.convertSelectImg(prop, id)],
	["input", (c, _elem, prop, id) => c.convertInput(prop, id)],
	["date_picker", (c, _elem, prop, id) => c.convertDatePicker(prop, id, "date")],
	["picker_time", (c, _elem, prop, id) => c.convertDatePicker(prop, id, "time")],
	["picker_datetime", (c, _elem, prop, id) => c.convertDatePicker(prop, id, "datetime")],
	["checker", (c, _elem, prop, id) => c.convertChecker(prop, id)],
	["img", (c, _elem, prop, id) => c.convertImage(prop, id)],
	["image", (c, _elem, prop, id) => c.convertImage(prop, id)],
	["img_combination", (c, _elem, prop) => c.convertImgCombination(prop)],
	["table", (c, _elem, prop) => c.convertTable(prop)],
	["chart", (c, _elem, prop, id) => c.convertChart(prop, id)],
	["audio", (c, _elem, prop, id) => c.convertAudio(prop, id)],
	["video", (c, _elem, prop, id) => c.convertVideo(prop, id)],
	["collapsible_panel", (c, _elem, prop, id) => c.convertCollapsiblePanel(prop, id)],
	["form", (c, _elem, prop, id) => c.convertForm(prop, id)],
	["interactive_container", (c, _elem, prop, id) => c.convertInteractiveContainer(prop, id)],
	["text_tag", (c, _elem, prop) => c.convertTextTag(prop)],
	["number_tag", (c, _elem, prop) => c.convertNumberTag(prop)],
	["link", (c, _elem, prop) => c.convertLink(prop)],
	["emoji", (c, _elem, prop) => c.convertEmoji(prop)],
	["local_datetime", (c, _elem, prop) => c.convertLocalDatetime(prop)],
	["list", (c, _elem, prop) => c.convertList(prop)],
	["blockquote", (c, _elem, prop) => c.convertBlockquote(prop)],
	["code_block", (c, _elem, prop) => c.convertCodeBlock(prop)],
	["code_span", (c, _elem, prop) => c.convertCodeSpan(prop)],
	["heading", (c, _elem, prop) => c.convertHeading(prop)],
	["fallback_text", (c, _elem, prop) => c.convertFallbackText(prop)],
	["repeat", (c, _elem, prop) => c.convertRepeat(prop)],
	["card_header", () => ""],
	["custom_icon", () => ""],
	["standard_icon", () => ""]
]);
var CardConverter = class {
	mode;
	attachment;
	constructor(mode) {
		this.mode = mode;
	}
	convert(input) {
		const card = safeParse(input.json_card);
		if (!card) return {
			content: "<card>\n[无法解析卡片内容]\n</card>",
			schema: 0
		};
		if (input.json_attachment) this.attachment = safeParse(input.json_attachment);
		let schema = input.card_schema ?? 0;
		if (schema === 0) {
			const s = card.schema;
			schema = typeof s === "number" ? s : 1;
		}
		const header = card.header;
		const title = header ? this.extractHeaderTitle(header, schema) : "";
		const body = this.extractBody(card, schema);
		const bodyContent = body ? this.convertBody(body, schema) : "";
		let out = title ? `<card title="${escapeAttr(title)}">\n` : "<card>\n";
		if (bodyContent) out += bodyContent + "\n";
		out += "</card>";
		return {
			content: out,
			schema
		};
	}
	extractBody(card, _schema) {
		if (card.body && typeof card.body === "object") return card.body;
	}
	extractHeaderTitle(header, _schema) {
		const prop = header.property;
		if (prop) {
			const titleElem = prop.title;
			if (titleElem) return this.extractTextContent(titleElem);
		} else {
			const titleElem = header.title;
			if (titleElem) return this.extractTextContent(titleElem);
		}
		return "";
	}
	convertBody(body, _schema) {
		let elements;
		const prop = body.property;
		if (prop) {
			const e = prop.elements;
			if (Array.isArray(e) && e.length > 0) elements = e;
		}
		if (!elements || elements.length === 0) {
			const e = body.elements;
			if (Array.isArray(e)) elements = e;
		}
		if (!elements || elements.length === 0) return "";
		return this.convertElements(elements, 0);
	}
	convertElements(elements, depth) {
		const results = [];
		for (const elem of elements) {
			if (typeof elem !== "object" || elem == null) continue;
			const result = this.convertElement(elem, depth);
			if (result) results.push(result);
		}
		return results.join("\n");
	}
	convertElement(elem, depth) {
		const tag = elem.tag ?? "";
		const id = elem.id ?? "";
		const prop = this.extractProperty(elem);
		const fn = elementConverters.get(tag);
		if (fn) return fn(this, elem, prop, id, depth);
		return this.convertUnknown(prop, tag);
	}
	extractProperty(elem) {
		if (elem.property && typeof elem.property === "object") return elem.property;
		return elem;
	}
	extractTextContent(textElem) {
		if (textElem == null) return "";
		if (typeof textElem === "string") return textElem;
		if (typeof textElem === "object") {
			const m = textElem;
			if (m.property && typeof m.property === "object") return this.extractTextFromProperty(m.property);
			return this.extractTextFromProperty(m);
		}
		return "";
	}
	extractTextFromProperty(prop) {
		const i18n = prop.i18nContent;
		if (i18n && typeof i18n === "object") for (const lang of [
			"zh_cn",
			"en_us",
			"ja_jp"
		]) {
			const t = i18n[lang];
			if (typeof t === "string" && t) return t;
		}
		if (typeof prop.content === "string") return prop.content;
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) {
			const texts = [];
			for (const elem of elements) if (typeof elem === "object" && elem != null) {
				const t = this.extractTextContent(elem);
				if (t) texts.push(t);
			}
			return texts.join("");
		}
		if (typeof prop.text === "string") return prop.text;
		return "";
	}
	convertPlainText(prop) {
		const content = prop.content;
		if (!content) return "";
		const style = this.extractTextStyle(prop);
		return this.applyTextStyle(content, style);
	}
	convertMarkdown(prop) {
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) return this.convertMarkdownElements(elements);
		if (typeof prop.content === "string") return prop.content;
		return "";
	}
	convertMarkdownV1(elem, prop) {
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) return this.convertMarkdownElements(elements);
		const fallback = elem.fallback;
		if (fallback && typeof fallback === "object") return this.convertElement(fallback, 0);
		if (typeof prop.content === "string") return prop.content;
		return "";
	}
	convertMarkdownElements(elements) {
		const parts = [];
		for (const elem of elements) {
			if (typeof elem !== "object" || elem == null) continue;
			const result = this.convertElement(elem, 0);
			if (result) parts.push(result);
		}
		return parts.join("");
	}
	convertDiv(prop, _id) {
		const results = [];
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") {
			const text = this.convertElement(textElem, 0);
			if (text) results.push(text);
		}
		const fields = prop.fields;
		if (Array.isArray(fields) && fields.length > 0) {
			const fieldTexts = [];
			for (const field of fields) {
				if (typeof field !== "object" || field == null) continue;
				const te = field.text;
				if (te && typeof te === "object") {
					const ft = this.convertElement(te, 0);
					if (ft) fieldTexts.push(ft);
				}
			}
			if (fieldTexts.length > 0) results.push(fieldTexts.join("\n"));
		}
		const extraElem = prop.extra;
		if (extraElem && typeof extraElem === "object") {
			const extra = this.convertElement(extraElem, 0);
			if (extra) results.push(extra);
		}
		return results.join("\n");
	}
	convertNote(prop) {
		const elements = prop.elements;
		if (!Array.isArray(elements) || elements.length === 0) return "";
		const texts = [];
		for (const elem of elements) {
			if (typeof elem !== "object" || elem == null) continue;
			const text = this.convertElement(elem, 0);
			if (text) texts.push(text);
		}
		if (texts.length === 0) return "";
		return `📝 ${texts.join(" ")}`;
	}
	convertLink(prop) {
		const content = prop.content || "链接";
		let url = "";
		const urlObj = prop.url;
		if (urlObj && typeof urlObj === "object") url = urlObj.url || "";
		if (url) return `[${content}](${url})`;
		return content;
	}
	convertEmoji(prop) {
		const key = prop.key || "";
		return EMOJI_MAP[key] ?? `:${key}:`;
	}
	convertLocalDatetime(prop) {
		const milliseconds = prop.milliseconds;
		const fallbackText = prop.fallbackText;
		if (milliseconds) {
			const formatted = formatMillisecondsToISO8601(milliseconds);
			if (formatted) return formatted;
		}
		return fallbackText || "";
	}
	convertList(prop) {
		const items = prop.items;
		if (!Array.isArray(items) || items.length === 0) return "";
		const lines = [];
		for (const item of items) {
			if (typeof item !== "object" || item == null) continue;
			const im = item;
			const level = im.level || 0;
			const listType = im.type || "";
			const order = im.order || 0;
			const indent = "  ".repeat(level);
			const marker = listType === "ol" ? `${Math.floor(order)}.` : "-";
			const elements = im.elements;
			if (Array.isArray(elements)) {
				const content = this.convertMarkdownElements(elements);
				lines.push(`${indent}${marker} ${content}`);
			}
		}
		return lines.join("\n");
	}
	convertBlockquote(prop) {
		let content = "";
		if (typeof prop.content === "string") content = prop.content;
		else {
			const elements = prop.elements;
			if (Array.isArray(elements)) content = this.convertMarkdownElements(elements);
		}
		if (!content) return "";
		return content.split("\n").map((line) => `> ${line}`).join("\n");
	}
	convertCodeBlock(prop) {
		const language = prop.language || "plaintext";
		let code = "";
		const contents = prop.contents;
		if (Array.isArray(contents)) for (const line of contents) {
			if (typeof line !== "object" || line == null) continue;
			const lineContents = line.contents;
			if (Array.isArray(lineContents)) for (const c of lineContents) {
				if (typeof c !== "object" || c == null) continue;
				const cm = c;
				if (typeof cm.content === "string") code += cm.content;
			}
		}
		return `\`\`\`${language}\n${code}\`\`\``;
	}
	convertCodeSpan(prop) {
		return `\`${prop.content || ""}\``;
	}
	convertHeading(prop) {
		let level = prop.level || 1;
		if (level < 1) level = 1;
		if (level > 6) level = 6;
		let content = "";
		if (typeof prop.content === "string") content = prop.content;
		else {
			const elements = prop.elements;
			if (Array.isArray(elements)) content = this.convertMarkdownElements(elements);
		}
		return `${"#".repeat(level)} ${content}`;
	}
	convertFallbackText(prop) {
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") return this.extractTextContent(textElem);
		const elements = prop.elements;
		if (Array.isArray(elements)) return this.convertMarkdownElements(elements);
		return "";
	}
	convertTextTag(prop) {
		const textElem = prop.text;
		let text = "";
		if (textElem && typeof textElem === "object") text = this.extractTextContent(textElem);
		if (!text) return "";
		return `「${text}」`;
	}
	convertNumberTag(prop) {
		const textElem = prop.text;
		let text = "";
		if (textElem && typeof textElem === "object") text = this.extractTextContent(textElem);
		if (!text) return "";
		const urlObj = prop.url;
		if (urlObj && typeof urlObj === "object") {
			const url = urlObj.url;
			if (url) return `[${text}](${url})`;
		}
		return text;
	}
	convertUnknown(prop, tag) {
		if (!prop) {
			if (this.mode === MODE.Detailed) return `[未知内容](tag:${tag})`;
			return "[未知内容]";
		}
		for (const path of [
			"content",
			"text",
			"title",
			"label",
			"placeholder"
		]) if (prop[path] != null) {
			const text = this.extractTextContent(prop[path]);
			if (text) return text;
		}
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) return this.convertElements(elements, 0);
		if (this.mode === MODE.Detailed) return `[未知内容](tag:${tag})`;
		return "[未知内容]";
	}
	convertColumnSet(prop, depth) {
		const columns = prop.columns;
		if (!Array.isArray(columns) || columns.length === 0) return "";
		const results = [];
		for (const col of columns) {
			if (typeof col !== "object" || col == null) continue;
			const result = this.convertElement(col, depth + 1);
			if (result) results.push(result);
		}
		return results.join("\n\n");
	}
	convertColumn(prop, depth) {
		const elements = prop.elements;
		if (!Array.isArray(elements) || elements.length === 0) return "";
		return this.convertElements(elements, depth);
	}
	convertForm(prop, _id) {
		let out = "<form>\n";
		const elements = prop.elements;
		if (Array.isArray(elements)) out += this.convertElements(elements, 0);
		out += "\n</form>";
		return out;
	}
	convertCollapsiblePanel(prop, _id) {
		const expanded = prop.expanded === true;
		let title = "详情";
		const header = prop.header;
		if (header && typeof header === "object") {
			const titleElem = header.title;
			if (titleElem) {
				const t = this.extractTextContent(titleElem);
				if (t) title = t;
			}
		}
		if (expanded || this.mode === MODE.Detailed) {
			let out = `▼ ${title}\n`;
			const elements = prop.elements;
			if (Array.isArray(elements)) {
				const content = this.convertElements(elements, 1);
				for (const line of content.split("\n")) if (line) out += `    ${line}\n`;
			}
			out += "▲";
			return out;
		}
		return `▶ ${title}`;
	}
	convertInteractiveContainer(prop, _id) {
		let url = "";
		const actions = prop.actions;
		if (Array.isArray(actions) && actions.length > 0) {
			const action = actions[0];
			if (action && typeof action === "object") {
				if (action.type === "open_url") {
					const actionData = action.action;
					if (actionData && typeof actionData === "object") url = actionData.url || "";
				}
			}
		}
		let out = "<clickable";
		if (url) out += ` url="${escapeAttr(url)}"`;
		if (this.mode === MODE.Detailed && _id) out += ` id="${_id}"`;
		out += ">\n";
		const elements = prop.elements;
		if (Array.isArray(elements)) out += this.convertElements(elements, 0);
		out += "\n</clickable>";
		return out;
	}
	convertRepeat(prop) {
		const elements = prop.elements;
		if (Array.isArray(elements)) return this.convertElements(elements, 0);
		return "";
	}
	convertButton(prop, _id) {
		let buttonText = "";
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") buttonText = this.extractTextContent(textElem);
		if (!buttonText) buttonText = "按钮";
		const disabled = prop.disabled === true;
		if (disabled && this.mode === MODE.Concise) return `[${buttonText} ✗]`;
		const actions = prop.actions;
		if (Array.isArray(actions)) for (const action of actions) {
			if (typeof action !== "object" || action == null) continue;
			const am = action;
			if (am.type === "open_url") {
				const ad = am.action;
				if (ad && typeof ad === "object") {
					const url = ad.url;
					if (url) return `[${buttonText}](${url})`;
				}
			}
		}
		if (disabled && this.mode === MODE.Detailed) {
			let result = `[${buttonText} ✗]`;
			const tips = prop.disabledTips;
			if (tips && typeof tips === "object") {
				const tipsText = this.extractTextContent(tips);
				if (tipsText) result += `(tips:"${tipsText}")`;
			}
			return result;
		}
		return `[${buttonText}]`;
	}
	convertActions(prop) {
		const actions = prop.actions;
		if (!Array.isArray(actions) || actions.length === 0) return "";
		const results = [];
		for (const action of actions) {
			if (typeof action !== "object" || action == null) continue;
			const result = this.convertElement(action, 0);
			if (result) results.push(result);
		}
		return results.join(" ");
	}
	convertSelect(prop, _id, isMulti) {
		const options = prop.options || [];
		const selectedValues = /* @__PURE__ */ new Set();
		if (isMulti) {
			const vals = prop.selectedValues;
			if (Array.isArray(vals)) {
				for (const v of vals) if (typeof v === "string") selectedValues.add(v);
			}
		} else {
			const initialOption = prop.initialOption;
			if (typeof initialOption === "string") selectedValues.add(initialOption);
			const initialIndex = prop.initialIndex;
			if (typeof initialIndex === "number" && initialIndex >= 0 && initialIndex < options.length) {
				const opt = options[initialIndex];
				if (opt && typeof opt === "object") {
					const val = opt.value;
					if (val) selectedValues.add(val);
				}
			}
		}
		const optionTexts = [];
		let hasSelected = false;
		for (const opt of options) {
			if (typeof opt !== "object" || opt == null) continue;
			const om = opt;
			let optText = "";
			const textElem = om.text;
			if (textElem && typeof textElem === "object") optText = this.extractTextContent(textElem);
			if (!optText) optText = om.value || "";
			if (!optText) continue;
			const value = om.value || "";
			if (selectedValues.has(value)) {
				optText = "✓" + optText;
				hasSelected = true;
			}
			optionTexts.push(optText);
		}
		if (optionTexts.length === 0) {
			let placeholder = "请选择";
			const phElem = prop.placeholder;
			if (phElem && typeof phElem === "object") {
				const ph = this.extractTextContent(phElem);
				if (ph) placeholder = ph;
			}
			optionTexts.push(placeholder + " ▼");
		} else if (!hasSelected) optionTexts[optionTexts.length - 1] += " ▼";
		let result = `{${optionTexts.join(" / ")}}`;
		if (this.mode === MODE.Detailed) {
			const attrs = [];
			if (isMulti) attrs.push("multi");
			if (_id.includes("person") || prop.type === "person") attrs.push("type:person");
			if (attrs.length > 0) result += `(${attrs.join(" ")})`;
		}
		return result;
	}
	convertSelectImg(prop, _id) {
		const options = prop.options;
		if (!Array.isArray(options)) return "";
		const selectedValues = /* @__PURE__ */ new Set();
		const vals = prop.selectedValues;
		if (Array.isArray(vals)) {
			for (const v of vals) if (typeof v === "string") selectedValues.add(v);
		}
		const optTexts = [];
		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			if (!opt || typeof opt !== "object") continue;
			const value = opt.value || "";
			let text = `🖼️图${i + 1}`;
			if (selectedValues.has(value)) text = "✓" + text;
			optTexts.push(text);
		}
		return `{${optTexts.join(" / ")}}`;
	}
	convertInput(prop, _id) {
		let label = "";
		const labelElem = prop.label;
		if (labelElem && typeof labelElem === "object") label = this.extractTextContent(labelElem);
		const defaultValue = prop.defaultValue || "";
		let placeholder = "";
		const phElem = prop.placeholder;
		if (phElem && typeof phElem === "object") placeholder = this.extractTextContent(phElem);
		let result;
		if (defaultValue) result = defaultValue + "___";
		else if (placeholder) result = placeholder + "_____";
		else result = "_____";
		if (label) result = label + ": " + result;
		if (prop.inputType === "multiline_text") result = result.replace(/_____/g, "...");
		return result;
	}
	convertDatePicker(prop, _id, pickerType) {
		let emoji;
		let value = "";
		switch (pickerType) {
			case "date":
				emoji = "📅";
				value = prop.initialDate || "";
				break;
			case "time":
				emoji = "🕐";
				value = prop.initialTime || "";
				break;
			case "datetime":
				emoji = "📅";
				value = prop.initialDatetime || "";
				break;
			default: emoji = "📅";
		}
		if (value) value = normalizeTimeFormat(value);
		if (!value) {
			let placeholder = "选择";
			const phElem = prop.placeholder;
			if (phElem && typeof phElem === "object") {
				const ph = this.extractTextContent(phElem);
				if (ph) placeholder = ph;
			}
			value = placeholder;
		}
		return `${emoji} ${value}`;
	}
	convertChecker(prop, _id) {
		const checkMark = prop.checked === true ? "[x]" : "[ ]";
		let text = "";
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") text = this.extractTextContent(textElem);
		let result = `${checkMark} ${text}`;
		if (this.mode === MODE.Detailed && _id) result += `(id:${_id})`;
		return result;
	}
	convertOverflow(prop) {
		const options = prop.options;
		if (!Array.isArray(options) || options.length === 0) return "";
		const optTexts = [];
		for (const opt of options) {
			if (typeof opt !== "object" || opt == null) continue;
			const textElem = opt.text;
			if (textElem && typeof textElem === "object") {
				const text = this.extractTextContent(textElem);
				if (text) optTexts.push(text);
			}
		}
		return `⋮ ${optTexts.join(", ")}`;
	}
	convertPerson(prop, _id) {
		const userID = prop.userID || "";
		if (!userID) return "";
		let personName = "";
		if (this.attachment) {
			const persons = this.attachment.persons;
			if (persons && typeof persons === "object") {
				const person = persons[userID];
				if (person && typeof person === "object") {
					const content = person.content;
					if (content) personName = content;
				}
			}
		}
		if (!personName) {
			const notation = prop.notation;
			if (notation && typeof notation === "object") personName = this.extractTextContent(notation);
		}
		if (personName) {
			if (this.mode === MODE.Detailed) return `@${personName}(open_id:${userID})`;
			return `@${personName}`;
		}
		if (this.mode === MODE.Detailed) return `@用户(open_id:${userID})`;
		return `@${userID}`;
	}
	convertPersonV1(prop, _id) {
		const userID = prop.userID || "";
		if (!userID) return "";
		let personName = "";
		if (this.attachment) {
			const persons = this.attachment.persons;
			if (persons && typeof persons === "object") {
				const person = persons[userID];
				if (person && typeof person === "object") {
					const content = person.content;
					if (content) personName = content;
				}
			}
		}
		if (personName) {
			if (this.mode === MODE.Detailed) return `@${personName}(open_id:${userID})`;
			return `@${personName}`;
		}
		if (this.mode === MODE.Detailed) return `@用户(open_id:${userID})`;
		return `@${userID}`;
	}
	convertPersonList(prop) {
		const persons = prop.persons;
		if (!Array.isArray(persons) || persons.length === 0) return "";
		const names = [];
		for (const person of persons) {
			if (typeof person !== "object" || person == null) continue;
			const personID = person.id || "";
			const name = "用户";
			if (this.mode === MODE.Detailed && personID) names.push(`@${name}(id:${personID})`);
			else names.push(`@${name}`);
		}
		return names.join(", ");
	}
	convertAvatar(prop, _id) {
		const userID = prop.userID || "";
		let result = "👤";
		if (this.mode === MODE.Detailed && userID) result += `(id:${userID})`;
		return result;
	}
	convertAt(prop) {
		const userID = prop.userID || "";
		if (!userID) return "";
		let userName = "";
		let actualUserID = "";
		if (this.attachment) {
			const atUsers = this.attachment.at_users;
			if (atUsers && typeof atUsers === "object") {
				const userInfo = atUsers[userID];
				if (userInfo && typeof userInfo === "object") {
					const content = userInfo.content;
					if (content) userName = content;
					const uid = userInfo.user_id;
					if (uid) actualUserID = uid;
				}
			}
		}
		if (userName) {
			if (this.mode === MODE.Detailed) {
				if (actualUserID) return `@${userName}(user_id:${actualUserID})`;
				return `@${userName}(open_id:${userID})`;
			}
			return `@${userName}`;
		}
		if (this.mode === MODE.Detailed) {
			if (actualUserID) return `@用户(user_id:${actualUserID})`;
			return `@用户(open_id:${userID})`;
		}
		return `@${userID}`;
	}
	convertImage(prop, _id) {
		let alt = "图片";
		const altElem = prop.alt;
		if (altElem && typeof altElem === "object") {
			const altText = this.extractTextContent(altElem);
			if (altText) alt = altText;
		}
		const titleElem = prop.title;
		if (titleElem && typeof titleElem === "object") {
			const titleText = this.extractTextContent(titleElem);
			if (titleText) alt = titleText;
		}
		let result = `🖼️ ${alt}`;
		if (this.mode === MODE.Detailed) {
			const imageID = prop.imageID;
			if (imageID) {
				const token = this.getImageToken(imageID);
				if (token) result += `(img_token:${token})`;
				else result += `(img_key:${imageID})`;
			}
		}
		return result;
	}
	convertImgCombination(prop) {
		const imgList = prop.imgList;
		if (!Array.isArray(imgList) || imgList.length === 0) return "";
		let result = `🖼️ ${imgList.length}张图片`;
		if (this.mode === MODE.Detailed) {
			const keys = [];
			for (const img of imgList) {
				if (typeof img !== "object" || img == null) continue;
				const imageID = img.imageID;
				if (imageID) keys.push(imageID);
			}
			if (keys.length > 0) result += `(keys:${keys.join(",")})`;
		}
		return result;
	}
	convertChart(prop, _id) {
		let title = "图表";
		let chartType = "";
		const chartSpec = prop.chartSpec;
		if (chartSpec && typeof chartSpec === "object") {
			const titleObj = chartSpec.title;
			if (titleObj && typeof titleObj === "object") {
				const text = titleObj.text;
				if (text) title = text;
			}
			const ct = chartSpec.type;
			if (ct) {
				chartType = ct;
				const typeName = CHART_TYPE_NAMES[chartType];
				if (typeName) title = `${title}${typeName}`;
			}
		}
		const summary = this.extractChartSummary(prop, chartType);
		let result = `📊 ${title}`;
		if (summary) result += `\n数据摘要: ${summary}`;
		return result;
	}
	extractChartSummary(prop, chartType) {
		const chartSpec = prop.chartSpec;
		if (!chartSpec || typeof chartSpec !== "object") return "";
		const dataObj = chartSpec.data;
		if (!dataObj || typeof dataObj !== "object") return "";
		const values = dataObj.values;
		if (!Array.isArray(values) || values.length === 0) return "";
		switch (chartType) {
			case "line":
			case "bar":
			case "area": return this.extractLineBarSummary(chartSpec, values);
			case "pie": return this.extractPieSummary(chartSpec, values);
			default: return this.extractGenericSummary(values);
		}
	}
	extractLineBarSummary(chartSpec, values) {
		const xField = chartSpec.xField;
		const yField = chartSpec.yField;
		if (!xField || !yField || values.length === 0) return this.extractGenericSummary(values);
		const parts = [];
		for (const v of values) {
			if (typeof v !== "object" || v == null) continue;
			const vm = v;
			parts.push(`${vm[xField]}:${vm[yField]}`);
		}
		return parts.length > 0 ? parts.join(", ") : this.extractGenericSummary(values);
	}
	extractPieSummary(chartSpec, values) {
		const categoryField = chartSpec.categoryField;
		const valueField = chartSpec.valueField;
		if (!categoryField || !valueField || values.length === 0) return this.extractGenericSummary(values);
		const parts = [];
		for (const v of values) {
			if (typeof v !== "object" || v == null) continue;
			const vm = v;
			parts.push(`${vm[categoryField]}:${vm[valueField]}`);
		}
		return parts.length > 0 ? parts.join(", ") : this.extractGenericSummary(values);
	}
	extractGenericSummary(values) {
		return `${values.length}个数据点`;
	}
	convertAudio(prop, _id) {
		let result = "🎵 音频";
		if (this.mode === MODE.Detailed) {
			const fileID = prop.fileID || prop.audioID || "";
			if (fileID) result += `(key:${fileID})`;
		}
		return result;
	}
	convertVideo(prop, _id) {
		let result = "🎬 视频";
		if (this.mode === MODE.Detailed) {
			const fileID = prop.fileID || prop.videoID || "";
			if (fileID) result += `(key:${fileID})`;
		}
		return result;
	}
	convertTable(prop) {
		const columns = prop.columns;
		if (!Array.isArray(columns) || columns.length === 0) return "";
		const rows = prop.rows || [];
		const colNames = [];
		const colKeys = [];
		for (const col of columns) {
			if (typeof col !== "object" || col == null) continue;
			const cm = col;
			let displayName = cm.displayName || "";
			const name = cm.name || "";
			if (!displayName) displayName = name;
			colNames.push(displayName);
			colKeys.push(name);
		}
		const lines = [];
		lines.push("| " + colNames.join(" | ") + " |");
		lines.push("|" + colNames.map(() => "------|").join(""));
		for (const row of rows) {
			if (typeof row !== "object" || row == null) continue;
			const rm = row;
			const cells = [];
			for (const key of colKeys) {
				let cellValue = "";
				const cellData = rm[key];
				if (cellData && typeof cellData === "object") {
					if (cellData.data != null) cellValue = this.extractTableCellValue(cellData.data);
				}
				cells.push(cellValue);
			}
			lines.push("| " + cells.join(" | ") + " |");
		}
		return lines.join("\n");
	}
	extractTableCellValue(data) {
		if (typeof data === "string") return data;
		if (typeof data === "number") return data.toFixed(2);
		if (Array.isArray(data)) {
			const texts = [];
			for (const item of data) if (typeof item === "object" && item != null) {
				const im = item;
				if (typeof im.text === "string") texts.push(`「${im.text}」`);
			}
			return texts.join(" ");
		}
		if (typeof data === "object" && data != null) return this.extractTextContent(data);
		return "";
	}
	extractTextStyle(prop) {
		const style = {
			bold: false,
			italic: false,
			strikethrough: false
		};
		const textStyle = prop.textStyle;
		if (!textStyle || typeof textStyle !== "object") return style;
		const attrs = textStyle.attributes;
		if (Array.isArray(attrs)) for (const attr of attrs) {
			if (typeof attr !== "string") continue;
			switch (attr) {
				case "bold":
					style.bold = true;
					break;
				case "italic":
					style.italic = true;
					break;
				case "strikethrough":
					style.strikethrough = true;
					break;
			}
		}
		return style;
	}
	applyTextStyle(content, style) {
		if (!content) return content;
		if (style.strikethrough) content = `~~${content}~~`;
		if (style.italic) content = `*${content}*`;
		if (style.bold) content = `**${content}**`;
		return content;
	}
	getImageToken(imageID) {
		if (!this.attachment) return "";
		const images = this.attachment.images;
		if (!images || typeof images !== "object") return "";
		const imageInfo = images[imageID];
		if (!imageInfo || typeof imageInfo !== "object") return "";
		return imageInfo.token || "";
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/interactive/legacy.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Legacy card converter for non-raw_card_content format.
*/
function convertLegacyCard(parsed) {
	const texts = [];
	const header = parsed.header;
	if (header) {
		const title = header.title;
		if (title && typeof title.content === "string") texts.push(`**${title.content}**`);
	}
	const body = parsed.body;
	extractTexts(parsed.elements ?? body?.elements ?? [], texts);
	return {
		content: texts.length > 0 ? texts.join("\n") : "[interactive card]",
		resources: []
	};
}
function extractTexts(elements, out) {
	if (!Array.isArray(elements)) return;
	for (const el of elements) {
		if (typeof el !== "object" || el == null) continue;
		const elem = el;
		if (elem.tag === "markdown" && typeof elem.content === "string") {
			out.push(elem.content);
			continue;
		}
		if (elem.tag === "div" || elem.tag === "plain_text" || elem.tag === "lark_md") {
			const text = elem.text;
			if (text?.content && typeof text.content === "string") out.push(text.content);
			if (typeof elem.content === "string") out.push(elem.content);
		}
		if (elem.tag === "column_set") {
			const columns = elem.columns;
			if (columns) for (const col of columns) {
				const colObj = col;
				if (colObj.elements) extractTexts(colObj.elements, out);
			}
		}
		if (elem.elements) extractTexts(elem.elements, out);
	}
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/interactive/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Entry point for the interactive (card) message converter.
*/
const convertInteractive = (raw) => {
	const parsed = safeParse(raw);
	if (!parsed) return {
		content: "[interactive card]",
		resources: []
	};
	if (typeof parsed.json_card === "string") return {
		content: new CardConverter(MODE.Concise).convert(parsed).content || "[interactive card]",
		resources: []
	};
	return convertLegacyCard(parsed);
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/share.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "share_chat" and "share_user" message types.
*/
const convertShareChat = (raw) => {
	return {
		content: `<group_card id="${safeParse(raw)?.chat_id ?? ""}"/>`,
		resources: []
	};
};
const convertShareUser = (raw) => {
	return {
		content: `<contact_card id="${safeParse(raw)?.user_id ?? ""}"/>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/location.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "location" message type.
*/
const convertLocation = (raw) => {
	const parsed = safeParse(raw);
	const name = parsed?.name ?? "";
	const lat = parsed?.latitude ?? "";
	const lng = parsed?.longitude ?? "";
	return {
		content: `<location${name ? ` name="${name}"` : ""}${lat && lng ? ` coords="lat:${lat},lng:${lng}"` : ""}/>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/merge-forward.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "merge_forward" message type.
*
* Unlike other converters this is async — it fetches sub-messages via
* the Feishu IM API and recursively expands nested merge_forward messages.
*
* The API returns ALL nested sub-messages in a single flat `items`
* array with `upper_message_id` pointing to the parent container.
* We build a tree from this flat list and recursively format it —
* only one API call is needed regardless of nesting depth.
*
* This module is a pure "data → format" converter: all API capabilities
* (`fetchSubMessages`, `batchResolveNames`, `resolveUserName`) are
* injected via callbacks in `ConvertContext`. Callers are responsible
* for creating the appropriate callbacks (UAT / TAT / event push).
*/
const log$16 = larkLogger("converters/merge-forward");
/**
* Recursively expand a merge_forward message.
*
* Output format aligns with the Go reference implementation:
* ```
* <forwarded_messages>
* [RFC3339] sender_id:
*     message content
* </forwarded_messages>
* ```
*/
const convertMergeForward = async (_raw, ctx) => {
	const { accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages, convertMessageContent } = ctx;
	if (!fetchSubMessages) return {
		content: "<forwarded_messages/>",
		resources: []
	};
	return {
		content: await expand(accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages, convertMessageContent),
		resources: []
	};
};
async function expand(accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages, convertContent) {
	let items;
	try {
		items = await fetchSubMessages(messageId);
	} catch (error) {
		log$16.error("fetch sub-messages failed", {
			messageId,
			error: error instanceof Error ? error.message : String(error)
		});
		return "<forwarded_messages/>";
	}
	if (items.length === 0) return "<forwarded_messages/>";
	const childrenMap = buildChildrenMap(items, messageId);
	const senderIds = collectSenderIds(items, messageId);
	if (senderIds.length > 0 && batchResolveNames) try {
		await batchResolveNames(senderIds);
	} catch (err) {
		log$16.debug("batchResolveNames failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
	}
	return formatSubTree(messageId, childrenMap, accountId, resolveUserName, convertContent);
}
/**
* Build a map from parent message ID → ordered child items.
*
* The API returns a flat `items` array where each item may carry an
* `upper_message_id` pointing to its parent container. Items without
* `upper_message_id` are direct children of the root container.
*
* The root container message itself (matching `rootMessageId`) is skipped.
*/
function buildChildrenMap(items, rootMessageId) {
	const map = /* @__PURE__ */ new Map();
	for (const item of items) {
		if (item.message_id === rootMessageId && !item.upper_message_id) continue;
		const parentId = item.upper_message_id ?? rootMessageId;
		let children = map.get(parentId);
		if (!children) {
			children = [];
			map.set(parentId, children);
		}
		children.push(item);
	}
	for (const children of map.values()) children.sort((a, b) => {
		return parseInt(String(a.create_time ?? "0"), 10) - parseInt(String(b.create_time ?? "0"), 10);
	});
	return map;
}
/**
* Collect all unique sender IDs from non-root items for batch name resolution.
*/
function collectSenderIds(items, rootMessageId) {
	const ids = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (item.message_id === rootMessageId && !item.upper_message_id) continue;
		if (item.sender?.sender_type === "user") {
			const senderId = item.sender.id;
			if (senderId) ids.add(senderId);
		}
	}
	return [...ids];
}
/**
* Recursively format a sub-tree of messages rooted at `parentId`.
*
* For `merge_forward` children this recurses into `formatSubTree`
* directly (no additional API calls). For other message types it
* delegates to `convertMessageContent`.
*/
async function formatSubTree(parentId, childrenMap, accountId, resolveUserName, convertContent) {
	const children = childrenMap.get(parentId);
	if (!children || children.length === 0) return "<forwarded_messages/>";
	const parts = [];
	for (const item of children) try {
		const msgType = item.msg_type ?? "text";
		const senderId = item.sender?.id ?? "unknown";
		const createTime = item.create_time ? parseInt(String(item.create_time), 10) : void 0;
		const timestamp = createTime ? formatTimestamp(createTime) : "unknown";
		const rawContent = item.body?.content ?? "{}";
		let content;
		if (msgType === "merge_forward") {
			const nestedId = item.message_id;
			if (nestedId) content = await formatSubTree(nestedId, childrenMap, accountId, resolveUserName, convertContent);
			else content = "<forwarded_messages/>";
		} else {
			const subCtx = {
				...buildConvertContextFromItem(item, parentId, accountId),
				accountId,
				resolveUserName,
				convertMessageContent: convertContent
			};
			if (!convertContent) content = rawContent;
			else content = (await convertContent(rawContent, msgType, subCtx)).content;
		}
		const displayName = resolveUserName?.(senderId) ?? senderId;
		const indented = indentLines(content, "    ");
		parts.push(`[${timestamp}] ${displayName}:\n${indented}`);
	} catch (err) {
		log$16.warn("failed to convert sub-message", {
			messageId: item.message_id,
			msgType: item.msg_type ?? "unknown",
			error: err instanceof Error ? err.message : String(err)
		});
	}
	if (parts.length === 0) return "<forwarded_messages/>";
	return `<forwarded_messages>\n${parts.join("\n")}\n</forwarded_messages>`;
}
/**
* Convert a millisecond timestamp to RFC 3339 format with +08:00 offset
* (Beijing time).
*/
function formatTimestamp(ms) {
	const date = new Date(ms);
	const utcMs = date.getTime() + date.getTimezoneOffset() * 6e4;
	const bjDate = new Date(utcMs + 8 * 36e5);
	return `${bjDate.getFullYear()}-${String(bjDate.getMonth() + 1).padStart(2, "0")}-${String(bjDate.getDate()).padStart(2, "0")}T${String(bjDate.getHours()).padStart(2, "0")}:${String(bjDate.getMinutes()).padStart(2, "0")}:${String(bjDate.getSeconds()).padStart(2, "0")}+08:00`;
}
/** Add a prefix indent to every line of text. */
function indentLines(text, indent) {
	return text.split("\n").map((line) => `${indent}${line}`).join("\n");
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/folder.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "folder" message type.
*/
const convertFolder = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[folder]",
		resources: []
	};
	const fileName = parsed?.file_name ?? "";
	return {
		content: `<folder key="${fileKey}"${fileName ? ` name="${fileName}"` : ""}/>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/system.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "system" message type.
*
* System messages use a template string with placeholders like
* `{from_user}`, `{to_chatters}`, `{divider_text}` that are replaced
* with actual values from the message body.
*/
const convertSystem = (raw) => {
	const parsed = safeParse(raw);
	if (!parsed?.template) return {
		content: "[system message]",
		resources: []
	};
	let content = parsed.template;
	const replacements = {
		"{from_user}": parsed.from_user?.length ? parsed.from_user.filter(Boolean).join(", ") : void 0,
		"{to_chatters}": parsed.to_chatters?.length ? parsed.to_chatters.filter(Boolean).join(", ") : void 0,
		"{divider_text}": parsed.divider_text?.text
	};
	for (const [placeholder, value] of Object.entries(replacements)) if (value != null) content = content.replaceAll(placeholder, value);
	else content = content.replaceAll(placeholder, "");
	return {
		content: content.trim(),
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/hongbao.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "hongbao" (red packet) message type.
*/
const convertHongbao = (raw) => {
	const text = safeParse(raw)?.text;
	return {
		content: `<hongbao${text ? ` text="${text}"` : ""}/>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/calendar.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converters for calendar-related message types:
* - share_calendar_event
* - calendar
* - general_calendar
*/
function formatCalendarContent(parsed) {
	const summary = parsed?.summary ?? "";
	const parts = [];
	if (summary) parts.push(`📅 ${summary}`);
	const start = parsed?.start_time ? millisToDatetime(parsed.start_time) : "";
	const end = parsed?.end_time ? millisToDatetime(parsed.end_time) : "";
	if (start && end) parts.push(`🕙 ${start} ~ ${end}`);
	else if (start) parts.push(`🕙 ${start}`);
	return parts.join("\n") || "[calendar event]";
}
const convertShareCalendarEvent = (raw) => {
	return {
		content: `<calendar_share>${formatCalendarContent(safeParse(raw))}</calendar_share>`,
		resources: []
	};
};
const convertCalendar = (raw) => {
	return {
		content: `<calendar_invite>${formatCalendarContent(safeParse(raw))}</calendar_invite>`,
		resources: []
	};
};
const convertGeneralCalendar = (raw) => {
	return {
		content: `<calendar>${formatCalendarContent(safeParse(raw))}</calendar>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/video-chat.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "video_chat" message type.
*/
const convertVideoChat = (raw) => {
	const parsed = safeParse(raw);
	const topic = parsed?.topic ?? "";
	const meetingNo = parsed?.meet_number?.trim() ?? "";
	const parts = [];
	if (topic) parts.push(`Topic: ${topic}`);
	if (parsed?.start_time) parts.push(`Start time: ${millisToDatetime(parsed.start_time)}`);
	if (meetingNo) parts.push(`Meeting number: ${meetingNo}`);
	return {
		content: `<meeting>${parts.join("\n") || "[video chat]"}</meeting>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/todo.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "todo" message type.
*/
/** Extract plain text from post-style content blocks. */
function extractPlainText(content) {
	const lines = [];
	for (const paragraph of content) {
		if (!Array.isArray(paragraph)) continue;
		let line = "";
		for (const el of paragraph) if (el.text) line += el.text;
		lines.push(line);
	}
	return lines.join("\n").trim();
}
const convertTodo = (raw) => {
	const parsed = safeParse(raw);
	const parts = [];
	const fullTitle = [parsed?.summary?.title ?? "", parsed?.summary?.content ? extractPlainText(parsed.summary.content) : ""].filter(Boolean).join("\n");
	if (fullTitle) parts.push(fullTitle);
	if (parsed?.due_time) parts.push(`Due: ${millisToDatetime(parsed.due_time)}`);
	return {
		content: `<todo>\n${parts.join("\n") || "[todo]"}\n</todo>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/vote.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "vote" message type.
*/
const convertVote = (raw) => {
	const parsed = safeParse(raw);
	const topic = parsed?.topic ?? "";
	const options = parsed?.options ?? [];
	const parts = [];
	if (topic) parts.push(topic);
	for (const opt of options) parts.push(`• ${opt}`);
	return {
		content: `<vote>\n${parts.join("\n") || "[vote]"}\n</vote>`,
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/unknown.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Fallback converter for unsupported message types.
*/
const convertUnknown = (raw) => {
	const parsed = safeParse(raw);
	if (parsed != null && typeof parsed === "object" && "text" in parsed) {
		const text = parsed.text;
		if (typeof text === "string") return {
			content: text,
			resources: []
		};
	}
	return {
		content: "[unsupported message]",
		resources: []
	};
};
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Content converter mapping for all Feishu message types.
*/
const converters = new Map([
	["text", convertText],
	["post", convertPost],
	["image", convertImage],
	["file", convertFile],
	["audio", convertAudio],
	["video", convertVideo],
	["media", convertVideo],
	["sticker", convertSticker],
	["interactive", convertInteractive],
	["share_chat", convertShareChat],
	["share_user", convertShareUser],
	["location", convertLocation],
	["merge_forward", convertMergeForward],
	["folder", convertFolder],
	["system", convertSystem],
	["hongbao", convertHongbao],
	["share_calendar_event", convertShareCalendarEvent],
	["calendar", convertCalendar],
	["general_calendar", convertGeneralCalendar],
	["video_chat", convertVideoChat],
	["todo", convertTodo],
	["vote", convertVote],
	["unknown", convertUnknown]
]);
//#endregion
//#region vendor/openclaw-lark/dist/messaging/converters/content-converter.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Content converter for Feishu messages.
*
* Each message type (text, post, image, etc.) has a dedicated converter
* function that parses raw JSON content into an AI-friendly text
* representation plus a list of resource descriptors.
*
* This module is a general-purpose message parsing utility — usable
* from inbound handling, outbound formatting, and skills.
*/
/**
* Convert raw message content using the converter for the given message
* type. Falls back to the "unknown" converter for unrecognised types.
*
* Returns a Promise because some converters (e.g. merge_forward) perform
* async operations. Synchronous converters are awaited transparently.
*/
async function convertMessageContent(raw, messageType, ctx) {
	const fn = converters.get(messageType) ?? converters.get("unknown");
	if (!fn) return {
		content: raw,
		resources: []
	};
	return fn(raw, ctx.convertMessageContent ? ctx : {
		...ctx,
		convertMessageContent
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/mention.js
/**
* Detect whether a raw mention entry represents @all / @所有人.
*
* Feishu @all mentions have `key: "@_all"` and empty ID fields.
* We match on `key` as the primary signal (most stable across locales).
*/
function isMentionAll(mention) {
	return mention.key === "@_all";
}
/**
* Format a mention for a Feishu text / post message.
* @returns e.g. `<at user_id="ou_xxx">Alice</at>`
*/
function formatMentionForText(target) {
	return `<at user_id="${target.openId}">${target.name}</at>`;
}
/** Prepend @mention tags (text format) to a message body. */
function buildMentionedMessage(targets, message) {
	if (targets.length === 0) return message;
	return `${targets.map(formatMentionForText).join(" ")}\n${message}`;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/parse-io.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* I/O adapters for inbound message parsing.
*
* Contains API-calling functions that are used during the parse phase
* but separated from the pure parsing logic in parse.ts.
*/
const log$15 = larkLogger("inbound/parse-io");
/**
* 对 interactive 消息，通过 TAT 调用 API 获取完整 v2 卡片内容。
* 事件推送的 content 可能不包含 json_card，API 调用可返回完整的 raw_card_content。
* 失败时返回 undefined，调用方 fallback 到原始 content。
*
* Note: `larkClient.sdk` 的类型定义不暴露 raw `request` 方法，
* 因此这里使用 `as any` 断言调用。
*/
async function fetchCardContent(messageId, larkClient) {
	try {
		return (await larkClient.sdk.request({
			method: "GET",
			url: `/open-apis/im/v1/messages/${messageId}`,
			params: {
				user_id_type: "open_id",
				card_msg_content_type: "raw_card_content"
			}
		}))?.data?.items?.[0]?.body?.content ?? void 0;
	} catch (err) {
		log$15.warn(`fetchCardContent failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
}
/**
* Create a `fetchSubMessages` callback for use in `ConvertContext`.
*
* The returned function calls the im/v1/messages API to fetch
* sub-messages of a merge_forward message.
*
* Note: `larkClient.sdk` 的类型定义不暴露 raw `request` 方法，
* 因此这里使用 `as any` 断言调用。
*/
function createFetchSubMessages(larkClient) {
	return async (msgId) => {
		const response = await larkClient.sdk.request({
			method: "GET",
			url: `/open-apis/im/v1/messages/${msgId}`,
			params: {
				user_id_type: "open_id",
				card_msg_content_type: "raw_card_content"
			}
		});
		if (response?.code !== 0) throw new Error(`API error: code=${response?.code} msg=${response?.msg}`);
		return response?.data?.items ?? [];
	};
}
/**
* Create a `batchResolveNames` callback for use in `ConvertContext`.
*
* Wraps `createBatchResolveNames` from user-name-cache.ts, providing
* the account and log function.
*/
function createParseResolveNames(account) {
	return createBatchResolveNames(account, (...args) => log$15.info(args.map(String).join(" ")));
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/parse.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Event parsing for inbound Feishu messages.
*
* Converts a raw FeishuMessageEvent into a normalised MessageContext.
* All mention information is captured in `mentions: MentionInfo[]`;
* downstream logic derives `mentionedBot` and non-bot targets from it.
*
* When `expandCtx` is provided, `cfg` and `accountId` are passed into
* the converter context so that async converters (e.g. merge_forward)
* can make API calls during parsing.
*/
const log$14 = larkLogger("inbound/parse");
/**
* Parse a raw Feishu message event into a normalised MessageContext.
*
* @param expandCtx  When provided, cfg/accountId are used to create
*                   callbacks for async converters (e.g. merge_forward)
*                   to fetch sub-messages and resolve sender names.
*/
async function parseMessageEvent(event, botOpenId, expandCtx) {
	const mentionMap = /* @__PURE__ */ new Map();
	const mentionList = [];
	let mentionAll = false;
	for (const m of event.message.mentions ?? []) {
		if (isMentionAll(m)) {
			mentionAll = true;
			mentionMap.set(m.key, {
				key: m.key,
				openId: "",
				name: m.name,
				isBot: false
			});
			continue;
		}
		const openId = m.id?.open_id ?? "";
		if (!openId) continue;
		const info = {
			key: m.key,
			openId,
			name: m.name,
			isBot: Boolean(botOpenId && openId === botOpenId)
		};
		mentionMap.set(m.key, info);
		mentionList.push(info);
	}
	const mentionsByOpenId = /* @__PURE__ */ new Map();
	for (const info of mentionList) mentionsByOpenId.set(info.openId, info);
	const acctId = expandCtx?.accountId;
	const larkClient = expandCtx ? LarkClient.fromCfg(expandCtx.cfg, acctId) : void 0;
	let fetchSubMessages;
	let batchResolveNames;
	if (expandCtx) {
		const account = getLarkAccount(expandCtx.cfg, acctId);
		fetchSubMessages = createFetchSubMessages(larkClient);
		batchResolveNames = createParseResolveNames(account);
	}
	let effectiveContent = event.message.content;
	if (event.message.message_type === "interactive" && expandCtx) {
		const fullContent = await fetchCardContent(event.message.message_id, larkClient);
		if (fullContent) {
			effectiveContent = fullContent;
			log$14.info("replaced interactive content with full v2 card data");
		}
	}
	const convertCtx = {
		mentions: mentionMap,
		mentionsByOpenId,
		messageId: event.message.message_id,
		botOpenId,
		cfg: expandCtx?.cfg,
		accountId: acctId,
		resolveUserName: acctId ? (openId) => getUserNameCache(acctId).get(openId) : void 0,
		fetchSubMessages,
		batchResolveNames,
		stripBotMentions: true
	};
	const { content, resources } = await convertMessageContent(effectiveContent, event.message.message_type, convertCtx);
	const createTimeStr = event.message.create_time;
	const createTime = createTimeStr ? parseInt(createTimeStr, 10) : void 0;
	return {
		chatId: event.message.chat_id,
		messageId: event.message.message_id,
		senderId: event.sender.sender_id.open_id || "",
		chatType: event.message.chat_type,
		rootId: event.message.root_id || void 0,
		parentId: event.message.parent_id || void 0,
		threadId: event.message.thread_id || void 0,
		content,
		contentType: event.message.message_type,
		resources,
		mentions: mentionList,
		mentionAll,
		senderIsBot: event.sender.sender_type === "bot" || event.sender.sender_type === "app",
		createTime: Number.isNaN(createTime) ? void 0 : createTime,
		rawMessage: effectiveContent !== event.message.content ? {
			...event.message,
			content: effectiveContent
		} : event.message,
		rawSender: event.sender
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/core/targets.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Feishu target ID parsing and formatting utilities.
*
* Feishu uses several namespaced identifier prefixes:
*   - `oc_*`  -- chat (group / DM) IDs
*   - `ou_*`  -- open user IDs
*   - plain alphanumeric strings -- user IDs from the tenant directory
*
* This module provides helpers to detect, normalise, and format these IDs
* for both internal routing and outbound Feishu API calls.
*/
const CHAT_PREFIX = "oc_";
const OPEN_ID_PREFIX = "ou_";
const TAG_CHAT = "chat:";
const TAG_USER = "user:";
const TAG_OPEN_ID = "open_id:";
const TAG_FEISHU = "feishu:";
const ROUTE_META_FRAGMENT_REPLY_TO = "__feishu_reply_to";
const ROUTE_META_FRAGMENT_THREAD_ID = "__feishu_thread_id";
/**
* Strip OpenClaw routing prefixes (`chat:`, `user:`, `open_id:`) from a
* raw target string, returning the bare Feishu identifier.
*
* Returns `null` when the input is empty or falsy.
*/
function normalizeFeishuTarget(raw) {
	if (!raw) return null;
	const trimmed = parseFeishuRouteTarget(raw).target.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith(TAG_FEISHU)) {
		const inner = trimmed.slice(7).trim();
		if (inner) return inner;
	}
	if (trimmed.startsWith(TAG_CHAT)) return trimmed.slice(5);
	if (trimmed.startsWith(TAG_USER)) return trimmed.slice(5);
	if (trimmed.startsWith(TAG_OPEN_ID)) return trimmed.slice(8);
	return trimmed;
}
function parseFeishuRouteTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return { target: "" };
	const hashIndex = trimmed.indexOf("#");
	if (hashIndex < 0) return { target: trimmed };
	const target = trimmed.slice(0, hashIndex).trim();
	const fragment = trimmed.slice(hashIndex + 1).trim();
	if (!fragment) return { target };
	const params = new URLSearchParams(fragment);
	const replyToMessageId = normalizeMessageId(params.get(ROUTE_META_FRAGMENT_REPLY_TO)?.trim() || void 0);
	const threadId = params.get(ROUTE_META_FRAGMENT_THREAD_ID)?.trim() || void 0;
	return {
		target,
		...replyToMessageId ? { replyToMessageId } : {},
		...threadId ? { threadId } : {}
	};
}
/**
* Determine the `receive_id_type` query parameter for the Feishu send-message
* API based on the target identifier.
*/
function resolveReceiveIdType(id) {
	if (id.startsWith(CHAT_PREFIX)) return "chat_id";
	if (id.startsWith(OPEN_ID_PREFIX)) return "open_id";
	return "open_id";
}
function normalizeMessageId(messageId) {
	if (!messageId) return void 0;
	const colonIndex = messageId.indexOf(":");
	if (colonIndex >= 0) return messageId.slice(0, colonIndex);
	return messageId;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/outbound/media-url-utils.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*/
function normalizeMediaUrlInput(value) {
	let raw = value.trim();
	if (raw.startsWith("<") && raw.endsWith(">") && raw.length >= 2) raw = raw.slice(1, -1).trim();
	const first = raw[0];
	const last = raw[raw.length - 1];
	if (raw.length >= 2 && (first === "\"" && last === "\"" || first === "'" && last === "'" || first === "`" && last === "`")) raw = raw.slice(1, -1).trim();
	return raw;
}
function isWindowsAbsolutePath(value) {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
function isLocalMediaPath(value) {
	const raw = normalizeMediaUrlInput(value);
	return raw.startsWith("file://") || path$1.isAbsolute(raw) || isWindowsAbsolutePath(raw);
}
function safeFileUrlToPath(fileUrl) {
	const raw = normalizeMediaUrlInput(fileUrl);
	try {
		return fileURLToPath(raw);
	} catch {
		return new URL(raw).pathname;
	}
}
/**
* Validate that a resolved local file path falls under one of the
* allowed root directories.  Prevents path-traversal attacks when
* the AI or an external payload supplies a local media path.
*
* Semantics:
* - **`undefined`** — caller has not opted in to restriction; the
*   function is a no-op so existing behaviour is preserved.  The
*   caller should log a warning independently.
* - **`[]` (empty array)** — explicitly configured with no allowed
*   roots → all local access is denied.
* - **Non-empty array** — standard allowlist check.
*
* @param filePath   - Resolved absolute path to validate.
* @param localRoots - Allowed root directories.
* @throws {Error} When the path is not under any allowed root, or
*                 when `localRoots` is an empty array.
*/
function validateLocalMediaRoots(filePath, localRoots) {
	if (localRoots === void 0) return;
	if (localRoots.length === 0) throw new Error(`[feishu-media] Local file access denied for "${filePath}": mediaLocalRoots is configured as an empty array, which blocks all local access. Add allowed directories to mediaLocalRoots or use a remote URL instead.`);
	let resolved;
	try {
		resolved = fs$1.realpathSync(path$1.resolve(filePath));
	} catch {
		resolved = path$1.resolve(filePath);
	}
	if (!localRoots.some((root) => {
		let resolvedRoot;
		try {
			resolvedRoot = fs$1.realpathSync(path$1.resolve(root));
		} catch {
			resolvedRoot = path$1.resolve(root);
		}
		return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path$1.sep);
	})) throw new Error(`[feishu-media] Local file access denied for "${filePath}": path is not under any allowed mediaLocalRoots (${localRoots.join(", ")}). Move the file to an allowed directory or use a remote URL instead.`);
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/outbound/media.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Media handling for the Lark/Feishu channel plugin.
*
* Provides functions for downloading images and file resources from
* Feishu messages, uploading media to the Feishu IM storage, and
* sending image / file messages to chats.
*/
const log$13 = larkLogger("outbound/media");
/** HTTP status codes that are safe to retry (transient server errors). */
const RETRYABLE_STATUS_CODES = new Set([
	502,
	503,
	504
]);
/** Maximum number of retry attempts for transient failures. */
const MEDIA_RETRY_MAX = 2;
/** Base delay (ms) between retries — actual delay = base * attempt. */
const MEDIA_RETRY_DELAY_MS = 1e3;
/**
* Run an async operation with bounded retries for transient HTTP errors.
*
* Only retries when the error carries a recognised retryable HTTP status
* code. All other errors are thrown immediately.
*/
async function withRetry(fn, label, maxRetries = MEDIA_RETRY_MAX) {
	let lastError;
	for (let attempt = 0; attempt <= maxRetries; attempt++) try {
		return await fn();
	} catch (err) {
		lastError = err;
		const status = extractHttpStatus(err);
		if (status == null || !RETRYABLE_STATUS_CODES.has(status) || attempt >= maxRetries) throw err;
		const delay = MEDIA_RETRY_DELAY_MS * (attempt + 1);
		log$13.warn(`${label}: HTTP ${status}, retrying (${attempt + 1}/${maxRetries}) after ${delay}ms`);
		await new Promise((r) => setTimeout(r, delay));
	}
	throw lastError;
}
/**
* Best-effort extraction of an HTTP status code from an unknown error.
* Returns `undefined` when the error does not carry status information.
*/
function extractHttpStatus(err) {
	if (err != null && typeof err === "object") {
		const obj = err;
		if (typeof obj.status === "number") return obj.status;
		if (typeof obj.statusCode === "number") return obj.statusCode;
		if (typeof obj.message === "string") {
			const m = obj.message.match(/\b(50[2-4])\b/);
			if (m) return Number(m[1]);
		}
	}
}
/**
* Extract a Buffer from various SDK response formats.
*
* The Feishu Node SDK can return binary data in several shapes depending
* on the runtime environment and SDK version:
*   - A Buffer directly
*   - An ArrayBuffer
*   - A response object with a `.data` property
*   - A response object with `.getReadableStream()`
*   - A response object with `.writeFile(path)`
*   - An async iterable / iterator
*   - A Node.js Readable stream
*
* This helper normalises all of those into a single Buffer.
*/
async function extractBufferFromResponse(response) {
	if (Buffer.isBuffer(response)) return { buffer: response };
	if (response instanceof ArrayBuffer) return { buffer: Buffer.from(response) };
	if (response == null) throw new Error("[feishu-media] Received null/undefined response");
	const resp = response;
	const contentType = resp.headers?.["content-type"] ?? resp.contentType ?? void 0;
	if (resp.data != null) {
		if (Buffer.isBuffer(resp.data)) return {
			buffer: resp.data,
			contentType
		};
		if (resp.data instanceof ArrayBuffer) return {
			buffer: Buffer.from(resp.data),
			contentType
		};
		if (typeof resp.data.pipe === "function") return {
			buffer: await streamToBuffer(resp.data),
			contentType
		};
	}
	if (typeof resp.getReadableStream === "function") return {
		buffer: await streamToBuffer(await resp.getReadableStream()),
		contentType
	};
	if (typeof resp.writeFile === "function") {
		const tmpDir = os.tmpdir();
		const tmpFile = path$1.join(tmpDir, `feishu-media-${Date.now()}`);
		try {
			await resp.writeFile(tmpFile);
			return {
				buffer: fs$1.readFileSync(tmpFile),
				contentType
			};
		} finally {
			try {
				fs$1.unlinkSync(tmpFile);
			} catch {}
		}
	}
	if (typeof resp[Symbol.asyncIterator] === "function" || typeof resp.next === "function") {
		const chunks = [];
		const iterable = typeof resp[Symbol.asyncIterator] === "function" ? resp : asyncIteratorToIterable(resp);
		for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
		return {
			buffer: Buffer.concat(chunks),
			contentType
		};
	}
	if (typeof resp.pipe === "function") return {
		buffer: await streamToBuffer(resp),
		contentType
	};
	throw new Error("[feishu-media] Unable to extract binary data from response: unrecognised format");
}
/**
* Consume a Readable stream into a Buffer.
*/
function streamToBuffer(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", (chunk) => {
			chunks.push(Buffer.from(chunk));
		});
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}
/**
* Wrap an AsyncIterator into an AsyncIterable.
*/
async function* asyncIteratorToIterable(iterator) {
	while (true) {
		const { value, done } = await iterator.next();
		if (done) break;
		yield value;
	}
}
/**
* Download a resource (image or file) attached to a specific message.
*
* @param params.cfg       - Plugin configuration.
* @param params.messageId - The message the resource belongs to.
* @param params.fileKey   - The file_key or image_key of the resource.
* @param params.type      - Whether the resource is an "image" or "file".
* @param params.accountId - Optional account identifier.
* @returns The resource buffer, content type, and file name.
*/
async function downloadMessageResourceFeishu(params) {
	const { cfg, messageId, fileKey, type, accountId } = params;
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	const response = await withRetry(() => client.im.messageResource.get({
		path: {
			message_id: messageId,
			file_key: fileKey
		},
		params: { type }
	}), `downloadMessageResource(${fileKey})`);
	const { buffer, contentType } = await extractBufferFromResponse(response);
	let fileName;
	if (response && typeof response === "object") {
		const resp = response;
		const disposition = resp.headers?.["content-disposition"] ?? resp.headers?.["Content-Disposition"];
		if (typeof disposition === "string") {
			const match = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
			if (match) fileName = decodeURIComponent(match[1].trim());
		}
	}
	return {
		buffer,
		contentType,
		fileName
	};
}
/**
* Upload an image to Feishu IM storage.
*
* Accepts either a Buffer containing the raw image bytes or a file
* system path to read from.
*
* @param params.cfg       - Plugin configuration.
* @param params.image     - A Buffer or local file path for the image.
* @param params.imageType - The image usage type: "message" (default) or "avatar".
* @param params.accountId - Optional account identifier.
* @returns The assigned image_key.
*/
async function uploadImageLark(params) {
	const { cfg, image, imageType = "message", accountId } = params;
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	const imageStream = Buffer.isBuffer(image) ? Readable.from(image) : fs$1.createReadStream(image);
	const response = await client.im.image.create({ data: {
		image_type: imageType,
		image: imageStream
	} });
	const imageKey = response?.data?.image_key ?? response?.image_key;
	if (!imageKey) throw new Error(`[feishu-media] Image upload failed: no image_key in response. Check that the image is a valid format (JPEG/PNG/GIF/BMP/WEBP). Response: ${JSON.stringify(response).slice(0, 200)}`);
	return { imageKey };
}
/**
* Fetch remote image bytes by URL (http/https only).
* Local file access is denied. Includes SSRF protection.
*/
async function fetchRemoteImageBuffer(url) {
	return fetchMediaBuffer(url, void 0);
}
/**
* Check whether an IP address belongs to a private or reserved range.
*
* Blocks: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
* 169.254.0.0/16 (link-local / cloud metadata), 0.0.0.0,
* IPv6 loopback (::1), link-local (fe80::), ULA (fc/fd).
*/
function isPrivateIP(ip) {
	if (ip.startsWith("127.")) return true;
	if (ip.startsWith("10.")) return true;
	if (ip.startsWith("192.168.")) return true;
	if (ip.startsWith("169.254.")) return true;
	if (ip === "0.0.0.0") return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
	if (ip === "::1" || ip === "::") return true;
	if (ip.startsWith("fe80:")) return true;
	if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
	return false;
}
/**
* Validate that a remote URL does not target private/reserved IP addresses.
*
* Resolves the hostname via DNS and checks all returned addresses.
* Rejects URLs with non-http(s) protocols.
*/
async function validateRemoteUrl(raw) {
	const parsed = new URL(raw);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`[feishu-media] Unsupported protocol "${parsed.protocol}" in URL "${raw}". Only http:// and https:// are allowed for remote media.`);
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	if (net.isIP(hostname)) {
		if (isPrivateIP(hostname)) throw new Error(`[feishu-media] Access to private/reserved IP "${hostname}" is denied (SSRF protection). URL: "${raw}"`);
	} else try {
		const addresses = await dns.resolve(hostname);
		for (const addr of addresses) if (isPrivateIP(addr)) throw new Error(`[feishu-media] Domain "${hostname}" resolves to private/reserved IP "${addr}" (SSRF protection). URL: "${raw}"`);
	} catch (err) {
		if (err instanceof Error && err.message.includes("SSRF protection")) throw err;
		log$13.warn(`[feishu-media] DNS resolution failed for "${hostname}": ${err}`);
	}
}
/**
* Fetch media bytes from a URL or local file path.
*
* Supports:
* - `http://` and `https://` URLs (fetched via the global `fetch` API)
* - `file://` URLs and bare file system paths (read from disk, gated
*   by `localRoots` for path-traversal prevention)
*/
async function fetchMediaBuffer(urlOrPath, localRoots) {
	const raw = normalizeMediaUrlInput(urlOrPath);
	if (isLocalMediaPath(raw)) {
		const filePath = raw.startsWith("file://") ? safeFileUrlToPath(raw) : raw;
		if (localRoots !== void 0) validateLocalMediaRoots(filePath, localRoots);
		else throw new Error(`[feishu-media] Local file access denied for "${filePath}": mediaLocalRoots is not configured. Configure mediaLocalRoots to explicitly allow local file access.`);
		const buf = fs$1.readFileSync(filePath);
		log$13.debug(`local file read: "${filePath}", ${buf.length} bytes`);
		return buf;
	}
	await validateRemoteUrl(raw);
	const FETCH_TIMEOUT_MS = 3e4;
	log$13.info(`fetching remote media: ${raw}`);
	const arrayBuffer = await withRetry(async () => {
		const response = await fetch(raw, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok) {
			const err = /* @__PURE__ */ new Error(`[feishu-media] Failed to fetch media from "${raw}": HTTP ${response.status} ${response.statusText}. Verify the URL is accessible and returns a valid media resource.`);
			err.status = response.status;
			throw err;
		}
		return response.arrayBuffer();
	}, `fetchMedia(${raw})`);
	log$13.debug(`remote media fetched: ${raw}, ${arrayBuffer.byteLength} bytes`);
	return Buffer.from(arrayBuffer);
}
//#endregion
//#region vendor/openclaw-lark/dist/channel/chat-queue.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Process-level chat task queue.
*
* Although located in channel/, this module is intentionally shared
* across channel, messaging, tools, and card layers as a process-level
* singleton. Consumers: monitor.ts, dispatch.ts, oauth.ts, auto-auth.ts.
*
* Ensures tasks targeting the same account+chat are executed serially.
* Used by both websocket inbound messages and synthetic message paths.
*/
const chatQueues = /* @__PURE__ */ new Map();
/**
* Append `:thread:{threadId}` suffix when threadId is present.
* Consistent with the SDK's `:thread:` separator convention.
*/
function threadScopedKey(base, threadId) {
	return threadId ? `${base}:thread:${threadId}` : base;
}
function buildQueueKey(accountId, chatId, threadId) {
	return threadScopedKey(`${accountId}:${chatId}`, threadId);
}
function enqueueFeishuChatTask(params) {
	const { accountId, chatId, threadId, task } = params;
	const key = buildQueueKey(accountId, chatId, threadId);
	const prev = chatQueues.get(key) ?? Promise.resolve();
	const status = chatQueues.has(key) ? "queued" : "immediate";
	const taskPromise = prev.then(task, task);
	chatQueues.set(key, taskPromise);
	const cleanup = () => {
		if (chatQueues.get(key) === taskPromise) chatQueues.delete(key);
	};
	taskPromise.then(cleanup, cleanup);
	return {
		status,
		promise: taskPromise
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/core/api-error.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared Lark API error handling utilities.
*
* Provides unified error handling for two distinct error paths:
*
* 1. **Response-level errors** — The SDK returns a response object with a
*    non-zero `code`.  Handled by {@link assertLarkOk}.
*
* 2. **Thrown exceptions** — The SDK throws an Axios-style error (HTTP 4xx)
*    whose properties include the Feishu error `code` and `msg`.
*    Handled by {@link formatLarkError}.
*
* Both paths intercept well-known codes (e.g. LARK_ERROR.APP_SCOPE_MISSING (99991672) — missing API scopes)
* and produce user-friendly messages with actionable authorization links.
*/
/**
* Given a Feishu error code and msg, format a user-friendly permission
* error string if the code is LARK_ERROR.APP_SCOPE_MISSING (99991672).  Returns `null` for other codes.
*/
function formatPermissionError(code, msg) {
	if (code !== LARK_ERROR.APP_SCOPE_MISSING) return null;
	const authUrl = extractPermissionGrantUrl(msg);
	return `权限不足：应用缺少 [${extractPermissionScopes(msg)}] 权限。\n请管理员点击以下链接申请并开通权限：\n${authUrl}`;
}
function coerceCode(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
/**
* 从 Lark SDK 抛错对象中提取飞书 API code。
*
* 支持三种常见结构：
* - `{ code }` — SDK 直接挂载
* - `{ data: { code } }` — 响应体嵌套
* - `{ response: { data: { code } } }` — Axios 风格
*/
function extractLarkApiCode(err) {
	if (!err || typeof err !== "object") return void 0;
	const e = err;
	return coerceCode(e.code) ?? coerceCode(e.data?.code) ?? coerceCode(e.response?.data?.code);
}
/**
* Assert that a Lark SDK response is successful (code === 0).
*
* For permission errors (code LARK_ERROR.APP_SCOPE_MISSING (99991672)), the thrown error includes the
* required scope names and a direct authorization URL so the AI can
* present it to the end user.
*/
function assertLarkOk(res) {
	if (!res.code || res.code === 0) return;
	const permMsg = formatPermissionError(res.code, res.msg ?? "");
	if (permMsg) throw new Error(permMsg);
	throw new Error(res.msg ?? `Feishu API error (code: ${res.code})`);
}
/**
* Extract a meaningful error message from a thrown Lark SDK / Axios error.
*
* The Lark SDK throws Axios errors whose object carries Feishu-specific
* fields (`code`, `msg`) alongside the standard `message`.  For permission
* errors (LARK_ERROR.APP_SCOPE_MISSING (99991672)) we format a user-friendly string with scopes + auth URL.
* For all other errors we try `err.msg` first (the Feishu detail) and fall
* back to `err.message` (the generic Axios text).
*/
function formatLarkError(err) {
	if (!err || typeof err !== "object") return String(err);
	const e = err;
	if (typeof e.code === "number" && e.msg) {
		const permMsg = formatPermissionError(e.code, e.msg);
		if (permMsg) return permMsg;
		return e.msg;
	}
	const data = e.response?.data;
	if (data && typeof data.code === "number" && data.msg) {
		const permMsg = formatPermissionError(data.code, data.msg);
		if (permMsg) return permMsg;
		return data.msg;
	}
	return e.message ?? String(err);
}
//#endregion
//#region vendor/openclaw-lark/dist/core/message-unavailable.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 消息不可用（已撤回/已删除）状态管理。
*
* 目标：
* 1) 当命中飞书终止错误码（230011/231003）时，按 message_id 标记不可用；
* 2) 后续针对该 message_id 的 API 调用直接短路，避免持续报错刷屏。
*/
const UNAVAILABLE_CACHE_TTL_MS = 1800 * 1e3;
const MAX_CACHE_SIZE_BEFORE_PRUNE = 512;
const unavailableMessageCache = /* @__PURE__ */ new Map();
function pruneExpired(nowMs = Date.now()) {
	for (const [messageId, state] of unavailableMessageCache) if (nowMs - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) unavailableMessageCache.delete(messageId);
}
function isTerminalMessageApiCode(code) {
	return typeof code === "number" && MESSAGE_TERMINAL_CODES.has(code);
}
function markMessageUnavailable(params) {
	const normalizedId = normalizeMessageId(params.messageId);
	if (!normalizedId) return;
	if (unavailableMessageCache.size >= MAX_CACHE_SIZE_BEFORE_PRUNE) pruneExpired();
	unavailableMessageCache.set(normalizedId, {
		apiCode: params.apiCode,
		operation: params.operation,
		markedAtMs: Date.now()
	});
}
function getMessageUnavailableState(messageId) {
	const normalizedId = normalizeMessageId(messageId);
	if (!normalizedId) return void 0;
	const state = unavailableMessageCache.get(normalizedId);
	if (!state) return void 0;
	if (Date.now() - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) {
		unavailableMessageCache.delete(normalizedId);
		return;
	}
	return state;
}
function isMessageUnavailable(messageId) {
	return !!getMessageUnavailableState(messageId);
}
function markMessageUnavailableFromError(params) {
	const normalizedId = normalizeMessageId(params.messageId);
	if (!normalizedId) return void 0;
	const code = extractLarkApiCode(params.error);
	if (!isTerminalMessageApiCode(code)) return void 0;
	markMessageUnavailable({
		messageId: normalizedId,
		apiCode: code,
		operation: params.operation
	});
	return code;
}
var MessageUnavailableError = class extends Error {
	messageId;
	apiCode;
	operation;
	constructor(params) {
		const operationText = params.operation ? `, op=${params.operation}` : "";
		super(`[feishu-message-unavailable] message ${params.messageId} unavailable (code=${params.apiCode}${operationText})`);
		this.name = "MessageUnavailableError";
		this.messageId = params.messageId;
		this.apiCode = params.apiCode;
		this.operation = params.operation;
	}
};
function isMessageUnavailableError(error) {
	return error instanceof MessageUnavailableError || typeof error === "object" && error != null && error.name === "MessageUnavailableError";
}
function assertMessageAvailable(messageId, operation) {
	const normalizedId = normalizeMessageId(messageId);
	if (!normalizedId) return;
	const state = getMessageUnavailableState(normalizedId);
	if (!state) return;
	throw new MessageUnavailableError({
		messageId: normalizedId,
		apiCode: state.apiCode,
		operation: operation ?? state.operation
	});
}
/**
* 针对 message_id 的统一保护：
* - 调用前检查是否已标记不可用；
* - 调用报错后识别 230011/231003 并标记；
* - 命中时抛出 MessageUnavailableError 供上游快速终止流程。
*/
async function runWithMessageUnavailableGuard(params) {
	const normalizedId = normalizeMessageId(params.messageId);
	if (!normalizedId) return params.fn();
	assertMessageAvailable(normalizedId, params.operation);
	try {
		return await params.fn();
	} catch (error) {
		const code = markMessageUnavailableFromError({
			messageId: normalizedId,
			error,
			operation: params.operation
		});
		if (code) throw new MessageUnavailableError({
			messageId: normalizedId,
			apiCode: code,
			operation: params.operation
		});
		throw error;
	}
}
//#endregion
//#region vendor/openclaw-lark/dist/card/markdown-style.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Markdown 样式优化工具
*/
/**
* 优化 Markdown 样式：
* - 标题降级：H1 → H4，H2~H6 → H5
* - 表格前后增加段落间距
* - 有序列表：序号后确保只有一个空格
* - 无序列表："- " 格式规范化（跳过分隔线 ---）
* - 表格：单元格前后补空格，分隔符行规范化，表格前后加空行
* - 代码块内容不受影响
*/
function optimizeMarkdownStyle(text, cardVersion = 2) {
	try {
		let r = _optimizeMarkdownStyle(text, cardVersion);
		r = stripInvalidImageKeys(r);
		return r;
	} catch {
		return text;
	}
}
function _optimizeMarkdownStyle(text, cardVersion = 2) {
	const MARK = "___CB_";
	const codeBlocks = [];
	let r = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (m, prefix = "") => {
		const block = m.slice(String(prefix).length);
		return `${prefix}${MARK}${codeBlocks.push(block) - 1}___`;
	});
	if (/^#{1,3} /m.test(text)) {
		r = r.replace(/^#{2,6} (.+)$/gm, "##### $1");
		r = r.replace(/^# (.+)$/gm, "#### $1");
	}
	if (cardVersion >= 2) {
		r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");
		r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
		r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
		r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
			const after = r.slice(offset + m.length).replace(/^\n+/, "");
			if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m;
			return m + "\n<br>\n";
		});
		r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
		r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
		r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");
		codeBlocks.forEach((block, i) => {
			r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
		});
	} else codeBlocks.forEach((block, i) => {
		r = r.replace(`${MARK}${i}___`, block);
	});
	r = r.replace(/\n{3,}/g, "\n\n");
	return r;
}
/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE$1 = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
/**
* Strip `![alt](value)` where value is not a valid Feishu image key
* (`img_xxx`). Prevents CardKit error 200570.
*
* HTTP URLs are stripped as well — ImageResolver should have already
* replaced them with `img_xxx` keys before this point. This serves
* as a safety net for any unresolved URLs.
*/
function stripInvalidImageKeys(text) {
	if (!text.includes("![")) return text;
	return text.replace(IMAGE_RE$1, (fullMatch, _alt, value) => {
		if (value.startsWith("img_")) return fullMatch;
		return "";
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/sentinel-store.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Per-thread store for unresolved mention feedback. The outbound
* normalizer records a SentinelEntry whenever an `@Name` cannot be
* resolved; the next inbound message on the same thread consumes
* (take and delete) the entries, which buildMentionAnnotation surfaces
* as a system note so the next reply can disambiguate.
*
* Kept separate from UserNameCache because the lifecycle differs:
* 10-minute TTL, per-thread keying, and take-and-delete consumption.
*/
const DEFAULT_TTL_MS = 600 * 1e3;
const DEFAULT_MAX_THREADS = 200;
function dedup(entries) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const e of entries) {
		const key = `${e.reason}:${e.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}
var SentinelStore = class {
	byThread = /* @__PURE__ */ new Map();
	maxThreads;
	ttlMs;
	constructor(maxThreads = DEFAULT_MAX_THREADS, ttlMs = DEFAULT_TTL_MS) {
		this.maxThreads = maxThreads;
		this.ttlMs = ttlMs;
	}
	recordSentinels(threadKey, sentinels) {
		if (sentinels.length === 0) return;
		const existing = this.byThread.get(threadKey);
		const merged = existing ? [...existing.entries, ...sentinels] : sentinels;
		this.byThread.delete(threadKey);
		this.byThread.set(threadKey, {
			entries: dedup(merged),
			expireAt: Date.now() + this.ttlMs
		});
		this.evict();
	}
	consumeSentinels(threadKey) {
		const stored = this.byThread.get(threadKey);
		if (!stored) return [];
		this.byThread.delete(threadKey);
		if (stored.expireAt <= Date.now()) return [];
		return stored.entries;
	}
	clear() {
		this.byThread.clear();
	}
	evict() {
		while (this.byThread.size > this.maxThreads) {
			const oldest = this.byThread.keys().next().value;
			if (oldest === void 0) break;
			this.byThread.delete(oldest);
		}
	}
};
const registry = /* @__PURE__ */ new Map();
function getSentinelStore(accountId, maxThreads, ttlMs) {
	let store = registry.get(accountId);
	if (!store) {
		store = new SentinelStore(maxThreads, ttlMs);
		registry.set(accountId, store);
	}
	return store;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/outbound/normalize-mentions.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Outbound mention normalizer for Feishu post messages. Rewrites <at>
* tag variants and resolves "@Name" to the canonical
* <at user_id="ou_xxx">Name</at> form expected by the Feishu API.
*/
/**
* Rewrites <at> tag attribute and quote variants to the canonical
* `<at user_id="ou_xxx">` form. Idempotent; pure string transform.
*
* Recognized variants: `id=`, `open_id=`, `user_id=`; double-quoted,
* single-quoted, or unquoted; `id=all` aligned to `user_id="all"` with
* "Everyone" name fill. `<person>` picker tags are left untouched.
*/
function normalizeOutboundMentionsTagPass(text) {
	let out = text;
	out = out.replace(/<at\s+(?:id|user_id|open_id)\s*=\s*["']?all["']?\s*>\s*<\/at>/gi, "<at user_id=\"all\">Everyone</at>");
	out = out.replace(/<at\s+(?:id|open_id|user_id)\s*=\s*["']?(ou_[A-Za-z0-9_-]+)["']?\s*>/gi, "<at user_id=\"$1\">");
	return out;
}
const noopLog = () => {};
/** Spans excluded from the @Name scan: code, canonical tags, emails, URLs. */
const MASK_PATTERNS = [
	/```[\s\S]*?```/g,
	/`[^`\n]*`/g,
	/<at\s+user_id="[^"]+">[^<]*<\/at>/g,
	/<person\s+[^>]*>[^<]*<\/person>/g,
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	/\b(?:https?|ftp|mailto):\/\/[^\s)\]<>]+/g
];
const CANDIDATE_RE = /@([A-Za-z0-9\u4e00-\u9fa5_]+(?:[.-][A-Za-z0-9\u4e00-\u9fa5_]+)*)/g;
const FALLBACK_PREFETCHES = [prefetchChatBots, prefetchChatMembers];
/**
* Normalizes outbound text for Feishu: rewrites <at> tag variants and
* resolves plain "@Name" against the per-account name cache.
*
* On cache miss, fetches the chat's bot list and retries; if still
* unresolved, fetches the chat's member list and retries. Names that
* match multiple cache entries become ambiguous sentinels for next-turn
* disambiguation; remaining misses are dropped without a sentinel to
* avoid false positives on `@` followed by non-name CJK runs.
*/
async function normalizeOutboundMentions(text, ctx) {
	let out = normalizeOutboundMentionsTagPass(text);
	out = out.replace(/@(<at\s+user_id="ou_[A-Za-z0-9_-]+">[^<]*<\/at>)/g, "$1");
	const inMask = buildMaskPredicate(out);
	const sentinels = [];
	const replacements = [];
	let pending = [];
	for (const m of out.matchAll(CANDIDATE_RE)) {
		const start = m.index;
		if (inMask(start)) continue;
		const end = start + m[0].length;
		const r = resolveCandidate(m[1], ctx);
		if (r.kind === "resolved") replacements.push(makeReplacement(start, end, r));
		else if (r.entry.reason === "ambiguous") sentinels.push(r.entry);
		else pending.push({
			start,
			end,
			name: m[1]
		});
	}
	for (const prefetch of FALLBACK_PREFETCHES) {
		if (pending.length === 0) break;
		pending = await retryWithPrefetch(pending, prefetch, ctx, replacements, sentinels);
	}
	return {
		normalizedText: applyReplacements(out, replacements),
		sentinels
	};
}
function buildMaskPredicate(text) {
	const masks = [];
	for (const re of MASK_PATTERNS) for (const m of text.matchAll(re)) masks.push([m.index, m.index + m[0].length]);
	return (idx) => masks.some(([s, e]) => idx >= s && idx < e);
}
function makeReplacement(start, end, r) {
	return {
		start,
		end,
		text: `<at user_id="${r.openId}">${r.displayName}</at>`
	};
}
async function retryWithPrefetch(pending, prefetch, ctx, replacements, sentinels) {
	await prefetch(ctx.account, ctx.chatId, ctx.log ?? noopLog);
	const stillMissing = [];
	for (const p of pending) {
		const r = resolveCandidate(p.name, ctx);
		if (r.kind === "resolved") replacements.push(makeReplacement(p.start, p.end, r));
		else if (r.entry.reason === "ambiguous") sentinels.push(r.entry);
		else stillMissing.push(p);
	}
	return stillMissing;
}
/**
* Applies non-overlapping replacements in a single left-to-right pass.
* Builds an array of literal chunks then joins it once — O(n + total
* replacement length), no string-concat quadratic behavior.
*/
function applyReplacements(text, replacements) {
	if (replacements.length === 0) return text;
	const sorted = [...replacements].sort((a, b) => a.start - b.start);
	const out = [];
	let cursor = 0;
	for (const r of sorted) {
		if (r.start < cursor) continue;
		out.push(text.slice(cursor, r.start), r.text);
		cursor = r.end;
	}
	out.push(text.slice(cursor));
	return out.join("");
}
/**
* Aliases for "mention everyone" that may appear as plain text instead
* of the canonical `<at user_id="all">` tag. Match is case-insensitive.
*/
const ALL_ALIASES = new Set([
	"all",
	"everyone",
	"所有人"
]);
function resolveCandidate(name, ctx) {
	if (ALL_ALIASES.has(name.toLowerCase())) return {
		kind: "resolved",
		openId: "all",
		displayName: "Everyone"
	};
	const matches = getUserNameCache(ctx.account.accountId).lookupByName(name);
	if (matches.length === 1) return {
		kind: "resolved",
		openId: matches[0].openId,
		displayName: matches[0].name
	};
	if (matches.length > 1) return {
		kind: "sentinel",
		entry: {
			name,
			reason: "ambiguous",
			candidates: matches.map((m) => ({
				openId: m.openId,
				kind: m.kind
			}))
		}
	};
	return {
		kind: "sentinel",
		entry: {
			name,
			reason: "not_found"
		}
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/outbound/outbound-mention.js
/**
* Ensure the reply explicitly @-mentions the given peer.
*
* Designed for bot↔bot group flows: when the peer is another bot, Feishu
* won't deliver the message unless an `<at user_id="ou_peer">` element is
* present somewhere in the text. If the LLM already mentioned the peer,
* no-op; otherwise, prepend a standard `<at>` so the peer wakes up.
*/
function ensureMention(text, peerOpenId, peerName) {
	if (!peerOpenId) return text;
	const escaped = peerOpenId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`<at\\s+user_id="${escaped}">[^<]*<\\/at>`).test(text)) return text;
	const standardAt = `<at user_id="${peerOpenId}">${peerName || peerOpenId}</at>`;
	if (!text || !text.trim()) return standardAt;
	return `${standardAt} ${text}`;
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/outbound/bot-peer-context.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* AsyncLocalStorage-backed channel for telling the outbound adapter that
* the current dispatch is replying to a bot peer in a group chat.
*
* Why ALS instead of an extra adapter parameter: the outbound adapter is
* channel-agnostic (Slack / Telegram / Feishu share the same shape) and
* the SDK owns the call site between dispatch and our outbound. Adding a
* Feishu-specific "peer-is-bot" parameter would pollute that interface.
* ALS lets the dispatch layer attach context once and have it flow through
* the SDK's async chain to the outbound adapter without any other layer
* needing to know.
*
* Lifetime: scoped to a single `runWithBotPeerContext(...)` call. When that
* promise settles, the store is gone. No manual cleanup required.
*/
const storage = new AsyncLocalStorage();
/**
* Read the active bot-peer context, or `undefined` if none is set.
* Outbound code uses this to decide whether to wrap the reply text with
* `ensureMention` so the peer bot actually receives a Feishu notification.
*/
function currentBotPeerContext() {
	return storage.getStore();
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/outbound/send.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Message sending for the Lark/Feishu channel plugin.
*/
const sendLog = larkLogger("outbound/send");
/**
* Runs the outbound text through mention normalization. Returns the
* input unchanged on any failure so a parser bug never blocks send.
* Sentinels collected during normalization are returned for the caller
* to record after a successful send.
*/
async function normalizeFeishuOutboundText(cfg, to, text, accountId) {
	if (!text?.trim()) return {
		text,
		sentinels: [],
		resolvedAccountId: accountId
	};
	try {
		const account = getLarkAccount(cfg, accountId ?? void 0);
		const r = await normalizeOutboundMentions(text, {
			chatId: to,
			account,
			log: (...args) => sendLog.warn(args.map(String).join(" "))
		});
		let outText = r.normalizedText;
		const peer = currentBotPeerContext();
		if (peer && !peer.mentioned) {
			outText = ensureMention(outText, peer.peerOpenId, peer.peerName);
			if (outText.includes(`user_id="${peer.peerOpenId}"`)) peer.mentioned = true;
		}
		return {
			text: outText,
			sentinels: r.sentinels,
			resolvedAccountId: account.accountId
		};
	} catch (err) {
		sendLog.warn(`normalizeOutboundMentions failed, using raw text: ${String(err)}`);
		return {
			text,
			sentinels: [],
			resolvedAccountId: accountId
		};
	}
}
function recordFeishuSendSentinels(resolvedAccountId, to, threadId, sentinels) {
	if (!resolvedAccountId || sentinels.length === 0) return;
	const threadKey = threadScopedKey(to, threadId);
	getSentinelStore(resolvedAccountId).recordSentinels(threadKey, sentinels);
}
/**
* Send a text message (rendered as a Feishu "post" with markdown support)
* to a chat or user.
*
* The message text is wrapped in Feishu's post format using the `md` tag
* for rich rendering. If `replyToMessageId` is provided, the message is
* sent as a threaded reply; otherwise it is sent as a new message using
* the appropriate `receive_id_type`.
*
* Markdown tables and code blocks are sent as-is so Feishu renders them
* natively in the post(`tag:md`); only `optimizeMarkdownStyle` is applied.
*
* @param params - See {@link SendFeishuMessageParams}.
* @returns The send result containing the new message ID.
*/
async function sendMessageFeishu(params) {
	const { cfg, to, replyToMessageId, mentions, accountId, replyInThread, i18nTexts, threadId } = params;
	let { text } = params;
	let normalizationSentinels = [];
	let normalizationAccountId = accountId ?? void 0;
	if (!i18nTexts && text?.trim()) {
		const r = await normalizeFeishuOutboundText(cfg, to, text, accountId ?? void 0);
		text = r.text;
		normalizationSentinels = r.sentinels;
		normalizationAccountId = r.resolvedAccountId;
	}
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	let contentPayload;
	if (i18nTexts && Object.keys(i18nTexts).length > 0) {
		const postBody = {};
		for (const [locale, localeText] of Object.entries(i18nTexts)) {
			let processed = localeText;
			if (mentions && mentions.length > 0) processed = buildMentionedMessage(mentions, processed);
			processed = optimizeMarkdownStyle(processed, 1);
			postBody[locale] = { content: [[{
				tag: "md",
				text: processed
			}]] };
		}
		contentPayload = JSON.stringify(postBody);
	} else {
		let messageText = text;
		if (mentions && mentions.length > 0) messageText = buildMentionedMessage(mentions, messageText);
		messageText = optimizeMarkdownStyle(messageText, 1);
		contentPayload = JSON.stringify({ zh_cn: { content: [[{
			tag: "md",
			text: messageText
		}]] } });
	}
	if (replyToMessageId) {
		const normalizedId = normalizeMessageId(replyToMessageId);
		const response = await runWithMessageUnavailableGuard({
			messageId: normalizedId,
			operation: "im.message.reply(post)",
			fn: () => client.im.message.reply({
				path: { message_id: normalizedId },
				data: {
					content: contentPayload,
					msg_type: "post",
					reply_in_thread: replyInThread
				}
			})
		});
		recordFeishuSendSentinels(normalizationAccountId, to, threadId, normalizationSentinels);
		return {
			messageId: response?.data?.message_id ?? "",
			chatId: response?.data?.chat_id ?? ""
		};
	}
	const target = normalizeFeishuTarget(to);
	if (!target) throw new Error(`[feishu-send] Invalid target: "${to}"`);
	const receiveIdType = resolveReceiveIdType(target);
	const response = await client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: target,
			msg_type: "post",
			content: contentPayload
		}
	});
	recordFeishuSendSentinels(normalizationAccountId, to, threadId, normalizationSentinels);
	return {
		messageId: response?.data?.message_id ?? "",
		chatId: response?.data?.chat_id ?? ""
	};
}
/**
* Send an interactive card message to a chat or user.
*
* @param params - See {@link SendFeishuCardParams}.
* @returns The send result containing the new message ID.
*/
async function sendCardFeishu(params) {
	const { cfg, to, card, replyToMessageId, accountId, replyInThread } = params;
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	const contentPayload = JSON.stringify(card);
	if (replyToMessageId) {
		const normalizedId = normalizeMessageId(replyToMessageId);
		const response = await runWithMessageUnavailableGuard({
			messageId: normalizedId,
			operation: "im.message.reply(interactive)",
			fn: () => client.im.message.reply({
				path: { message_id: normalizedId },
				data: {
					content: contentPayload,
					msg_type: "interactive",
					reply_in_thread: replyInThread
				}
			})
		});
		return {
			messageId: response?.data?.message_id ?? "",
			chatId: response?.data?.chat_id ?? ""
		};
	}
	const target = normalizeFeishuTarget(to);
	if (!target) throw new Error(`[feishu-send] Invalid target: "${to}"`);
	const receiveIdType = resolveReceiveIdType(target);
	const response = await client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: target,
			msg_type: "interactive",
			content: contentPayload
		}
	});
	return {
		messageId: response?.data?.message_id ?? "",
		chatId: response?.data?.chat_id ?? ""
	};
}
/**
* Update (PATCH) the content of an existing interactive card message.
*
* Only messages originally sent by the bot can be updated. The card
* must have been created with `"update_multi": true` in its config if
* all recipients should see the update.
*
* @param params.cfg       - Plugin configuration.
* @param params.messageId - The card message ID to update.
* @param params.card      - The new card content.
* @param params.accountId - Optional account identifier.
*/
async function updateCardFeishu(params) {
	const { cfg, messageId, card, accountId } = params;
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	await runWithMessageUnavailableGuard({
		messageId,
		operation: "im.message.patch(interactive)",
		fn: () => client.im.message.patch({
			path: { message_id: messageId },
			data: { content: JSON.stringify(card) }
		})
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/core/card-action-operator.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Card callback operator identity extraction.
*
* Feishu Schema 2 card callbacks may carry the operator identity under
* either `operator.open_id` (Schema 1 / default) or `operator.user_id`
* (Schema 2 when the user has no open_id in the app's tenant).
*
* This helper provides a single, consistent extraction point so that
* every card callback handler resolves the operator identity the same
* way.  See openclaw/openclaw#71670 for the upstream Schema 2 change.
*/
/**
* Extract the operator's identity from a Feishu card callback event.
*
* Prefers `open_id` (the stable per-app user identifier) and falls back
* to `user_id` when `open_id` is absent or empty — this is the Schema 2 path.
*
* @param operator - The `operator` field from the card callback payload.
* @returns The resolved operator identifier, or `undefined` when neither
*   field is present.
*/
function resolveCardCallbackOperatorId(operator) {
	return operator?.open_id || operator?.user_id;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/token-store.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* UAT (User Access Token) persistent storage with cross-platform support.
*
* Stores OAuth token data using OS-native credential services so that tokens
* survive process restarts without introducing plain-text local files.
*
* Platform backends:
*   macOS   – Keychain Access via `security` CLI
*   Linux   – AES-256-GCM encrypted files (XDG_DATA_HOME)
*   Windows – AES-256-GCM encrypted files (%LOCALAPPDATA%)
*
* Storage layout:
*   Service  = "openclaw-feishu-uat"
*   Account  = "{appId}:{userOpenId}"
*   Password = JSON-serialised StoredUAToken
*/
const log$12 = larkLogger("core/token-store");
const execFile = promisify(createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url)(`node:${["child", "process"].join("_")}`).execFile);
const KEYCHAIN_SERVICE = "openclaw-feishu-uat";
/** Refresh proactively when access_token expires within this window. */
const REFRESH_AHEAD_MS = 300 * 1e3;
function accountKey(appId, userOpenId) {
	return `${appId}:${userOpenId}`;
}
/** Mask a token for safe logging: only the last 4 chars are visible. */
function maskToken(token) {
	if (token.length <= 8) return "****";
	return `****${token.slice(-4)}`;
}
const darwinBackend = {
	async get(service, account) {
		try {
			const { stdout } = await execFile("security", [
				"find-generic-password",
				"-s",
				service,
				"-a",
				account,
				"-w"
			]);
			return stdout.trim() || null;
		} catch {
			return null;
		}
	},
	async set(service, account, data) {
		try {
			await execFile("security", [
				"delete-generic-password",
				"-s",
				service,
				"-a",
				account
			]);
		} catch {}
		await execFile("security", [
			"add-generic-password",
			"-s",
			service,
			"-a",
			account,
			"-w",
			data
		]);
	},
	async remove(service, account) {
		try {
			await execFile("security", [
				"delete-generic-password",
				"-s",
				service,
				"-a",
				account
			]);
		} catch {}
	}
};
const LINUX_UAT_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "openclaw-feishu-uat");
const MASTER_KEY_PATH = join(LINUX_UAT_DIR, "master.key");
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Convert account key to a filesystem-safe filename. */
function linuxSafeFileName(account) {
	return account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
}
/** Ensure the credentials directory exists with mode 0700. */
async function ensureLinuxCredDir() {
	await mkdir(LINUX_UAT_DIR, {
		recursive: true,
		mode: 448
	});
}
/**
* Load or create the 32-byte master key.
*
* On first run, generates a random key and writes it to disk (mode 0600).
* On subsequent runs, reads the existing key file.
*/
async function getMasterKey() {
	try {
		const key = await readFile(MASTER_KEY_PATH);
		if (key.length === MASTER_KEY_BYTES) return key;
		log$12.warn("master key has unexpected length, regenerating");
	} catch (err) {
		if (!(err instanceof Error) || err.code !== "ENOENT") log$12.warn(`failed to read master key: ${err instanceof Error ? err.message : err}`);
	}
	await ensureLinuxCredDir();
	const key = randomBytes(MASTER_KEY_BYTES);
	await writeFile(MASTER_KEY_PATH, key, { mode: 384 });
	await chmod(MASTER_KEY_PATH, 384);
	log$12.info("generated new master key for encrypted file storage");
	return key;
}
/** AES-256-GCM encrypt. Returns [12-byte IV][16-byte tag][ciphertext]. */
function encryptData(plaintext, key) {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([
		iv,
		cipher.getAuthTag(),
		enc
	]);
}
/** AES-256-GCM decrypt. Returns plaintext or `null` on failure. */
function decryptData(data, key) {
	if (data.length < IV_BYTES + TAG_BYTES) return null;
	try {
		const iv = data.subarray(0, IV_BYTES);
		const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
		const enc = data.subarray(IV_BYTES + TAG_BYTES);
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
	} catch {
		return null;
	}
}
const linuxBackend = {
	async get(_service, account) {
		try {
			const key = await getMasterKey();
			return decryptData(await readFile(join(LINUX_UAT_DIR, linuxSafeFileName(account))), key);
		} catch {
			return null;
		}
	},
	async set(_service, account, data) {
		const key = await getMasterKey();
		await ensureLinuxCredDir();
		const filePath = join(LINUX_UAT_DIR, linuxSafeFileName(account));
		await writeFile(filePath, encryptData(data, key), { mode: 384 });
		await chmod(filePath, 384);
	},
	async remove(_service, account) {
		try {
			await unlink(join(LINUX_UAT_DIR, linuxSafeFileName(account)));
		} catch {}
	}
};
const WIN32_UAT_DIR = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData", "Local"), KEYCHAIN_SERVICE);
const WIN32_MASTER_KEY_PATH = join(WIN32_UAT_DIR, "master.key");
/** Convert account key to a filesystem-safe filename (whitelist approach). */
function win32SafeFileName(account) {
	return account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
}
async function ensureWin32CredDir() {
	await mkdir(WIN32_UAT_DIR, { recursive: true });
}
async function getWin32MasterKey() {
	try {
		const key = await readFile(WIN32_MASTER_KEY_PATH);
		if (key.length === MASTER_KEY_BYTES) return key;
		log$12.warn("win32 master key has unexpected length, regenerating");
	} catch (err) {
		if (!(err instanceof Error) || err.code !== "ENOENT") log$12.warn(`failed to read win32 master key: ${err instanceof Error ? err.message : err}`);
	}
	await ensureWin32CredDir();
	const key = randomBytes(MASTER_KEY_BYTES);
	await writeFile(WIN32_MASTER_KEY_PATH, key);
	log$12.info("generated new master key for win32 encrypted file storage");
	return key;
}
const win32Backend = {
	async get(_service, account) {
		try {
			const key = await getWin32MasterKey();
			return decryptData(await readFile(join(WIN32_UAT_DIR, win32SafeFileName(account))), key);
		} catch {
			return null;
		}
	},
	async set(_service, account, data) {
		const key = await getWin32MasterKey();
		await ensureWin32CredDir();
		await writeFile(join(WIN32_UAT_DIR, win32SafeFileName(account)), encryptData(data, key));
	},
	async remove(_service, account) {
		try {
			await unlink(join(WIN32_UAT_DIR, win32SafeFileName(account)));
		} catch {}
	}
};
function createBackend() {
	switch (process.platform) {
		case "darwin": return darwinBackend;
		case "linux": return linuxBackend;
		case "win32": return win32Backend;
		default:
			log$12.warn(`unsupported platform "${process.platform}", falling back to macOS backend`);
			return darwinBackend;
	}
}
const backend = createBackend();
/**
* Read the stored UAT for a given (appId, userOpenId) pair.
* Returns `null` when no entry exists or the payload is unparseable.
*/
async function getStoredToken(appId, userOpenId) {
	try {
		const json = await backend.get(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
		if (!json) return null;
		return JSON.parse(json);
	} catch {
		return null;
	}
}
/**
* Persist a UAT using the platform credential store.
*
* Overwrites any existing entry for the same (appId, userOpenId).
*/
async function setStoredToken(token) {
	const key = accountKey(token.appId, token.userOpenId);
	const payload = JSON.stringify(token);
	await backend.set(KEYCHAIN_SERVICE, key, payload);
	log$12.info(`saved UAT for ${token.userOpenId} (at:${maskToken(token.accessToken)})`);
}
/**
* Remove a stored UAT from the credential store.
*/
async function removeStoredToken(appId, userOpenId) {
	await backend.remove(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
	log$12.info(`removed UAT for ${userOpenId}`);
}
/**
* Determine the freshness of a stored token.
*
* - `"valid"`         – access_token is still good (expires > 5 min from now)
* - `"needs_refresh"` – access_token expired/expiring but refresh_token is valid
* - `"expired"`       – both tokens are expired; re-authorization required
*/
function tokenStatus(token) {
	const now = Date.now();
	if (now < token.expiresAt - REFRESH_AHEAD_MS) return "valid";
	if (now < token.refreshExpiresAt) return "needs_refresh";
	return "expired";
}
//#endregion
//#region vendor/openclaw-lark/dist/core/feishu-fetch.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Header-aware fetch for Feishu API calls.
*
* Drop-in replacement for `fetch()` that automatically injects
* the User-Agent header.
*/
/**
* Drop-in replacement for `fetch()` that automatically injects
* the User-Agent header.
*
* Used by `device-flow.ts` and `uat-client.ts` so that the custom
* User-Agent is transparently applied without changing every
* call-site's signature.
*/
function feishuFetch(url, init) {
	const headers = {
		...init?.headers,
		"User-Agent": getUserAgent()
	};
	return fetch(url, {
		...init,
		headers
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/core/device-flow.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* OAuth 2.0 Device Authorization Grant (RFC 8628) for Lark/Feishu.
*
* Two-step flow:
*   1. `requestDeviceAuthorization` – obtains device_code + user_code.
*   2. `pollDeviceToken` – polls the token endpoint until the user authorises,
*      rejects, or the code expires.
*
* All HTTP calls use the built-in `fetch` (Node 18+). The Lark SDK is not
* used here because these OAuth endpoints are outside the SDK's scope.
*/
const log$11 = larkLogger("core/device-flow");
/**
* Resolve the two OAuth endpoint URLs based on the configured brand.
*/
function resolveOAuthEndpoints(brand) {
	if (!brand || brand === "feishu") return {
		deviceAuthorization: "https://accounts.feishu.cn/oauth/v1/device_authorization",
		token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
	};
	if (brand === "lark") return {
		deviceAuthorization: "https://accounts.larksuite.com/oauth/v1/device_authorization",
		token: "https://open.larksuite.com/open-apis/authen/v2/oauth/token"
	};
	const base = brand.replace(/\/+$/, "");
	let accountsBase = base;
	try {
		const parsed = new URL(base);
		if (parsed.hostname.startsWith("open.")) accountsBase = `${parsed.protocol}//${parsed.hostname.replace(/^open\./, "accounts.")}`;
	} catch {}
	return {
		deviceAuthorization: `${accountsBase}/oauth/v1/device_authorization`,
		token: `${base}/open-apis/authen/v2/oauth/token`
	};
}
/**
* Request a device authorisation code from the Feishu OAuth server.
*
* Uses Confidential Client authentication (HTTP Basic with appId:appSecret).
* The `offline_access` scope is automatically appended so that the token
* response includes a refresh_token.
*/
async function requestDeviceAuthorization(params) {
	const { appId, appSecret, brand } = params;
	const endpoints = resolveOAuthEndpoints(brand);
	let scope = params.scope ?? "";
	if (!scope.includes("offline_access")) scope = scope ? `${scope} offline_access` : "offline_access";
	const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString("base64");
	const body = new URLSearchParams();
	body.set("client_id", appId);
	body.set("scope", scope);
	log$11.info(`requesting device authorization (scope="${scope}") url=${endpoints.deviceAuthorization} token_url=${endpoints.token}`);
	const resp = await feishuFetch(endpoints.deviceAuthorization, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${basicAuth}`
		},
		body: body.toString()
	});
	const text = await resp.text();
	log$11.info(`response status=${resp.status} body=${text.slice(0, 500)}`);
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`Device authorization failed: HTTP ${resp.status} – ${text.slice(0, 200)}`);
	}
	if (!resp.ok || data.error) {
		const msg = data.error_description ?? data.error ?? "Unknown error";
		throw new Error(`Device authorization failed: ${msg}`);
	}
	const expiresIn = data.expires_in ?? 240;
	const interval = data.interval ?? 5;
	log$11.info(`device_code obtained, expires_in=${expiresIn}s (${Math.round(expiresIn / 60)}min), interval=${interval}s`);
	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri: data.verification_uri,
		verificationUriComplete: data.verification_uri_complete ?? data.verification_uri,
		expiresIn,
		interval
	};
}
function sleep$1(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		}, { once: true });
	});
}
/**
* Poll the token endpoint until the user authorises, rejects, or the code
* expires.
*
* Handles `authorization_pending` (keep polling), `slow_down` (back off by
* +5 s), `access_denied` and `expired_token` (terminal errors).
*
* Pass an `AbortSignal` to cancel polling from the outside.
*/
async function pollDeviceToken(params) {
	const MAX_POLL_INTERVAL = 60;
	const MAX_POLL_ATTEMPTS = 200;
	const { appId, appSecret, brand, deviceCode, expiresIn, signal } = params;
	let interval = params.interval;
	const endpoints = resolveOAuthEndpoints(brand);
	const deadline = Date.now() + expiresIn * 1e3;
	let attempts = 0;
	while (Date.now() < deadline && attempts < MAX_POLL_ATTEMPTS) {
		attempts++;
		if (signal?.aborted) return {
			ok: false,
			error: "expired_token",
			message: "Polling was cancelled"
		};
		await sleep$1(interval * 1e3, signal);
		let data;
		try {
			data = await (await feishuFetch(endpoints.token, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: deviceCode,
					client_id: appId,
					client_secret: appSecret
				}).toString()
			})).json();
		} catch (err) {
			log$11.warn(`poll network error: ${err}`);
			interval = Math.min(interval + 1, MAX_POLL_INTERVAL);
			continue;
		}
		const error = data.error;
		if (!error && data.access_token) {
			log$11.info("token obtained successfully");
			const refreshToken = data.refresh_token ?? "";
			const expiresIn = data.expires_in ?? 7200;
			let refreshExpiresIn = data.refresh_token_expires_in ?? 604800;
			if (!refreshToken) {
				log$11.warn("no refresh_token in response, token will not be refreshable");
				refreshExpiresIn = expiresIn;
			}
			return {
				ok: true,
				token: {
					accessToken: data.access_token,
					refreshToken,
					expiresIn,
					refreshExpiresIn,
					scope: data.scope ?? ""
				}
			};
		}
		if (error === "authorization_pending") {
			log$11.debug("authorization_pending, retrying...");
			continue;
		}
		if (error === "slow_down") {
			interval = Math.min(interval + 5, MAX_POLL_INTERVAL);
			log$11.info(`slow_down, interval increased to ${interval}s`);
			continue;
		}
		if (error === "access_denied") {
			log$11.info("user denied authorization");
			return {
				ok: false,
				error: "access_denied",
				message: "用户拒绝了授权"
			};
		}
		if (error === "expired_token" || error === "invalid_grant") {
			log$11.info(`device code expired/invalid (error=${error})`);
			return {
				ok: false,
				error: "expired_token",
				message: "授权码已过期，请重新发起"
			};
		}
		const desc = data.error_description ?? error ?? "Unknown error";
		log$11.warn(`unexpected error: error=${error}, desc=${desc}`);
		return {
			ok: false,
			error: "expired_token",
			message: desc
		};
	}
	if (attempts >= MAX_POLL_ATTEMPTS) log$11.warn(`max poll attempts (${MAX_POLL_ATTEMPTS}) reached`);
	return {
		ok: false,
		error: "expired_token",
		message: "授权超时，请重新发起"
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/core/uat-client.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* UAT (User Access Token) API call wrapper.
*
* Provides a safe, auto-refreshing interface for making Feishu API calls on
* behalf of a user.  Tokens are read from the OS Keychain, refreshed
* transparently, and **never** exposed to the AI layer.
*/
const log$10 = larkLogger("core/uat-client");
/**
* Guards against concurrent refresh operations for the same user.
*
* refresh_token is single-use: if two requests trigger a refresh
* simultaneously, the second one would use an already-consumed token and
* fail.  The lock ensures only one refresh runs at a time per user.
*/
const refreshLocks = /* @__PURE__ */ new Map();
async function doRefreshToken(opts, stored) {
	if (Date.now() >= stored.refreshExpiresAt) {
		log$10.info(`refresh_token expired for ${opts.userOpenId}, clearing`);
		await removeStoredToken(opts.appId, opts.userOpenId);
		return null;
	}
	const endpoints = resolveOAuthEndpoints(opts.domain);
	const requestBody = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: stored.refreshToken,
		client_id: opts.appId,
		client_secret: opts.appSecret
	}).toString();
	const callEndpoint = async () => {
		return await (await feishuFetch(endpoints.token, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: requestBody
		})).json();
	};
	let data = await callEndpoint();
	const code = data.code;
	const error = data.error;
	if (code !== void 0 && code !== 0 || error) {
		const errCode = code ?? error;
		if (REFRESH_TOKEN_RETRYABLE.has(code)) {
			log$10.warn(`refresh transient error (code=${errCode}) for ${opts.userOpenId}, retrying once`);
			data = await callEndpoint();
			const retryCode = data.code;
			const retryError = data.error;
			if (retryCode !== void 0 && retryCode !== 0 || retryError) {
				const retryErrCode = retryCode ?? retryError;
				log$10.warn(`refresh failed after retry (code=${retryErrCode}), clearing token for ${opts.userOpenId}`);
				await removeStoredToken(opts.appId, opts.userOpenId);
				return null;
			}
		} else {
			log$10.warn(`refresh failed (code=${errCode}), clearing token for ${opts.userOpenId}`);
			await removeStoredToken(opts.appId, opts.userOpenId);
			return null;
		}
	}
	if (!data.access_token) throw new Error("Token refresh returned no access_token");
	const now = Date.now();
	const updated = {
		userOpenId: stored.userOpenId,
		appId: opts.appId,
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? stored.refreshToken,
		expiresAt: now + (data.expires_in ?? 7200) * 1e3,
		refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1e3 : stored.refreshExpiresAt,
		scope: data.scope ?? stored.scope,
		grantedAt: stored.grantedAt
	};
	await setStoredToken(updated);
	log$10.info(`refreshed UAT for ${opts.userOpenId} (at:${maskToken(updated.accessToken)})`);
	return updated;
}
/**
* Refresh with per-user locking.
*/
async function refreshWithLock(opts, stored) {
	const key = `${opts.appId}:${opts.userOpenId}`;
	const existing = refreshLocks.get(key);
	if (existing) {
		await existing;
		return getStoredToken(opts.appId, opts.userOpenId);
	}
	const promise = doRefreshToken(opts, stored);
	refreshLocks.set(key, promise);
	try {
		return await promise;
	} finally {
		refreshLocks.delete(key);
	}
}
/**
* Obtain a valid access_token for the given user.
*
* - Reads from Keychain.
* - Refreshes proactively if the token is about to expire.
* - Throws when no token exists or refresh fails irrecoverably.
*
* **The returned token must never be exposed to the AI layer.**
*/
async function getValidAccessToken(opts) {
	const stored = await getStoredToken(opts.appId, opts.userOpenId);
	if (!stored) throw new NeedAuthorizationError(opts.userOpenId);
	const status = tokenStatus(stored);
	if (status === "valid") return stored.accessToken;
	if (status === "needs_refresh") {
		const refreshed = await refreshWithLock(opts, stored);
		if (!refreshed) throw new NeedAuthorizationError(opts.userOpenId);
		return refreshed.accessToken;
	}
	await removeStoredToken(opts.appId, opts.userOpenId);
	throw new NeedAuthorizationError(opts.userOpenId);
}
/**
* Execute an API call with a valid UAT, retrying once on token-expiry errors.
*/
async function callWithUAT(opts, apiCall) {
	const accessToken = await getValidAccessToken(opts);
	try {
		return await apiCall(accessToken);
	} catch (err) {
		const code = err?.code ?? err?.response?.data?.code;
		if (TOKEN_RETRY_CODES.has(code)) {
			log$10.warn(`API call failed (code=${code}), refreshing and retrying`);
			const stored = await getStoredToken(opts.appId, opts.userOpenId);
			if (!stored) throw new NeedAuthorizationError(opts.userOpenId);
			const refreshed = await refreshWithLock(opts, stored);
			if (!refreshed) throw new NeedAuthorizationError(opts.userOpenId);
			return await apiCall(refreshed.accessToken);
		}
		throw err;
	}
}
/**
* Revoke a user's UAT by removing it from the Keychain.
*/
async function revokeUAT(appId, userOpenId) {
	await removeStoredToken(appId, userOpenId);
	log$10.info(`revoked UAT for ${userOpenId}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/core/app-scope-checker.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* App Scope Checker — 查询应用已开通的 scope 列表。
*
* 通过 `GET /open-apis/application/v6/applications/:app_id` (TAT) 获取
* 应用信息，从 `app.scopes` 中提取已开通的 scope 字符串列表。
*
* 结果带 30 秒内存缓存，避免每次 invoke() 都调远程 API。
* scope 检查失败后可调 {@link invalidateAppScopeCache} 清缓存重查。
*/
const log$9 = larkLogger("core/app-scope-checker");
const cache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 30 * 1e3;
/** 清除指定 appId 的缓存。 */
function invalidateAppScopeCache(appId) {
	cache.delete(appId);
}
/**
* 获取应用已开通的 scope 列表。
*
* 需要应用自身有 `application:application:self_manage` 权限。
* `appId` 可传 `"me"` 查自己。
*
* @param sdk - Lark SDK 实例
* @param appId - 应用 ID
* @param tokenType - token 类型，用于过滤只支持特定 token 类型的 scope
* @returns scope 字符串数组，如 `["calendar:calendar", "task:task:write"]`
*/
async function getAppGrantedScopes(sdk, appId, tokenType) {
	const cached = cache.get(appId);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rawScopes.filter((s) => {
		if (tokenType && s.token_types && Array.isArray(s.token_types)) return s.token_types.includes(tokenType);
		return true;
	}).map((s) => s.scope);
	try {
		const res = await sdk.request({
			method: "GET",
			url: `/open-apis/application/v6/applications/${appId}`,
			params: { lang: "zh_cn" }
		});
		if (res.code !== 0) throw new AppScopeCheckFailedError(appId);
		const app = res.data?.app ?? res.app ?? res.data;
		const validScopes = (app?.scopes ?? app?.online_version?.scopes ?? []).filter((s) => typeof s.scope === "string" && s.scope.length > 0).map((s) => ({
			scope: s.scope,
			token_types: s.token_types
		}));
		cache.set(appId, {
			rawScopes: validScopes,
			rawApp: app,
			fetchedAt: Date.now()
		});
		log$9.info(`fetched ${validScopes.length} scopes for app ${appId}`);
		const scopes = validScopes.filter((s) => {
			if (tokenType && s.token_types && Array.isArray(s.token_types)) return s.token_types.includes(tokenType);
			return true;
		}).map((s) => s.scope);
		log$9.info(`returning ${scopes.length} scopes${tokenType ? ` for ${tokenType} token` : ""}`);
		return scopes;
	} catch (err) {
		if (err instanceof AppScopeCheckFailedError) throw err;
		const statusCode = err?.response?.status || err?.status || err?.statusCode;
		if (statusCode === 400 || statusCode === 403 || err instanceof Error && (err.message.includes("status code 400") || err.message.includes("status code 403"))) throw new AppScopeCheckFailedError(appId);
		log$9.warn(`failed to fetch scopes for ${appId}: ${err instanceof Error ? err.message : err}`);
		return [];
	}
}
/**
* 获取应用信息，包括 owner 信息。
*
* 复用 getAppGrantedScopes 的 API 调用和缓存。
* 如果缓存中已有数据且未过期，直接从缓存提取。
*
* @param sdk - Lark SDK 实例
* @param appId - 应用 ID（可传 "me"）
*/
async function getAppInfo(sdk, appId) {
	await getAppGrantedScopes(sdk, appId);
	const cached = cache.get(appId);
	const rawApp = cached?.rawApp;
	const owner = rawApp?.owner;
	const creatorId = rawApp?.creator_id;
	const effectiveOwnerOpenId = (owner?.owner_type ?? owner?.type) === 2 && owner?.owner_id ? owner.owner_id : creatorId ?? owner?.owner_id;
	return {
		appId,
		creatorId,
		ownerOpenId: owner?.owner_id,
		ownerType: owner?.owner_type,
		effectiveOwnerOpenId,
		scopes: cached?.rawScopes ?? []
	};
}
/**
* 计算 APP 已有 ∩ OAPI 需要 的交集。
*
* 用于传给 OAuth 的 scope 参数 — 只请求 APP 已开通且 API 需要的 scope。
*
* @param appGranted - 应用已开通的 scope 列表
* @param apiRequired - OAPI 要求的 scope 列表
* @returns 交集 scope 列表
*/
function intersectScopes(appGranted, apiRequired) {
	const grantedSet = new Set(appGranted);
	return apiRequired.filter((s) => grantedSet.has(s));
}
/**
* 计算 OAPI 需要但 APP 未开通的 scope（差集）。
*
* 用于 AppScopeMissingError 的 missingScopes。
*
* @param appGranted - 应用已开通的 scope 列表
* @param apiRequired - OAPI 要求的 scope 列表
* @returns 缺失的 scope 列表
*/
function missingScopes(appGranted, apiRequired) {
	const grantedSet = new Set(appGranted);
	return apiRequired.filter((s) => !grantedSet.has(s));
}
/**
* 校验应用已开通的 scope 是否满足要求。
*
* 与 tool-client.ts invoke() 的 scope 校验逻辑完全一致，作为唯一真值来源：
*   - `scopeNeedType === "all"`: appScopes 必须包含 requiredScopes 的全部项
*   - 其他（默认 "one"）:        appScopes 与 requiredScopes 的交集非空即可
*   - appScopes 为空:            视为满足（API 查询失败，退回服务端判断）
*
* @param appScopes      - 应用已开通的 scope 列表（由 getAppGrantedScopes 返回）
* @param requiredScopes - 需要的 scope 列表
* @param scopeNeedType  - "all" 表示全部必须，undefined/"one" 表示任一即可
*/
function isAppScopeSatisfied(appScopes, requiredScopes, scopeNeedType) {
	if (appScopes.length === 0) return true;
	if (requiredScopes.length === 0) return true;
	if (scopeNeedType === "all") return missingScopes(appScopes, requiredScopes).length === 0;
	return intersectScopes(appScopes, requiredScopes).length > 0;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/app-owner-fallback.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 应用所有者查询 — 复用 app-scope-checker 的 API 调用和统一 owner 定义。
*
* 所有 owner 判定统一使用 {@link getAppInfo} 返回的 `effectiveOwnerOpenId`。
* 不维护独立缓存，完全依赖 app-scope-checker 的 30s 缓存。
*/
const log$8 = larkLogger("core/app-owner-fallback");
/**
* 获取应用的 effectiveOwnerOpenId。
*
* 复用 app-scope-checker 的 API 调用、缓存和统一 owner 定义（effectiveOwnerOpenId）。
* 查询失败时返回 undefined（fail-open）。
*
* @param account - 已配置的飞书账号信息
* @param sdk - 飞书 SDK 实例（必须已初始化 TAT）
* @returns 应用所有者的 open_id，如果查询失败则返回 undefined
*/
async function getAppOwnerFallback(account, sdk) {
	const { appId } = account;
	try {
		return (await getAppInfo(sdk, appId)).effectiveOwnerOpenId;
	} catch (err) {
		log$8.warn(`failed to get owner for ${appId}: ${err instanceof Error ? err.message : err}`);
		return;
	}
}
//#endregion
//#region vendor/openclaw-lark/dist/core/tool-scopes.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Tool Scopes 配置
*
* 定义所有工具动作所需的飞书权限映射。
*
* ## 维护方式
*
* ⚠️ 此文件采用**手动维护**，新增或修改工具时需同步更新。
*
* ### 新增工具动作
*
* 1. 在 `ToolActionKey` 类型中添加新键：
*    ```typescript
*    export type ToolActionKey =
*      | "feishu_calendar_event.create"
*      | "feishu_new_tool.action"  // 新增
*    ```
*
* 2. 在 `TOOL_SCOPES` 对象中添加对应配置：
*    ```typescript
*    export const TOOL_SCOPES: ToolScopeMapping = {
*      "feishu_new_tool.action": [
*        "required:scope:here"
*      ],
*    };
*    ```
*
* 3. 运行 TypeScript 类型检查验证一致性：
*    ```bash
*    cd openclaw/feishu && npx tsc --noEmit
*    ```
*
* ### 如何确定所需 Scope
*
* 1. **查阅飞书开放平台 API 文档**：https://open.feishu.cn/document
* 2. **使用 feishu-oapi-search skill**：在 Claude Code 中搜索 API 文档
* 3. **参考类似工具**：查看功能相近的工具的 scope 配置
* 4. **实际测试**：观察 API 调用的错误码（LARK_ERROR.APP_SCOPE_MISSING/99991672=应用缺权限，LARK_ERROR.USER_SCOPE_INSUFFICIENT/99991679=用户缺授权）
*
* 最后更新: 2026-03-03
*/
/**
* Tool Scope 数据
*
* 每个工具动作所需的飞书权限列表（Required Scopes）
*
* ## 数据说明
*
* - 空数组 `[]` 表示该工具动作不需要任何权限
* - 多个权限表示需要同时拥有所有权限（AND 关系）
* - 所有 scope 都是 user scopes（用户级权限）
*
* ## 示例
*
* ```typescript
* TOOL_SCOPES["feishu_calendar_event.create"]
* // 返回: ["calendar:calendar.event:create", "calendar:calendar.event:update"]
* ```
*
* @see {@link ToolActionKey} 所有可用的工具动作键
*/
const TOOL_SCOPES = {
	"feishu_bitable_app.create": ["base:app:create"],
	"feishu_bitable_app.get": ["base:app:read"],
	"feishu_bitable_app.list": ["space:document:retrieve"],
	"feishu_bitable_app.patch": ["base:app:update"],
	"feishu_bitable_app.copy": ["base:app:copy"],
	"feishu_bitable_app_table.create": ["base:table:create"],
	"feishu_bitable_app_table.list": ["base:table:read"],
	"feishu_bitable_app_table.patch": ["base:table:update"],
	"feishu_bitable_app_table.batch_create": ["base:table:create"],
	"feishu_bitable_app_table_record.create": ["base:record:create"],
	"feishu_bitable_app_table_record.update": ["base:record:update"],
	"feishu_bitable_app_table_record.delete": ["base:record:delete"],
	"feishu_bitable_app_table_record.batch_create": ["base:record:create"],
	"feishu_bitable_app_table_record.batch_update": ["base:record:update"],
	"feishu_bitable_app_table_record.batch_delete": ["base:record:delete"],
	"feishu_bitable_app_table_record.list": ["base:record:retrieve"],
	"feishu_bitable_app_table_field.create": ["base:field:create"],
	"feishu_bitable_app_table_field.list": ["base:field:read"],
	"feishu_bitable_app_table_field.update": ["base:field:read", "base:field:update"],
	"feishu_bitable_app_table_field.delete": ["base:field:delete"],
	"feishu_bitable_app_table_view.create": ["base:view:write_only"],
	"feishu_bitable_app_table_view.get": ["base:view:read"],
	"feishu_bitable_app_table_view.list": ["base:view:read"],
	"feishu_bitable_app_table_view.patch": ["base:view:write_only"],
	"feishu_calendar_calendar.list": ["calendar:calendar:read"],
	"feishu_calendar_calendar.get": ["calendar:calendar:read"],
	"feishu_calendar_calendar.primary": ["calendar:calendar:read"],
	"feishu_calendar_event.create": ["calendar:calendar.event:create", "calendar:calendar.event:update"],
	"feishu_calendar_event.list": ["calendar:calendar.event:read"],
	"feishu_calendar_event.get": ["calendar:calendar.event:read"],
	"feishu_calendar_event.patch": ["calendar:calendar.event:update"],
	"feishu_calendar_event.delete": ["calendar:calendar.event:delete"],
	"feishu_calendar_event.search": ["calendar:calendar.event:read"],
	"feishu_calendar_event.reply": ["calendar:calendar.event:reply"],
	"feishu_calendar_event.instances": ["calendar:calendar.event:read"],
	"feishu_calendar_event.instance_view": ["calendar:calendar.event:read"],
	"feishu_calendar_event_attendee.create": ["calendar:calendar.event:update"],
	"feishu_calendar_event_attendee.list": ["calendar:calendar.event:read"],
	"feishu_calendar_freebusy.list": ["calendar:calendar.free_busy:read"],
	"feishu_task_attachment.upload": ["task:attachment:write"],
	"feishu_task_task.create": ["task:task:write", "task:task:writeonly"],
	"feishu_task_task.get": ["task:task:read", "task:task:write"],
	"feishu_task_task.list": ["task:task:read", "task:task:write"],
	"feishu_task_task.patch": ["task:task:write", "task:task:writeonly"],
	"feishu_task_task.add_members": ["task:task:write", "task:task:writeonly"],
	"feishu_task_task.append_steps": ["task:task:write", "task:task:writeonly"],
	"feishu_task_tasklist.create": ["task:tasklist:write"],
	"feishu_task_tasklist.get": ["task:tasklist:read", "task:tasklist:write"],
	"feishu_task_tasklist.list": ["task:tasklist:read", "task:tasklist:write"],
	"feishu_task_tasklist.tasks": ["task:tasklist:read", "task:tasklist:write"],
	"feishu_task_tasklist.patch": ["task:tasklist:write"],
	"feishu_task_tasklist.add_members": ["task:tasklist:write"],
	"feishu_task_comment.create": ["task:comment:write"],
	"feishu_task_comment.list": ["task:comment:read", "task:comment:write"],
	"feishu_task_comment.get": ["task:comment:read", "task:comment:write"],
	"feishu_task_section.create": ["task:task"],
	"feishu_task_section.get": ["task:task"],
	"feishu_task_section.list": ["task:task"],
	"feishu_task_section.patch": ["task:task"],
	"feishu_task_section.tasks": ["task:task"],
	"feishu_task_subtask.create": ["task:task:write"],
	"feishu_task_subtask.list": ["task:task:read", "task:task:write"],
	"feishu_task_agent.register": ["task:task:write"],
	"feishu_task_agent.update_profile": ["task:task:write", "task:task:writeonly"],
	"feishu_chat.search": ["im:chat:read"],
	"feishu_chat.get": ["im:chat:read"],
	"feishu_chat_members.default": ["im:chat.members:read"],
	"feishu_drive_file.list": ["space:document:retrieve"],
	"feishu_drive_file.get_meta": ["drive:drive.metadata:readonly"],
	"feishu_drive_file.copy": ["docs:document:copy"],
	"feishu_drive_file.move": ["space:document:move"],
	"feishu_drive_file.delete": ["space:document:delete"],
	"feishu_drive_file.upload": ["drive:file:upload"],
	"feishu_drive_file.download": ["drive:file:download"],
	"feishu_doc_media.download": ["board:whiteboard:node:read", "docs:document.media:download"],
	"feishu_doc_media.insert": ["docx:document:write_only", "docs:document.media:upload"],
	"feishu_doc_comments.list": ["wiki:node:read", "docs:document.comment:read"],
	"feishu_doc_comments.list_replies": ["wiki:node:read", "docs:document.comment:read"],
	"feishu_doc_comments.create": ["wiki:node:read", "docs:document.comment:create"],
	"feishu_doc_comments.reply": ["wiki:node:read", "docs:document.comment:create"],
	"feishu_doc_comments.patch": ["docs:document.comment:update"],
	"feishu_wiki_space.list": ["wiki:space:retrieve"],
	"feishu_wiki_space.get": ["wiki:space:read"],
	"feishu_wiki_space.create": ["wiki:space:write_only"],
	"feishu_wiki_space_node.list": ["wiki:node:retrieve"],
	"feishu_wiki_space_node.get": ["wiki:node:read"],
	"feishu_wiki_space_node.create": ["wiki:node:create"],
	"feishu_wiki_space_node.move": ["wiki:node:move"],
	"feishu_wiki_space_node.copy": ["wiki:node:copy"],
	"feishu_im_user_message.send": ["im:message", "im:message.send_as_user"],
	"feishu_im_user_message.reply": ["im:message", "im:message.send_as_user"],
	"feishu_im_user_fetch_resource.default": [
		"im:message.group_msg:get_as_user",
		"im:message.p2p_msg:get_as_user",
		"im:message:readonly"
	],
	"feishu_im_user_get_messages.default": [
		"im:chat:read",
		"im:message:readonly",
		"im:message.group_msg:get_as_user",
		"im:message.p2p_msg:get_as_user",
		"contact:contact.base:readonly",
		"contact:user.base:readonly"
	],
	"feishu_im_user_search_messages.default": [
		"im:chat:read",
		"im:message:readonly",
		"im:message.group_msg:get_as_user",
		"im:message.p2p_msg:get_as_user",
		"contact:contact.base:readonly",
		"contact:user.base:readonly",
		"search:message"
	],
	"feishu_search_doc_wiki.search": ["search:docs:read"],
	"feishu_get_user.basic_batch": ["contact:user.basic_profile:readonly"],
	"feishu_get_user.default": ["contact:contact.base:readonly", "contact:user.base:readonly"],
	"feishu_search_user.default": ["contact:user:search"],
	"feishu_create_doc.default": [
		"board:whiteboard:node:create",
		"docx:document:create",
		"docx:document:readonly",
		"docx:document:write_only",
		"wiki:node:create",
		"wiki:node:read",
		"docs:document.media:upload"
	],
	"feishu_fetch_doc.default": ["docx:document:readonly", "wiki:node:read"],
	"feishu_update_doc.default": [
		"board:whiteboard:node:create",
		"docx:document:create",
		"docx:document:readonly",
		"docx:document:write_only"
	],
	"feishu_sheet.info": ["sheets:spreadsheet.meta:read", "sheets:spreadsheet:read"],
	"feishu_sheet.read": ["sheets:spreadsheet.meta:read", "sheets:spreadsheet:read"],
	"feishu_sheet.write": [
		"sheets:spreadsheet.meta:read",
		"sheets:spreadsheet:read",
		"sheets:spreadsheet:create",
		"sheets:spreadsheet:write_only"
	],
	"feishu_sheet.append": [
		"sheets:spreadsheet.meta:read",
		"sheets:spreadsheet:read",
		"sheets:spreadsheet:create",
		"sheets:spreadsheet:write_only"
	],
	"feishu_sheet.find": ["sheets:spreadsheet.meta:read", "sheets:spreadsheet:read"],
	"feishu_sheet.create": [
		"sheets:spreadsheet.meta:read",
		"sheets:spreadsheet:read",
		"sheets:spreadsheet:create",
		"sheets:spreadsheet:write_only"
	],
	"feishu_sheet.export": ["docs:document:export"]
};
/**
* 高敏感权限清单
*
* 这些权限具有较高的敏感度，不应在批量授权时自动申请。
* 用户需要明确知晓这些权限的影响后，才能手动授权。
*
* 权限说明：
* - im:message.send_as_user - 以用户身份发送消息（高风险，可能被滥用发送钓鱼或垃圾消息）
* - space:document:delete - 删除云文档
* - calendar:calendar.event:delete - 删除日程
* - base:table:delete - 删除多维表格数据表
*
* 使用场景：
* - 批量授权时会自动过滤掉这些权限
* - 需要这些权限的功能会单独提示用户授权
*
* 最后更新: 2026-03-17
*/
const SENSITIVE_SCOPES = [
	"im:message.send_as_user",
	"space:document:delete",
	"calendar:calendar.event:delete",
	"base:table:delete"
];
/**
* 过滤掉高敏感权限
*
* 用于批量授权时排除高敏感权限，这些权限需要用户明确授权。
*
* @param scopes - 原始权限列表
* @returns 过滤后的权限列表（不包含高敏感权限）
*
* @example
* ```typescript
* const allScopes = ["im:message", "im:message.send_as_user", "calendar:calendar:read"];
* const safeScopes = filterSensitiveScopes(allScopes);
* // 返回: ["im:message", "calendar:calendar:read"]
* ```
*/
function filterSensitiveScopes(scopes) {
	const sensitiveSet = new Set(SENSITIVE_SCOPES);
	return scopes.filter((scope) => !sensitiveSet.has(scope));
}
/**
* 工具动作总数: 96
* 唯一 scope 总数: 74
* 必需应用权限总数: 20
* 高敏感权限总数: 4
*/
//#endregion
//#region vendor/openclaw-lark/dist/core/scope-manager.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Scope 管理模块
*
* 为所有工具动作提供类型安全的 scope 查询和检查功能。
*
* ## 三个核心概念
*
* ### 1. Required Scopes（API 需要的权限）
* - 定义：每个 API 调用所需的飞书权限列表
* - 来源：tool-scopes.ts（手动维护的类型化配置）
* - 示例：`["calendar:calendar.event:create", "calendar:calendar.event:update"]`
* - 用途：判断应用和用户是否需要申请/授权权限
*
* ### 2. App Granted Scopes（应用已开通的权限）
* - 定义：应用在飞书开放平台配置并获得管理员批准的权限
* - 来源：通过 API 查询 `/open-apis/application/v6/applications`
* - 作用：应用级权限前置检查，避免无效的用户授权请求
* - 检查时机：在请求用户授权前
*
* ### 3. User Granted Scopes（用户授权的权限）
* - 定义：用户通过 OAuth 流程明确授权给应用的权限
* - 来源：OAuth token 中的 scope 字段
* - 作用：用户级权限检查，确保用户已授权所需权限
* - 检查时机：每次 API 调用前
*
* ## 权限检查流程
*
* ```
* 1. 获取 Required Scopes (API 需要什么权限？)
*    ↓
* 2. 检查 App Granted Scopes (应用开通了吗？)
*    ↓ 是
* 3. 检查 User Granted Scopes (用户授权了吗？)
*    ↓ 是
* 4. 调用 API
* ```
*/
/**
* 获取单个工具动作所需的 scopes（Required Scopes）
*
* @param toolAction - 工具动作键（例如 "feishu_calendar_event.create"）
* @returns API 需要的 scope 字符串数组
*
* @example
* ```ts
* const requiredScopes = getRequiredScopes("feishu_calendar_event.create");
* // 返回: ["calendar:calendar.event:create", "calendar:calendar.event:update"]
* ```
*/
function getRequiredScopes(toolAction) {
	return TOOL_SCOPES[toolAction] ?? [];
}
//#endregion
//#region vendor/openclaw-lark/dist/core/raw-request.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* raw-request.ts — 飞书 Open API 裸 HTTP 请求工具。
*
* 从 tool-client.ts 提取，提供不依赖 SDK 的直接 API 调用能力。
* 用于 SDK 未覆盖的 API 或需要精细控制请求的场景。
*/
/** 将 LarkBrand 映射为 API base URL。 */
function resolveDomainUrl(brand) {
	return {
		feishu: "https://open.feishu.cn",
		lark: "https://open.larksuite.com"
	}[brand] ?? `https://${brand}`;
}
function isFormDataBody(body) {
	return typeof body === "object" && body !== null && typeof body.append === "function" && typeof body.entries === "function";
}
function isBinaryBody(body) {
	return body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}
function buildRequestBody(body) {
	if (typeof body === "string" || body instanceof URLSearchParams$1 || isFormDataBody(body) || isBinaryBody(body)) return { body };
	return {
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	};
}
/**
* 发起 raw HTTP 请求到飞书 API，自动处理域名解析、header 注入和错误检测。
*
* 飞书 API 统一错误模式：返回 JSON 中 `code !== 0` 表示失败。
*/
async function rawLarkRequest(options) {
	const baseUrl = resolveDomainUrl(options.brand);
	const url = new URL(options.path, baseUrl);
	if (options.query) for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
	const headers = {};
	let requestBody;
	if (options.accessToken) headers["Authorization"] = `Bearer ${options.accessToken}`;
	if (options.body !== void 0) {
		const prepared = buildRequestBody(options.body);
		requestBody = prepared.body;
		if (prepared.headers) Object.assign(headers, prepared.headers);
	}
	if (options.headers) Object.assign(headers, options.headers);
	const data = await (await feishuFetch(url.toString(), {
		method: options.method ?? "GET",
		headers,
		...requestBody !== void 0 ? { body: requestBody } : {}
	})).json();
	if (data.code !== void 0 && data.code !== 0) {
		const err = new Error(data.msg ?? `Lark API error: code=${data.code}`);
		err.code = data.code;
		err.msg = data.msg;
		throw err;
	}
	return data;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/tool-client.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* ToolClient — 工具层统一客户端。
*
* 专为 `src/tools/` 下的工具设计，封装 account 解析、SDK 管理、
* TAT/UAT 自动切换和 scope 预检。工具代码只需声明 API 名称和调用逻辑，
* 身份选择/scope 校验/token 管理全部由 `invoke()` 内聚处理。
*
* 用法：
* ```typescript
* const client = createToolClient(config);
*
* // UAT 调用 — 通过 { as: "user" } 指定用户身份
* const res = await client.invoke(
*   "calendar.v4.calendarEvent.create",
*   (sdk, opts) => sdk.calendar.calendarEvent.create(payload, opts),
*   { as: "user" },
* );
*
* // TAT 调用 — 默认走应用身份
* const res = await client.invoke(
*   "calendar.v4.calendar.list",
*   (sdk) => sdk.calendar.calendar.list(payload),
*   { as: "tenant" },
* );
* ```
*/
const tcLog = larkLogger("core/tool-client");
var ToolClient = class {
	config;
	/** 当前解析的账号信息（appId、appSecret 保证存在）。 */
	account;
	/** 当前请求的用户 open_id（来自 LarkTicket，可能为 undefined）。 */
	senderOpenId;
	/** Lark SDK 实例（TAT 身份），直接调用即可。 */
	sdk;
	constructor(params) {
		this.account = params.account;
		this.senderOpenId = params.senderOpenId;
		this.sdk = params.sdk;
		this.config = params.config;
	}
	/**
	* 统一 API 调用入口。
	*
	* 自动处理：
	* - 根据 API meta 选择 UAT / TAT
	* - 严格模式：检查应用和用户是否拥有所有 API 要求的 scope
	* - 无 token 或 scope 不足时抛出结构化错误
	* - UAT 模式下复用 callWithUAT 的 refresh + retry
	*
	* @param apiName - meta.json 中的 toolName，如 `"calendar.v4.calendarEvent.create"`
	* @param fn - API 调用逻辑。UAT 时 opts 已注入 token，TAT 时 opts 为 undefined。
	* @param options - 可选配置：
	*   - `as`: 指定 UAT/TAT
	*   - `userOpenId`: 覆盖用户 ID
	*
	* @throws {@link AppScopeMissingError} 应用未开通 API 所需 scope
	* @throws {@link UserAuthRequiredError} 用户未授权或 scope 不足
	* @throws {@link UserScopeInsufficientError} 服务端报用户 scope 不足
	*
	* @example
	* // UAT 调用 — 通过 { as: "user" } 指定
	* const res = await client.invoke(
	*   "calendar.v4.calendarEvent.create",
	*   (sdk, opts) => sdk.calendar.calendarEvent.create(payload, opts),
	*   { as: "user" },
	* );
	*
	* @example
	* // TAT 调用
	* const res = await client.invoke(
	*   "calendar.v4.calendar.list",
	*   (sdk) => sdk.calendar.calendar.list(payload),
	*   { as: "tenant" },
	* );
	*
	*/
	async invoke(toolAction, fn, options) {
		return this._invokeInternal(toolAction, fn, options);
	}
	/**
	* 内部 invoke 实现，只支持 ToolActionKey（严格类型检查）
	*/
	async _invokeInternal(toolAction, fn, options) {
		const feishuEntry = this.config.plugins?.entries?.feishu;
		if (feishuEntry && feishuEntry.enabled !== false) throw new Error("❌ 检测到旧版插件未禁用。\n👉 请依次运行命令：\n```\nopenclaw config set plugins.entries.feishu.enabled false --json\nopenclaw gateway restart\n```");
		const requiredScopes = getRequiredScopes(toolAction);
		const tokenType = options?.as ?? "user";
		const appCheckScopes = tokenType === "user" ? [...new Set([...requiredScopes, "offline_access"])] : requiredScopes;
		let appScopeVerified = true;
		if (appCheckScopes.length > 0) {
			const appGrantedScopes = await getAppGrantedScopes(this.sdk, this.account.appId, tokenType);
			if (appGrantedScopes.length > 0) {
				const missingAppScopes = missingScopes(appGrantedScopes, appCheckScopes);
				if (missingAppScopes.length > 0) throw new AppScopeMissingError({
					apiName: toolAction,
					scopes: missingAppScopes,
					appId: this.account.appId
				}, "all", tokenType, requiredScopes);
			} else appScopeVerified = false;
		}
		if (tokenType === "tenant") return this.invokeAsTenant(toolAction, fn, requiredScopes);
		let userOpenId = options?.userOpenId ?? this.senderOpenId;
		if (!userOpenId) {
			const fallbackUserId = await getAppOwnerFallback(this.account, this.sdk);
			if (fallbackUserId) {
				userOpenId = fallbackUserId;
				tcLog.info(`Using app owner as fallback user`, {
					toolAction,
					appId: this.account.appId,
					ownerId: fallbackUserId
				});
			}
		}
		return this.invokeAsUser(toolAction, fn, requiredScopes, userOpenId, appScopeVerified);
	}
	/**
	* invoke() 的非抛出包装，适用于"允许失败"的子操作。
	*
	* - 成功 → `{ ok: true, data }`
	* - 用户授权错误（可通过 OAuth 恢复）→ `{ ok: false, authHint }`
	* - 应用权限缺失 / appScopeVerified=false → **仍然 throw**（需管理员操作）
	* - 其他错误 → `{ ok: false, error }`
	*/
	/**
	* 对 SDK 未覆盖的飞书 API 发起 raw HTTP 请求，同时复用 invoke() 的
	* auth/scope/refresh 全链路。
	*
	* @param apiName - 逻辑 API 名称（用于日志和错误信息），如 `"im.v1.chatP2p.batchQuery"`
	* @param path - API 路径（以 `/open-apis/` 开头），如 `"/open-apis/im/v1/chat_p2p/batch_query"`
	* @param options - HTTP 方法、body、query 及 InvokeOptions（as、userOpenId 等）
	*
	* @example
	* ```typescript
	* const res = await client.invokeByPath<{ data: { items: Array<{ chat_id: string }> } }>(
	*   "im.v1.chatP2p.batchQuery",
	*   "/open-apis/im/v1/chat_p2p/batch_query",
	*   {
	*     method: "POST",
	*     body: { chatter_ids: [openId] },
	*     as: "user",
	*   },
	* );
	* ```
	*/
	async invokeByPath(toolAction, path, options) {
		const fn = async (_sdk, _opts, uat) => {
			return this.rawRequest(path, {
				method: options?.method,
				body: options?.body,
				query: options?.query,
				headers: options?.headers,
				accessToken: uat
			});
		};
		return this._invokeInternal(toolAction, fn, options);
	}
	async invokeAsTenant(toolAction, fn, requiredScopes) {
		try {
			return await fn(this.sdk);
		} catch (err) {
			this.rethrowStructuredError(err, toolAction, requiredScopes, void 0, "tenant");
			throw err;
		}
	}
	async invokeAsUser(toolAction, fn, requiredScopes, userOpenId, appScopeVerified) {
		if (!userOpenId) throw new UserAuthRequiredError("unknown", {
			apiName: toolAction,
			scopes: requiredScopes,
			appScopeVerified,
			appId: this.account.appId
		});
		const stored = await getStoredToken(this.account.appId, userOpenId);
		if (!stored) throw new UserAuthRequiredError(userOpenId, {
			apiName: toolAction,
			scopes: requiredScopes,
			appScopeVerified,
			appId: this.account.appId
		});
		if (appScopeVerified && stored.scope && requiredScopes.length > 0) {
			const userGrantedScopes = new Set(stored.scope.split(/\s+/).filter(Boolean));
			const missingUserScopes = requiredScopes.filter((s) => !userGrantedScopes.has(s));
			if (missingUserScopes.length > 0) throw new UserAuthRequiredError(userOpenId, {
				apiName: toolAction,
				scopes: missingUserScopes,
				appScopeVerified,
				appId: this.account.appId
			});
		}
		try {
			return await callWithUAT({
				userOpenId,
				appId: this.account.appId,
				appSecret: this.account.appSecret,
				domain: this.account.brand
			}, (accessToken) => fn(this.sdk, Lark.withUserAccessToken(accessToken), accessToken));
		} catch (err) {
			if (err instanceof NeedAuthorizationError) throw new UserAuthRequiredError(userOpenId, {
				apiName: toolAction,
				scopes: requiredScopes,
				appScopeVerified
			});
			this.rethrowStructuredError(err, toolAction, requiredScopes, userOpenId, "user");
			throw err;
		}
	}
	/**
	* 发起 raw HTTP 请求到飞书 API，委托 rawLarkRequest 处理。
	*/
	async rawRequest(path, options) {
		return rawLarkRequest({
			brand: this.account.brand,
			path,
			...options
		});
	}
	/**
	* 识别飞书服务端错误码并转换为结构化错误。
	*
	* - LARK_ERROR.APP_SCOPE_MISSING (99991672) → AppScopeMissingError（清缓存后抛出）
	* - LARK_ERROR.USER_SCOPE_INSUFFICIENT (99991679) → UserScopeInsufficientError
	*/
	rethrowStructuredError(err, apiName, effectiveScopes, userOpenId, tokenType) {
		const code = err?.code ?? err?.response?.data?.code;
		if (code === LARK_ERROR.APP_SCOPE_MISSING) {
			invalidateAppScopeCache(this.account.appId);
			throw new AppScopeMissingError({
				apiName,
				scopes: effectiveScopes,
				appId: this.account.appId
			}, "all", tokenType);
		}
		if (code === LARK_ERROR.USER_SCOPE_INSUFFICIENT && userOpenId) throw new UserScopeInsufficientError(userOpenId, {
			apiName,
			scopes: effectiveScopes
		});
	}
};
/**
* 从配置创建 {@link ToolClient}。
*
* 自动从当前 {@link LarkTicket} 解析 accountId 和 senderOpenId。
* 如果 LarkTicket 不可用（如非消息场景），回退到 `accountIndex`
* 指定的账号。
*
* @param config - OpenClaw 配置对象
* @param accountIndex - 回退账号索引（默认 0）
*/
function createToolClient(config, accountIndex = 0) {
	const ticket = getTicket();
	const resolveConfig = getResolvedConfig(config);
	let account;
	if (ticket?.accountId) {
		const resolved = getLarkAccount(resolveConfig, ticket.accountId);
		if (!resolved.configured) throw new Error(`Feishu account "${ticket.accountId}" is not configured (missing appId or appSecret). Please check channels.feishu.accounts.${ticket.accountId} in your config.`);
		if (!resolved.enabled) throw new Error(`Feishu account "${ticket.accountId}" is disabled. Set channels.feishu.accounts.${ticket.accountId}.enabled to true, or remove it to use defaults.`);
		account = resolved;
	}
	if (!account) {
		const accounts = getEnabledLarkAccounts(resolveConfig);
		if (accounts.length === 0) throw new Error("No enabled Feishu accounts configured. Please add appId and appSecret in config under channels.feishu");
		if (accountIndex >= accounts.length) throw new Error(`Requested account index ${accountIndex} but only ${accounts.length} accounts available`);
		const fallback = accounts[accountIndex];
		if (!fallback.configured) throw new Error(`Account at index ${accountIndex} is not fully configured (missing appId or appSecret)`);
		account = fallback;
	}
	const larkClient = LarkClient.fromAccount(account);
	return new ToolClient({
		account,
		senderOpenId: ticket?.senderOpenId,
		sdk: larkClient.sdk,
		config
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/core/app-auth-url.js
/** Single source for one-click application permission requests. */
function appPermissionAuthUrl(appId, scopes, brand = "feishu", source = "feishu-openclaw") {
	const openDomain = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
	const unique = [...new Set(scopes.filter(Boolean))];
	return `${openDomain}/app/${appId}/auth?q=${encodeURIComponent(unique.join(","))}&op_from=${encodeURIComponent(source)}&token_type=user`;
}
//#endregion
//#region vendor/openclaw-lark/dist/card/card-error.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Unified card API error handling.
*
* Provides structured error class for CardKit API responses, sub-error
* parsing for the generic 230099 code, and helper predicates used by
* reply-dispatcher and streaming-card-controller.
*/
/** 卡片 API 级别错误码。 */
const CARD_ERROR = {
	/** 发送频率限制 */
	RATE_LIMITED: 230020,
	/** 卡片内容创建失败（通用码，需检查子错误） */
	CARD_CONTENT_FAILED: 230099
};
/** 230099 子错误码，嵌套在 msg 的 ErrCode 字段中。 */
const CARD_CONTENT_SUB_ERROR = { 
/** 卡片元素（表格等）数量超限 */
ELEMENT_LIMIT: 11310 };
/** CardKit API 返回非零 code 时的结构化错误。 */
var CardKitApiError = class extends Error {
	code;
	msg;
	constructor(params) {
		const { api, code, msg, context } = params;
		super(`cardkit ${api} FAILED: code=${code}, msg=${msg}, ${context}`);
		this.name = "CardKitApiError";
		this.code = code;
		this.msg = msg;
	}
};
/**
* 从 msg 字符串中提取子错误码。
*
* 示例输入: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: element exceeds the limit; code:230099"
* 返回 11310 或 null。
*/
function extractSubCode(msg) {
	const match = /ErrCode:\s*(\d+)/.exec(msg);
	if (!match) return null;
	const code = Number(match[1]);
	return Number.isFinite(code) ? code : null;
}
/**
* 从任意抛错对象中解析卡片 API 错误结构。
*
* 返回 { code, subCode, errMsg }，如果无法提取 code 则返回 null。
*/
function parseCardApiError(err) {
	const code = extractLarkApiCode(err);
	if (code === void 0) return null;
	let errMsg = "";
	if (err && typeof err === "object") {
		const e = err;
		if (typeof e.msg === "string") errMsg = e.msg;
		else if (typeof e.response?.data?.msg === "string") errMsg = e.response.data.msg;
		else if (typeof e.message === "string") errMsg = e.message;
	}
	return {
		code,
		subCode: extractSubCode(errMsg),
		errMsg
	};
}
/**
* 判断错误是否为卡片表格数量超限。
*
* 匹配条件：code 230099 + subCode 11310 + errMsg 含 "table number over limit"。
* 11310 是通用的元素超限码（也覆盖模板可见性、组件上限等），
* 必须同时检查 errMsg 确认是表格数量导致的。
*
* 实际错误格式（生产日志 2026-03-13）：
* "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; "
*/
function isCardTableLimitError(err) {
	const parsed = parseCardApiError(err);
	if (!parsed) return false;
	return parsed.code === CARD_ERROR.CARD_CONTENT_FAILED && parsed.subCode === CARD_CONTENT_SUB_ERROR.ELEMENT_LIMIT && /table number over limit/i.test(parsed.errMsg);
}
/** 判断错误是否为卡片发送频率限制（230020）。 */
function isCardRateLimitError(err) {
	const parsed = parseCardApiError(err);
	if (!parsed) return false;
	return parsed.code === CARD_ERROR.RATE_LIMITED;
}
/**
* 收集正文里可被飞书卡片实际渲染的 markdown 表格。
*
* 代码块里的示例表格不会被飞书解析成卡片表格元素，因此这里要先排除，
* 让 shouldUseCard() 预检和 sanitizeTextForCard() 降级逻辑使用同一份结果。
*/
function findMarkdownTablesOutsideCodeBlocks(text) {
	const codeBlockRanges = [];
	const codeBlockRegex = /```[\s\S]*?```/g;
	let codeBlockMatch = codeBlockRegex.exec(text);
	while (codeBlockMatch != null) {
		codeBlockRanges.push({
			start: codeBlockMatch.index,
			end: codeBlockMatch.index + codeBlockMatch[0].length
		});
		codeBlockMatch = codeBlockRegex.exec(text);
	}
	const isInsideCodeBlock = (idx) => codeBlockRanges.some((range) => idx >= range.start && idx < range.end);
	const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g;
	const matches = [];
	let tableMatch = tableRegex.exec(text);
	while (tableMatch != null) {
		if (!isInsideCodeBlock(tableMatch.index)) matches.push({
			index: tableMatch.index,
			length: tableMatch[0].length,
			raw: tableMatch[0]
		});
		tableMatch = tableRegex.exec(text);
	}
	return matches;
}
/**
* 对多段 markdown 文本共享一个表格预算。
*
* 段落按数组顺序消耗额度，适合处理“reasoning + 正文”这类会被飞书
* 作为同一张卡片渲染的多块文本。
*/
function sanitizeTextSegmentsForCard(texts, tableLimit = 3) {
	let remainingTableBudget = tableLimit;
	return texts.map((text) => {
		const matches = findMarkdownTablesOutsideCodeBlocks(text);
		if (matches.length <= remainingTableBudget) {
			remainingTableBudget -= matches.length;
			return text;
		}
		const sanitizedText = wrapTablesBeyondLimit(text, matches, Math.max(remainingTableBudget, 0));
		remainingTableBudget = 0;
		return sanitizedText;
	});
}
function wrapTablesBeyondLimit(text, matches, keepCount) {
	if (matches.length <= keepCount) return text;
	let result = text;
	for (let i = matches.length - 1; i >= keepCount; i--) {
		const { index, length, raw } = matches[i];
		const replacement = `\`\`\`\n${raw}\n\`\`\``;
		result = result.slice(0, index) + replacement + result.slice(index + length);
	}
	return result;
}
//#endregion
//#region vendor/openclaw-lark/dist/card/cardkit.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* CardKit streaming APIs for Lark/Feishu.
*/
const log$7 = larkLogger("card/cardkit");
/**
* 记录 CardKit API 响应日志，检测错误码并抛出异常。
*
* 默认 fail-fast：body-level 非零 code 视为业务错误，立即抛出，
* 由调用方（streaming-card-controller 等）统一走 catch → guard 处理。
*/
function logCardKitResponse(params) {
	const { resp, api, context } = params;
	const { code, msg } = resp;
	log$7.info(`cardkit ${api} response`, {
		code,
		msg,
		context
	});
	if (code && code !== 0) {
		log$7.warn(`cardkit ${api} FAILED`, {
			code,
			msg,
			context,
			fullResponse: resp
		});
		throw new CardKitApiError({
			api,
			code,
			msg: msg ?? "",
			context
		});
	}
}
/**
* Create a card entity via the CardKit API.
*
* Returns the card_id directly, bypassing the idConvert step.
* The card can then be sent via IM API and streamed via CardKit.
*/
async function createCardEntity(params) {
	const { cfg, card, accountId } = params;
	const response = await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.card.create({ data: {
		type: "card_json",
		data: JSON.stringify(card)
	} });
	const cardId = response.data?.card_id ?? response.card_id ?? null;
	logCardKitResponse({
		resp: response,
		api: "card.create",
		context: `cardId=${cardId}`
	});
	return cardId;
}
/**
* Stream text content to a specific card element using the CardKit API.
*
* The card automatically diffs the new content against the previous
* content and renders incremental changes with a typewriter animation.
*
* @param params.cardId    - CardKit card ID (from `convertMessageToCardId`).
* @param params.elementId - The element ID to update (e.g. `STREAMING_ELEMENT_ID`).
* @param params.content   - The full cumulative text (not a delta).
* @param params.sequence  - Monotonically increasing sequence number.
*/
async function streamCardContent(params) {
	const { cfg, cardId, elementId, content, sequence, accountId } = params;
	logCardKitResponse({
		resp: await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.cardElement.content({
			data: {
				content,
				sequence
			},
			path: {
				card_id: cardId,
				element_id: elementId
			}
		}),
		api: "cardElement.content",
		context: `seq=${sequence}, contentLen=${content.length}`
	});
}
/**
* Fully replace a card using the CardKit API.
*
* Used for the final "complete" state update (with action buttons, green
* header, etc.) after streaming finishes.
*
* @param params.cardId   - CardKit card ID.
* @param params.card     - The new card JSON content.
* @param params.sequence - Monotonically increasing sequence number.
*/
async function updateCardKitCard(params) {
	const { cfg, cardId, card, sequence, accountId } = params;
	logCardKitResponse({
		resp: await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.card.update({
			data: {
				card: {
					type: "card_json",
					data: JSON.stringify(card)
				},
				sequence
			},
			path: { card_id: cardId }
		}),
		api: "card.update",
		context: `seq=${sequence}, cardId=${cardId}`
	});
}
async function updateCardKitCardForAuth(params) {
	return updateCardKitCard(params);
}
/**
* Send an interactive card message by referencing a CardKit card_id.
*
* The content format is: {"type":"card","data":{"card_id":"xxx"}}
* This links the IM message to the CardKit card entity, enabling
* streaming updates via cardElement.content().
*/
async function sendCardByCardId(params) {
	const { cfg, to, cardId, replyToMessageId, replyInThread, accountId } = params;
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	const contentPayload = JSON.stringify({
		type: "card",
		data: { card_id: cardId }
	});
	if (replyToMessageId) {
		const normalizedId = normalizeMessageId(replyToMessageId);
		const response = await runWithMessageUnavailableGuard({
			messageId: normalizedId,
			operation: "im.message.reply(interactive.cardkit)",
			fn: () => client.im.message.reply({
				path: { message_id: normalizedId },
				data: {
					content: contentPayload,
					msg_type: "interactive",
					reply_in_thread: replyInThread
				}
			})
		});
		return {
			messageId: response?.data?.message_id ?? "",
			chatId: response?.data?.chat_id ?? ""
		};
	}
	const target = normalizeFeishuTarget(to);
	if (!target) throw new Error(`[feishu-send] Invalid target: "${to}"`);
	const receiveIdType = resolveReceiveIdType(target);
	const response = await client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: target,
			msg_type: "interactive",
			content: contentPayload
		}
	});
	return {
		messageId: response?.data?.message_id ?? "",
		chatId: response?.data?.chat_id ?? ""
	};
}
/**
* Close (or open) the streaming mode on a CardKit card.
*
* Must be called after streaming is complete to restore normal card
* behaviour (forwarding, interaction callbacks, etc.).
*/
async function setCardStreamingMode(params) {
	const { cfg, cardId, streamingMode, sequence, accountId } = params;
	logCardKitResponse({
		resp: await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.card.settings({
			data: {
				settings: JSON.stringify({ streaming_mode: streamingMode }),
				sequence
			},
			path: { card_id: cardId }
		}),
		api: "card.settings",
		context: `seq=${sequence}, streaming_mode=${streamingMode}`
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/core/owner-policy.js
/**
* 非应用 owner 尝试执行 owner-only 操作时抛出。
*
* 注意：`appOwnerId` 仅用于内部日志，不应序列化到用户可见的响应中，
* 以避免泄露 owner 的 open_id。
*/
var OwnerAccessDeniedError = class extends Error {
	userOpenId;
	appOwnerId;
	constructor(userOpenId, appOwnerId) {
		super("Permission denied: Only the app owner is authorized to use this feature.");
		this.name = "OwnerAccessDeniedError";
		this.userOpenId = userOpenId;
		this.appOwnerId = appOwnerId;
	}
};
function getInboundHandler() {
	throw new Error("Feishu inbound handler has not been initialised.");
}
//#endregion
//#region vendor/openclaw-lark/dist/messaging/inbound/synthetic-message.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared helper for dispatching synthetic inbound text messages.
*
* Synthetic messages are used to resume the normal inbound pipeline after
* card actions or OAuth flows complete.
*/
async function dispatchSyntheticTextMessage(params) {
	const handleFeishuMessage = getInboundHandler();
	const { cfg, accountId, chatId, senderOpenId, text, syntheticMessageId, replyToMessageId, chatType, threadId, runtime, forceMention = true, cardActionGate } = params;
	const syntheticEvent = {
		sender: { sender_id: { open_id: senderOpenId } },
		message: {
			message_id: syntheticMessageId,
			chat_id: chatId,
			chat_type: chatType ?? "p2p",
			message_type: "text",
			content: JSON.stringify({ text }),
			thread_id: threadId
		}
	};
	const { status, promise } = enqueueFeishuChatTask({
		accountId,
		chatId,
		threadId,
		task: async () => {
			await withTicket({
				messageId: syntheticMessageId,
				chatId,
				accountId,
				startTime: Date.now(),
				senderOpenId,
				chatType,
				threadId
			}, () => handleFeishuMessage({
				cfg,
				event: syntheticEvent,
				accountId,
				forceMention,
				cardActionGate,
				runtime,
				replyToMessageId
			}));
		}
	});
	await promise;
	return status;
}
//#endregion
//#region vendor/openclaw-lark/dist/core/domains.js
/** Applink 域名 */
function applinkDomain(brand) {
	return brand === "lark" ? "https://applink.larksuite.com" : "https://applink.feishu.cn";
}
/** 主站域名 (文档、表格等用户可见链接) */
function wwwDomain(brand) {
	return brand === "lark" ? "https://www.larksuite.com" : "https://www.feishu.cn";
}
/** MCP 服务域名 */
function mcpDomain(brand) {
	return brand === "lark" ? "https://mcp.larksuite.com" : "https://mcp.feishu.cn";
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oauth-cards.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* oauth-cards.ts — OAuth 授权卡片构建函数。
*
* 从 oauth.ts 提取的纯 UI 函数，与 OAuth 业务流程解耦。
* 卡片使用 v2 JSON 结构 + i18n_content 支持多语言。
*/
/** v2 卡片 i18n 配置，注入到 config 中 */
const I18N_CONFIG$1 = {
	update_multi: true,
	locales: ["zh_cn", "en_us"]
};
const CARD_TEXTS = {
	zh_cn: {
		authRequired: "请授权以继续当前操作",
		goAuth: "前往授权",
		expiresHint: (min) => `<font color='grey'>授权链接将在 ${min} 分钟后失效，届时需重新发起</font>`,
		batchAuthHint: "<font color='grey'>💡如果你希望一次性授予所有插件所需要的权限，可以告诉我「授予所有用户权限」，我会协助你完成。</font>",
		batchScopeMsg: (count, total, granted) => `应用需要授权 **${count}** 个用户权限（共 ${total} 个，已授权 ${granted} 个）。`,
		scopePreviewLabel: "**将要授权的权限**",
		scopeListLabel: "**将要授权的权限列表**",
		scopeDesc: "授权后，应用将能够以你的身份执行相关操作。",
		requiredScopes: "所需权限：",
		authSuccess: "授权成功",
		authSuccessBody: (brandName) => `你的${brandName}账号已成功授权，正在为你继续执行操作。\n\n<font color='grey'>如需撤销授权，可随时告诉我。</font>`,
		authIncomplete: "授权未完成",
		authExpiredBody: "授权链接已过期，请重新发起授权。",
		authMismatchTitle: "授权失败，操作账号与发起账号不一致",
		authMismatchBody: (brandName) => `检测到当前进行授权操作的${brandName}账号与发起授权请求的账号不一致。为保障数据安全，本次授权已被拒绝。\n\n<font color='grey'>请授权请求的发起人使用其账号，点击授权链接完成授权。</font>`
	},
	en_us: {
		authRequired: "Authorize to continue",
		goAuth: "Authorize Now",
		expiresHint: (min) => `<font color='grey'>This link will time out in ${min} minutes, so you'll need a new one if it expires.</font>`,
		batchAuthHint: "<font color='grey'>💡 If you'd like to grant all permissions at once, just say \"Authorize all\", and I'll take care of it.</font>",
		batchScopeMsg: (count, total, granted) => `The app requires ${count} additional user token permissions (${granted} of ${total} granted).`,
		scopePreviewLabel: "**Permissions to authorize**",
		scopeListLabel: "**Permissions to authorize**",
		scopeDesc: "Once authorized, the app can perform actions on your behalf.",
		requiredScopes: "Required permissions:",
		authSuccess: "Authorized",
		authSuccessBody: (brandName) => `${brandName} account authorized. Continuing with your request.\n\n<font color='grey'>Let me know if you ever need to revoke the permissions.</font>`,
		authIncomplete: "Authorization incomplete",
		authExpiredBody: "The link is no longer active. Please restart the process.",
		authMismatchTitle: "Authorization failed: Account mismatch",
		authMismatchBody: (brandName) => `The ${brandName} account used for authorization does not match the account that initiated the request. To protect your data, this request has been denied.\n\n<font color='grey'>Only the person who started this request can authorize it using their account.</font>`
	}
};
/** 构造 i18n_content 对象（双语） */
function i18nContent(zh, en) {
	return {
		zh_cn: zh,
		en_us: en
	};
}
/** 构造带 i18n_content 的 plain_text（默认语言为英文） */
function i18nPlainText(zh, en) {
	return {
		tag: "plain_text",
		content: en,
		i18n_content: i18nContent(zh, en)
	};
}
function buildAuthCard(params) {
	const { verificationUriComplete, expiresMin, scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, filteredScopes, appId, showBatchAuthHint, brand } = params;
	const inAppUrl = toInAppWebUrl(verificationUriComplete, brand);
	const multiUrl = {
		url: inAppUrl,
		pc_url: inAppUrl,
		android_url: inAppUrl,
		ios_url: inAppUrl
	};
	const scopeParams = {
		scope,
		isBatchAuth,
		totalAppScopes,
		alreadyGranted,
		batchInfo,
		filteredScopes,
		appId
	};
	const scopeDescZh = formatScopeDescription("zh_cn", scopeParams);
	const scopeDescEn = formatScopeDescription("en_us", scopeParams);
	const zhT = CARD_TEXTS.zh_cn;
	const enT = CARD_TEXTS.en_us;
	const elements = [
		{
			tag: "markdown",
			content: scopeDescEn,
			i18n_content: i18nContent(scopeDescZh, scopeDescEn),
			text_size: "normal"
		},
		{
			tag: "column_set",
			flex_mode: "none",
			horizontal_align: "right",
			columns: [{
				tag: "column",
				width: "auto",
				elements: [{
					tag: "button",
					text: i18nPlainText(zhT.goAuth, enT.goAuth),
					type: "primary",
					size: "medium",
					multi_url: multiUrl
				}]
			}]
		},
		{
			tag: "markdown",
			content: enT.expiresHint(expiresMin),
			i18n_content: i18nContent(zhT.expiresHint(expiresMin), enT.expiresHint(expiresMin)),
			text_size: "notation"
		},
		...showBatchAuthHint ? [{
			tag: "markdown",
			content: enT.batchAuthHint,
			i18n_content: i18nContent(zhT.batchAuthHint, enT.batchAuthHint),
			text_size: "notation"
		}] : []
	];
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: false,
			...I18N_CONFIG$1,
			style: { color: { "light-yellow-bg": {
				light_mode: "rgba(255, 214, 102, 0.12)",
				dark_mode: "rgba(255, 214, 102, 0.08)"
			} } }
		},
		header: {
			title: i18nPlainText(zhT.authRequired, enT.authRequired),
			subtitle: {
				tag: "plain_text",
				content: ""
			},
			template: "blue",
			padding: "12px 12px 12px 12px",
			icon: {
				tag: "standard_icon",
				token: "lock-chat_filled"
			}
		},
		body: { elements }
	};
}
/** scope 字符串 → 可读描述（支持多语言） */
function formatScopeDescription(locale, params) {
	const { scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo } = params;
	const t = CARD_TEXTS[locale];
	const scopes = scope?.split(/\s+/).filter(Boolean);
	if (isBatchAuth && scopes && scopes.length > 0) {
		let message = t.batchScopeMsg(scopes.length, totalAppScopes ?? 0, alreadyGranted ?? 0);
		if (scopes.length > 5) {
			const previewScopes = scopes.slice(0, 3).join("\n");
			message += `\n\n${t.scopePreviewLabel}：\n${previewScopes}\n...\n`;
		} else {
			const scopeList = scopes.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
			message += `\n\n${t.scopeListLabel}：\n${scopeList}\n`;
		}
		if (batchInfo) message += `\n\n${batchInfo}`;
		return message;
	}
	if (!scopes?.length) return t.scopeDesc;
	return t.scopeDesc + "\n\n" + t.requiredScopes + "\n" + scopes.map((s) => `- ${s}`).join("\n");
}
function toInAppWebUrl(targetUrl, brand) {
	const lkMeta = encodeURIComponent(JSON.stringify({ "page-meta": {
		showNavBar: "false",
		showBottomNavBar: "false"
	} }));
	const fullUrl = `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}lk_meta=${lkMeta}`;
	const encoded = encodeURIComponent(fullUrl);
	return `${applinkDomain(brand)}/client/web_url/open?mode=sidebar-semi&max_width=800&reload=false&url=${encoded}`;
}
function buildAuthSuccessCard(brand) {
	const zhT = CARD_TEXTS.zh_cn;
	const enT = CARD_TEXTS.en_us;
	const brandZh = brand === "lark" ? "Lark" : "飞书";
	const brandEn = brand === "lark" ? "Lark" : "Feishu";
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: false,
			...I18N_CONFIG$1,
			style: { color: { "light-green-bg": {
				light_mode: "rgba(52, 199, 89, 0.12)",
				dark_mode: "rgba(52, 199, 89, 0.08)"
			} } }
		},
		header: {
			title: i18nPlainText(zhT.authSuccess, enT.authSuccess),
			subtitle: {
				tag: "plain_text",
				content: ""
			},
			template: "green",
			padding: "12px 12px 12px 12px",
			icon: {
				tag: "standard_icon",
				token: "yes_filled"
			}
		},
		body: { elements: [{
			tag: "markdown",
			content: enT.authSuccessBody(brandEn),
			i18n_content: i18nContent(zhT.authSuccessBody(brandZh), enT.authSuccessBody(brandEn))
		}] }
	};
}
function buildAuthFailedCard(_reason) {
	const zhT = CARD_TEXTS.zh_cn;
	const enT = CARD_TEXTS.en_us;
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: false,
			...I18N_CONFIG$1,
			style: { color: { "light-grey-bg": {
				light_mode: "rgba(142, 142, 147, 0.12)",
				dark_mode: "rgba(142, 142, 147, 0.08)"
			} } }
		},
		header: {
			title: i18nPlainText(zhT.authIncomplete, enT.authIncomplete),
			subtitle: {
				tag: "plain_text",
				content: ""
			},
			template: "yellow",
			padding: "12px 12px 12px 12px",
			icon: {
				tag: "standard_icon",
				token: "warning_filled"
			}
		},
		body: { elements: [{
			tag: "markdown",
			content: enT.authExpiredBody,
			i18n_content: i18nContent(zhT.authExpiredBody, enT.authExpiredBody)
		}] }
	};
}
function buildAuthIdentityMismatchCard(brand) {
	const zhT = CARD_TEXTS.zh_cn;
	const enT = CARD_TEXTS.en_us;
	const brandZh = brand === "lark" ? "Lark" : "飞书";
	const brandEn = brand === "lark" ? "Lark" : "Feishu";
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: false,
			...I18N_CONFIG$1
		},
		header: {
			title: i18nPlainText(zhT.authMismatchTitle, enT.authMismatchTitle),
			subtitle: {
				tag: "plain_text",
				content: ""
			},
			template: "red",
			padding: "12px 12px 12px 12px",
			icon: {
				tag: "standard_icon",
				token: "close_filled"
			}
		},
		body: { elements: [{
			tag: "markdown",
			content: enT.authMismatchBody(brandEn),
			i18n_content: i18nContent(zhT.authMismatchBody(brandZh), enT.authMismatchBody(brandEn))
		}] }
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/core/tools-config.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Default values and resolution logic for the Feishu tools configuration.
*
* Each boolean flag controls whether a particular category of Feishu-specific
* agent tools (document access, wiki queries, drive operations, etc.) is
* enabled for a given account.
*/
/**
* The default tools configuration.
*
* By default every non-destructive capability is enabled.  The `perm` flag
* (permission management) defaults to `false` because granting / revoking
* permissions is a privileged operation that admins should opt into
* explicitly.
*/
const DEFAULT_TOOLS_CONFIG = {
	doc: true,
	wiki: true,
	drive: true,
	scopes: true,
	perm: false,
	mail: true,
	sheets: true,
	okr: false
};
/**
* Merge a partial tools configuration with `DEFAULT_TOOLS_CONFIG`.
*
* Fields present in the input take precedence; anything absent falls back
* to the default value.
*/
function resolveToolsConfig(cfg) {
	if (!cfg) return { ...DEFAULT_TOOLS_CONFIG };
	return {
		doc: cfg.doc ?? DEFAULT_TOOLS_CONFIG.doc,
		wiki: cfg.wiki ?? DEFAULT_TOOLS_CONFIG.wiki,
		drive: cfg.drive ?? DEFAULT_TOOLS_CONFIG.drive,
		perm: cfg.perm ?? DEFAULT_TOOLS_CONFIG.perm,
		scopes: cfg.scopes ?? DEFAULT_TOOLS_CONFIG.scopes,
		mail: cfg.mail ?? DEFAULT_TOOLS_CONFIG.mail,
		sheets: cfg.sheets ?? DEFAULT_TOOLS_CONFIG.sheets,
		okr: cfg.okr ?? DEFAULT_TOOLS_CONFIG.okr
	};
}
/**
* 合并多个账户的工具配置（取并集）。
*
* 工具注册是全局的（启动时注册一次），只要任意一个账户启用了某工具，
* 该工具就应被注册。执行时由 LarkTicket 路由到具体账户。
*/
function resolveAnyEnabledToolsConfig(accounts) {
	const merged = {
		doc: false,
		wiki: false,
		drive: false,
		perm: false,
		scopes: false,
		mail: false,
		sheets: false,
		okr: false
	};
	for (const account of accounts) {
		const cfg = resolveToolsConfig(account.config.tools);
		merged.doc = merged.doc || cfg.doc;
		merged.wiki = merged.wiki || cfg.wiki;
		merged.drive = merged.drive || cfg.drive;
		merged.perm = merged.perm || cfg.perm;
		merged.scopes = merged.scopes || cfg.scopes;
		merged.mail = merged.mail || cfg.mail;
		merged.sheets = merged.sheets || cfg.sheets;
		merged.okr = merged.okr || cfg.okr;
	}
	return merged;
}
/**
* Check whether a string matches any of the given patterns.
* Supports trailing `*` as a simple wildcard (e.g., `feishu_calendar_*`).
*/
function matchesAnyPattern(value, patterns) {
	for (const pattern of patterns) {
		if (pattern === "*") return true;
		if (pattern.endsWith("*")) {
			if (value.startsWith(pattern.slice(0, -1))) return true;
		} else if (value === pattern) return true;
	}
	return false;
}
/**
* 检查工具是否应该被注册（channel 级别的 tools.deny 检查）。
*
* 从 `channels.feishu.tools.deny` 读取禁用列表，支持通配符模式。
*
* @param cfg - OpenClaw 配置对象
* @param toolName - 工具名称（如 `feishu_im_user_message`）
* @returns `true` 如果应该注册，`false` 如果应该跳过
*
* @example
* ```typescript
* // 配置示例：
* // channels.feishu.tools.deny: ["feishu_im_user_message", "feishu_calendar_*"]
*
* shouldRegisterTool(cfg, "feishu_im_user_message")  // false
* shouldRegisterTool(cfg, "feishu_calendar_event")   // false (匹配通配符)
* shouldRegisterTool(cfg, "feishu_task_task")        // true
* ```
*/
function shouldRegisterTool(cfg, toolName) {
	const denyList = (cfg.channels?.feishu)?.["tools"]?.["deny"];
	if (Array.isArray(denyList) && denyList.length > 0) {
		if (matchesAnyPattern(toolName, denyList)) return false;
	}
	return true;
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/helpers.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 飞书工具开发的通用辅助函数
*
* 提供所有工具通用的模式，减少重复代码。
*/
/**
* 获取飞书客户端的标准模式
*
* 这是所有工具通用的逻辑：
* 1. 优先使用 LarkTicket 中的 accountId 动态解析账号
* 2. 如果没有 LarkTicket，回退到 accountIndex 指定的账号
* 3. 返回创建好的客户端实例
*
* @param config - OpenClaw 配置对象
* @param accountIndex - 使用第几个账号（默认 0，即第一个），仅在无 LarkTicket 时使用
* @returns 飞书 SDK 客户端实例
* @throws 如果没有启用的账号
*
* @example
* ```typescript
* export function registerMyTool(api: OpenClawPluginApi) {
*   const getClient = createClientGetter(api.config);
*
*   api.registerTool({
*     name: "my_tool",
*     async execute(_toolCallId, params) {
*       const client = getClient();
*       const res = await client.im.message.create({ ... });
*       return formatToolResult(res.data);
*     }
*   });
* }
* ```
*/
function createClientGetter(config, accountIndex = 0) {
	return () => {
		const resolveConfig = getResolvedConfig(config);
		const ticket = getTicket();
		if (ticket?.accountId) {
			const account = getLarkAccount(resolveConfig, ticket.accountId);
			if (account.enabled && account.configured) return LarkClient.fromAccount(account).sdk;
		}
		const accounts = getEnabledLarkAccounts(resolveConfig);
		if (accounts.length === 0) throw new Error("No enabled Feishu accounts configured. Please add appId and appSecret in config under channels.feishu");
		if (accountIndex >= accounts.length) throw new Error(`Requested account index ${accountIndex} but only ${accounts.length} accounts available`);
		const account = accounts[accountIndex];
		return LarkClient.fromAccount(account).sdk;
	};
}
/**
* 获取当前请求对应的飞书账号信息
*
* 优先使用 LarkTicket 中的 accountId，回退到第一个启用的账号。
*
* @param config - OpenClaw 配置对象
* @returns 解析后的账号信息
* @throws 如果没有启用的账号
*
* @example
* ```typescript
* const account = getFirstAccount(api.config);
* const client = LarkClient.fromAccount(account);
* ```
*/
function getFirstAccount(config) {
	const resolveConfig = getResolvedConfig(config);
	const ticket = getTicket();
	if (ticket?.accountId) {
		const account = getLarkAccount(resolveConfig, ticket.accountId);
		if (account.enabled && account.configured) return account;
	}
	const accounts = getEnabledLarkAccounts(resolveConfig);
	if (accounts.length === 0) throw new Error("No enabled Feishu accounts configured. Please add appId and appSecret in config under channels.feishu");
	return accounts[0];
}
/**
* 创建工具上下文，一次性返回所有常用的辅助工具
*
* 这是推荐的模式，避免在每个工具中重复调用 createClientGetter 和 createToolLogger。
*
* @param api - OpenClaw 插件 API
* @param toolName - 工具名称
* @param options - 可选配置
* @returns 工具上下文对象
*
* @example
* ```typescript
* export function registerMyTool(api: OpenClawPluginApi) {
*   if (!api.config) return;
*
*   const { toolClient, log } = createToolContext(api, "my_tool");
*
*   api.registerTool({
*     name: "my_tool",
*     async execute(_toolCallId, params) {
*       const client = getClient();
*       log.info(`Processing action: ${params.action}`);
*       const res = await client.im.message.create({ ... });
*       return formatToolResult(res.data);
*     }
*   });
* }
* ```
*/
function createToolContext(api, toolName, options) {
	if (!api.config) throw new Error("No config available");
	const config = api.config;
	const accountIndex = options?.accountIndex ?? 0;
	return {
		getClient: createClientGetter(config, accountIndex),
		toolClient: () => createToolClient(config, accountIndex),
		log: createToolLogger(api, toolName)
	};
}
/**
* 检查工具是否应该被注册（根据 channels.feishu.tools.deny 配置）。
*
* 在工具注册函数开头调用此函数，如果返回 `false` 则应该直接 return。
*
* @param api - OpenClaw Plugin API
* @param toolName - 工具名称
* @returns `true` 如果应该继续注册，`false` 如果应该跳过
*
* @example
* ```typescript
* export function registerMyTool(api: OpenClawPluginApi) {
*   if (!checkToolRegistration(api, 'feishu_my_tool')) {
*     return;
*   }
*
*   const { toolClient, log } = createToolContext(api, 'feishu_my_tool');
*   api.registerTool({ ... });
* }
* ```
*/
function checkToolRegistration(api, toolName) {
	if (!api.config) return false;
	if (!shouldRegisterTool(api.config, toolName)) {
		api.logger.debug?.(`${toolName}: Skipped registration (in deny list)`);
		return false;
	}
	return true;
}
/**
* 包装的工具注册函数，自动检查 channels.feishu.tools.deny 配置。
*
* 用法：将 `api.registerTool(...)` 替换为 `registerTool(api, ...)`。
*
* @param api - OpenClaw Plugin API
* @param tool - 工具配置对象或工具工厂函数
* @param opts - 可选的工具注册选项
*
* @example
* ```typescript
* // 旧代码：
* api.registerTool({ name: 'feishu_my_tool', ... });
*
* // 新代码：
* registerTool(api, { name: 'feishu_my_tool', ... });
* ```
*/
function registerTool(api, tool, opts) {
	const toolName = typeof tool === "function" ? tool.name : tool.name;
	if (!toolName) {
		api.registerTool(tool, opts);
		return true;
	}
	if (!checkToolRegistration(api, toolName)) return false;
	api.registerTool(tool, opts);
	return true;
}
/**
* 格式化工具返回值为 OpenClaw 期望的格式
*
* @param data - 要返回的数据（会被序列化为 JSON）
* @param options - 可选配置
* @returns OpenClaw 工具返回值格式
*
* @example
* ```typescript
* // 简单使用
* return formatToolResult({ success: true, user_id: "ou_xxx" });
*
* // 自定义 JSON 格式化
* return formatToolResult(data, { indent: 4 });
* ```
*/
function formatToolResult(data, options = {}) {
	const { indent = 2 } = options;
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, indent)
		}],
		details: data
	};
}
/**
* 创建带工具名前缀的日志函数
*
* @param api - OpenClaw 插件 API
* @param toolName - 工具名称
* @returns 日志函数对象
*
* @example
* ```typescript
* export function registerMyTool(api: OpenClawPluginApi) {
*   const log = createToolLogger(api, "my_tool");
*
*   log.info("Tool started");
*   log.warn("Missing optional param: user_id");
*   log.error("API call failed");
*   log.debug("Intermediate state", { count: 5 });
* }
* ```
*/
function createToolLogger(api, toolName) {
	const prefix = `${toolName}:`;
	return {
		info: (msg) => {
			if (api.logger.info) api.logger.info(`${prefix} ${msg}`);
		},
		warn: (msg) => {
			if (api.logger.warn) api.logger.warn(`${prefix} ${msg}`);
		},
		error: (msg) => {
			if (api.logger.error) api.logger.error(`${prefix} ${msg}`);
		},
		debug: (msg) => {
			if (api.logger.debug) api.logger.debug(`${prefix} ${msg}`);
		}
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oauth.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_oauth tool — User OAuth authorisation management.
*
* Actions:
*   - authorize : Initiate Device Flow, send auth card, poll for token.
*   - status    : Check whether the current user has a valid UAT.
*   - revoke    : Remove the current user's stored UAT.
*
* Security:
*   - **Does not** accept a `user_open_id` parameter.  The target user is
*     always the message sender, obtained from the LarkTicket.
*   - Token values are never included in the return payload (AI cannot see
*     them).
*/
const log$6 = larkLogger("tools/oauth");
const json$2 = formatToolResult;
const FeishuOAuthSchema = Type.Object({ action: Type.Union([Type.Literal("authorize"), Type.Literal("revoke")], { description: "authorize: 为当前用户发送授权卡片；revoke: 撤销当前用户已保存的授权凭据" }) }, { description: "飞书用户撤销授权工具。仅在用户明确说\"撤销授权\"、\"取消授权\"、\"退出登录\"、\"清除授权\"时调用。【严禁调用场景】用户说\"重新授权\"、\"发起授权\"、\"重新发起\"、\"授权失败\"、\"授权过期\"时，绝对不要调用此工具，授权流程由系统自动处理。" });
const pendingFlows = /* @__PURE__ */ new Map();
/**
* 使用刚获取的 UAT 调用 /authen/v1/user_info，
* 验证实际完成 OAuth 授权的用户 open_id 是否与预期的 senderOpenId 一致。
*
* 防止群聊中其他用户点击授权链接后，错误的 UAT 被绑定到 owner 的身份。
*/
async function verifyTokenIdentity(brand, accessToken, expectedOpenId) {
	const url = `${brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"}/open-apis/authen/v1/user_info`;
	try {
		const data = await (await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
		if (data.code !== 0) {
			log$6.warn(`user_info API error: code=${data.code}, msg=${data.msg}`);
			return { valid: false };
		}
		const actualOpenId = data.data?.open_id;
		if (!actualOpenId) {
			log$6.warn("user_info API returned no open_id");
			return { valid: false };
		}
		return {
			valid: actualOpenId === expectedOpenId,
			actualOpenId
		};
	} catch (err) {
		log$6.warn(`identity verification request failed: ${err}`);
		return { valid: false };
	}
}
function registerFeishuOAuthTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	registerTool(api, {
		name: "feishu_oauth",
		label: "Feishu OAuth",
		description: "飞书用户授权工具。当消息/文档工具明确提示缺少权限或未授权时，最多调用一次 authorize 向当前用户发送授权卡片。若飞书返回未在应用所在企业/可用范围或其他失败原因，原样展示并停止，不要重试、不要猜测原因、不要改用其他人的令牌。仅在用户明确说\"撤销授权\"、\"取消授权\"、\"退出登录\"、\"清除授权\"时调用 revoke。不需要传入 user_open_id，系统自动从消息上下文获取当前用户。",
		parameters: FeishuOAuthSchema,
		async execute(_toolCallId, params) {
			const p = params;
			const ticket = getTicket();
			const senderOpenId = ticket?.senderOpenId;
			if (!senderOpenId) return json$2({ error: "无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。" });
			const acct = getLarkAccount(cfg, ticket.accountId);
			if (!acct.configured) return json$2({ error: `账号 ${ticket.accountId} 缺少 appId 或 appSecret 配置` });
			const account = acct;
			try {
				switch (p.action) {
					case "authorize": return await executeAuthorize({
						account,
						senderOpenId,
						scope: "im:chat:read im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user",
						isBatchAuth: false,
						cfg,
						ticket
					});
					case "revoke":
						await revokeUAT(account.appId, senderOpenId);
						return json$2({
							success: true,
							message: "用户授权已撤销。"
						});
					default: return json$2({ error: `未知操作: ${p.action}` });
				}
			} catch (err) {
				log$6.error(`${p.action} failed: ${err}`);
				return json$2({ error: formatLarkError(err) });
			}
		}
	}, { name: "feishu_oauth" });
	api.logger.debug?.("feishu_oauth: Registered feishu_oauth tool");
}
/**
* 执行 OAuth 授权流程（Device Flow）
* 可被 feishu_oauth 和 feishu_oauth_batch_auth 共享调用
*/
async function executeAuthorize(params) {
	const { account, senderOpenId, scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, skipSyntheticMessage, showBatchAuthHint, forceAuth, onAuthComplete, cfg, ticket } = params;
	const { appId, appSecret, brand, accountId } = account;
	let effectiveScope = scope;
	const existing = forceAuth ? null : await getStoredToken(appId, senderOpenId);
	if (existing && tokenStatus(existing) !== "expired") if (effectiveScope) {
		const requestedScopes = effectiveScope.split(/\s+/).filter(Boolean);
		const grantedScopes = new Set((existing.scope ?? "").split(/\s+/).filter(Boolean));
		const missingScopes = requestedScopes.filter((s) => !grantedScopes.has(s));
		if (missingScopes.length > 0) log$6.info(`existing token missing scopes [${missingScopes.join(", ")}], starting incremental auth`);
		else {
			if (onAuthComplete) try {
				await onAuthComplete();
			} catch (e) {
				log$6.warn(`onAuthComplete failed: ${e}`);
			}
			return json$2({
				success: true,
				message: "用户已授权，scope 已覆盖。",
				authorized: true,
				scope: existing.scope
			});
		}
	} else {
		if (onAuthComplete) try {
			await onAuthComplete();
		} catch (e) {
			log$6.warn(`onAuthComplete failed: ${e}`);
		}
		return json$2({
			success: true,
			message: "用户已授权，无需重复授权。",
			authorized: true,
			scope: existing.scope
		});
	}
	const flowKey = `${appId}:${senderOpenId}`;
	let reuseCardId;
	let reuseSeq = 0;
	if (pendingFlows.has(flowKey)) {
		const oldFlow = pendingFlows.get(flowKey);
		const currentMessageId = ticket?.messageId ?? "";
		if (oldFlow.messageId === currentMessageId) {
			oldFlow.superseded = true;
			oldFlow.controller.abort();
			reuseCardId = oldFlow.cardId;
			reuseSeq = oldFlow.sequence;
			pendingFlows.delete(flowKey);
			if (oldFlow.scope) {
				const oldScopes = oldFlow.scope.split(/\s+/).filter(Boolean);
				const newScopes = effectiveScope?.split(/\s+/).filter(Boolean) ?? [];
				const merged = new Set([...oldScopes, ...newScopes]);
				effectiveScope = [...merged].join(" ");
				log$6.info(`scope merge on reuse: [${[...merged].join(", ")}]`);
			}
			log$6.info(`same message, replacing flow for user=${senderOpenId}, app=${appId}, reusing cardId=${reuseCardId}`);
		} else {
			oldFlow.superseded = true;
			oldFlow.controller.abort();
			pendingFlows.delete(flowKey);
			log$6.info(`new message, cancelling old flow for user=${senderOpenId}, app=${appId}, old cardId=${oldFlow.cardId}`);
			try {
				await updateCardKitCardForAuth({
					cfg,
					cardId: oldFlow.cardId,
					card: buildAuthFailedCard("新的授权请求已发起"),
					sequence: oldFlow.sequence + 1,
					accountId
				});
			} catch (e) {
				log$6.warn(`failed to update old card to expired: ${e}`);
			}
		}
	}
	let filteredScope = effectiveScope;
	let unavailableScopes = [];
	if (effectiveScope) try {
		const sdk = LarkClient.fromAccount(account).sdk;
		const requestedScopes = effectiveScope.split(/\s+/).filter(Boolean);
		const appScopes = await getAppGrantedScopes(sdk, appId, "user");
		const availableScopes = requestedScopes.filter((s) => appScopes.includes(s));
		unavailableScopes = requestedScopes.filter((s) => !appScopes.includes(s));
		if (unavailableScopes.length > 0) {
			log$6.info(`app has not granted scopes [${unavailableScopes.join(", ")}], filtering them out`);
			if (availableScopes.length === 0) {
				const permissionUrl = appPermissionAuthUrl(appId, unavailableScopes, brand);
				return json$2({
					error: "app_scopes_not_granted",
					message: `应用未开通任何请求的用户权限，无法发起授权。请先点击一键申请链接开通以下权限并发布版本：\n${unavailableScopes.map((s) => `- ${s}`).join("\n")}\n\n一键申请地址：${permissionUrl}`,
					unavailable_scopes: unavailableScopes,
					app_permission_url: permissionUrl
				});
			}
			filteredScope = availableScopes.join(" ");
			log$6.info(`proceeding with available scopes [${availableScopes.join(", ")}]`);
		}
	} catch (err) {
		log$6.warn(`failed to check app scopes, proceeding anyway: ${err}`);
	}
	const deviceAuth = await requestDeviceAuthorization({
		appId,
		appSecret,
		brand,
		scope: filteredScope
	});
	const authCard = buildAuthCard({
		verificationUriComplete: deviceAuth.verificationUriComplete,
		expiresMin: Math.round(deviceAuth.expiresIn / 60),
		scope: filteredScope,
		isBatchAuth,
		totalAppScopes,
		alreadyGranted,
		batchInfo,
		filteredScopes: unavailableScopes.length > 0 ? unavailableScopes : void 0,
		appId,
		showBatchAuthHint,
		brand
	});
	let cardId;
	let seq;
	const chatId = ticket?.chatId;
	if (!chatId || !ticket) return json$2({ error: "无法确定发送目标" });
	if (reuseCardId) {
		const newSeq = reuseSeq + 1;
		try {
			await updateCardKitCardForAuth({
				cfg,
				cardId: reuseCardId,
				card: authCard,
				sequence: newSeq,
				accountId
			});
			log$6.info(`updated existing card ${reuseCardId} with merged scopes, seq=${newSeq}`);
		} catch (err) {
			log$6.warn(`failed to update existing card, creating new one: ${err}`);
			const newCardId = await createCardEntity({
				cfg,
				card: authCard,
				accountId
			});
			if (!newCardId) return json$2({ error: "创建授权卡片失败" });
			if (chatId) await sendCardByCardId({
				cfg,
				to: chatId,
				cardId: newCardId,
				replyToMessageId: ticket?.messageId?.startsWith("om_") ? ticket.messageId : void 0,
				replyInThread: Boolean(ticket?.threadId),
				accountId
			});
			cardId = newCardId;
			seq = 1;
			reuseCardId = void 0;
		}
		if (reuseCardId) {
			cardId = reuseCardId;
			seq = newSeq;
		} else {
			cardId = cardId;
			seq = seq;
		}
	} else {
		const newCardId = await createCardEntity({
			cfg,
			card: authCard,
			accountId
		});
		if (!newCardId) return json$2({ error: "创建授权卡片失败" });
		await sendCardByCardId({
			cfg,
			to: chatId,
			cardId: newCardId,
			replyToMessageId: ticket?.messageId?.startsWith("om_") ? ticket.messageId : void 0,
			replyInThread: Boolean(ticket?.threadId),
			accountId
		});
		cardId = newCardId;
		seq = 1;
	}
	const abortController = new AbortController();
	const currentFlow = {
		controller: abortController,
		cardId,
		sequence: seq,
		messageId: ticket?.messageId ?? "",
		superseded: false,
		scope: effectiveScope
	};
	pendingFlows.set(flowKey, currentFlow);
	let pendingFlowDelete = false;
	pollDeviceToken({
		appId,
		appSecret,
		brand,
		deviceCode: deviceAuth.deviceCode,
		interval: deviceAuth.interval,
		expiresIn: deviceAuth.expiresIn,
		signal: abortController.signal
	}).then(async (result) => {
		if (currentFlow.superseded) {
			log$6.info(`flow superseded, skipping card update for cardId=${cardId}`);
			return;
		}
		if (result.ok) {
			const identity = await verifyTokenIdentity(brand, result.token.accessToken, senderOpenId);
			if (!identity.valid) {
				log$6.warn(`identity mismatch! expected=${senderOpenId}, actual=${identity.actualOpenId ?? "unknown"}, cardId=${cardId}`);
				try {
					await updateCardKitCardForAuth({
						cfg,
						cardId,
						card: buildAuthIdentityMismatchCard(brand),
						sequence: ++seq,
						accountId
					});
				} catch (e) {
					log$6.warn(`failed to update card for identity mismatch: ${e}`);
				}
				pendingFlows.delete(flowKey);
				pendingFlowDelete = true;
				return;
			}
			const now = Date.now();
			await setStoredToken({
				userOpenId: senderOpenId,
				appId,
				accessToken: result.token.accessToken,
				refreshToken: result.token.refreshToken,
				expiresAt: now + result.token.expiresIn * 1e3,
				refreshExpiresAt: now + result.token.refreshExpiresIn * 1e3,
				scope: result.token.scope,
				grantedAt: now
			});
			try {
				await updateCardKitCardForAuth({
					cfg,
					cardId,
					card: buildAuthSuccessCard(brand),
					sequence: ++seq,
					accountId
				});
			} catch (e) {
				log$6.warn(`failed to update card to success: ${e}`);
			}
			pendingFlows.delete(flowKey);
			pendingFlowDelete = true;
			if (onAuthComplete) try {
				await onAuthComplete();
			} catch (e) {
				log$6.warn(`onAuthComplete failed: ${e}`);
			}
			if (skipSyntheticMessage) log$6.info("skipSyntheticMessage=true, skipping synthetic message");
			else try {
				const status = await dispatchSyntheticTextMessage({
					cfg,
					accountId,
					chatId,
					senderOpenId,
					text: "我已完成飞书账号授权，请继续执行之前的操作。",
					syntheticMessageId: `${ticket.messageId}:auth-complete`,
					replyToMessageId: ticket.messageId,
					chatType: ticket.chatType,
					threadId: ticket.threadId,
					runtime: {
						log: (msg) => log$6.info(msg),
						error: (msg) => log$6.error(msg)
					}
				});
				log$6.info(`synthetic message queued (${status})`);
				log$6.info("synthetic message dispatched after successful auth");
			} catch (e) {
				log$6.warn(`failed to send synthetic message after auth: ${e}`);
			}
		} else {
			try {
				await updateCardKitCardForAuth({
					cfg,
					cardId,
					card: buildAuthFailedCard(result.message),
					sequence: ++seq,
					accountId
				});
			} catch (e) {
				log$6.warn(`failed to update card to failure: ${e}`);
			}
			pendingFlows.delete(flowKey);
			pendingFlowDelete = true;
		}
	}).catch((err) => {
		log$6.error(`polling error: ${err}`);
	}).finally(() => {
		if (!pendingFlowDelete) {
			if (pendingFlows.get(flowKey) === currentFlow) pendingFlows.delete(flowKey);
		}
	});
	const scopeCount = filteredScope.split(/\s+/).filter(Boolean).length;
	let message = isBatchAuth ? `已发送批量授权请求卡片，共需授权 ${scopeCount} 个权限。请在卡片中完成授权。` : "已发送授权请求卡片，请用户在卡片中点击链接完成授权。授权完成后请重新执行之前的操作。";
	if (batchInfo) message += batchInfo;
	if (unavailableScopes.length > 0) {
		const permissionUrl = appPermissionAuthUrl(appId, unavailableScopes, brand);
		message += `\n\n⚠️ **注意**：以下权限因应用未开通而被跳过。请先点击一键申请链接开通并发布版本：\n${unavailableScopes.map((s) => `- ${s}`).join("\n")}\n\n一键申请地址：${permissionUrl}`;
	}
	return json$2({
		success: true,
		message,
		awaiting_authorization: true,
		filtered_scopes: unavailableScopes.length > 0 ? unavailableScopes : void 0,
		app_permission_url: unavailableScopes.length > 0 ? appPermissionAuthUrl(appId, unavailableScopes, brand) : void 0
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/auto-auth.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* auto-auth.ts — 工具层自动授权处理。
*
* 当 OAPI 工具遇到授权问题时，直接在工具层处理，不再让 AI 判断：
*
* - UserAuthRequiredError (appScopeVerified=true)
*   → 直接调用 executeAuthorize 发起 OAuth Device Flow 卡片
*
* - UserScopeInsufficientError
*   → 直接调用 executeAuthorize（使用 missingScopes）
*
* - AppScopeMissingError
*   → 发送应用权限引导卡片；用户点击"我已完成"后：
*     1. 更新卡片为处理中状态
*     2. invalidateAppScopeCache
*     3. 发送中间合成消息告知 AI（"应用权限已确认，正在发起用户授权..."）
*     4. 调用 executeAuthorize 发起 OAuth Device Flow
*
* - 其他情况（AppScopeCheckFailedError、appScopeVerified=false 等）
*   → 回退到原 handleInvokeError（不触发自动授权）
*
* 降级策略（保守）：以下情况均回退到 handleInvokeError：
* - 无 LarkTicket（非消息场景）
* - 无 senderOpenId（无法确定授权对象）
* - 账号未配置（!acct.configured）
* - 任何步骤抛出异常
*/
const log$5 = larkLogger("tools/auto-auth");
const json$1 = formatToolResult;
/**
* 防抖缓冲区 Map。
*
* Key 规则：
*   用户授权：`user:${accountId}:${senderOpenId}:${messageId}`
*   应用授权：`app:${accountId}:${chatId}:${messageId}`
*/
const authBatches = /* @__PURE__ */ new Map();
/** 防抖窗口（毫秒） */
const AUTH_DEBOUNCE_MS = 50;
/** 用户授权防抖窗口（毫秒）。比 app auth 的 50ms 更长，保证应用权限卡片先发出。 */
const AUTH_USER_DEBOUNCE_MS = 150;
/**
* Scope 更新防抖窗口（毫秒）。
* 比初始防抖更长，因为工具调用可能间隔数十到数百毫秒顺序到达。
* 需要等足够久以收集所有后续到达的 scope 后再一次性更新卡片。
*/
const AUTH_UPDATE_DEBOUNCE_MS = 500;
/**
* 冷却期（毫秒）。
* flushFn 执行完毕后，entry 继续保留在 Map 中这么长时间，
* 防止后续顺序到达的工具调用创建重复卡片。
*/
const AUTH_COOLDOWN_MS = 3e4;
/**
* 将授权请求入队到防抖缓冲区。
*
* 同一 bufferKey 的请求会被合并：
* - collecting 阶段：scope 集合取并集，共享同一个 flushFn 执行结果
* - executing 阶段：flushFn 已在运行，后续请求直接复用已有结果（不重复发卡片）
*
* @param bufferKey - 缓冲区 key（区分不同用户/会话）
* @param scopes - 本次请求需要的 scope 列表
* @param ctx - 上下文信息（仅第一个请求的被采用）
* @param flushFn - 定时器到期后执行的实际授权函数，接收合并后的 scope 数组
*/
function enqueueAuthRequest(bufferKey, scopes, ctx, flushFn, debounceMs = AUTH_DEBOUNCE_MS) {
	const existing = authBatches.get(bufferKey);
	if (existing) {
		for (const s of scopes) existing.scopes.add(s);
		if (existing.phase === "executing") {
			log$5.info(`auth in-flight, piggyback → key=${bufferKey}, scopes=[${[...existing.scopes].join(", ")}]`);
			if (existing.updateTimer) clearTimeout(existing.updateTimer);
			existing.updateTimer = setTimeout(async () => {
				existing.updateTimer = null;
				if (existing.isUpdating) {
					existing.pendingReupdate = true;
					log$5.info(`scope update deferred (previous update still running) → key=${bufferKey}`);
					return;
				}
				existing.isUpdating = true;
				try {
					const mergedScopes = [...existing.scopes];
					log$5.info(`scope update flush → key=${bufferKey}, scopes=[${mergedScopes.join(", ")}]`);
					await existing.flushFn(mergedScopes);
				} catch (err) {
					log$5.warn(`scope update failed: ${err}`);
				} finally {
					existing.isUpdating = false;
					if (existing.pendingReupdate) {
						existing.pendingReupdate = false;
						const finalScopes = [...existing.scopes];
						log$5.info(`scope reupdate → key=${bufferKey}, scopes=[${finalScopes.join(", ")}]`);
						try {
							await existing.flushFn(finalScopes);
						} catch (err) {
							log$5.warn(`scope reupdate failed: ${err}`);
						}
					}
				}
			}, AUTH_UPDATE_DEBOUNCE_MS);
			return existing.resultPromise;
		}
		log$5.info(`debounce merge → key=${bufferKey}, scopes=[${[...existing.scopes].join(", ")}]`);
		return new Promise((resolve, reject) => {
			existing.waiters.push({
				resolve,
				reject
			});
		});
	}
	const entry = {
		phase: "collecting",
		scopes: new Set(scopes),
		waiters: [],
		timer: null,
		resultPromise: null,
		updateTimer: null,
		isUpdating: false,
		pendingReupdate: false,
		flushFn: null,
		account: ctx.account,
		cfg: ctx.cfg,
		ticket: ctx.ticket
	};
	const promise = new Promise((resolve, reject) => {
		entry.waiters.push({
			resolve,
			reject
		});
	});
	entry.timer = setTimeout(async () => {
		entry.phase = "executing";
		entry.timer = null;
		entry.flushFn = flushFn;
		const mergedScopes = [...entry.scopes];
		log$5.info(`debounce flush → key=${bufferKey}, waiters=${entry.waiters.length}, scopes=[${mergedScopes.join(", ")}]`);
		entry.resultPromise = flushFn(mergedScopes);
		try {
			const result = await entry.resultPromise;
			for (const w of entry.waiters) w.resolve(result);
		} catch (err) {
			for (const w of entry.waiters) w.reject(err);
		} finally {
			setTimeout(() => authBatches.delete(bufferKey), AUTH_COOLDOWN_MS);
		}
	}, debounceMs);
	authBatches.set(bufferKey, entry);
	return promise;
}
/** TTL：15 分钟后自动清理，防止内存泄漏。 */
const PENDING_FLOW_TTL_MS = 900 * 1e3;
/** 计算去重 key（chatId + messageId + 有序 scopes）。 */
function makeDedupKey(chatId, messageId, scopes) {
	return chatId + "\0" + messageId + "\0" + [...scopes].sort().join(",");
}
/**
* 应用权限授权流管理器 — 统一管理三个关联索引的一致性。
*
* 替代原来散布的 pendingAppAuthFlows / dedupIndex / activeAppCardIndex 三个 Map，
* 确保注册、删除、迁移操作的原子性。
*/
var AppAuthFlowManager = class {
	flows = /* @__PURE__ */ new Map();
	dedupIndex = /* @__PURE__ */ new Map();
	activeCardIndex = /* @__PURE__ */ new Map();
	/** 原子注册新流程（同时写入 3 个索引 + 设置统一 TTL） */
	register(operationId, flow, dedupKey, activeCardKey) {
		const registered = {
			...flow,
			dedupKey,
			activeCardKey
		};
		this.flows.set(operationId, registered);
		this.dedupIndex.set(dedupKey, operationId);
		this.activeCardIndex.set(activeCardKey, operationId);
		setTimeout(() => {
			if (!this.flows.has(operationId)) return;
			this.remove(operationId);
		}, PENDING_FLOW_TTL_MS);
	}
	/** 只需 operationId 即可原子清理所有索引 */
	remove(operationId) {
		const flow = this.flows.get(operationId);
		if (!flow) return;
		if (flow.ticket?.senderOpenId) {
			const deferKey = `${flow.accountId}:${flow.ticket.senderOpenId}:${flow.ticket.messageId}`;
			deferredUserAuth.delete(deferKey);
		}
		this.flows.delete(operationId);
		if (this.dedupIndex.get(flow.dedupKey) === operationId) this.dedupIndex.delete(flow.dedupKey);
		if (this.activeCardIndex.get(flow.activeCardKey) === operationId) this.activeCardIndex.delete(flow.activeCardKey);
	}
	/**
	* 迁移到新 operationId（卡片复用场景：按钮回调需要匹配新 ID）。
	* 原子操作：清理旧索引 → 更新 flow → 建立新索引 → 注册新 TTL。
	*
	* 修复原代码卡片复用路径缺少 TTL 注册导致的内存泄漏。
	*/
	migrateToNewOperationId(oldOperationId, newOperationId, updates) {
		const flow = this.flows.get(oldOperationId);
		if (!flow) return void 0;
		this.flows.delete(oldOperationId);
		if (updates?.dedupKey) {
			if (this.dedupIndex.get(flow.dedupKey) === oldOperationId) this.dedupIndex.delete(flow.dedupKey);
			flow.dedupKey = updates.dedupKey;
		}
		if (updates?.requiredScopes) flow.requiredScopes = updates.requiredScopes;
		if (updates?.scopeNeedType) flow.scopeNeedType = updates.scopeNeedType;
		this.flows.set(newOperationId, flow);
		this.dedupIndex.set(flow.dedupKey, newOperationId);
		this.activeCardIndex.set(flow.activeCardKey, newOperationId);
		setTimeout(() => {
			if (!this.flows.has(newOperationId)) return;
			this.remove(newOperationId);
		}, PENDING_FLOW_TTL_MS);
		return flow;
	}
	/** 通过 operationId 查询（card action 回调用） */
	getByOperationId(id) {
		return this.flows.get(id);
	}
	/** 通过去重键查询（避免发送重复卡片） */
	getByDedupKey(key) {
		const opId = this.dedupIndex.get(key);
		if (!opId) return void 0;
		const flow = this.flows.get(opId);
		return flow ? {
			operationId: opId,
			flow
		} : void 0;
	}
	/** 通过活跃卡片键查询（同消息卡片复用） */
	getByActiveCardKey(key) {
		const opId = this.activeCardIndex.get(key);
		if (!opId) return void 0;
		const flow = this.flows.get(opId);
		return flow ? {
			operationId: opId,
			flow
		} : void 0;
	}
};
const appAuthFlows = new AppAuthFlowManager();
/** 延迟用户授权队列。Key: `${accountId}:${senderOpenId}:${messageId}` */
const deferredUserAuth = /* @__PURE__ */ new Map();
/**
* 检查指定消息上下文是否有未完成的应用权限授权流程。
* 检查两个来源：
*   1. authBatches 中的 app auth entry（collecting/executing 阶段）
*   2. appAuthFlows 中的活跃流（卡片已发送，等待用户点击"已完成"）
*/
function hasActiveAppAuthForMessage(ticket) {
	const appKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
	const appEntry = authBatches.get(appKey);
	if (appEntry && (appEntry.phase === "collecting" || appEntry.phase === "executing")) return true;
	const activeCardKey = `${ticket.chatId}:${ticket.messageId}`;
	return !!appAuthFlows.getByActiveCardKey(activeCardKey);
}
/**
* 将用户授权 scope 添加到延迟队列。
* 多个工具调用的 scope 会被合并到同一个 entry。
*/
function addToDeferredUserAuth(ticket, scopes, account, cfg) {
	const key = `${ticket.accountId}:${ticket.senderOpenId}:${ticket.messageId}`;
	const existing = deferredUserAuth.get(key);
	if (existing) {
		for (const s of scopes) existing.scopes.add(s);
		log$5.info(`deferred user auth scope merge → key=${key}, scopes=[${[...existing.scopes].join(", ")}]`);
	} else {
		deferredUserAuth.set(key, {
			scopes: new Set(scopes),
			account,
			cfg,
			ticket
		});
		log$5.info(`deferred user auth created → key=${key}, scopes=[${scopes.join(", ")}]`);
	}
}
/** v2 卡片 i18n 配置 */
const I18N_CONFIG = {
	update_multi: true,
	locales: ["zh_cn", "en_us"]
};
/**
* 构建应用权限引导卡片。
*
* 橙色 header，列出缺失的 scope，提供权限管理链接和"已完成"按钮。
*/
function buildAppScopeMissingCard(params) {
	const { missingScopes, appId, operationId, brand } = params;
	const multiUrl = {
		url: appId ? appPermissionAuthUrl(appId, missingScopes, brand) : `${brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"}/`,
		pc_url: "",
		android_url: "",
		ios_url: ""
	};
	const scopeList = missingScopes.map((s) => `• ${s}`).join("\n");
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: true,
			...I18N_CONFIG
		},
		header: {
			title: {
				tag: "plain_text",
				content: "🔐 Permissions required to continue",
				i18n_content: {
					zh_cn: "🔐 需要申请权限才能继续",
					en_us: "🔐 Permissions required to continue"
				}
			},
			template: "orange"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: `Please request **all** the following permissions to proceed:\n\n${scopeList}`,
				i18n_content: {
					zh_cn: `调用前，请你先申请以下**所有**权限：\n\n${scopeList}`,
					en_us: `Please request **all** the following permissions to proceed:\n\n${scopeList}`
				},
				text_size: "normal"
			},
			{ tag: "hr" },
			{
				tag: "markdown",
				content: "**Step 1: Request all permissions**",
				i18n_content: {
					zh_cn: "**第一步：申请所有权限**",
					en_us: "**Step 1: Request all permissions**"
				},
				text_size: "normal"
			},
			{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Request Now",
					i18n_content: {
						zh_cn: "去申请",
						en_us: "Request Now"
					}
				},
				type: "primary",
				multi_url: multiUrl
			},
			{
				tag: "markdown",
				content: "**Step 2: Create version and get approval**",
				i18n_content: {
					zh_cn: "**第二步：创建版本并审核通过**",
					en_us: "**Step 2: Create version and get approval**"
				},
				text_size: "normal"
			},
			{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Done",
					i18n_content: {
						zh_cn: "已完成",
						en_us: "Done"
					}
				},
				type: "default",
				value: {
					action: "app_auth_done",
					operation_id: operationId
				}
			}
		] }
	};
}
/**
* 构建应用权限引导卡片的"处理中"状态（用户点击按钮后更新）。
*/
function buildAppAuthProgressCard() {
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: false,
			...I18N_CONFIG
		},
		header: {
			title: {
				tag: "plain_text",
				content: "Permissions enabled",
				i18n_content: {
					zh_cn: "应用权限已开通",
					en_us: "Permissions enabled"
				}
			},
			subtitle: {
				tag: "plain_text",
				content: ""
			},
			template: "green",
			padding: "12px 12px 12px 12px",
			icon: {
				tag: "standard_icon",
				token: "yes_filled"
			}
		},
		body: { elements: [{
			tag: "markdown",
			content: "App permissions ready. Starting user authorization...",
			i18n_content: {
				zh_cn: "你的应用权限已开通，正在为你发起用户授权",
				en_us: "App permissions ready. Starting user authorization..."
			},
			text_size: "normal"
		}] }
	};
}
/**
* 发送应用权限引导卡片，并将 flow 存入 pendingAppAuthFlows。
* 返回工具结果（告知 AI 等待用户操作）。
*/
async function sendAppScopeCard(params) {
	const { account, missingScopes, appId, scopeNeedType, tokenType, cfg, ticket } = params;
	const { accountId, chatId, messageId } = ticket;
	const activeCardKey = `${chatId}:${messageId}`;
	const dedup = makeDedupKey(chatId, messageId, missingScopes);
	if (appAuthFlows.getByDedupKey(dedup)) {
		log$5.info(`dedup – app-scope card already pending for chatId=${chatId}, scopes=[${missingScopes.join(", ")}], skipping duplicate send`);
		return json$1({
			awaiting_app_authorization: true,
			message: "已向用户发送授权引导卡片，等待用户完成授权操作。请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。请等待用户完成卡片操作，不要建议其他替代方案。",
			missing_scopes: missingScopes
		});
	}
	const activeEntry = appAuthFlows.getByActiveCardKey(activeCardKey);
	if (activeEntry) {
		const { operationId: activeOpId, flow: activeFlow } = activeEntry;
		const newOperationId = Date.now().toString(36) + Math.random().toString(36).slice(2);
		const card = buildAppScopeMissingCard({
			missingScopes,
			appId,
			operationId: newOperationId,
			brand: account.brand
		});
		const newSeq = activeFlow.sequence + 1;
		const newDedup = makeDedupKey(chatId, messageId, missingScopes);
		const migrated = appAuthFlows.migrateToNewOperationId(activeOpId, newOperationId, {
			dedupKey: newDedup,
			requiredScopes: missingScopes,
			scopeNeedType
		});
		if (!migrated) log$5.info(`migrate raced, falling through to new card creation`);
		else try {
			await updateCardKitCardForAuth({
				cfg,
				cardId: activeFlow.cardId,
				card,
				sequence: newSeq,
				accountId
			});
			log$5.info(`app-scope card updated in-place, cardId=${activeFlow.cardId}, seq=${newSeq}, scopes=[${missingScopes.join(", ")}]`);
			migrated.sequence = newSeq;
			return json$1({
				awaiting_app_authorization: true,
				message: "已向用户发送授权引导卡片，等待用户完成授权操作。请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。请等待用户完成卡片操作，不要建议其他替代方案。",
				missing_scopes: missingScopes
			});
		} catch (err) {
			appAuthFlows.remove(newOperationId);
			log$5.warn(`failed to update existing app-scope card, creating new one: ${err}`);
		}
	}
	const operationId = Date.now().toString(36) + Math.random().toString(36).slice(2);
	const cardId = await createCardEntity({
		cfg,
		card: buildAppScopeMissingCard({
			missingScopes,
			appId,
			operationId,
			brand: account.brand
		}),
		accountId
	});
	if (!cardId) {
		log$5.warn("createCardEntity failed for app-scope card, falling back");
		return json$1({
			error: "app_scope_missing",
			missing_scopes: missingScopes,
			message: `应用缺少以下权限：${missingScopes.join(", ")}，请管理员在开放平台开通后重试。` + (appId ? `\n一键申请地址：${appPermissionAuthUrl(appId, missingScopes, account.brand)}` : "")
		});
	}
	await sendCardByCardId({
		cfg,
		to: chatId,
		cardId,
		replyToMessageId: ticket.messageId?.startsWith("om_") ? ticket.messageId : void 0,
		replyInThread: Boolean(ticket?.threadId),
		accountId
	});
	const flow = {
		appId: appId ?? account.appId,
		accountId,
		cardId,
		sequence: 0,
		requiredScopes: missingScopes,
		scopeNeedType,
		tokenType,
		cfg,
		ticket
	};
	appAuthFlows.register(operationId, flow, dedup, activeCardKey);
	log$5.info(`app-scope card sent, operationId=${operationId}, scopes=[${missingScopes.join(", ")}]`);
	return json$1({
		awaiting_app_authorization: true,
		message: "已向用户发送授权引导卡片，等待用户完成授权操作。请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。请等待用户完成卡片操作，不要建议其他替代方案。",
		missing_scopes: missingScopes
	});
}
/**
* 处理 card.action.trigger 回调事件（由 monitor.ts 调用）。
*
* 当用户点击应用权限引导卡片的"我已完成，继续授权"按钮时：
* 1. 更新卡片为"处理中"状态
* 2. 清除应用 scope 缓存
* 3. 发送中间合成消息告知 AI
* 4. 发起 OAuth Device Flow
*
* 注意：函数体内的主要逻辑通过 setImmediate + fire-and-forget 异步执行，
* 确保 Feishu card.action.trigger 回调在 3 秒内返回。
*/
async function handleCardAction(data, cfg, accountId) {
	let action;
	let operationId;
	let senderOpenId;
	try {
		const event = data;
		action = event.action?.value?.action;
		operationId = event.action?.value?.operation_id;
		senderOpenId = resolveCardCallbackOperatorId(event.operator);
	} catch {
		return;
	}
	if (action !== "app_auth_done" || !operationId) return;
	const flow = appAuthFlows.getByOperationId(operationId);
	if (!flow) {
		log$5.warn(`card action ${operationId} not found (expired or already handled)`);
		return;
	}
	log$5.info(`app_auth_done clicked by ${senderOpenId}, operationId=${operationId}`);
	invalidateAppScopeCache(flow.appId);
	const acct = getLarkAccount(flow.cfg, flow.accountId);
	if (!acct.configured) {
		log$5.warn(`account ${flow.accountId} not configured, skipping OAuth`);
		return;
	}
	const sdk = LarkClient.fromAccount(acct).sdk;
	let grantedScopes = [];
	try {
		grantedScopes = await getAppGrantedScopes(sdk, flow.appId, flow.tokenType);
	} catch (err) {
		log$5.warn(`failed to re-check app scopes: ${err}, proceeding anyway`);
	}
	if (!isAppScopeSatisfied(grantedScopes, flow.requiredScopes, flow.scopeNeedType)) {
		log$5.warn(`app scopes still missing after user confirmation: [${flow.requiredScopes.join(", ")}]`);
		return { toast: {
			type: "error",
			content: "权限尚未开通，请确认已申请并审核通过后再试"
		} };
	}
	log$5.info(`app scopes verified, proceeding with OAuth`);
	const deferKey = flow.ticket.senderOpenId ? `${flow.accountId}:${flow.ticket.senderOpenId}:${flow.ticket.messageId}` : void 0;
	const consumedDeferred = deferKey ? deferredUserAuth.get(deferKey) : void 0;
	if (consumedDeferred && deferKey) {
		deferredUserAuth.delete(deferKey);
		log$5.info(`consumed deferred user auth scopes: [${[...consumedDeferred.scopes].join(", ")}]`);
	}
	appAuthFlows.remove(operationId);
	const successCard = buildAppAuthProgressCard();
	setImmediate(async () => {
		try {
			try {
				await updateCardKitCardForAuth({
					cfg,
					cardId: flow.cardId,
					card: successCard,
					sequence: flow.sequence + 1,
					accountId
				});
			} catch (err) {
				log$5.warn(`failed to update app-scope card to progress via API: ${err}`);
			}
			if (!flow.ticket.senderOpenId) {
				log$5.warn("no senderOpenId in ticket, skipping OAuth");
				return;
			}
			const mergedScopes = new Set(flow.requiredScopes.filter((s) => s !== "offline_access"));
			if (consumedDeferred) for (const s of consumedDeferred.scopes) mergedScopes.add(s);
			const userBatchKey = `user:${flow.accountId}:${flow.ticket.senderOpenId}:${flow.ticket.messageId}`;
			const userBatch = authBatches.get(userBatchKey);
			if (userBatch) {
				for (const s of userBatch.scopes) mergedScopes.add(s);
				log$5.info(`merged user batch scopes into app auth completion: [${[...mergedScopes].join(", ")}]`);
			}
			if (mergedScopes.size === 0) {
				log$5.info("no business scopes to authorize after app auth, sending synthetic message for retry");
				const syntheticMsgId = `${flow.ticket.messageId}:app-auth-complete`;
				await dispatchSyntheticTextMessage({
					cfg: flow.cfg,
					accountId: flow.accountId,
					chatId: flow.ticket.chatId,
					senderOpenId: flow.ticket.senderOpenId,
					text: "应用权限已开通，请继续执行之前的操作。",
					syntheticMessageId: syntheticMsgId,
					replyToMessageId: flow.ticket.messageId,
					chatType: flow.ticket.chatType,
					threadId: flow.ticket.threadId,
					runtime: {
						log: (msg) => log$5.info(msg),
						error: (msg) => log$5.error(msg)
					}
				});
				log$5.info("synthetic message dispatched after app-auth-only completion");
			} else await executeAuthorize({
				account: acct,
				senderOpenId: flow.ticket.senderOpenId,
				scope: [...mergedScopes].join(" "),
				showBatchAuthHint: true,
				forceAuth: true,
				cfg: flow.cfg,
				ticket: flow.ticket
			});
		} catch (err) {
			log$5.error(`handleCardAction background task failed: ${err}`);
		}
	});
	return {
		toast: {
			type: "success",
			content: "权限确认成功"
		},
		card: {
			type: "raw",
			data: successCard
		}
	};
}
/**
* 统一处理 `client.invoke()` 抛出的错误，支持自动发起 OAuth 授权。
*
* 替代 `handleInvokeError`，在工具层直接处理授权问题：
* - 用户授权类错误 → 直接 executeAuthorize（发 Device Flow 卡片）
* - 应用权限缺失 → 发送引导卡片，用户确认后自动接力 OAuth
* - 其他错误 → 回退到 handleInvokeError 的标准处理
*
* @param err - invoke() 或其他逻辑抛出的错误
* @param cfg - OpenClaw 配置对象（从工具注册函数的闭包中获取）
*/
async function handleInvokeErrorWithAutoAuth(err, cfg) {
	cfg = getResolvedConfig(cfg);
	const ticket = getTicket();
	if (err instanceof OwnerAccessDeniedError) return json$1({
		error: "permission_denied",
		message: "当前应用仅限所有者（App Owner）使用。您没有权限使用相关功能。",
		user_open_id: err.userOpenId
	});
	if (ticket) {
		const senderOpenId = ticket.senderOpenId;
		if (senderOpenId) {
			if (err instanceof UserAuthRequiredError && err.appScopeVerified) {
				const scopes = err.requiredScopes;
				try {
					const acct = getLarkAccount(cfg, ticket.accountId);
					if (acct.configured) {
						if (hasActiveAppAuthForMessage(ticket)) {
							addToDeferredUserAuth(ticket, scopes, acct, cfg);
							log$5.info(`UserAuthRequiredError deferred (app auth pending), scopes=[${scopes.join(", ")}]`);
							return json$1({
								awaiting_app_authorization: true,
								user_auth_deferred: true,
								message: "应用权限尚未开通，将在应用权限通过后自动为您发起用户授权。请先按照应用权限卡片的提示完成操作。请等待用户完成卡片操作，不要建议其他替代方案。",
								deferred_scopes: scopes
							});
						}
						const bufferKey = `user:${ticket.accountId}:${senderOpenId}:${ticket.messageId}`;
						log$5.info(`UserAuthRequiredError → enqueue, key=${bufferKey}, scopes=[${scopes.join(", ")}]`);
						return await enqueueAuthRequest(bufferKey, scopes, {
							account: acct,
							cfg,
							ticket
						}, async (mergedScopes) => {
							const appKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
							const appEntry = authBatches.get(appKey);
							if (appEntry?.resultPromise) await appEntry.resultPromise.catch(() => {});
							return executeAuthorize({
								account: acct,
								senderOpenId,
								scope: mergedScopes.join(" "),
								showBatchAuthHint: true,
								cfg,
								ticket
							});
						}, AUTH_USER_DEBOUNCE_MS);
					}
				} catch (autoAuthErr) {
					log$5.warn(`executeAuthorize failed: ${autoAuthErr}, falling back`);
				}
			}
			if (err instanceof UserScopeInsufficientError) {
				const scopes = err.missingScopes;
				try {
					const acct = getLarkAccount(cfg, ticket.accountId);
					if (acct.configured) {
						if (hasActiveAppAuthForMessage(ticket)) {
							addToDeferredUserAuth(ticket, scopes, acct, cfg);
							log$5.info(`UserScopeInsufficientError deferred (app auth pending), scopes=[${scopes.join(", ")}]`);
							return json$1({
								awaiting_app_authorization: true,
								user_auth_deferred: true,
								message: "应用权限尚未开通，将在应用权限通过后自动为您发起用户授权。请先按照应用权限卡片的提示完成操作。请等待用户完成卡片操作，不要建议其他替代方案。",
								deferred_scopes: scopes
							});
						}
						const bufferKey = `user:${ticket.accountId}:${senderOpenId}:${ticket.messageId}`;
						log$5.info(`UserScopeInsufficientError → enqueue, key=${bufferKey}, scopes=[${scopes.join(", ")}]`);
						return await enqueueAuthRequest(bufferKey, scopes, {
							account: acct,
							cfg,
							ticket
						}, async (mergedScopes) => {
							const appKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
							const appEntry = authBatches.get(appKey);
							if (appEntry?.resultPromise) await appEntry.resultPromise.catch(() => {});
							return executeAuthorize({
								account: acct,
								senderOpenId,
								scope: mergedScopes.join(" "),
								showBatchAuthHint: true,
								cfg,
								ticket
							});
						}, AUTH_USER_DEBOUNCE_MS);
					}
				} catch (autoAuthErr) {
					log$5.warn(`executeAuthorize failed: ${autoAuthErr}, falling back`);
				}
			}
		} else log$5.error(`senderOpenId not found ${err}`);
		if (err instanceof AppScopeMissingError && ticket.chatId) {
			const appScopeErr = err;
			try {
				const acct = getLarkAccount(cfg, ticket.accountId);
				if (acct.configured) {
					if (senderOpenId && appScopeErr.allRequiredScopes?.length) {
						addToDeferredUserAuth(ticket, appScopeErr.allRequiredScopes, acct, cfg);
						log$5.info(`AppScopeMissingError → deferred allRequiredScopes=[${appScopeErr.allRequiredScopes.join(", ")}]`);
					}
					const bufferKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
					log$5.info(`AppScopeMissingError → enqueue, key=${bufferKey}, scopes=[${appScopeErr.missingScopes.join(", ")}]`);
					return await enqueueAuthRequest(bufferKey, appScopeErr.missingScopes, {
						account: acct,
						cfg,
						ticket
					}, (mergedScopes) => sendAppScopeCard({
						account: acct,
						missingScopes: mergedScopes,
						appId: appScopeErr.appId,
						scopeNeedType: "all",
						tokenType: appScopeErr.tokenType,
						cfg,
						ticket
					}));
				}
			} catch (cardErr) {
				log$5.warn(`sendAppScopeCard failed: ${cardErr}, falling back`);
			}
		}
	} else log$5.error(`ticket not found ${err}`);
	return json$1({ error: formatLarkError(err) });
}
//#endregion
//#region src/config.ts
const Config = z.object({
	appId: z.string().required(false),
	appName: z.string().required(false),
	appSecret: z.string().required(false),
	appSecretEnv: z.string().required(false),
	domain: z.union([z.const("feishu"), z.const("lark")]).required(false),
	defaultCwd: z.string().required(false),
	workspaceRoot: z.string().required(false),
	dataDir: z.string().required(false),
	provider: z.string().required(false),
	model: z.string().required(false),
	reasoningEffort: z.string().required(false),
	allowedChats: z.array(z.string()).required(false),
	allowedUsers: z.array(z.string()).required(false),
	groupMentionMode: z.union([
		z.const("always"),
		z.const("never"),
		z.const("ambient")
	]).required(false),
	replyMode: z.const("streaming").required(false),
	tools: z.object({ deny: z.array(z.string()).required(false) }).required(false),
	officialTools: z.union([z.boolean(), z.const("messages")]).required(false),
	agentToolAllow: z.array(z.string()).required(false),
	mcpEndpoint: z.string().required(false),
	accountId: z.string().required(false),
	agentId: z.string().required(false),
	botsFile: z.string().required(false),
	bots: z.array(z.object({
		accountId: z.string(),
		appId: z.string(),
		appSecret: z.string(),
		appName: z.string().required(false),
		agentId: z.string().required(false),
		workspaceRoot: z.string().required(false),
		dataDir: z.string().required(false),
		defaultCwd: z.string().required(false),
		domain: z.union([z.const("feishu"), z.const("lark")]).required(false)
	})).required(false)
});
/**
* Minimal manifest.yml reader: proto plus an optional three-key model block.
* No YAML dependency — the identity manifest format is deliberately tiny.
*/
function readAgentManifest(agentsRoot, agentId) {
	let text;
	try {
		text = readFileSync(join(agentsRoot, agentId, "manifest.yml"), "utf8");
	} catch {
		return;
	}
	const manifest = {};
	let inModel = false;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.replace(/\s+#.*$/, "").trimEnd();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (/^model:\s*$/.test(trimmed)) {
			inModel = true;
			continue;
		}
		if (/^\S/.test(trimmed)) inModel = false;
		if (inModel) {
			const kv = /^\s+(provider|name|reasoningEffort):\s*(\S+)\s*$/.exec(trimmed);
			if (kv) {
				manifest.model ??= {};
				manifest.model[kv[1]] = kv[2];
				continue;
			}
		}
		const proto = /^proto:\s*(guest|companion|owner)\s*$/.exec(trimmed);
		if (proto) manifest.proto = proto[1];
		else {
			const name = /^displayName:\s*(\S.*?)\s*$/.exec(trimmed);
			if (name) manifest.displayName = name[1];
		}
	}
	return manifest.proto === void 0 && manifest.model === void 0 && manifest.displayName === void 0 ? void 0 : manifest;
}
/** Resolve independent account/storage/workspace settings without sharing session registries. */
function resolveBots(config) {
	const primary = resolveCredentials(config);
	const { bots: _additional, botsFile, ...base } = config;
	const agentsRoot = base.workspaceRoot ?? agentsRootDefault();
	const resolveOne = (entry, accountId, primaryBot) => {
		const agentId = entry.agentId;
		if (!primaryBot && !agentId) throw new Error(`Feishu bot ${accountId} requires agentId (identity directory under the agents root)`);
		const manifest = agentId ? readAgentManifest(agentsRoot, agentId) : void 0;
		const dataDir = entry.dataDir ?? (primaryBot ? void 0 : join(larkBotsRoot(), accountId));
		const workspaceRoot = agentId ? entry.workspaceRoot ?? join(agentsRoot, agentId) : entry.workspaceRoot;
		return {
			...base,
			...entry,
			...manifest ? { manifest } : {},
			...dataDir ? { dataDir } : {},
			...workspaceRoot ? { workspaceRoot } : {},
			accountId
		};
	};
	const bots = primary ? [resolveOne({
		...base,
		...primary
	}, "default", true)] : [];
	const seen = new Set(bots.map((bot) => bot.accountId));
	const appIds = new Set(bots.map((bot) => bot.appId));
	const dataDirs = new Set(bots.map((bot) => bot.dataDir !== void 0 ? resolve(dataDirectory(bot)) : "").filter(Boolean));
	let fileBots = [];
	if (botsFile) {
		const parsed = JSON.parse(readFileSync(botsFile, "utf8"));
		if (!Array.isArray(parsed)) throw new Error("Feishu botsFile must contain a JSON array");
		fileBots = parsed;
	}
	for (const bot of [...fileBots, ...config.bots ?? []]) {
		const accountId = bot.accountId.toLowerCase();
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId) || accountId === "default" || seen.has(accountId)) throw new Error(`invalid or duplicate Feishu bot accountId: ${bot.accountId}`);
		if (!bot.appId || !bot.appSecret) throw new Error(`Feishu bot ${accountId} requires appId/appSecret`);
		if (bot.agentId !== void 0 && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(bot.agentId)) throw new Error(`Feishu bot ${accountId} has invalid agentId: ${String(bot.agentId)}`);
		const resolved = resolveOne(bot, accountId, false);
		if (resolved.dataDir === void 0) throw new Error(`Feishu bot ${accountId} requires dataDir`);
		if (appIds.has(bot.appId) || dataDirs.has(resolve(resolved.dataDir))) throw new Error(`duplicate Feishu bot appId/dataDir: ${accountId}`);
		seen.add(accountId);
		appIds.add(bot.appId);
		dataDirs.add(resolve(resolved.dataDir));
		bots.push(resolved);
	}
	return bots;
}
/** Default per-account storage root: $DSH_HOME/lark/bots/<accountId>. */
function larkBotsRoot() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark", "bots");
}
/** Default identity root: $DSH_HOME/home/agents (agents/<agentId>/ tiers). */
function agentsRootDefault() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "home", "agents");
}
function resolveCredentials(config) {
	const appId = config.appId ?? process.env.FEISHU_APP_ID;
	const appSecret = config.appSecret ?? (config.appSecretEnv ? resolveSecretRef(config.appSecretEnv) : void 0) ?? process.env.FEISHU_APP_SECRET;
	return appId && appSecret ? {
		appId,
		appSecret
	} : void 0;
}
/**
* appSecretEnv 解析:先环境变量,再 $DSH_HOME/.credentials.yaml 的 refs: 段直读
* (feishu profile 下 credentials 服务未挂载;与 media-tools 同款兜底,只匹配 refs 段内缩进行)。
*/
function resolveSecretRef(ref) {
	const fromEnv = process.env[ref];
	if (fromEnv) return fromEnv;
	try {
		const text = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml"), "utf8");
		const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		let inRefs = false;
		for (const line of text.split(/\r?\n/)) {
			if (/^refs:\s*$/.test(line)) {
				inRefs = true;
				continue;
			}
			if (!inRefs) continue;
			if (/^\S/.test(line)) break;
			const match = line.match(new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`));
			if (match?.[1] && !match[1].startsWith("\"")) return match[1];
		}
	} catch {}
}
function dataDirectory(config) {
	return config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark");
}
//#endregion
//#region src/pdf.ts
const MAX_TEXT_CHARS = 5e5;
const MAX_PDF_PAGES = 20;
/** Extract PDF content at the channel boundary, before the model sees the message. */
async function pdfMessageContent(agent, fileName, bytes, logger, contentType) {
	if (!isPdf(fileName, contentType)) return void 0;
	try {
		const result = await readPdf(bytes, {
			maxPages: MAX_PDF_PAGES,
			maxTextChars: MAX_TEXT_CHARS
		});
		const text = result.text.trim();
		const blocks = [];
		const notes = [`以下是飞书 PDF「${fileName}」的自动解析内容，无需再调用 PDF 工具。`, "工具边界：自动解析的正文可直接阅读，无需重复调用 PDF 工具。可围绕文档核验少量关键行情，但不得把阅读任务扩展为全市场扫描；未获明确请求不得查询账户、持仓、委托或自选股等个人数据，也不要为同一目的反复调用等价工具。"];
		notes.push(`PDF 共 ${result.totalPages} 页，已处理前 ${result.processedPages} 页${result.images.length > 0 ? `，其中 ${result.images.length} 页补充页面图片` : ""}。`);
		if (result.truncated.images) notes.push(`仅处理前 ${MAX_PDF_PAGES} 页；其余 ${result.totalPages - result.processedPages} 页仍保存在原文件中。`);
		if (result.truncated.text) notes.push("文字层达到长度上限，已截断；请使用原始附件分段阅读。");
		for (const item of result.pageErrors) notes.push(item.error);
		if (text.length > 0) notes.push(`【提取的文本${text.length > MAX_TEXT_CHARS ? "（已截断）" : ""}】\n${text.slice(0, MAX_TEXT_CHARS)}`);
		if (result.images.length > 0) notes.push("请结合随后附上的 PDF 页面图片逐页阅读。");
		if (text.length === 0 && result.images.length === 0) notes.push("未能提取到文本或页面图片，请使用原始附件路径处理。");
		blocks.push({
			type: "text",
			text: notes.join("\n\n")
		});
		if (result.images.length > 0) {
			const attachments = agent.ctx.get("attachments");
			if (!attachments) throw new Error("PDF 页面需要附件服务，但当前会话未提供");
			const refs = await attachments.saveImages(result.images.map((image) => ({
				data: image.bytes,
				mediaType: image.mimeType,
				name: `${fileName}-page-${image.page}.png`
			})));
			for (let i = 0; i < refs.length; i++) {
				blocks.push({
					type: "text",
					text: `【${fileName} · 第 ${result.images[i]?.page} 页】`
				});
				blocks.push({
					type: "image",
					attachment: refs[i]
				});
			}
		}
		logger.info(`[lark] PDF auto-extracted: ${fileName} (text=${text.length}, pages=${result.images.length})`);
		return blocks;
	} catch (error) {
		logger.warn(`[lark] PDF auto-extraction failed: ${fileName}: ${String(error)}`);
		return [{
			type: "text",
			text: `飞书 PDF「${fileName}」自动解析失败：${String(error)}。原始附件路径如下，可用 pdf_read 重试。`
		}];
	}
}
//#endregion
//#region src/skill-sync.ts
/**
* Provision identity-level skills into a user's fenced workspace.
* Existing files are never overwritten; reference updates must be deliberate.
*/
async function syncIdentitySkills(agentsRoot, agentId, userCwd) {
	if (!agentId) return;
	const source = join(agentsRoot, agentId, ".dsh", "skills");
	const target = join(userCwd, ".dsh", "skills");
	try {
		await mkdir(target, {
			recursive: true,
			mode: 448
		});
		await cp(source, target, {
			recursive: true,
			force: false,
			errorOnExist: false
		});
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
}
//#endregion
//#region src/dedup-store.ts
/** JSON backing file for Feishu message IDs; contains no message content. */
var DedupStore = class {
	values = /* @__PURE__ */ new Map();
	constructor(path) {
		this.path = path;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
			for (const [id, seenAt] of Object.entries(parsed)) if (typeof seenAt === "number" && Number.isFinite(seenAt)) this.values.set(id, seenAt);
		} catch {}
	}
	get(id) {
		return this.values.get(id);
	}
	set(id, seenAt) {
		this.values.set(id, seenAt);
	}
	delete(id) {
		this.values.delete(id);
	}
	sweep(expiresBefore, maxEntries) {
		for (const [id, seenAt] of this.values) if (seenAt < expiresBefore || this.values.size > maxEntries) this.values.delete(id);
		else break;
		this.persist();
	}
	persist() {
		const temporary = `${this.path}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.values))}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {
			rmSync(temporary, { force: true });
		}
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/core/shutdown-hooks.js
/**
* Process-level graceful shutdown hook registry.
*
* Provides a singleton Map of async cleanup callbacks, drained
* during graceful shutdown by the channel monitor.
*/
const hooks = /* @__PURE__ */ new Map();
/**
* Register a cleanup callback to run during graceful shutdown.
*
* @param key - Unique identifier for this hook (duplicate keys overwrite).
* @param cleanup - Async function to execute on shutdown.
* @returns An unregister function — call it when the resource is
*          released normally (e.g. card streaming completes).
*/
function registerShutdownHook(key, cleanup) {
	hooks.set(key, cleanup);
	return () => {
		hooks.delete(key);
	};
}
//#endregion
//#region vendor/openclaw-lark/dist/card/reasoning-utils.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared utilities for the reasoning display subsystem.
*/
function normalizeToolName(name) {
	return name?.trim().toLowerCase() ?? "";
}
function truncateText(value, maxLength) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}
const INLINE_ASSIGNMENT_RE = /(^|[\s"'`])([A-Za-z_][A-Za-z0-9_]*)(=(?:"[^"]*"|'[^']*'|[^\s"'`]+))/g;
const AUTH_HEADER_SECRET_RE = /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^'"\s]+)/gi;
const QUOTED_HEADER_ARG_RE = /((?:^|[\s"'`])(?:-H|--header)\s+)(['"])([A-Za-z0-9_-]+)(\s*:\s*)([^'"]*)(\2)/gi;
const UNQUOTED_HEADER_ARG_RE = /((?:^|[\s"'`])(?:-H|--header)\s+)([A-Za-z0-9_-]+)(\s*:\s*)([^\s"'`]+)/gi;
const SECRET_FLAG_RE = /((?:^|[\s"'`]))(--?[A-Za-z0-9][A-Za-z0-9-]*)(=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"'`]+))/g;
const SENSITIVE_NAME_RE = /token|secret|password|api[_-]?key|authorization|cookie|credential|bearer|session[_-]?id|client[_-]?secret|access[_-]?key/i;
function redactInlineSecrets(value) {
	return value.replace(INLINE_ASSIGNMENT_RE, (match, prefix, key) => isSensitiveName(key) ? `${prefix}${key}=[redacted]` : match).replace(AUTH_HEADER_SECRET_RE, "$1[redacted]").replace(QUOTED_HEADER_ARG_RE, (match, prefix, quote, name, separator) => shouldRedactHeaderValue(name) ? `${prefix}${quote}${name}${separator}[redacted]${quote}` : match).replace(UNQUOTED_HEADER_ARG_RE, (match, prefix, name, separator) => shouldRedactHeaderValue(name) ? `${prefix}${name}${separator}[redacted]` : match).replace(SECRET_FLAG_RE, (match, prefix, flag, separator, doubleQuoted, singleQuoted, bare) => {
		if (!isSensitiveName(flag.replace(/^-+/, ""))) return match;
		return `${prefix}${flag}${separator}${doubleQuoted !== void 0 ? "\"[redacted]\"" : singleQuoted !== void 0 ? "'[redacted]'" : bare !== void 0 ? "[redacted]" : "[redacted]"}`;
	});
}
function isSensitiveName(value) {
	return SENSITIVE_NAME_RE.test(value);
}
function shouldRedactHeaderValue(name) {
	return !/^authorization$/i.test(name) && isSensitiveName(name);
}
const DEFAULT_SUMMARY_PREFERENCE = [
	"matched",
	"code",
	"quoted",
	"url",
	"line"
];
const TOOL_DESCRIPTORS = [
	{
		aliases: ["skill"],
		iconToken: "app-default_outlined",
		title: "Load skill",
		sanitizer: "skill",
		paramKeys: ["skill", "name"],
		summaryPatterns: [/^(?:load|use)\s+skill\s+(.+)$/i]
	},
	{
		aliases: ["read", "open"],
		iconToken: "file-link-text_outlined",
		title: "Read",
		sanitizer: "path",
		paramKeys: [
			"file_path",
			"path",
			"file"
		],
		summaryPatterns: [/^(?:read|open)\s+(?:file\s+)?(.+)$/i],
		summaryPreference: [
			"code",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: ["write", "edit"],
		iconToken: "edit_outlined",
		title: "Edit",
		sanitizer: "path",
		paramKeys: [
			"file_path",
			"path",
			"file"
		],
		summaryPatterns: [/^(?:edit|write)\s+(?:file\s+)?(.+)$/i],
		summaryPreference: [
			"code",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"web_search",
			"web-search",
			"search"
		],
		iconToken: "search_outlined",
		title: "Search web",
		sanitizer: "search",
		paramKeys: ["query", "q"],
		summaryPatterns: [/^(?:search\s+(?:web\s+)?(?:for|about)|query)\s+(.+)$/i],
		summaryPreference: [
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"web_fetch",
			"web-fetch",
			"fetch"
		],
		iconToken: "language_outlined",
		title: "Fetch web page",
		sanitizer: "url",
		paramKeys: ["url"],
		summaryPatterns: [/^(?:fetch|open)\s+(?:web\s+page\s+)?(?:from\s+)?(.+)$/i],
		summaryPreference: [
			"url",
			"matched",
			"quoted",
			"line"
		]
	},
	{
		aliases: ["grep"],
		iconToken: "doc-search_outlined",
		title: "Search text",
		sanitizer: "generic",
		detailFromParams: (params) => buildPatternDetail(params, { includeTarget: true }),
		summaryPatterns: [/^(?:search\s+text(?:\s+by\s+pattern)?|grep)\s+(.+)$/i]
	},
	{
		aliases: ["glob"],
		iconToken: "folder_outlined",
		title: "Search files",
		sanitizer: "generic",
		paramKeys: ["pattern"],
		summaryPatterns: [/^(?:search\s+files(?:\s+by\s+pattern)?|glob)\s+(.+)$/i]
	},
	{
		aliases: [
			"exec",
			"bash",
			"command",
			"run"
		],
		iconToken: "setting_outlined",
		title: "Run command",
		sanitizer: "command",
		paramKeys: [
			"description",
			"command",
			"script"
		],
		summaryPatterns: [/^(?:run|execute)\s+(?:command|script)?\s*(.+)$/i],
		summaryPreference: [
			"code",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"browser",
			"playwright",
			"navigate"
		],
		iconToken: "browser-mac_outlined",
		title: "Browser",
		sanitizer: "url",
		paramKeys: ["url"],
		summaryPatterns: [/^(?:open|browse|visit|navigate\s+to)\s+(.+)$/i],
		summaryPreference: [
			"url",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"agent",
			"task",
			"spawn"
		],
		iconToken: "robot_outlined",
		title: "Run sub-agent",
		sanitizer: "generic",
		paramKeys: [
			"task",
			"description",
			"prompt"
		],
		summaryPatterns: [/^(?:run\s+sub-?agent|spawn\s+agent)\s+(.+)$/i]
	},
	{
		aliases: [
			"check",
			"determine",
			"verify"
		],
		iconToken: "list-check_outlined",
		title: "Check",
		sanitizer: "generic",
		paramKeys: [
			"target",
			"subject",
			"description"
		]
	},
	{
		aliases: [
			"summarize",
			"analyze",
			"prepare"
		],
		iconToken: "report_outlined",
		title: "Analyze",
		sanitizer: "generic",
		paramKeys: [
			"target",
			"subject",
			"description"
		]
	}
];
function normalizeToolUseDisplay(params) {
	const traceSteps = params.traceSteps ?? [];
	const showFullPaths = params.showFullPaths === true;
	const showResultDetails = params.showResultDetails === true;
	const steps = traceSteps.map(toTraceSource).map((source) => formatToolStep(source, {
		showFullPaths,
		showResultDetails
	})).filter((step) => !!step);
	return {
		content: steps.map((step) => step.detail ? `- ${step.title}: ${step.detail}` : `- ${step.title}`).join("\n"),
		stepCount: steps.length,
		steps
	};
}
function buildToolUseTitleSuffix(params) {
	const { stepCount } = params;
	return {
		zh: `查看 ${stepCount} 个步骤`,
		en: `Show ${stepCount} step${stepCount === 1 ? "" : "s"}`
	};
}
function toTraceSource(step) {
	return {
		toolName: step.toolName,
		params: step.params,
		result: step.result,
		error: step.error,
		durationMs: step.durationMs,
		status: step.status
	};
}
function formatToolStep(source, options) {
	const descriptor = resolveToolDescriptor(source.toolName);
	const rawDetail = (descriptor ? extractDetailFromParams(source.params, descriptor) : void 0) ?? (descriptor ? extractDetailFromSummary(source.summaryText, descriptor) : cleanupLine(source.summaryText ?? "")) ?? void 0;
	const detail = rawDetail ? sanitizeToolDetail(descriptor?.sanitizer ?? "generic", rawDetail, options) : void 0;
	const title = buildToolTitle(source, descriptor, rawDetail);
	const status = resolveStepStatus(source);
	const errorBlock = source.error ? buildErrorBlock(source.error, descriptor) : void 0;
	const resultBlock = !errorBlock && options.showResultDetails ? buildResultBlock(source, descriptor) : void 0;
	return {
		title,
		detail,
		iconToken: descriptor?.iconToken ?? "setting-inter_outlined",
		status,
		resultBlock,
		errorBlock
	};
}
function buildToolTitle(source, descriptor, rawDetail) {
	const baseTitle = descriptor?.title === "Read" && rawDetail && isSkillPathValue(rawDetail) ? "Skill Read" : descriptor?.title ?? humanizeToolName(source.toolName ?? "tool");
	const durationLabel = source.durationMs != null ? formatDurationLabel(source.durationMs) : void 0;
	return durationLabel ? `${baseTitle} (${durationLabel})` : baseTitle;
}
function resolveToolDescriptor(toolName) {
	const normalizedName = normalizeToolName(toolName);
	return TOOL_DESCRIPTORS.find((descriptor) => descriptor.aliases.some((alias) => normalizedName === alias || normalizedName.startsWith(`${alias}_`) || normalizedName.startsWith(`${alias}-`)));
}
function extractDetailFromParams(params, descriptor) {
	if (!params) return void 0;
	if (descriptor.detailFromParams) return descriptor.detailFromParams(params);
	for (const key of descriptor.paramKeys ?? []) {
		const value = params[key];
		const text = extractScalarText(value);
		if (text) return text;
	}
}
function extractDetailFromSummary(summaryText, descriptor) {
	if (!summaryText) return void 0;
	const lines = summaryText.replace(/\r\n/g, "\n").split("\n").map((line) => cleanupLine(stripMarkdown(line))).filter((line) => line && !isNoiseLine(line));
	for (const line of lines) {
		const detail = pickSummaryDetail(buildSummarySignals(line, descriptor.summaryPatterns ?? []), descriptor.summaryPreference ?? DEFAULT_SUMMARY_PREFERENCE);
		if (detail) return detail;
	}
}
function buildSummarySignals(line, patterns) {
	return {
		line,
		matched: patterns.map((pattern) => line.match(pattern)?.[1]?.trim()).find((value) => Boolean(value)),
		code: extractFirstCodeSpan(line),
		quoted: extractFirstQuotedText(line),
		url: extractFirstUrl(line)
	};
}
function pickSummaryDetail(signals, preference) {
	for (const key of preference) {
		const value = signals[key];
		if (value) return value;
	}
}
function buildResultBlock(source, descriptor) {
	if (source.result == null) return void 0;
	if (descriptor && [
		"Read",
		"Edit",
		"Fetch web page",
		"Browser"
	].includes(descriptor.title)) return;
	return buildDisplayBlock(sanitizeDisplayBlockValue(source.result, descriptor));
}
function buildErrorBlock(error, descriptor) {
	return buildDisplayBlock(sanitizeDisplayBlockValue(error, descriptor), "text");
}
function sanitizeDisplayBlockValue(value, descriptor) {
	if (descriptor?.sanitizer === "command" && typeof value === "string") return redactInlineSecrets(value);
	return value;
}
function buildPatternDetail(params, options) {
	const pattern = extractScalarText(params.pattern);
	const target = extractScalarText(params.glob ?? params.path ?? params.file_path);
	if (pattern && target && options.includeTarget) return `${pattern} in ${target}`;
	return pattern ?? target ?? void 0;
}
function extractScalarText(value) {
	if (typeof value === "string") return value.trim() || void 0;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
}
function sanitizeToolDetail(kind, value, options) {
	if (kind === "command") {
		const cleaned = normalizeInlineDisplayText(value);
		if (!cleaned) return void 0;
		return sanitizeCommandLike(cleaned, options);
	}
	const cleaned = sanitizeGenericText(value);
	if (!cleaned) return void 0;
	switch (kind) {
		case "skill": return cleaned.replace(/^skill\s+/i, "").replace(/[-_]+/g, " ").trim() || "skill";
		case "path": return sanitizePathLike(cleaned, options);
		case "search": return stripQuotes(cleaned);
		case "url": return stripQuotes(cleaned).replace(/^from\s+/i, "");
		default: return cleaned;
	}
}
function normalizeInlineDisplayText(value) {
	return value.replace(/\s+/g, " ").trim();
}
function sanitizePathLike(value, options) {
	const cleaned = sanitizeGenericText(value).replace(/^(?:from|file|path)\s+/i, "").trim();
	if (options.showFullPaths) return cleaned;
	const skillMatch = cleaned.match(/(?:^|\/)skills\/([^/]+)\//i);
	if (skillMatch?.[1]) return skillMatch[1].replace(/[-_]+/g, " ").trim() || cleaned;
	return cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? cleaned;
}
function sanitizeCommandLike(value, options) {
	const cleaned = stripQuotes(value).replace(/^(?:command|script|description)\s+/i, "").replace(/^.*?\s+->\s+/i, "").trim();
	if (!cleaned) return "command";
	const redacted = redactInlineSecrets(cleaned);
	return options.showFullPaths ? redacted : redactCommandPaths(redacted);
}
function resolveStepStatus(source) {
	if (source.error) return "error";
	if (source.status) return source.status;
	return "success";
}
function buildDisplayBlock(value, fallbackLanguage = "json") {
	if (value == null) return void 0;
	if (typeof value === "string") {
		const normalized = value.replace(/\r\n/g, "\n").trim();
		if (!normalized) return void 0;
		const parsed = tryParseJson(normalized);
		if (parsed && typeof parsed === "object") {
			const prettyJson = stringifyJson(parsed);
			if (prettyJson) return {
				language: "json",
				content: prettyJson
			};
		}
		return {
			language: fallbackLanguage === "json" ? "text" : fallbackLanguage,
			content: normalized
		};
	}
	if (typeof value === "object") {
		const prettyJson = stringifyJson(value);
		if (prettyJson) return {
			language: "json",
			content: prettyJson
		};
	}
	const normalized = String(value).trim();
	return normalized ? {
		language: "text",
		content: normalized
	} : void 0;
}
function stringifyJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return;
	}
}
function tryParseJson(value) {
	const trimmed = value.trim();
	if (!trimmed || !/^(?:\{|\[)/.test(trimmed)) return;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
function redactCommandPaths(command) {
	return command.split(/(\s+)/).map((segment) => {
		if (!segment || /^\s+$/.test(segment)) return segment;
		return redactCommandToken(segment);
	}).join("");
}
function redactCommandToken(token) {
	const match = token.match(/^([("'`]*)(.*?)([)"'`,;:]*)$/);
	if (!match) return token;
	const [, prefix, rawCore, suffix] = match;
	return `${prefix}${redactPathAssignment(rawCore)}${suffix}`;
}
function redactPathAssignment(value) {
	const equalsIndex = value.indexOf("=");
	if (equalsIndex > 0) return `${value.slice(0, equalsIndex + 1)}${redactStandalonePath(value.slice(equalsIndex + 1))}`;
	return redactStandalonePath(value);
}
function redactStandalonePath(value) {
	if (/^https?:\/\//i.test(value)) return sanitizeUrlForDisplay(value);
	if (!looksLikePathToken(value)) return value;
	return basenameFromPath(value);
}
function sanitizeUrlForDisplay(url) {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		for (const key of [...parsed.searchParams.keys()]) if (/(secret|token|password|key|credential|bearer|auth)/i.test(key)) parsed.searchParams.set(key, "[redacted]");
		return parsed.toString();
	} catch {
		return url;
	}
}
function looksLikePathToken(value) {
	return value.startsWith("~/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.includes("/");
}
function basenameFromPath(value) {
	return value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? value;
}
function isSkillPathValue(value) {
	return /(?:^|\/)skills\/[^/]+\//i.test(value);
}
function sanitizeGenericText(value) {
	return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function cleanupLine(line) {
	return line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").replace(/\s+/g, " ").trim();
}
function stripMarkdown(line) {
	return line.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^>\s*/, "").trim();
}
function isNoiseLine(line) {
	return /^(?:completed|complete|done|success|succeeded|running|started|finished|ok)$/i.test(line);
}
function humanizeToolName(name) {
	const cleaned = name.replace(/[-_]+/g, " ").trim();
	if (!cleaned) return "Tool";
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
function formatDurationLabel(durationMs) {
	return durationMs < 1e3 ? `${durationMs} ms` : `${(durationMs / 1e3).toFixed(1)} s`;
}
function stripQuotes(value) {
	return value.replace(/^[`'"]+|[`'"]+$/g, "").trim();
}
function extractFirstCodeSpan(value) {
	return value.match(/`([^`]+)`/)?.[1]?.trim() || void 0;
}
function extractFirstQuotedText(value) {
	return value.match(/["']([^"']+)["']/)?.[1]?.trim() || void 0;
}
function extractFirstUrl(value) {
	return value.match(/\bhttps?:\/\/[^\s"'`]+/i)?.[0]?.trim() || void 0;
}
//#endregion
//#region vendor/openclaw-lark/dist/card/builder.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Interactive card building for Lark/Feishu.
*
* Provides utilities to construct Feishu Interactive Message Cards for
* different agent response states (thinking, streaming, complete, confirm).
*/
/**
* Element ID used for the streaming text area in cards. The CardKit
* `cardElement.content()` API targets this element for typewriter-effect
* streaming updates.
*/
const STREAMING_ELEMENT_ID = "streaming_content";
const TOOL_USE_STEP_CONTENT_INDENT = "0px 0px 0px 22px";
const REASONING_PREFIX = "Reasoning:\n";
/**
* Split a payload text into optional `reasoningText` and `answerText`.
*
* Handles two formats produced by the framework:
* 1. "Reasoning:\n_italic line_\n…" prefix (from `formatReasoningMessage`)
* 2. `<think>…</think>` / `<thinking>…</thinking>` XML tags
*
* Equivalent to the framework's `splitTelegramReasoningText()`.
*/
function splitReasoningText(text) {
	if (typeof text !== "string" || !text.trim()) return {};
	const trimmed = text.trim();
	if (trimmed.startsWith(REASONING_PREFIX) && trimmed.length > 11) return { reasoningText: cleanReasoningPrefix(trimmed) };
	const taggedReasoning = extractThinkingContent(text);
	const strippedAnswer = stripReasoningTags(text);
	if (!taggedReasoning && strippedAnswer === text) return { answerText: text };
	return {
		reasoningText: taggedReasoning || void 0,
		answerText: strippedAnswer || void 0
	};
}
/**
* Extract content from `<think>`, `<thinking>`, `<thought>` blocks.
* Handles both closed and unclosed (streaming) tags.
*/
function extractThinkingContent(text) {
	if (!text) return "";
	const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of text.matchAll(scanRe)) {
		const idx = match.index ?? 0;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = match[1] !== "/";
		lastIndex = idx + match[0].length;
	}
	if (inThinking) result += text.slice(lastIndex);
	return result.trim();
}
/**
* Strip reasoning blocks — both XML tags with their content and any
* "Reasoning:\n" prefixed content.
*/
function stripReasoningTags(text) {
	let result = text.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, "");
	result = result.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, "");
	result = result.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, "");
	return result.trim();
}
/**
* Clean a "Reasoning:\n_italic_" formatted message back to plain text.
* Strips the prefix and per-line italic markdown wrappers.
*/
function cleanReasoningPrefix(text) {
	let cleaned = text.replace(/^Reasoning:\s*/i, "");
	cleaned = cleaned.split("\n").map((line) => line.replace(/^_(.+)_$/, "$1")).join("\n");
	return cleaned.trim();
}
/**
* Format reasoning duration into a human-readable i18n pair.
* e.g. { zh: "思考了 3.2s", en: "Thought for 3.2s" }
*/
function formatReasoningDuration(ms) {
	const d = formatElapsed(ms);
	return {
		zh: `思考了 ${d}`,
		en: `Thought for ${d}`
	};
}
/**
* Format tool-use duration into a human-readable i18n pair.
*/
function formatToolUseDuration(ms) {
	const d = formatElapsed(ms);
	return {
		zh: `执行耗时 ${d}`,
		en: `Tool use for ${d}`
	};
}
/**
* Format milliseconds into a human-readable duration string.
*/
function formatElapsed(ms) {
	const seconds = ms / 1e3;
	return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
/**
* Build footer meta-info: notation-sized text with i18n support.
* Error text is rendered in red; normal text uses default grey (notation).
*/
function buildFooter(zhText, enText, isError) {
	const zhContent = isError ? `<font color='red'>${zhText}</font>` : zhText;
	const enContent = isError ? `<font color='red'>${enText}</font>` : enText;
	return [{
		tag: "markdown",
		content: enContent,
		i18n_content: {
			zh_cn: zhContent,
			en_us: enContent
		},
		text_size: "notation"
	}];
}
function compactNumber(value) {
	const abs = Math.abs(value);
	if (abs >= 1e6) {
		const m = value / 1e6;
		return Math.abs(m) >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`;
	}
	if (abs >= 1e3) {
		const k = value / 1e3;
		return Math.abs(k) >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
	}
	return `${Math.round(value)}`;
}
function formatFooterRuntimeSegments(params) {
	const { footer, metrics, elapsedMs, isError, isAborted } = params;
	const primaryZh = [];
	const primaryEn = [];
	const detailZh = [];
	const detailEn = [];
	if (footer?.status) if (isError) {
		primaryZh.push("出错");
		primaryEn.push("Error");
	} else if (isAborted) {
		primaryZh.push("已停止");
		primaryEn.push("Stopped");
	} else {
		primaryZh.push("已完成");
		primaryEn.push("Completed");
	}
	if (footer?.elapsed && elapsedMs != null) {
		const d = formatElapsed(elapsedMs);
		primaryZh.push(`耗时 ${d}`);
		primaryEn.push(`Elapsed ${d}`);
	}
	if (footer?.model && metrics?.model) {
		const model = metrics.model.trim();
		if (model) {
			primaryZh.push(model);
			primaryEn.push(model);
		}
	}
	if (footer?.tokens && metrics) {
		const inTokens = typeof metrics.inputTokens === "number" ? Math.max(0, metrics.inputTokens) : void 0;
		const outTokens = typeof metrics.outputTokens === "number" ? Math.max(0, metrics.outputTokens) : void 0;
		if (inTokens != null && outTokens != null) {
			const inLabel = compactNumber(inTokens);
			const outLabel = compactNumber(outTokens);
			detailZh.push(`↑ ${inLabel} ↓ ${outLabel}`);
			detailEn.push(`↑ ${inLabel} ↓ ${outLabel}`);
		}
	}
	if (footer?.cache && metrics) {
		const read = typeof metrics.cacheRead === "number" ? Math.max(0, metrics.cacheRead) : void 0;
		const write = typeof metrics.cacheWrite === "number" ? Math.max(0, metrics.cacheWrite) : void 0;
		const inputVal = typeof metrics.inputTokens === "number" ? Math.max(0, metrics.inputTokens) : void 0;
		if (read != null && write != null && inputVal != null) {
			const total = read + write + inputVal;
			const hit = total > 0 ? Math.round(read / total * 100) : 0;
			const left = compactNumber(read);
			const right = compactNumber(write);
			detailZh.push(`缓存 ${left}/${right} (${hit}%)`);
			detailEn.push(`Cache ${left}/${right} (${hit}%)`);
		}
	}
	if (footer?.context && metrics) {
		const freshTotal = metrics.totalTokensFresh === false ? void 0 : metrics.totalTokens;
		const total = typeof freshTotal === "number" ? Math.max(0, freshTotal) : void 0;
		const ctx = typeof metrics.contextTokens === "number" ? Math.max(0, metrics.contextTokens) : void 0;
		if (total != null && ctx != null) {
			const totalLabel = compactNumber(total);
			const ctxLabel = compactNumber(ctx);
			const pctLabel = `${ctx > 0 ? Math.round(total / ctx * 100) : 0}%`;
			detailZh.push(`上下文 ${totalLabel}/${ctxLabel} (${pctLabel})`);
			detailEn.push(`Context ${totalLabel}/${ctxLabel} (${pctLabel})`);
		}
	}
	return {
		primaryZh,
		primaryEn,
		detailZh,
		detailEn
	};
}
/**
* Build a full Feishu Interactive Message Card JSON object for the
* given state.
*/
function buildCardContent(state, data = {}) {
	switch (state) {
		case "thinking": return buildThinkingCard();
		case "streaming": return buildStreamingCard(data.text ?? "", {
			reasoningText: data.reasoningText,
			showToolUse: data.showToolUse,
			toolUseSteps: data.toolUseSteps,
			toolUseTitleSuffix: data.toolUseTitleSuffix
		});
		case "complete": return buildCompleteCard({
			text: data.text ?? "",
			elapsedMs: data.elapsedMs,
			isError: data.isError,
			reasoningText: data.reasoningText,
			reasoningElapsedMs: data.reasoningElapsedMs,
			toolUseSteps: data.toolUseSteps,
			toolUseTitleSuffix: data.toolUseTitleSuffix,
			toolUseElapsedMs: data.toolUseElapsedMs,
			showToolUse: data.showToolUse,
			isAborted: data.isAborted,
			footer: data.footer,
			footerMetrics: data.footerMetrics
		});
		case "confirm": return buildConfirmCard(data.confirmData);
		default: throw new Error(`Unknown card state: ${state}`);
	}
}
function buildThinkingCard() {
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true,
			locales: ["zh_cn", "en_us"]
		},
		elements: [{
			tag: "markdown",
			content: "Thinking...",
			i18n_content: {
				zh_cn: "思考中...",
				en_us: "Thinking..."
			}
		}]
	};
}
function buildStreamingCard(partialText, params = {}) {
	const { showToolUse = true, toolUseSteps, toolUseTitleSuffix, reasoningText } = params;
	const elements = [];
	const hasToolUse = Boolean(toolUseSteps?.length);
	if (showToolUse && hasToolUse) elements.push(buildToolUsePanel({
		toolUseSteps,
		titleSuffix: toolUseTitleSuffix
	}));
	if (!partialText && reasoningText) elements.push({
		tag: "markdown",
		content: `💭 **Thinking...**\n\n${reasoningText}`,
		i18n_content: {
			zh_cn: `💭 **思考中...**\n\n${reasoningText}`,
			en_us: `💭 **Thinking...**\n\n${reasoningText}`
		},
		text_size: "notation"
	});
	else if (partialText) elements.push({
		tag: "markdown",
		content: optimizeMarkdownStyle(partialText)
	});
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true,
			locales: ["zh_cn", "en_us"]
		},
		elements
	};
}
function buildCompleteCard(params) {
	const { text, elapsedMs, isError, reasoningText, reasoningElapsedMs, toolUseSteps, toolUseTitleSuffix, toolUseElapsedMs, showToolUse = true, isAborted, footer, footerMetrics } = params;
	const elements = [];
	if (showToolUse && toolUseSteps?.length) elements.push(buildToolUsePanel({
		toolUseSteps,
		toolUseElapsedMs,
		titleSuffix: toolUseTitleSuffix
	}));
	if (reasoningText) {
		const dur = reasoningElapsedMs ? formatReasoningDuration(reasoningElapsedMs) : null;
		const zhLabel = dur ? dur.zh : "思考";
		const enLabel = dur ? dur.en : "Thought";
		elements.push({
			tag: "collapsible_panel",
			expanded: false,
			header: {
				title: {
					tag: "markdown",
					content: `💭 ${enLabel}`,
					i18n_content: {
						zh_cn: `💭 ${zhLabel}`,
						en_us: `💭 ${enLabel}`
					}
				},
				vertical_align: "center",
				icon: {
					tag: "standard_icon",
					token: "down-small-ccm_outlined",
					size: "16px 16px"
				},
				icon_position: "follow_text",
				icon_expanded_angle: -180
			},
			border: {
				color: "grey",
				corner_radius: "5px"
			},
			vertical_spacing: "8px",
			padding: "8px 8px 8px 8px",
			elements: [{
				tag: "markdown",
				content: reasoningText,
				text_size: "notation"
			}]
		});
	}
	elements.push({
		tag: "markdown",
		content: optimizeMarkdownStyle(text)
	});
	const fp = formatFooterRuntimeSegments({
		footer,
		metrics: footerMetrics,
		elapsedMs,
		isError,
		isAborted
	});
	const footerZhLines = [];
	const footerEnLines = [];
	if (fp.primaryZh.length > 0) {
		footerZhLines.push(fp.primaryZh.join(" · "));
		footerEnLines.push(fp.primaryEn.join(" · "));
	}
	if (fp.detailZh.length > 0) {
		footerZhLines.push(fp.detailZh.join(" · "));
		footerEnLines.push(fp.detailEn.join(" · "));
	}
	if (footerZhLines.length > 0) elements.push(...buildFooter(footerZhLines.join("\n"), footerEnLines.join("\n"), isError));
	const summaryText = text.replace(/[*_`#>[\]()~]/g, "").trim();
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true,
			locales: ["zh_cn", "en_us"],
			summary: summaryText ? { content: summaryText.slice(0, 120) } : void 0
		},
		elements
	};
}
function buildConfirmCard(confirmData) {
	const elements = [];
	elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: confirmData.operationDescription
		}
	});
	if (confirmData.preview) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "div",
			text: {
				tag: "lark_md",
				content: `**Preview:**\n${confirmData.preview}`
			}
		});
	}
	elements.push({ tag: "hr" });
	elements.push({
		tag: "action",
		actions: [
			{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Confirm"
				},
				type: "primary",
				value: {
					action: "confirm_write",
					operation_id: confirmData.pendingOperationId
				}
			},
			{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Reject"
				},
				type: "danger",
				value: {
					action: "reject_write",
					operation_id: confirmData.pendingOperationId
				}
			},
			...confirmData.preview ? [] : [{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Preview"
				},
				type: "default",
				value: {
					action: "preview_write",
					operation_id: confirmData.pendingOperationId
				}
			}]
		]
	});
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true
		},
		header: {
			title: {
				tag: "plain_text",
				content: "🔒 Confirmation Required"
			},
			template: "orange"
		},
		elements
	};
}
/**
* Convert an old-format FeishuCard to CardKit JSON 2.0 format.
* JSON 2.0 uses `body.elements` instead of top-level `elements`.
*/
/**
* Build the initial CardKit 2.0 streaming card with a loading icon.
* Optionally includes a tool-use pending panel above the streaming area.
*/
function buildStreamingThinkingCard(showToolUse = true) {
	return buildStreamingPreAnswerCard({ showToolUse });
}
/**
* Build a CardKit 2.0 card for the pre-answer streaming phase.
* Used both for the initial card and for live updates during tool calls.
*/
function buildStreamingPreAnswerCard(params) {
	const { steps, elapsedMs, showToolUse = true, text = "" } = params;
	const hasSteps = Boolean(steps?.length);
	const elements = [];
	if (showToolUse && hasSteps && steps) elements.push(buildStreamingToolUseActivePanel({
		steps,
		elapsedMs
	}));
	elements.push({
		tag: "markdown",
		content: text,
		text_align: "left",
		text_size: "normal_v2",
		margin: "0px 0px 0px 0px",
		element_id: STREAMING_ELEMENT_ID
	});
	elements.push({
		tag: "markdown",
		content: " ",
		icon: {
			tag: "custom_icon",
			img_key: "img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg",
			size: "16px 16px"
		},
		element_id: "loading_icon"
	});
	return {
		schema: "2.0",
		config: {
			streaming_mode: true,
			locales: ["zh_cn", "en_us"],
			summary: {
				content: "Processing...",
				i18n_content: {
					zh_cn: "处理中...",
					en_us: "Processing..."
				}
			}
		},
		body: { elements }
	};
}
/**
* Build the collapsible panel for the active pre-answer phase.
* Used by buildStreamingPreAnswerCard when at least one step exists.
*/
function buildStreamingToolUseActivePanel(params) {
	const { steps, elapsedMs } = params;
	const enParts = ["Tool use"];
	const zhParts = ["工具执行"];
	if (steps.length > 0) {
		enParts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
		zhParts.push(`${steps.length} 步`);
	}
	if (elapsedMs != null && elapsedMs > 0) {
		const d = formatElapsed(elapsedMs);
		enParts.push(`(${d})`);
		zhParts.push(`(${d})`);
	}
	return {
		tag: "collapsible_panel",
		expanded: true,
		header: {
			title: {
				tag: "plain_text",
				content: `🛠️ ${enParts.join(" · ")}`,
				i18n_content: {
					zh_cn: `🛠️ ${zhParts.join(" · ")}`,
					en_us: `🛠️ ${enParts.join(" · ")}`
				},
				text_color: "grey",
				text_size: "notation"
			},
			vertical_align: "center",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				color: "grey",
				size: "16px 16px"
			},
			icon_position: "right",
			icon_expanded_angle: -180
		},
		border: {
			color: "grey",
			corner_radius: "5px"
		},
		vertical_spacing: "4px",
		padding: "8px 8px 8px 8px",
		elements: steps.flatMap((step) => buildToolUseStepElements(step))
	};
}
function toCardKit2(card) {
	const result = {
		schema: "2.0",
		config: card.config,
		body: { elements: card.elements }
	};
	if (card.header) result.header = card.header;
	return result;
}
function buildToolUsePanel(params) {
	const { toolUseSteps = [], toolUseElapsedMs, titleSuffix } = params;
	const duration = toolUseElapsedMs ? formatToolUseDuration(toolUseElapsedMs) : null;
	const zhTitleParts = [duration?.zh ?? "工具执行"];
	const enTitleParts = [duration?.en ?? "Tool use"];
	if (titleSuffix) {
		zhTitleParts.push(titleSuffix.zh);
		enTitleParts.push(titleSuffix.en);
	}
	const stepElements = toolUseSteps.length > 0 ? toolUseSteps.flatMap((step) => buildToolUseStepElements(step)) : [buildToolUsePlaceholder()];
	return {
		tag: "collapsible_panel",
		expanded: false,
		header: {
			title: {
				tag: "plain_text",
				content: `🛠️ ${enTitleParts.join(" · ")}`,
				i18n_content: {
					zh_cn: `🛠️ ${zhTitleParts.join(" · ")}`,
					en_us: `🛠️ ${enTitleParts.join(" · ")}`
				},
				text_color: "grey",
				text_size: "notation"
			},
			vertical_align: "center",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				color: "grey",
				size: "16px 16px"
			},
			icon_position: "right",
			icon_expanded_angle: -180
		},
		border: {
			color: "grey",
			corner_radius: "5px"
		},
		vertical_spacing: "4px",
		padding: "8px 8px 8px 8px",
		elements: stepElements
	};
}
function buildToolUseStepElements(step) {
	const elements = [buildToolUseStepTitleElement(step)];
	const detailElement = buildToolUseStepDetailElement(step);
	if (detailElement) elements.push(detailElement);
	const outputElement = buildToolUseStepOutputElement(step);
	if (outputElement) elements.push(outputElement);
	return elements;
}
function buildToolUsePlaceholder(labels) {
	const zh = labels?.zh ?? "暂无工具步骤";
	const en = labels?.en ?? "No tool steps available";
	return {
		tag: "div",
		text: {
			tag: "plain_text",
			content: en,
			i18n_content: {
				zh_cn: zh,
				en_us: en
			},
			text_color: "grey",
			text_size: "notation"
		}
	};
}
function buildToolUseStepTitleElement(step) {
	return {
		tag: "div",
		icon: {
			tag: "standard_icon",
			token: step.iconToken,
			color: "grey"
		},
		text: {
			tag: "lark_md",
			content: buildToolUseStepTitleMarkdown(step),
			text_size: "notation"
		}
	};
}
function buildToolUseStepTitleMarkdown(step) {
	const status = formatToolUseStepStatus(step.status);
	return optimizeMarkdownStyle(`**${escapeToolUseMarkdownText(step.title)}** · <font color='${status.color}'>${status.label}</font>`, 1);
}
function buildToolUseStepDetailElement(step) {
	const detail = step.detail?.trim();
	if (!detail) return void 0;
	return {
		tag: "div",
		margin: TOOL_USE_STEP_CONTENT_INDENT,
		text: {
			tag: "plain_text",
			content: detail,
			text_color: "grey",
			text_size: "notation"
		}
	};
}
function buildToolUseStepOutputElement(step) {
	const content = buildToolUseStepOutputMarkdown(step);
	if (!content) return void 0;
	return {
		tag: "div",
		margin: TOOL_USE_STEP_CONTENT_INDENT,
		text: {
			tag: "lark_md",
			content,
			text_size: "notation"
		}
	};
}
function buildToolUseStepOutputMarkdown(step) {
	const lines = [];
	if (step.errorBlock) {
		lines.push("**Error**");
		lines.push(formatToolUseCodeBlock(step.errorBlock.content, step.errorBlock.language));
	} else if (step.resultBlock) {
		lines.push("**Result**");
		lines.push(formatToolUseCodeBlock(step.resultBlock.content, step.resultBlock.language));
	}
	if (lines.length === 0) return void 0;
	return optimizeMarkdownStyle(lines.join("\n"), 1);
}
function formatToolUseStepStatus(status) {
	switch (status) {
		case "running": return {
			label: "Running",
			color: "turquoise"
		};
		case "error": return {
			label: "Failed",
			color: "red"
		};
		default: return {
			label: "Succeeded",
			color: "green"
		};
	}
}
function formatToolUseCodeBlock(content, language) {
	const normalized = content.replace(/\r\n/g, "\n").trim();
	const fence = "`".repeat(Math.max(3, longestBacktickRun(normalized) + 1));
	return `${fence}${language}\n${normalized}\n${fence}`;
}
function longestBacktickRun(value) {
	return (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
}
function escapeToolUseMarkdownText(value) {
	return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]<>])/g, "\\$1");
}
//#endregion
//#region vendor/openclaw-lark/dist/card/reply-dispatcher-types.js
const TERMINAL_PHASES = new Set([
	"completed",
	"aborted",
	"terminated",
	"creation_failed"
]);
const PHASE_TRANSITIONS = {
	idle: new Set([
		"creating",
		"aborted",
		"terminated"
	]),
	creating: new Set([
		"streaming",
		"creation_failed",
		"aborted",
		"terminated"
	]),
	streaming: new Set([
		"completed",
		"aborted",
		"terminated"
	]),
	completed: /* @__PURE__ */ new Set(),
	aborted: /* @__PURE__ */ new Set(),
	terminated: /* @__PURE__ */ new Set(),
	creation_failed: /* @__PURE__ */ new Set()
};
/**
* Throttle intervals for card updates.
*
* - `CARDKIT_MS`: CardKit `cardElement.content()` — designed for streaming,
*   low throttle is fine.
* - `PATCH_MS`: `im.message.patch` — strict rate limits (code 230020).
* - `LONG_GAP_THRESHOLD_MS`: After a long idle gap (tool call / LLM thinking),
*   defer the first flush briefly.
* - `BATCH_AFTER_GAP_MS`: Batching window after a long gap.
*/
const THROTTLE_CONSTANTS = {
	CARDKIT_MS: 100,
	PATCH_MS: 1500,
	LONG_GAP_THRESHOLD_MS: 2e3,
	BATCH_AFTER_GAP_MS: 300,
	REASONING_STATUS_MS: 1500
};
//#endregion
//#region vendor/openclaw-lark/dist/card/flush-controller.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Generic throttled flush controller.
*
* A pure scheduling primitive that manages timer-based throttling,
* mutex-guarded flushing, and reflush-on-conflict. Contains no
* business logic — the actual flush work is provided via a callback.
*/
var FlushController = class {
	doFlush;
	flushInProgress = false;
	flushResolvers = [];
	needsReflush = false;
	pendingFlushTimer = null;
	lastUpdateTime = 0;
	isCompleted = false;
	constructor(doFlush) {
		this.doFlush = doFlush;
	}
	/** Mark the controller as completed — no more flushes after current one. */
	complete() {
		this.isCompleted = true;
	}
	/** Cancel any pending deferred flush timer. */
	cancelPendingFlush() {
		if (this.pendingFlushTimer) {
			clearTimeout(this.pendingFlushTimer);
			this.pendingFlushTimer = null;
		}
	}
	/** Wait for any in-progress flush to finish. */
	waitForFlush() {
		if (!this.flushInProgress) return Promise.resolve();
		return new Promise((resolve) => this.flushResolvers.push(resolve));
	}
	/**
	* Execute a flush (mutex-guarded, with reflush on conflict).
	*
	* If a flush is already in progress, marks needsReflush so a
	* follow-up flush fires immediately after the current one completes.
	*/
	async flush() {
		if (!this.cardMessageReady() || this.flushInProgress || this.isCompleted) {
			if (this.flushInProgress && !this.isCompleted) this.needsReflush = true;
			return;
		}
		this.flushInProgress = true;
		this.needsReflush = false;
		this.lastUpdateTime = Date.now();
		try {
			await this.doFlush();
			this.lastUpdateTime = Date.now();
		} finally {
			this.flushInProgress = false;
			const resolvers = this.flushResolvers;
			this.flushResolvers = [];
			for (const resolve of resolvers) resolve();
			if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
				this.needsReflush = false;
				this.pendingFlushTimer = setTimeout(() => {
					this.pendingFlushTimer = null;
					this.flush();
				}, 0);
			}
		}
	}
	/**
	* Throttled update entry point.
	*
	* @param throttleMs - Minimum interval between flushes (varies by
	*   CardKit vs IM patch mode). Passed in by the caller so this
	*   controller remains business-logic-free.
	*/
	async throttledUpdate(throttleMs) {
		if (!this.cardMessageReady()) return;
		const now = Date.now();
		const elapsed = now - this.lastUpdateTime;
		if (elapsed >= throttleMs) {
			this.cancelPendingFlush();
			if (elapsed > THROTTLE_CONSTANTS.LONG_GAP_THRESHOLD_MS) {
				this.lastUpdateTime = now;
				this.pendingFlushTimer = setTimeout(() => {
					this.pendingFlushTimer = null;
					this.flush();
				}, THROTTLE_CONSTANTS.BATCH_AFTER_GAP_MS);
			} else await this.flush();
		} else if (!this.pendingFlushTimer) {
			const delay = throttleMs - elapsed;
			this.pendingFlushTimer = setTimeout(() => {
				this.pendingFlushTimer = null;
				this.flush();
			}, delay);
		}
	}
	/** Overridable gate: subclasses / consumers can set via setCardMessageReady. */
	_cardMessageReady = false;
	cardMessageReady() {
		return this._cardMessageReady;
	}
	setCardMessageReady(ready) {
		this._cardMessageReady = ready;
		if (ready) this.lastUpdateTime = Date.now();
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/card/image-resolver.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* ImageResolver — converts image URLs in markdown to Feishu image keys.
*
* Used by StreamingCardController to asynchronously download and upload
* images referenced via `![alt](https://...)` in model-generated markdown,
* replacing them with `![alt](img_xxx)` that Feishu cards can render.
*/
const log$4 = larkLogger("card/image-resolver");
/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
var ImageResolver = class {
	/** URL → imageKey for successfully uploaded images. */
	resolved = /* @__PURE__ */ new Map();
	/** URL → upload Promise for in-flight uploads (dedup). */
	pending = /* @__PURE__ */ new Map();
	/** URLs that have already failed — skip retries. */
	failed = /* @__PURE__ */ new Set();
	cfg;
	accountId;
	onImageResolved;
	constructor(opts) {
		this.cfg = opts.cfg;
		this.accountId = opts.accountId;
		this.onImageResolved = opts.onImageResolved;
	}
	/**
	* Synchronously resolve image URLs in markdown text.
	*
	* - `img_xxx` references are kept as-is.
	* - URLs with a cached imageKey are replaced inline.
	* - URLs with an in-flight upload are stripped (will appear after re-flush).
	* - New URLs trigger an async upload and are stripped for now.
	*/
	resolveImages(text) {
		if (!text.includes("![")) return text;
		return text.replace(IMAGE_RE, (fullMatch, alt, value) => {
			if (value.startsWith("img_")) return fullMatch;
			if (!value.startsWith("http://") && !value.startsWith("https://")) return "";
			const cached = this.resolved.get(value);
			if (cached) return `![${alt}](${cached})`;
			if (this.failed.has(value)) return "";
			if (this.pending.has(value)) return "";
			this.startUpload(value);
			return "";
		});
	}
	/**
	* Resolve all image URLs in text synchronously: trigger uploads for new
	* URLs, wait for all pending uploads, then return text with image keys.
	*/
	async resolveImagesAwait(text, timeoutMs) {
		this.resolveImages(text);
		if (this.pending.size > 0) {
			log$4.info("resolveImagesAwait: waiting for uploads", {
				count: this.pending.size,
				timeoutMs
			});
			const allUploads = Promise.all(this.pending.values());
			const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
			await Promise.race([allUploads, timeout]);
			if (this.pending.size > 0) log$4.warn("resolveImagesAwait: timed out with pending uploads", { remaining: this.pending.size });
		}
		return this.resolveImages(text);
	}
	startUpload(url) {
		const uploadPromise = this.doUpload(url);
		this.pending.set(url, uploadPromise);
	}
	async doUpload(url) {
		try {
			log$4.info("uploading image", { url });
			const buffer = await fetchRemoteImageBuffer(url);
			const { imageKey } = await uploadImageLark({
				cfg: this.cfg,
				image: buffer,
				imageType: "message",
				accountId: this.accountId
			});
			log$4.info("image uploaded", {
				url,
				imageKey
			});
			this.resolved.set(url, imageKey);
			this.pending.delete(url);
			this.onImageResolved();
			return imageKey;
		} catch (err) {
			log$4.warn("image upload failed", {
				url,
				error: String(err)
			});
			this.pending.delete(url);
			this.failed.add(url);
			return null;
		}
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/card/tool-use-trace-store.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Runtime store for structured tool-use steps.
*
* The Feishu card renderer reads from this store by session key so it can
* render observable, replayable tool execution without relying purely on
* reply payload text.
*/
const TRACE_TTL_MS = 1800 * 1e3;
const MAX_SESSION_TRACES = 128;
const MAX_STEPS_PER_SESSION = 256;
const STEP_RUNNING_TIMEOUT_MS = 300 * 1e3;
const GENERIC_STRING_LIMIT = 512;
const RESULT_STRING_LIMIT = 1024;
const COMMAND_STRING_LIMIT = 4096;
const PATH_STRING_LIMIT = 2048;
const sessionTraces = /* @__PURE__ */ new Map();
function startToolUseTraceRun(sessionKey) {
	if (!sessionKey) return;
	pruneTraceStore();
	sessionTraces.set(sessionKey, {
		nextSeq: 1,
		updatedAt: Date.now(),
		steps: [],
		currentRunId: void 0
	});
}
function clearToolUseTraceRun(sessionKey) {
	if (!sessionKey) return;
	sessionTraces.delete(sessionKey);
}
function recordToolUseStart(params) {
	const { sessionKey, toolName, toolParams, toolCallId, runId } = params;
	if (!sessionKey || !toolName) return;
	const state = sessionTraces.get(sessionKey);
	if (!state) return;
	if (runId) {
		if (state.currentRunId === void 0) state.currentRunId = runId;
		else if (state.currentRunId !== runId) return;
	}
	const now = Date.now();
	if (state.steps.length >= MAX_STEPS_PER_SESSION) state.steps.splice(0, state.steps.length - MAX_STEPS_PER_SESSION + 1);
	state.steps.push({
		id: `${state.nextSeq}`,
		seq: state.nextSeq,
		toolName,
		toolCallId: toolCallId || void 0,
		runId: runId || void 0,
		params: sanitizeTraceValue(toolParams, 0, { source: "params" }),
		status: "running",
		startedAt: now
	});
	state.nextSeq += 1;
	state.updatedAt = now;
}
function recordToolUseEnd(params) {
	const { sessionKey, toolName, toolParams, toolCallId, runId, result, error, durationMs } = params;
	if (!sessionKey || !toolName) return;
	const state = sessionTraces.get(sessionKey);
	if (!state) return;
	if (runId && state.currentRunId !== void 0 && state.currentRunId !== runId) return;
	const now = Date.now();
	const sanitizedParams = sanitizeTraceValue(toolParams, 0, { source: "params" });
	const pendingIndex = findPendingStepIndex(state.steps, toolName, sanitizedParams, toolCallId);
	if (pendingIndex >= 0) {
		const step = state.steps[pendingIndex];
		if (!step) return;
		step.status = error ? "error" : "success";
		step.result = sanitizeTraceValue(result, 0, { source: "result" });
		step.error = error ? truncateText(error, 160) : void 0;
		step.durationMs = durationMs;
		step.finishedAt = now;
		if (!step.params && sanitizedParams) step.params = sanitizedParams;
		state.updatedAt = now;
		return;
	}
	state.steps.push({
		id: `${state.nextSeq}`,
		seq: state.nextSeq,
		toolName,
		toolCallId: toolCallId || void 0,
		runId: runId || void 0,
		params: sanitizedParams,
		result: sanitizeTraceValue(result, 0, { source: "result" }),
		error: error ? truncateText(error, 160) : void 0,
		durationMs,
		status: error ? "error" : "success",
		startedAt: now,
		finishedAt: now
	});
	state.nextSeq += 1;
	state.updatedAt = now;
}
function getToolUseTraceSteps(sessionKey) {
	if (!sessionKey) return [];
	const state = sessionTraces.get(sessionKey);
	if (!state) return [];
	if (Date.now() - state.updatedAt > TRACE_TTL_MS) {
		sessionTraces.delete(sessionKey);
		return [];
	}
	const now = Date.now();
	return state.steps.map((step) => {
		if (step.status === "running" && now - step.startedAt > STEP_RUNNING_TIMEOUT_MS) return {
			...step,
			status: "error",
			error: "timed out",
			finishedAt: now
		};
		return { ...step };
	});
}
function findPendingStepIndex(steps, toolName, params, toolCallId) {
	if (toolCallId) for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || step.status !== "running") continue;
		if (step.toolCallId === toolCallId) return index;
	}
	const normalizedToolName = normalizeToolName(toolName);
	const paramsKey = fingerprintTraceValue(params);
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || step.status !== "running") continue;
		if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
		if (fingerprintTraceValue(step.params) !== paramsKey) continue;
		return index;
	}
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || step.status !== "running") continue;
		if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
		return index;
	}
	return -1;
}
function pruneTraceStore() {
	const now = Date.now();
	for (const [sessionKey, state] of sessionTraces) if (now - state.updatedAt > TRACE_TTL_MS) sessionTraces.delete(sessionKey);
	if (sessionTraces.size <= MAX_SESSION_TRACES) return;
	const overflow = sessionTraces.size - MAX_SESSION_TRACES;
	const entries = [...sessionTraces.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
	for (const [sessionKey] of entries.slice(0, overflow)) sessionTraces.delete(sessionKey);
}
function sanitizeTraceValue(value, depth = 0, context = {}) {
	if (value == null) return void 0;
	if (typeof value === "string") {
		const limit = resolveStringLimit(context);
		return truncateText(sanitizeTraceString(value, context), limit);
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 2) return "[truncated]";
	if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeTraceValue(item, depth + 1, { source: context.source }));
	if (typeof value === "object") {
		const input = value;
		const output = {};
		for (const [key, entryValue] of Object.entries(input).slice(0, 12)) output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeTraceValue(entryValue, depth + 1, {
			source: context.source,
			key
		});
		return output;
	}
	return truncateText(String(value), 180);
}
function sanitizeTraceString(value, context) {
	const redactedUrl = redactUrlParams(value);
	if (isCommandLikeKey(context.key)) return redactInlineSecrets(redactedUrl);
	return redactedUrl;
}
function resolveStringLimit(context) {
	const key = context.key?.toLowerCase() ?? "";
	if (/(?:^|_)(?:command|script|description|prompt|task)(?:$|_)/.test(key)) return COMMAND_STRING_LIMIT;
	if (/(?:^|_)(?:path|file|url|uri|cwd|folder|dir)(?:$|_)/.test(key)) return PATH_STRING_LIMIT;
	if (context.source === "result") return RESULT_STRING_LIMIT;
	return GENERIC_STRING_LIMIT;
}
function isCommandLikeKey(key) {
	const normalized = key?.toLowerCase() ?? "";
	return /(?:^|_)(?:command|script)(?:$|_)/.test(normalized);
}
const SENSITIVE_KEY_RE = /secret|token|password|authorization|cookie|api[-_]?key|credential|private[-_]?key|access[-_]?key|database[-_]?url|connection[-_]?string|bearer|signing[-_]?key|encryption[-_]?key|session[-_]?id|client[-_]?secret|auth[-_]?token/i;
function isSensitiveKey(key) {
	return SENSITIVE_KEY_RE.test(key);
}
function redactUrlParams(url) {
	return url.replace(/([?&])(api_key|token|secret|key)=[^&]*/gi, "$1$2=[redacted]");
}
function fingerprintTraceValue(value) {
	if (value == null) return "";
	if (typeof value !== "object") return String(value);
	return JSON.stringify(sortTraceValue(value));
}
function sortTraceValue(value) {
	if (Array.isArray(value)) return value.map((item) => sortTraceValue(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entryValue]) => [key, sortTraceValue(entryValue)]));
	return value;
}
//#endregion
//#region vendor/openclaw-lark/dist/card/unavailable-guard.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Guard against operating on unavailable (deleted/recalled) messages.
*
* Encapsulates the terminateDueToUnavailable / shouldSkipForUnavailable
* logic previously scattered as closures in reply-dispatcher.ts.
*/
const log$3 = larkLogger("card/unavailable-guard");
var UnavailableGuard = class {
	terminated = false;
	replyToMessageId;
	getCardMessageId;
	onTerminate;
	constructor(params) {
		this.replyToMessageId = params.replyToMessageId;
		this.getCardMessageId = params.getCardMessageId;
		this.onTerminate = params.onTerminate;
	}
	get isTerminated() {
		return this.terminated;
	}
	/**
	* Check whether the reply pipeline should skip further operations.
	* Returns true if the message is already known to be unavailable.
	*/
	shouldSkip(source) {
		if (this.terminated) return true;
		if (!this.replyToMessageId) return false;
		if (!isMessageUnavailable(this.replyToMessageId)) return false;
		return this.terminate(source);
	}
	/**
	* Attempt to terminate the reply pipeline due to an unavailable message.
	*
	* @param source - Descriptive label for the caller (for logging).
	* @param err    - Optional error that triggered the check.
	* @returns true if the pipeline was (or already had been) terminated.
	*/
	terminate(source, err) {
		if (this.terminated) return true;
		const fromError = isMessageUnavailableError(err) ? err : void 0;
		const cardMessageId = this.getCardMessageId();
		const state = getMessageUnavailableState(this.replyToMessageId) ?? getMessageUnavailableState(cardMessageId ?? void 0);
		let apiCode = fromError?.apiCode ?? state?.apiCode;
		if (!apiCode && err) {
			const detectedCode = extractLarkApiCode(err);
			if (isTerminalMessageApiCode(detectedCode)) {
				const fallbackMessageId = this.replyToMessageId ?? cardMessageId ?? void 0;
				if (fallbackMessageId) markMessageUnavailable({
					messageId: fallbackMessageId,
					apiCode: detectedCode,
					operation: source
				});
				apiCode = detectedCode;
			}
		}
		if (!apiCode) return false;
		this.terminated = true;
		this.onTerminate();
		const affectedMessageId = fromError?.messageId ?? this.replyToMessageId ?? cardMessageId ?? "unknown";
		log$3.warn("reply pipeline terminated by unavailable message", {
			source,
			apiCode,
			messageId: affectedMessageId
		});
		return true;
	}
};
//#endregion
//#region vendor/openclaw-lark/dist/card/streaming-card-controller.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Streaming card controller for the Lark/Feishu channel plugin.
*
* Manages the full lifecycle of a streaming CardKit card:
* idle → creating → streaming → completed / aborted / terminated.
*
* Delegates throttling to FlushController and message-unavailable
* detection to UnavailableGuard.
*/
const log$2 = larkLogger("card/streaming");
var StreamingCardController = class {
	phase = "idle";
	cardKit = {
		cardKitCardId: null,
		originalCardKitCardId: null,
		cardKitSequence: 0,
		cardMessageId: null
	};
	text = {
		accumulatedText: "",
		completedText: "",
		streamingPrefix: "",
		lastPartialText: "",
		lastFlushedText: ""
	};
	reasoning = {
		accumulatedReasoningText: "",
		reasoningStartTime: null,
		reasoningElapsedMs: 0,
		isReasoningPhase: false
	};
	toolUse = {
		startedAt: null,
		elapsedMs: 0,
		isActive: false
	};
	flush;
	guard;
	imageResolver;
	createEpoch = 0;
	_terminalReason = null;
	dispatchFullyComplete = false;
	cardCreationPromise = null;
	disposeShutdownHook = null;
	dispatchStartTime = Date.now();
	deps;
	elapsed() {
		return Date.now() - this.dispatchStartTime;
	}
	needsFooterMetrics() {
		const footer = this.deps.resolvedFooter;
		return footer.tokens || footer.cache || footer.context || footer.model;
	}
	async getFooterSessionMetrics() {
		try {
			const runtime = LarkClient.runtime;
			if (!runtime) return void 0;
			const cfgWithSession = this.deps.cfg;
			const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
			const key = this.deps.sessionKey.trim().toLowerCase();
			const defaultAgentId = resolveDefaultAgentId(this.deps.cfg);
			const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
			const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];
			const sessionApi = runtime.agent?.session;
			if (sessionApi?.resolveStorePath && sessionApi?.loadSessionStore) {
				const storePath = sessionApi.resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
				const store = sessionApi.loadSessionStore(storePath);
				let entry;
				let matchedKey;
				for (const candidate of candidateKeys) {
					const val = store[candidate];
					if (val && typeof val === "object") {
						entry = val;
						matchedKey = candidate;
						break;
					}
				}
				if (!entry) {
					log$2.debug("footer metrics lookup: session entry missing", {
						sessionKey: this.deps.sessionKey,
						candidateKeys,
						storePath,
						source: "runtime.agent.session"
					});
					return;
				}
				const metrics = {
					inputTokens: typeof entry.inputTokens === "number" ? entry.inputTokens : void 0,
					outputTokens: typeof entry.outputTokens === "number" ? entry.outputTokens : void 0,
					cacheRead: typeof entry.cacheRead === "number" ? entry.cacheRead : void 0,
					cacheWrite: typeof entry.cacheWrite === "number" ? entry.cacheWrite : void 0,
					totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : void 0,
					totalTokensFresh: typeof entry.totalTokensFresh === "boolean" ? entry.totalTokensFresh : void 0,
					contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : void 0,
					model: typeof entry.model === "string" ? entry.model : void 0
				};
				log$2.debug("footer metrics lookup: session entry found", {
					sessionKey: this.deps.sessionKey,
					matchedKey,
					storePath,
					source: "runtime.agent.session"
				});
				return metrics;
			}
			const channelSession = runtime.channel?.session;
			if (!channelSession?.resolveStorePath) return;
			const storePath = channelSession.resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
			const raw = await readFile(storePath, "utf8");
			const parsed = JSON.parse(raw);
			const store = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
			let entry;
			let matchedKey;
			for (const candidate of candidateKeys) {
				const val = store[candidate];
				if (val && typeof val === "object") {
					entry = val;
					matchedKey = candidate;
					break;
				}
			}
			if (!entry) {
				log$2.debug("footer metrics lookup: session entry missing", {
					sessionKey: this.deps.sessionKey,
					candidateKeys,
					storePath,
					source: "channel.session.file"
				});
				return;
			}
			const metrics = {
				inputTokens: typeof entry.inputTokens === "number" ? entry.inputTokens : void 0,
				outputTokens: typeof entry.outputTokens === "number" ? entry.outputTokens : void 0,
				cacheRead: typeof entry.cacheRead === "number" ? entry.cacheRead : void 0,
				cacheWrite: typeof entry.cacheWrite === "number" ? entry.cacheWrite : void 0,
				totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : void 0,
				totalTokensFresh: typeof entry.totalTokensFresh === "boolean" ? entry.totalTokensFresh : void 0,
				contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : void 0,
				model: typeof entry.model === "string" ? entry.model : void 0
			};
			log$2.debug("footer metrics lookup: session entry found", {
				sessionKey: this.deps.sessionKey,
				matchedKey,
				storePath,
				source: "channel.session.file"
			});
			return metrics;
		} catch (err) {
			log$2.warn("footer metrics lookup failed", {
				error: String(err),
				sessionKey: this.deps.sessionKey
			});
			return;
		}
	}
	constructor(deps) {
		this.deps = deps;
		this.guard = new UnavailableGuard({
			replyToMessageId: deps.replyToMessageId,
			getCardMessageId: () => this.cardKit.cardMessageId,
			onTerminate: () => {
				this.transition("terminated", "UnavailableGuard", "unavailable");
			}
		});
		this.flush = new FlushController(() => this.performFlush());
		this.imageResolver = new ImageResolver({
			cfg: deps.cfg,
			accountId: deps.accountId,
			onImageResolved: () => {
				if (!this.isTerminalPhase && this.cardKit.cardMessageId) this.throttledCardUpdate();
			}
		});
	}
	get cardMessageId() {
		return this.cardKit.cardMessageId;
	}
	get isTerminalPhase() {
		return TERMINAL_PHASES.has(this.phase);
	}
	/**
	* Whether the card has been explicitly aborted (via abortCard()).
	*
	* Distinct from isTerminalPhase — creation_failed is NOT an abort;
	* it should allow fallthrough to static delivery in the factory.
	*/
	get isAborted() {
		return this.phase === "aborted";
	}
	/** Whether the reply pipeline was terminated due to an unavailable message. */
	get isTerminated() {
		return this.guard.isTerminated;
	}
	/** Check if the pipeline should skip further operations for this source. */
	shouldSkipForUnavailable(source) {
		return this.guard.shouldSkip(source);
	}
	/** Attempt to terminate the pipeline due to an unavailable message error. */
	terminateIfUnavailable(source, err) {
		return this.guard.terminate(source, err);
	}
	/** Why the controller entered a terminal phase, or null if still active. */
	get terminalReason() {
		return this._terminalReason;
	}
	/** @internal — exposed for test assertions only. */
	get currentPhase() {
		return this.phase;
	}
	get shouldDisplayToolUse() {
		return this.deps.toolUseDisplay.showToolUse;
	}
	computeToolUseDisplay() {
		if (!this.shouldDisplayToolUse) return null;
		return normalizeToolUseDisplay({
			traceSteps: getToolUseTraceSteps(this.deps.sessionKey),
			showFullPaths: this.deps.toolUseDisplay.showFullPaths,
			showResultDetails: this.deps.toolUseDisplay.showToolResultDetails
		});
	}
	get visibleToolUseElapsedMs() {
		if (!this.shouldDisplayToolUse || !this.toolUse.startedAt) return;
		return this.toolUse.elapsedMs || Date.now() - this.toolUse.startedAt;
	}
	computeToolUseTitleSuffix(display) {
		if (!this.shouldDisplayToolUse) return void 0;
		const stepCount = display?.stepCount ?? 0;
		return stepCount > 0 ? buildToolUseTitleSuffix({ stepCount }) : void 0;
	}
	/**
	* Unified callback guard — returns true if the pipeline is active
	* and the callback should proceed.
	*
	* Combines three checks:
	* 1. guard.isTerminated — message recalled/deleted
	* 2. guard.shouldSkip(source) — eagerly detect unavailable messages
	* 3. isTerminalPhase — completed/aborted/terminated/creation_failed
	*/
	shouldProceed(source) {
		if (this.guard.isTerminated || this.guard.shouldSkip(source)) return false;
		return !this.isTerminalPhase;
	}
	isStaleCreate(epoch) {
		return epoch !== this.createEpoch;
	}
	transition(to, source, reason) {
		const from = this.phase;
		if (from === to) return false;
		if (!PHASE_TRANSITIONS[from].has(to)) {
			log$2.warn("phase transition rejected", {
				from,
				to,
				source
			});
			return false;
		}
		this.phase = to;
		log$2.info("phase transition", {
			from,
			to,
			source,
			reason
		});
		if (TERMINAL_PHASES.has(to)) {
			this._terminalReason = reason ?? null;
			this.onEnterTerminalPhase();
		}
		return true;
	}
	onEnterTerminalPhase() {
		this.createEpoch += 1;
		this.flush.cancelPendingFlush();
		this.flush.complete();
		this.disposeShutdownHook?.();
		this.disposeShutdownHook = null;
		if (this.phase === "terminated" || this.phase === "creation_failed") clearToolUseTraceRun(this.deps.sessionKey);
	}
	markToolUseActivity() {
		if (!this.toolUse.startedAt) this.toolUse.startedAt = Date.now();
		this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
		this.toolUse.isActive = true;
	}
	captureToolUseElapsed() {
		if (!this.toolUse.startedAt) return;
		this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
		this.toolUse.isActive = false;
	}
	/**
	* Handle a deliver() call in streaming card mode.
	*
	* Accumulates text from the SDK's deliver callbacks to build the
	* authoritative "completedText" for the final card.
	*/
	async onDeliver(payload) {
		if (!this.shouldProceed("onDeliver")) return;
		const text = payload.text ?? "";
		if (!text.trim()) return;
		await this.ensureCardCreated();
		if (!this.shouldProceed("onDeliver.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		this.captureToolUseElapsed();
		const split = splitReasoningText(text);
		if (split.reasoningText && !split.answerText) {
			this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime ? Date.now() - this.reasoning.reasoningStartTime : 0;
			this.reasoning.accumulatedReasoningText = split.reasoningText;
			this.reasoning.isReasoningPhase = true;
			await this.throttledCardUpdate();
			return;
		}
		this.reasoning.isReasoningPhase = false;
		if (split.reasoningText) this.reasoning.accumulatedReasoningText = split.reasoningText;
		const answerText = split.answerText ?? text;
		this.text.completedText += (this.text.completedText ? "\n\n" : "") + answerText;
		if (!this.text.lastPartialText && !this.text.streamingPrefix) {
			this.text.accumulatedText += (this.text.accumulatedText ? "\n\n" : "") + answerText;
			this.text.streamingPrefix = this.text.accumulatedText;
			await this.throttledCardUpdate();
		}
	}
	async onReasoningStream(payload) {
		if (!this.shouldProceed("onReasoningStream")) return;
		await this.ensureCardCreated();
		if (!this.shouldProceed("onReasoningStream.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		const rawText = payload.text ?? "";
		if (!rawText) return;
		if (!this.reasoning.reasoningStartTime) this.reasoning.reasoningStartTime = Date.now();
		this.reasoning.isReasoningPhase = true;
		const split = splitReasoningText(rawText);
		this.reasoning.accumulatedReasoningText = split.reasoningText ?? rawText;
		await this.throttledCardUpdate();
	}
	async onToolStart(payload) {
		if (!this.shouldProceed("onToolStart")) return;
		if (!this.shouldDisplayToolUse) return;
		if (payload.phase && payload.phase !== "start") return;
		this.markToolUseActivity();
		await this.ensureCardCreated();
		if (!this.shouldProceed("onToolStart.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		if (this.cardKit.cardKitCardId) {
			await this.throttledToolUseStatusUpdate();
			return;
		}
		await this.throttledCardUpdate();
	}
	async onToolPayload(_payload) {
		if (!this.shouldProceed("onToolPayload")) return;
		if (!this.shouldDisplayToolUse) return;
		this.markToolUseActivity();
		await this.ensureCardCreated();
		if (!this.shouldProceed("onToolPayload.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		if (this.cardKit.cardKitCardId) {
			await this.throttledToolUseStatusUpdate();
			return;
		}
		await this.throttledCardUpdate();
	}
	async onPartialReply(payload) {
		if (!this.shouldProceed("onPartialReply")) return;
		const rawText = payload.text ?? "";
		const split = splitReasoningText(rawText);
		if (split.reasoningText) {
			if (!this.reasoning.reasoningStartTime) this.reasoning.reasoningStartTime = Date.now();
			this.reasoning.accumulatedReasoningText = split.reasoningText;
			this.reasoning.isReasoningPhase = true;
		}
		const text = split.answerText ?? stripReasoningTags(rawText);
		log$2.debug("onPartialReply", { len: text.length });
		if (!text) return;
		this.captureToolUseElapsed();
		if (!this.reasoning.reasoningStartTime) this.reasoning.reasoningStartTime = Date.now();
		if (this.reasoning.isReasoningPhase) {
			this.reasoning.isReasoningPhase = false;
			this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime ? Date.now() - this.reasoning.reasoningStartTime : 0;
		}
		if (this.text.lastPartialText && text.length < this.text.lastPartialText.length) this.text.streamingPrefix += (this.text.streamingPrefix ? "\n\n" : "") + this.text.lastPartialText;
		this.text.lastPartialText = text;
		this.text.accumulatedText = this.text.streamingPrefix ? this.text.streamingPrefix + "\n\n" + text : text;
		if (!this.text.streamingPrefix && "NO_REPLY".startsWith(this.text.accumulatedText.trim())) {
			log$2.debug("onPartialReply: buffering NO_REPLY prefix");
			return;
		}
		await this.ensureCardCreated();
		if (!this.shouldProceed("onPartialReply.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		await this.throttledCardUpdate();
	}
	async onError(err, info) {
		if (this.guard.terminate("onError", err)) return;
		log$2.error(`${info.kind} reply failed`, { error: String(err) });
		this.captureToolUseElapsed();
		this.finalizeCard("onError", "error");
		await this.flush.waitForFlush();
		if (this.cardCreationPromise) await this.cardCreationPromise;
		const errorEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
		const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : void 0;
		const toolUseDisplay = this.computeToolUseDisplay();
		try {
			if (this.cardKit.cardMessageId) {
				const terminalContent = prepareTerminalCardContent({
					text: this.text.accumulatedText ? `${this.text.accumulatedText}\n\n---\n**Error**: An error occurred while generating the response.` : "**Error**: An error occurred while generating the response.",
					reasoningText: this.reasoning.accumulatedReasoningText || void 0
				}, this.imageResolver);
				const errorCard = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: toolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(toolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs: this.elapsed(),
					isError: true,
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				if (errorEffectiveCardId) await this.closeStreamingAndUpdate(errorEffectiveCardId, errorCard, "onError");
				else await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card: errorCard,
					accountId: this.deps.accountId
				});
			}
		} catch {} finally {
			clearToolUseTraceRun(this.deps.sessionKey);
		}
	}
	async onIdle() {
		if (this.guard.isTerminated || this.guard.shouldSkip("onIdle")) return;
		if (!this.dispatchFullyComplete) return;
		if (this.isTerminalPhase) return;
		this.captureToolUseElapsed();
		this.finalizeCard("onIdle", "normal");
		await this.flush.waitForFlush();
		if (this.cardCreationPromise) {
			await this.cardCreationPromise;
			await new Promise((resolve) => setTimeout(resolve, 0));
			await this.flush.waitForFlush();
		}
		const idleEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
		try {
			if (this.cardKit.cardMessageId) {
				if (idleEffectiveCardId) {
					const seqBeforeClose = this.cardKit.cardKitSequence;
					this.cardKit.cardKitSequence += 1;
					log$2.info("onIdle: closing streaming mode", {
						seqBefore: seqBeforeClose,
						seqAfter: this.cardKit.cardKitSequence
					});
					await setCardStreamingMode({
						cfg: this.deps.cfg,
						cardId: idleEffectiveCardId,
						streamingMode: false,
						sequence: this.cardKit.cardKitSequence,
						accountId: this.deps.accountId
					});
				}
				const isNoReplyLeak = !this.text.completedText && "NO_REPLY".startsWith(this.text.accumulatedText.trim());
				const displayText = this.text.completedText || (isNoReplyLeak ? "" : this.text.accumulatedText) || "Done.";
				if (!this.text.completedText && !this.text.accumulatedText) log$2.warn("reply completed without visible text, using empty-reply fallback");
				const resolvedDisplayText = await this.imageResolver.resolveImagesAwait(displayText, 15e3);
				const idleToolUseDisplay = this.computeToolUseDisplay();
				const terminalContent = prepareTerminalCardContent({
					text: resolvedDisplayText,
					reasoningText: this.reasoning.accumulatedReasoningText || void 0
				}, this.imageResolver);
				const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : void 0;
				const completeCard = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: idleToolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(idleToolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs: this.elapsed(),
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				if (idleEffectiveCardId) {
					const seqBeforeUpdate = this.cardKit.cardKitSequence;
					this.cardKit.cardKitSequence += 1;
					log$2.info("onIdle: updating final card", {
						seqBefore: seqBeforeUpdate,
						seqAfter: this.cardKit.cardKitSequence
					});
					await updateCardKitCard({
						cfg: this.deps.cfg,
						cardId: idleEffectiveCardId,
						card: toCardKit2(completeCard),
						sequence: this.cardKit.cardKitSequence,
						accountId: this.deps.accountId
					});
				} else await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card: completeCard,
					accountId: this.deps.accountId
				});
				log$2.info("reply completed, card finalized", {
					elapsedMs: this.elapsed(),
					isCardKit: !!idleEffectiveCardId
				});
			}
		} catch (err) {
			log$2.warn("final card update failed", { error: String(err) });
		} finally {
			clearToolUseTraceRun(this.deps.sessionKey);
		}
	}
	markFullyComplete() {
		log$2.debug("markFullyComplete", {
			completedTextLen: this.text.completedText.length,
			accumulatedTextLen: this.text.accumulatedText.length
		});
		this.dispatchFullyComplete = true;
	}
	async abortCard() {
		try {
			this.captureToolUseElapsed();
			if (!this.transition("aborted", "abortCard", "abort")) return;
			await this.flush.waitForFlush();
			if (this.cardCreationPromise) await this.cardCreationPromise;
			const effectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
			const elapsedMs = Date.now() - this.dispatchStartTime;
			const abortToolUseDisplay = this.computeToolUseDisplay();
			const terminalContent = prepareTerminalCardContent({
				text: this.text.accumulatedText || "Aborted.",
				reasoningText: this.reasoning.accumulatedReasoningText || void 0
			}, this.imageResolver);
			const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : void 0;
			if (effectiveCardId) {
				const abortCardContent = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: abortToolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs,
					isAborted: true,
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				await this.closeStreamingAndUpdate(effectiveCardId, abortCardContent, "abortCard");
				log$2.info("abortCard completed", { effectiveCardId });
			} else if (this.cardKit.cardMessageId) {
				const abortCard = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: abortToolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs,
					isAborted: true,
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card: abortCard,
					accountId: this.deps.accountId
				});
				log$2.info("abortCard completed (IM fallback)", { messageId: this.cardKit.cardMessageId });
			}
		} catch (err) {
			log$2.warn("abortCard failed", { error: String(err) });
		} finally {
			clearToolUseTraceRun(this.deps.sessionKey);
		}
	}
	async ensureCardCreated() {
		if (this.guard.shouldSkip("ensureCardCreated.precheck")) return;
		if (this.cardKit.cardMessageId || this.phase === "creation_failed" || this.isTerminalPhase) return;
		if (this.cardCreationPromise) {
			await this.cardCreationPromise;
			return;
		}
		if (!this.transition("creating", "ensureCardCreated")) return;
		this.createEpoch += 1;
		const epoch = this.createEpoch;
		this.cardCreationPromise = (async () => {
			try {
				try {
					const cId = await createCardEntity({
						cfg: this.deps.cfg,
						card: buildStreamingThinkingCard(this.deps.toolUseDisplay.showToolUse),
						accountId: this.deps.accountId
					});
					if (this.isStaleCreate(epoch)) {
						log$2.info("ensureCardCreated: stale epoch after createCardEntity, bailing out", {
							epoch,
							phase: this.phase
						});
						return;
					}
					if (cId) {
						this.cardKit.cardKitCardId = cId;
						this.cardKit.originalCardKitCardId = cId;
						this.cardKit.cardKitSequence = 1;
						this.disposeShutdownHook = registerShutdownHook(`streaming-card:${cId}`, () => this.abortCard());
						log$2.info("created CardKit entity", {
							cardId: cId,
							initialSequence: this.cardKit.cardKitSequence
						});
						const result = await sendCardByCardId({
							cfg: this.deps.cfg,
							to: this.deps.chatId,
							cardId: cId,
							replyToMessageId: this.deps.replyToMessageId,
							replyInThread: this.deps.replyInThread,
							accountId: this.deps.accountId
						});
						if (this.isStaleCreate(epoch)) {
							log$2.info("ensureCardCreated: stale epoch after sendCardByCardId, bailing out", {
								epoch,
								phase: this.phase
							});
							this.disposeShutdownHook?.();
							this.disposeShutdownHook = null;
							return;
						}
						this.cardKit.cardMessageId = result.messageId;
						this.flush.setCardMessageReady(true);
						if (!this.transition("streaming", "ensureCardCreated.cardkit")) {
							this.disposeShutdownHook?.();
							this.disposeShutdownHook = null;
							return;
						}
						log$2.info("sent CardKit card", { messageId: result.messageId });
					} else throw new Error("card.create returned empty card_id");
				} catch (cardKitErr) {
					if (this.isStaleCreate(epoch)) return;
					if (this.guard.terminate("ensureCardCreated.cardkitFlow", cardKitErr)) return;
					const apiDetail = extractApiDetail(cardKitErr);
					log$2.warn("CardKit flow failed, falling back to IM", { apiDetail });
					this.cardKit.cardKitCardId = null;
					this.cardKit.originalCardKitCardId = null;
					const fallbackCard = buildCardContent("streaming", { showToolUse: this.deps.toolUseDisplay.showToolUse });
					const result = await sendCardFeishu({
						cfg: this.deps.cfg,
						to: this.deps.chatId,
						card: fallbackCard,
						replyToMessageId: this.deps.replyToMessageId,
						replyInThread: this.deps.replyInThread,
						accountId: this.deps.accountId
					});
					if (this.isStaleCreate(epoch)) {
						log$2.info("ensureCardCreated: stale epoch after IM fallback send, bailing out", {
							epoch,
							phase: this.phase
						});
						return;
					}
					this.cardKit.cardMessageId = result.messageId;
					this.flush.setCardMessageReady(true);
					if (!this.transition("streaming", "ensureCardCreated.imFallback")) return;
					log$2.info("sent fallback IM card", { messageId: result.messageId });
				}
			} catch (err) {
				if (this.isStaleCreate(epoch)) return;
				if (this.guard.terminate("ensureCardCreated.outer", err)) return;
				log$2.warn("thinking card failed, falling back to static", { error: String(err) });
				this.transition("creation_failed", "ensureCardCreated.outer", "creation_failed");
			}
		})();
		await this.cardCreationPromise;
	}
	async performFlush() {
		if (!this.cardKit.cardMessageId || this.isTerminalPhase) return;
		if (!this.cardKit.cardKitCardId && this.cardKit.originalCardKitCardId) {
			log$2.debug("performFlush: skipping (CardKit streaming disabled, awaiting final update)");
			return;
		}
		log$2.debug("flushCardUpdate: enter", {
			seq: this.cardKit.cardKitSequence,
			isCardKit: !!this.cardKit.cardKitCardId
		});
		try {
			const displayText = this.buildDisplayText();
			const resolvedText = this.imageResolver.resolveImages(displayText);
			if (this.cardKit.cardKitCardId) {
				if (resolvedText !== this.text.lastFlushedText) {
					const prevSeq = this.cardKit.cardKitSequence;
					this.cardKit.cardKitSequence += 1;
					log$2.debug("flushCardUpdate: answer seq bump", {
						seqBefore: prevSeq,
						seqAfter: this.cardKit.cardKitSequence
					});
					await streamCardContent({
						cfg: this.deps.cfg,
						cardId: this.cardKit.cardKitCardId,
						elementId: STREAMING_ELEMENT_ID,
						content: optimizeMarkdownStyle(resolvedText),
						sequence: this.cardKit.cardKitSequence,
						accountId: this.deps.accountId
					});
					this.text.lastFlushedText = resolvedText;
				}
			} else {
				log$2.debug("flushCardUpdate: IM patch fallback");
				const flushDisplay = this.computeToolUseDisplay();
				const card = buildCardContent("streaming", {
					text: this.reasoning.isReasoningPhase ? "" : resolvedText,
					reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : void 0,
					toolUseSteps: flushDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(flushDisplay),
					showToolUse: this.deps.toolUseDisplay.showToolUse
				});
				await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card,
					accountId: this.deps.accountId
				});
			}
		} catch (err) {
			if (this.guard.terminate("flushCardUpdate", err)) return;
			const apiCode = extractLarkApiCode(err);
			if (isCardRateLimitError(err)) {
				log$2.info("flushCardUpdate: rate limited (230020), skipping", { seq: this.cardKit.cardKitSequence });
				return;
			}
			if (isCardTableLimitError(err)) {
				log$2.warn("flushCardUpdate: card table limit exceeded (230099/11310), disabling CardKit streaming", { seq: this.cardKit.cardKitSequence });
				this.cardKit.cardKitCardId = null;
				return;
			}
			const apiDetail = extractApiDetail(err);
			log$2.error("card stream update failed", {
				apiCode,
				seq: this.cardKit.cardKitSequence,
				apiDetail
			});
			if (this.cardKit.cardKitCardId) {
				log$2.warn("disabling CardKit streaming, falling back to im.message.patch");
				this.cardKit.cardKitCardId = null;
			}
		}
	}
	buildDisplayText() {
		if (this.reasoning.isReasoningPhase && this.reasoning.accumulatedReasoningText) {
			const reasoningDisplay = `💭 **Thinking...**\n\n${this.reasoning.accumulatedReasoningText}`;
			return this.text.accumulatedText ? this.text.accumulatedText + "\n\n" + reasoningDisplay : reasoningDisplay;
		}
		return this.text.accumulatedText;
	}
	async throttledCardUpdate() {
		if (this.guard.shouldSkip("throttledCardUpdate")) return;
		const throttleMs = this.cardKit.cardKitCardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS;
		await this.flush.throttledUpdate(throttleMs);
	}
	lastToolUseStatusUpdateTime = 0;
	async throttledToolUseStatusUpdate() {
		if (!this.cardKit.cardKitCardId) return;
		const now = Date.now();
		if (now - this.lastToolUseStatusUpdateTime < THROTTLE_CONSTANTS.REASONING_STATUS_MS) return;
		this.lastToolUseStatusUpdateTime = now;
		await this.updateToolUseStatus();
	}
	async updateToolUseStatus() {
		if (!this.cardKit.cardKitCardId || this.isTerminalPhase) return;
		try {
			const display = this.computeToolUseDisplay();
			const resolvedText = this.imageResolver.resolveImages(this.buildDisplayText());
			const card = buildStreamingPreAnswerCard({
				steps: display?.steps,
				elapsedMs: this.visibleToolUseElapsedMs,
				showToolUse: this.shouldDisplayToolUse,
				text: optimizeMarkdownStyle(resolvedText)
			});
			this.cardKit.cardKitSequence += 1;
			await updateCardKitCard({
				cfg: this.deps.cfg,
				cardId: this.cardKit.cardKitCardId,
				card,
				sequence: this.cardKit.cardKitSequence,
				accountId: this.deps.accountId
			});
		} catch (err) {
			log$2.debug("updateToolUseStatus failed", { error: String(err) });
		}
	}
	finalizeCard(source, reason) {
		this.transition("completed", source, reason);
	}
	/**
	* Close streaming mode then update card content (shared by onError and abortCard).
	*/
	async closeStreamingAndUpdate(cardId, card, label) {
		const seqBeforeClose = this.cardKit.cardKitSequence;
		this.cardKit.cardKitSequence += 1;
		log$2.info(`${label}: closing streaming mode`, {
			seqBefore: seqBeforeClose,
			seqAfter: this.cardKit.cardKitSequence
		});
		await setCardStreamingMode({
			cfg: this.deps.cfg,
			cardId,
			streamingMode: false,
			sequence: this.cardKit.cardKitSequence,
			accountId: this.deps.accountId
		});
		const seqBeforeUpdate = this.cardKit.cardKitSequence;
		this.cardKit.cardKitSequence += 1;
		log$2.info(`${label}: updating card`, {
			seqBefore: seqBeforeUpdate,
			seqAfter: this.cardKit.cardKitSequence
		});
		await updateCardKitCard({
			cfg: this.deps.cfg,
			cardId,
			card: toCardKit2(card),
			sequence: this.cardKit.cardKitSequence,
			accountId: this.deps.accountId
		});
	}
};
/**
* 终态卡片的正文和 reasoning 都会被飞书按 markdown 渲染，
* 因此两者都要先做图片替换与表格降级，避免再次撞到 230099/11310。
*/
function prepareTerminalCardContent(content, imageResolver, tableLimit = 3) {
	const resolvedReasoningText = content.reasoningText ? imageResolver.resolveImages(content.reasoningText) : void 0;
	const resolvedText = imageResolver.resolveImages(content.text);
	const sanitizedSegments = sanitizeTextSegmentsForCard(resolvedReasoningText ? [resolvedReasoningText, resolvedText] : [resolvedText], tableLimit);
	if (resolvedReasoningText) return {
		reasoningText: sanitizedSegments[0],
		text: sanitizedSegments[1]
	};
	return { text: sanitizedSegments[0] };
}
function extractApiDetail(err) {
	if (!err || typeof err !== "object") return String(err);
	const e = err;
	return e.response?.data ? JSON.stringify(e.response.data) : String(err);
}
//#endregion
//#region src/streaming.ts
const defaultFactory = (deps) => new StreamingCardController(deps);
/** One official CardKit turn. No legacy card builder or legacy fallback exists here. */
var OfficialTurnStream = class {
	controller;
	queue = Promise.resolve();
	constructor(sessionKey, chatId, replyToMessageId, cfg, factory = defaultFactory, accountId) {
		this.sessionKey = sessionKey;
		this.controller = factory({
			cfg,
			agentId: "dsh",
			sessionKey,
			accountId,
			chatId,
			replyToMessageId,
			replyInThread: false,
			toolUseDisplay: {
				mode: "on",
				showToolUse: true,
				showToolResultDetails: false,
				showFullPaths: false
			},
			resolvedFooter: {
				status: false,
				elapsed: false,
				tokens: false,
				cache: false,
				context: false,
				model: false
			}
		});
	}
	get phase() {
		return this.controller.currentPhase;
	}
	get messageId() {
		return this.controller.cardMessageId;
	}
	async start() {
		startToolUseTraceRun(this.sessionKey);
		await this.controller.ensureCardCreated();
	}
	text(snapshot) {
		return this.enqueue(() => this.controller.onPartialReply({ text: snapshot }));
	}
	reasoning(_snapshot) {
		return Promise.resolve();
	}
	toolStart(input) {
		return this.enqueue(async () => {
			recordToolUseStart({
				sessionKey: this.sessionKey,
				toolName: input.name,
				...input.callId !== void 0 ? { toolCallId: input.callId } : {},
				...input.params !== void 0 ? { toolParams: input.params } : {}
			});
			await this.controller.onToolStart({
				name: input.name,
				phase: "start"
			});
		});
	}
	toolEnd(input) {
		return this.enqueue(async () => {
			recordToolUseEnd({
				sessionKey: this.sessionKey,
				toolName: input.name,
				...input.callId !== void 0 ? { toolCallId: input.callId } : {},
				...input.params !== void 0 ? { toolParams: input.params } : {},
				result: input.result,
				...input.error !== void 0 ? { error: input.error } : {},
				...input.durationMs !== void 0 ? { durationMs: input.durationMs } : {}
			});
			await this.controller.onToolPayload({ text: "" });
		});
	}
	complete(answer) {
		return this.enqueue(async () => {
			if (answer.trim()) await this.controller.onDeliver({ text: answer });
			this.controller.markFullyComplete();
			await this.controller.onIdle();
		});
	}
	fail(error) {
		return this.enqueue(() => this.controller.onError(error, { kind: "turn" }));
	}
	abort() {
		return this.enqueue(() => this.controller.abortCard());
	}
	enqueue(operation) {
		const next = this.queue.then(operation, operation);
		this.queue = next.catch(() => {});
		return next;
	}
};
//#endregion
//#region src/channel.ts
/** Official Lark events directly driving DSH agents and official streaming cards. */
var LarkChannel = class {
	dedup;
	abort = new AbortController();
	activeByChat = /* @__PURE__ */ new Map();
	activeBySession = /* @__PURE__ */ new Map();
	queues = /* @__PURE__ */ new Map();
	client;
	constructor(options) {
		this.options = options;
		this.dedup = new MessageDedup({ persistence: new DedupStore(join(dataDirectory(options.config), "message-dedup.json")) });
	}
	async start() {
		await this.options.sessions.load();
		const client = LarkClient.fromCfg(this.options.officialConfig, this.options.config.accountId ?? "default");
		this.client = client;
		const probe = await client.probe();
		if (client.account.appId || this.options.config.agentId) {
			const identityName = this.options.config.manifest?.displayName ?? this.options.config.appName ?? probe.botName ?? this.options.config.agentId;
			const botName = this.options.config.appName ?? probe.botName;
			this.options.sessions.setAgentIdentity(this.options.config.agentId, identityName, client.account.appId ?? this.options.config.appId, botName);
			this.options.sessions.rebindCwd();
			await this.options.sessions.save();
			this.options.logger.info(`workspace identity agent=${this.options.config.agentId ?? "(unset)"} app=${client.account.appId ?? this.options.config.appId ?? "?"} name=${this.options.config.appName ?? probe.botName ?? "飞书应用"}`);
		}
		await client.startWS({
			handlers: {
				"im.message.receive_v1": (event) => this.receive(event),
				"card.action.trigger": ((data) => handleCardAction(data, this.options.officialConfig, this.options.config.accountId ?? "default"))
			},
			abortSignal: this.abort.signal,
			autoProbe: false
		});
	}
	async stop() {
		this.abort.abort();
		this.client?.disconnect();
		this.dedup.dispose();
		for (const turn of this.activeByChat.values()) {
			turn.agent.cancel({ kind: "user" }, { keepInbox: true });
			await turn.stream.abort();
			turn.settle();
		}
		this.activeByChat.clear();
		this.activeBySession.clear();
		await this.options.sessions.save();
	}
	/** Parse and queue one raw Feishu message; exposed for offline contract tests. */
	async receive(event) {
		if (!this.dedup.tryRecord(event.message.message_id, this.options.config.accountId ?? "default")) {
			this.options.logger.info(`duplicate inbound message suppressed: ${event.message.message_id}`);
			return;
		}
		const message = await parseMessageEvent(event, this.client?.botOpenId, {
			cfg: this.options.officialConfig,
			accountId: this.options.config.accountId ?? "default"
		});
		if (!this.admit(message)) return;
		this.options.logger.info(`inbound message ${message.messageId} chat=${message.chatId} type=${message.chatType}`);
		if (message.content.trim() === "/stop") {
			await this.stopActive(message.chatId);
			return;
		}
		if (this.options.models && this.isModelCommand(message.content.trim())) {
			try {
				await this.send(message.chatId, await this.options.models.handle(message.chatId, message.content.trim()));
			} catch (error) {
				await this.send(message.chatId, `命令执行失败：${errorMessage(error)}`);
			}
			return;
		}
		const next = (this.queues.get(message.chatId) ?? Promise.resolve()).catch(() => {}).then(() => this.dispatch(message));
		this.queues.set(message.chatId, next);
		await next;
	}
	/** Fold DSH live model deltas directly into the official controller. */
	assistantFrame(sessionId, frame) {
		const turn = this.activeBySession.get(sessionId);
		if (!turn || turn.closed) return;
		if (frame.type === "start") {
			turn.liveAnswer = "";
			turn.liveReasoning = "";
			return;
		}
		if (frame.type === "end") {
			turn.liveAnswer = "";
			turn.liveReasoning = "";
			return;
		}
		if (frame.chunk.type === "text-delta") {
			turn.liveAnswer += frame.chunk.text;
			turn.stream.text(turnText(turn)).catch((error) => this.options.logger.warn(String(error)));
		} else if (frame.chunk.type === "reasoning-delta") {
			turn.liveReasoning += frame.chunk.text;
			turn.stream.reasoning(turn.liveReasoning).catch((error) => this.options.logger.warn(String(error)));
		}
	}
	/** Fold durable tool and turn events into the official controller. */
	async sessionEvent(sessionId, event) {
		const turn = this.activeBySession.get(sessionId);
		if (!turn || turn.closed) return;
		if (event.type === "assistant/message") {
			const committed = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (committed) turn.committedText += (turn.committedText ? "\n\n" : "") + committed;
			turn.liveAnswer = "";
			return;
		}
		if (event.type === "tool/call") {
			const callId = event.data.callId;
			const name = event.data.name;
			this.options.logger.info(`tool call session=${sessionId} name=${name} call=${callId}`);
			const params = parseParams(event.data.arguments);
			turn.tools.set(callId, {
				name,
				params,
				startedAt: Date.now()
			});
			await turn.stream.toolStart({
				name,
				callId,
				params
			});
			return;
		}
		if (event.type === "tool/result") {
			const result = event.data.message;
			const callId = result.source.callId;
			this.options.logger.info(`tool result session=${sessionId} call=${callId} error=${result.isError === true}`);
			const started = turn.tools.get(callId);
			await turn.stream.toolEnd({
				name: started?.name ?? "tool",
				callId,
				params: started?.params,
				result: result.content,
				error: result.isError ? event.data.error?.reason ?? "Tool failed" : void 0,
				durationMs: started ? Date.now() - started.startedAt : void 0
			});
			turn.tools.delete(callId);
			return;
		}
		if (event.type === "turn/end") {
			const reason = event.data.reason;
			await this.finishTurn(turn, reason.kind, "error" in reason ? reason.error.message : void 0);
		}
	}
	admit(message) {
		const { allowedChats, allowedUsers, groupMentionMode = "always" } = this.options.config;
		if (message.senderIsBot || this.client?.botOpenId && message.senderId === this.client.botOpenId) return false;
		if (allowedChats?.length && !allowedChats.includes(message.chatId)) return false;
		if (allowedUsers?.length && !allowedUsers.includes(message.senderId)) return false;
		if (message.chatType !== "group") return true;
		const mentioned = message.mentionAll || message.mentions.some((mention) => mention.isBot);
		if (groupMentionMode === "always") return mentioned;
		if (groupMentionMode === "ambient") return mentioned || !message.mentions.some((mention) => !mention.isBot);
		return true;
	}
	async dispatch(message) {
		const text = message.content.trim();
		if (text === "/new") {
			this.options.sessions.reset(message.chatId, message.senderId);
			await this.options.sessions.save();
			await this.send(message.chatId, "Started a new DSH session.");
			return;
		}
		if (text === "/status") {
			const active = this.activeByChat.has(message.chatId);
			await this.send(message.chatId, `Official Lark streaming is ready. Active turn: ${active ? "yes" : "no"}.`);
			return;
		}
		if (this.activeByChat.has(message.chatId)) {
			await this.send(message.chatId, "The current turn is still running. Use /stop before sending a new turn.");
			return;
		}
		let resolvedName;
		if (message.senderId && this.client) {
			let timeout;
			try {
				resolvedName = (await Promise.race([resolveUserName({
					account: this.client.account,
					openId: message.senderId,
					log: (line) => this.options.logger.debug(String(line))
				}), new Promise((resolve) => {
					timeout = setTimeout(() => resolve({}), 1500);
				})])).name;
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		}
		const binding = this.options.sessions.get(message.chatId, message.senderId, resolvedName);
		await mkdir(binding.cwd, {
			recursive: true,
			mode: 448
		});
		await syncIdentitySkills(this.options.config.workspaceRoot ?? agentsRootDefault(), this.options.config.agentId, binding.cwd);
		await this.options.sessions.save();
		this.options.toolContexts.bind(binding.sessionId, {
			messageId: message.messageId,
			chatId: message.chatId,
			accountId: this.options.config.accountId ?? "default",
			startTime: message.createTime ?? Date.now(),
			senderOpenId: message.senderId,
			chatType: message.chatType,
			...message.threadId !== void 0 ? { threadId: message.threadId } : {}
		});
		const agent = await this.options.resolveAgent(binding.sessionId, binding.cwd);
		const stream = new OfficialTurnStream(binding.sessionId, message.chatId, message.messageId, this.options.officialConfig, this.options.streamFactory, this.options.config.accountId ?? "default");
		let settle;
		const done = new Promise((resolve) => {
			settle = resolve;
		});
		const turn = {
			chatId: message.chatId,
			sessionId: binding.sessionId,
			agent,
			stream,
			done,
			settle,
			committedText: "",
			liveAnswer: "",
			liveReasoning: "",
			closed: false,
			tools: /* @__PURE__ */ new Map()
		};
		this.activeByChat.set(message.chatId, turn);
		this.activeBySession.set(binding.sessionId, turn);
		try {
			await stream.start();
			if (turn.closed) return;
			this.options.logger.info(`official streaming started chat=${message.chatId} phase=${stream.phase} message=${stream.messageId ?? "pending"}`);
			const content = await this.messageContent(message, binding.cwd, agent);
			if (turn.closed) return;
			this.options.logger.info(`delivering message ${message.messageId} session=${binding.sessionId}`);
			agent.followup({
				id: randomUUID(),
				role: "user",
				content,
				source: { kind: "user" }
			});
			await done;
		} catch (error) {
			if (!turn.closed) {
				turn.closed = true;
				await stream.fail(error).catch(() => {});
				this.activeByChat.delete(message.chatId);
				this.activeBySession.delete(binding.sessionId);
				settle();
			}
			await this.send(message.chatId, `Turn failed: ${errorMessage(error)}`);
		}
	}
	async finishTurn(turn, kind, error) {
		if (turn.closed) return;
		turn.closed = true;
		try {
			if (kind === "aborted") await turn.stream.abort();
			else if (kind === "error") await turn.stream.fail(error ?? "Turn failed");
			else {
				await turn.stream.complete(turnText(turn));
				if (!turn.stream.messageId && turnText(turn).trim()) await this.send(turn.chatId, turnText(turn));
			}
		} finally {
			this.activeByChat.delete(turn.chatId);
			this.activeBySession.delete(turn.sessionId);
			turn.settle();
			this.options.logger.info(`official streaming finished chat=${turn.chatId} kind=${kind}`);
		}
	}
	isModelCommand(text) {
		return text === "/model" || text.startsWith("/model ") || text === "/effort" || text.startsWith("/effort ");
	}
	async stopActive(chatId) {
		const turn = this.activeByChat.get(chatId);
		if (!turn) {
			await this.send(chatId, "No active turn.");
			return;
		}
		turn.closed = true;
		turn.agent.cancel({ kind: "user" }, { keepInbox: true });
		this.activeByChat.delete(chatId);
		this.activeBySession.delete(turn.sessionId);
		turn.settle();
		await turn.stream.abort();
	}
	async messageContent(message, cwd, agent) {
		const parts = [message.content];
		const blocks = [];
		for (const resource of message.resources) try {
			const downloaded = await downloadMessageResourceFeishu({
				cfg: this.options.officialConfig,
				messageId: message.messageId,
				fileKey: resource.fileKey,
				type: resource.type === "image" ? "image" : "file",
				accountId: this.options.config.accountId ?? "default"
			});
			const directory = join(cwd, ".dsh_lark", "attachments", sanitize(message.chatId));
			await mkdir(directory, { recursive: true });
			const name = sanitize(resource.fileName ?? downloaded.fileName ?? `${resource.fileKey}${extension(downloaded.contentType)}`);
			const path = join(directory, basename(name));
			await writeFile(path, downloaded.buffer);
			parts.push(`[Attachment: ${path}]`);
			const pdf = await pdfMessageContent(agent, name, downloaded.buffer, this.options.logger, downloaded.contentType);
			if (pdf) blocks.push(...pdf);
		} catch (error) {
			parts.push(`[Attachment ${resource.fileKey} could not be downloaded: ${errorMessage(error)}]`);
		}
		return [{
			type: "text",
			text: parts.filter(Boolean).join("\n\n")
		}, ...blocks];
	}
	async send(chatId, text) {
		await sendMessageFeishu({
			cfg: this.options.officialConfig,
			to: chatId,
			text,
			accountId: this.options.config.accountId ?? "default"
		});
	}
};
function turnText(turn) {
	return [turn.committedText, turn.liveAnswer].filter(Boolean).join("\n\n");
}
function parseParams(value) {
	if (typeof value !== "string" || !value) return void 0;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function sanitize(value) {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function extension(contentType) {
	return {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
		"application/pdf": ".pdf",
		"text/plain": ".txt"
	}[contentType?.split(";")[0] ?? ""] ?? ".bin";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/console-exporter.ts
/** Export structured DSH logs to the long-running channel's stdout/stderr. */
function consoleExporter() {
	return {
		levels: { default: 3 },
		export(message) {
			if (message.type === "debug" && process.env.FEISHU_DEBUG !== "1") return;
			const prefix = `[${new Date(message.ts).toISOString()}] ${message.name} [${message.type}]`;
			(message.type === "error" || message.type === "warn" ? console.error : console.log)(prefix, ...message.args);
		}
	};
}
//#endregion
//#region src/model-selection.ts
function toModelSelection(selection) {
	return {
		provider: selection.provider,
		model: selection.model,
		...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }
	};
}
const CATALOG_TTL_MS = 6e4;
/**
* Live per-session ModelSelectionRef registry. Refs are installed exactly once
* per agent publication through the AgentSetup built by {@link setup}; the map
* entry outlives nothing else because agent-scope disposal removes it.
*/
var ModelSelectionRegistry = class {
	refs = /* @__PURE__ */ new Map();
	constructor(install = installModelSelection) {
		this.install = install;
	}
	ref(sessionId) {
		return this.refs.get(sessionId);
	}
	/** AgentSetup that installs a mutable selection seeded with the stored override. */
	setup(override) {
		return (agentCtx, agent) => {
			const id = agent.id;
			const ref = {
				current: override ? toModelSelection(override) : void 0,
				assembled: void 0
			};
			this.install(agentCtx, ref);
			agentCtx.effect(() => () => {
				if (this.refs.get(id) === ref) this.refs.delete(id);
			});
			return { commit: () => {
				this.refs.set(id, ref);
			} };
		};
	}
};
/** `/model` and `/effort` slash-command handling for one Lark deployment. */
var ModelCommands = class {
	catalogCache;
	constructor(deps) {
		this.deps = deps;
	}
	/** Route one command line; returns the reply text. */
	async handle(chatId, text) {
		const trimmed = text.trim();
		const space = trimmed.indexOf(" ");
		const command = space === -1 ? trimmed : trimmed.slice(0, space);
		const argument = space === -1 ? "" : trimmed.slice(space + 1).trim();
		if (command === "/model") return argument ? this.switchModel(chatId, argument) : this.status(chatId);
		return argument ? this.switchEffort(chatId, argument) : this.effortStatus(chatId);
	}
	async status(chatId) {
		const current = this.effectiveSelection(chatId);
		const lines = [
			`本会话模型：${label(current?.selection)}（${sourceLabel(current?.source)}）`,
			`全局默认：${label(this.defaultModel()?.currentSelection())}`,
			"可用模型："
		];
		for (const [provider, entries] of await this.groupedCatalog()) lines.push(`${provider}: ${entries.map((entry) => entry.id).join(" · ")}`);
		lines.push("用法：/model <名称> 切换 · /model reset 恢复 · /effort <级别> 调思考强度");
		return lines.join("\n");
	}
	async switchModel(chatId, query) {
		if (query === "reset" || query === "default" || query === "重置") return this.resetModel(chatId);
		const entries = await this.catalog();
		if (entries.length === 0) return "没有可用的模型目录，请检查 llm provider 配置。";
		const match = matchModel(entries, query);
		if ("unknown" in match) return `未找到模型“${query}”。\n${await this.catalogText()}`;
		if ("candidates" in match) return [`“${query}”匹配到多个模型，请用 provider/模型 精确指定：`, ...match.candidates.map((entry) => `- ${entry.provider}/${entry.id}`)].join("\n");
		const entry = match.entry;
		const selection = await this.withKeptEffort(chatId, entry);
		try {
			await this.llm().resolveCallConfig(selection);
		} catch (error) {
			return `切换失败：${messageOf(error)}\n${await this.catalogText()}`;
		}
		return this.apply(chatId, selection, `已切换模型：${label(selection)}（下次请求生效，会话历史保留）`);
	}
	async resetModel(chatId) {
		this.deps.sessions.clearModel(chatId);
		await this.deps.sessions.save();
		const binding = this.deps.sessions.get(chatId);
		const live = this.deps.getLiveAgent(binding.sessionId);
		const ref = live && this.deps.registry.ref(live.id);
		if (ref) ref.current = void 0;
		return "已取消本会话的模型固定：后续请求沿用本会话最近使用的模型，其次全局默认。";
	}
	async effortStatus(chatId) {
		const current = this.effectiveSelection(chatId);
		if (!current?.selection) return "当前没有生效的模型，先用 /model <名称> 选择一个。";
		const efforts = await this.effortsOf(current.selection.provider, current.selection.model);
		const listed = efforts?.length ? efforts.join(" · ") : "未知（可直接 /effort <级别> 尝试，由网关校验）";
		const active = current.selection.reasoningEffort ?? "模型默认";
		return `当前模型 ${label(current.selection)} · 思考强度：${active}\n可选强度：${listed}\n用法：/effort <级别>`;
	}
	async switchEffort(chatId, query) {
		const current = this.effectiveSelection(chatId);
		if (!current?.selection) return "当前没有生效的模型，先用 /model <名称> 选择一个。";
		const { provider, model } = current.selection;
		const efforts = await this.effortsOf(provider, model);
		if (efforts !== void 0 && efforts.length > 0) {
			const wanted = efforts.find((effort) => effort.toLowerCase() === query.toLowerCase());
			if (!wanted) {
				const suggestion = nearestOption(query, efforts);
				return `“${query}”不是 ${label(current.selection)} 支持的强度。可选：${efforts.join(" · ")}${suggestion ? `（是不是想输 ${suggestion}？）` : ""}`;
			}
			return this.applyEffort(chatId, provider, model, wanted);
		}
		return this.applyEffort(chatId, provider, model, query.toLowerCase());
	}
	async applyEffort(chatId, provider, model, reasoningEffort) {
		const selection = {
			provider,
			model,
			reasoningEffort
		};
		try {
			await this.llm().resolveCallConfig(selection);
		} catch (error) {
			return `设置失败：${messageOf(error)}`;
		}
		return this.apply(chatId, selection, `已设置思考强度：${reasoningEffort}（${label(selection)}，下次请求生效）`);
	}
	/** Persist the override, apply it to the live agent, and mirror the global default. */
	async apply(chatId, selection, summary) {
		this.deps.sessions.setModel(chatId, selection);
		await this.deps.sessions.save();
		const binding = this.deps.sessions.get(chatId);
		try {
			const agent = await this.deps.resolveAgent(binding.sessionId, binding.cwd);
			const ref = this.deps.registry.ref(agent.id);
			if (ref) ref.current = toModelSelection(selection);
		} catch (error) {
			this.deps.logger?.warn(`[lark] model switch agent apply failed: ${messageOf(error)}`);
		}
		const fallback = this.defaultModel();
		if (fallback) fallback.saveSelection(toModelSelection(selection)).catch((error) => this.deps.logger?.warn(`[lark] model selection applied to the session but the default was not saved: ${messageOf(error)}`));
		return `${summary}\n已同步为全局默认模型。`;
	}
	async withKeptEffort(chatId, entry) {
		const previous = this.effectiveSelection(chatId)?.selection;
		const selection = {
			provider: entry.provider,
			model: entry.id
		};
		if (!previous?.reasoningEffort) return selection;
		if ((await this.effortsOf(entry.provider, entry.id))?.includes(previous.reasoningEffort)) return {
			...selection,
			reasoningEffort: previous.reasoningEffort
		};
		return selection;
	}
	effectiveSelection(chatId) {
		const binding = this.deps.sessions.get(chatId);
		const ref = this.deps.registry.ref(binding.sessionId);
		if (ref?.current) return {
			selection: { ...ref.current },
			source: "override"
		};
		const live = this.deps.getLiveAgent(binding.sessionId);
		const header = live && requestHeaderOf(live);
		if (header) return {
			selection: {
				provider: header.provider,
				model: header.model,
				...header.reasoningEffort === void 0 ? {} : { reasoningEffort: header.reasoningEffort }
			},
			source: "sticky"
		};
		const current = this.defaultModel()?.currentSelection();
		if (current) return {
			selection: { ...current },
			source: "default"
		};
		return { source: "unset" };
	}
	async effortsOf(provider, model) {
		try {
			const efforts = (await this.llm().resolveModelInfo(provider, model)).reasoning?.efforts.map((effort) => effort.id);
			return efforts && efforts.length > 0 ? efforts : void 0;
		} catch (error) {
			this.deps.logger?.warn(`[lark] effort metadata unavailable for ${provider}/${model}: ${messageOf(error)}`);
			return;
		}
	}
	async catalog() {
		const now = Date.now();
		if (this.catalogCache && now - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.entries;
		const llm = this.llm();
		const entries = [];
		if (llm) for (const provider of llm.listProviders()) try {
			const models = await llm.listModels(provider.id);
			entries.push(...models.map((info) => ({
				provider: provider.id,
				id: info.id,
				...info.name === void 0 ? {} : { name: info.name }
			})));
		} catch (error) {
			this.deps.logger?.warn(`[lark] model list failed for ${provider.id}: ${messageOf(error)}`);
		}
		this.catalogCache = {
			at: now,
			entries
		};
		return entries;
	}
	async groupedCatalog() {
		const groups = /* @__PURE__ */ new Map();
		for (const entry of await this.catalog()) {
			const bucket = groups.get(entry.provider) ?? [];
			bucket.push(entry);
			groups.set(entry.provider, bucket);
		}
		return [...groups.entries()].map(([provider, list]) => [provider, list]);
	}
	async catalogText() {
		const lines = [];
		for (const [provider, entries] of await this.groupedCatalog()) lines.push(`${provider}: ${entries.map((entry) => entry.id).join(" · ")}`);
		return lines.join("\n");
	}
	llm() {
		const llm = this.deps.getLlm();
		if (!llm) throw new Error("llm 服务不可用");
		return llm;
	}
	defaultModel() {
		return this.deps.getDefaultModel();
	}
};
function matchModel(entries, query) {
	const normalized = query.trim().toLowerCase();
	if (normalized.includes("/")) {
		const slash = normalized.indexOf("/");
		const provider = normalized.slice(0, slash);
		const model = normalized.slice(slash + 1);
		const entry = entries.find((candidate) => candidate.provider.toLowerCase() === provider && candidate.id.toLowerCase() === model);
		return entry ? { entry } : { unknown: true };
	}
	const exact = entries.filter((entry) => entry.id.toLowerCase() === normalized);
	{
		const [first] = exact;
		if (exact.length === 1 && first) return { entry: first };
	}
	if (exact.length > 1) return { candidates: exact };
	const partial = entries.filter((entry) => entry.id.toLowerCase().includes(normalized) || (entry.name?.toLowerCase().includes(normalized) ?? false));
	{
		const [first] = partial;
		if (partial.length === 1 && first) return { entry: first };
	}
	if (partial.length > 1) return { candidates: partial };
	return { unknown: true };
}
function requestHeaderOf(agent) {
	const config = (agent.session?.requestHeader?.())?.config;
	if (!config?.provider || !config?.model) return void 0;
	return {
		provider: config.provider,
		model: config.model,
		...config.reasoningEffort === void 0 ? {} : { reasoningEffort: config.reasoningEffort }
	};
}
function label(selection) {
	return selection ? `${selection.provider}/${selection.model}` : "未设置";
}
function sourceLabel(source) {
	switch (source) {
		case "override": return "本会话固定";
		case "sticky": return "沿用会话最近模型";
		case "default": return "全局默认";
		default: return "未设置";
	}
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Closest advertised option within a small edit distance, for typo hints. */
function nearestOption(query, options) {
	let best;
	for (const option of options) {
		const distance = editDistance(query.toLowerCase(), option.toLowerCase());
		if (distance <= 2 && (!best || distance < best.distance)) best = {
			option,
			distance
		};
	}
	return best?.option;
}
function editDistance(left, right) {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		for (let column = 1; column <= right.length; column += 1) {
			const above = previous[column] ?? 0;
			const diagonal = previous[column - 1] ?? 0;
			const behind = current[column - 1] ?? 0;
			const substitution = diagonal + (left[row - 1] === right[column - 1] ? 0 : 1);
			current[column] = Math.min(above + 1, behind + 1, substitution);
		}
		previous = current;
	}
	return previous[right.length] ?? 0;
}
//#endregion
//#region src/session-store.ts
/** Durable one-chat-to-one-DSH-session registry, independent of legacy state. */
var SessionStore = class {
	bindings = /* @__PURE__ */ new Map();
	path;
	workspacePath;
	agentsRoot;
	cwd;
	userNames = /* @__PURE__ */ new Map();
	recoveredUsers = /* @__PURE__ */ new Map();
	identity;
	loaded = false;
	constructor(dataDir, defaultCwd, agentsRoot = join(defaultCwd, "agents")) {
		this.path = join(dataDir, "sessions.json");
		this.workspacePath = join(dataDir, "workspace.json");
		this.agentsRoot = agentsRoot;
		this.cwd = defaultCwd;
	}
	/** Set the identity (agent) tier; user archives live under agents/<agentId>/users/<userId>. */
	setAgentIdentity(agentId, displayName, appId, botName) {
		if (!agentId) {
			this.identity = void 0;
			return;
		}
		const path = join(this.agentsRoot, agentId);
		this.identity = {
			agentId,
			appId,
			appName: displayName?.trim() || agentId,
			...botName?.trim() ? { botName: botName.trim() } : {},
			path
		};
		this.cwd = path;
	}
	/**
	* Identity-center rebind (2026-10-30): after setAgentIdentity, remap every
	* openId-bound session cwd to the current identity path — bindings loaded
	* from pre-migration files keep stale app-era paths otherwise, and save()
	* alone would just persist them back.
	*/
	rebindCwd() {
		if (!this.identity) return;
		for (const [chatId, binding] of this.bindings) {
			if (!binding.openId) continue;
			const cwd = this.cwdFor(binding.openId);
			if (cwd !== binding.cwd) this.bindings.set(chatId, {
				...binding,
				cwd
			});
		}
	}
	async load() {
		try {
			const data = JSON.parse(await readFile(this.path, "utf8"));
			for (const [chatId, binding] of Object.entries(data)) if (typeof binding.sessionId === "string" && typeof binding.cwd === "string") {
				const openId = binding.openId;
				if (openId) {
					const configured = this.configuredDisplayName(openId);
					this.userNames.set(openId, configured || binding.displayName?.trim() || `用户 ${userKey(openId, this.identity?.appId).slice(0, 12)}`);
				} else {
					const match = /\/users\/((?:[a-f0-9]{24})|(?:u_[a-z0-9_-]{1,63}))$/.exec(binding.cwd);
					if (match) this.recoveredUsers.set(match[1], binding.cwd);
				}
				this.bindings.set(chatId, {
					sessionId: binding.sessionId,
					cwd: binding.cwd,
					...validModel(binding.model) ? { model: binding.model } : {},
					...binding.openId ? { openId: binding.openId } : {},
					...binding.displayName ? { displayName: binding.displayName } : {}
				});
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		this.loaded = true;
	}
	/** Admin-configured display name: top-level domain, or the applications.<appId> tier. */
	configuredDisplayName(openId) {
		if (!openId) return void 0;
		const appId = this.identity?.appId;
		const users = readUsers(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark", "user-connections.json"));
		return (appId ? users.applications?.[appId] : void 0)?.[openId]?.displayName?.trim() || users[openId]?.displayName?.trim();
	}
	cwdFor(openId) {
		if (!openId || !this.identity) return this.cwd;
		return workspaceFor(this.identity.path, openId, this.identity.appId);
	}
	get(chatId, openId, displayName) {
		const resolvedName = this.configuredDisplayName(openId)?.trim() || displayName?.trim() || this.userNames.get(openId ?? "") || (openId ? `用户 ${userKey(openId, this.identity?.appId).slice(0, 8)}` : void 0);
		if (openId) this.userNames.set(openId, resolvedName);
		const cwd = this.cwdFor(openId);
		const existing = this.bindings.get(chatId);
		if (existing) {
			if (openId && existing.cwd !== cwd) {
				const moved = {
					...existing,
					cwd,
					...openId ? {
						openId,
						displayName: resolvedName
					} : {}
				};
				this.bindings.set(chatId, moved);
				return moved;
			}
			if (openId && !existing.openId) this.bindings.set(chatId, {
				...existing,
				openId,
				displayName: resolvedName
			});
			return this.bindings.get(chatId);
		}
		const created = {
			sessionId: this.freshId(),
			cwd,
			...openId ? {
				openId,
				displayName: resolvedName
			} : {}
		};
		this.bindings.set(chatId, created);
		return created;
	}
	reset(chatId, openId) {
		const previous = this.bindings.get(chatId);
		const created = {
			sessionId: this.freshId(),
			cwd: this.cwdFor(openId),
			...previous?.model ? { model: previous.model } : {},
			...openId ? {
				openId,
				displayName: this.userNames.get(openId)
			} : {}
		};
		this.bindings.set(chatId, created);
		return created;
	}
	/** Chat-pinned override for one DSH session, when stored. */
	overrideFor(sessionId) {
		for (const binding of this.bindings.values()) if (binding.sessionId === sessionId && binding.model) return binding.model;
	}
	setModel(chatId, model) {
		const existing = this.get(chatId);
		this.bindings.set(chatId, {
			...existing,
			model
		});
	}
	clearModel(chatId) {
		const existing = this.bindings.get(chatId);
		if (!existing?.model) return;
		this.bindings.set(chatId, {
			sessionId: existing.sessionId,
			cwd: existing.cwd
		});
	}
	async save() {
		if (!this.loaded) return;
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		const persisted = Object.fromEntries(this.bindings);
		await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 384 });
		await rename(temporary, this.path);
		if (this.identity) {
			await mkdir(this.identity.path, { recursive: true });
			const registry = {
				version: 2,
				...this.identity,
				...this.identity.appId ? { appId: this.identity.appId } : {},
				sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === this.identity?.path).map((binding) => binding.sessionId),
				users: Object.fromEntries([...[...this.userNames].map(([openId, displayName]) => {
					const path = workspaceFor(this.identity.path, openId, this.identity.appId);
					const effective = this.configuredDisplayName(openId) || displayName;
					const suffix = this.identity.botName && !effective?.includes(this.identity.botName) ? ` · ${this.identity.botName}` : "";
					return [userKey(openId, this.identity.appId), {
						displayName: `${effective}${suffix}`,
						path,
						sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId)
					}];
				}), ...[...this.recoveredUsers].map(([hash, path]) => {
					return [hash, {
						displayName: `用户 ${hash.slice(0, 8)}`,
						path,
						sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId)
					}];
				})]),
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			const workspaceTemporary = `${this.workspacePath}.${process.pid}.tmp`;
			await writeFile(workspaceTemporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 384 });
			await rename(workspaceTemporary, this.workspacePath);
		}
	}
	freshId() {
		return `lark-${Date.now()}-${randomUUID().slice(0, 8)}`;
	}
};
function validModel(value) {
	if (value === null || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.provider === "string" && typeof candidate.model === "string" && (candidate.reasoningEffort === void 0 || typeof candidate.reasoningEffort === "string");
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/helpers.js
/**
* 格式化返回值为 JSON（OAPI 工具常用简化接口）
*
* 这是对 formatToolResult 的简化封装，函数名更短便于频繁使用。
*
* @param data - 要返回的数据
* @returns 格式化的工具返回值
*
* @example
* ```typescript
* return json({ task: taskData });
* return json({ error: "Invalid parameter" });
* ```
*/
function json(data) {
	return formatToolResult(data);
}
/**
* 解析时间字符串为 Unix 时间戳（秒）
*
* 支持多种格式：
* 1. ISO 8601 / RFC 3339（带时区）："2024-01-01T00:00:00+08:00"
* 2. 不带时区的格式（默认为北京时间 UTC+8）：
*    - "2026-02-25 14:30"
*    - "2026-02-25 14:30:00"
*    - "2026-02-25T14:30:00"
*
* @param input - 时间字符串
* @returns Unix 时间戳字符串（秒），解析失败返回 null
*
* @example
* ```typescript
* parseTimeToTimestamp("2026-02-25T14:30:00+08:00")  // => "1740459000"
* parseTimeToTimestamp("2026-02-25 14:30")           // => "1740459000" (默认北京时间)
* parseTimeToTimestamp("2026-02-25T14:30:00")        // => "1740459000" (默认北京时间)
* parseTimeToTimestamp("invalid")                    // => null
* ```
*/
function parseTimeToTimestamp(input) {
	try {
		const trimmed = input.trim();
		if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
			const date = new Date(trimmed);
			if (isNaN(date.getTime())) return null;
			return Math.floor(date.getTime() / 1e3).toString();
		}
		const match = trimmed.replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (!match) {
			const date = new Date(trimmed);
			if (isNaN(date.getTime())) return null;
			return Math.floor(date.getTime() / 1e3).toString();
		}
		const [, year, month, day, hour, minute, second] = match;
		const utcDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour) - 8, parseInt(minute), parseInt(second ?? "0")));
		return Math.floor(utcDate.getTime() / 1e3).toString();
	} catch {
		return null;
	}
}
/**
* 解析时间字符串为 Unix 时间戳（毫秒）
*
* 支持多种格式：
* 1. ISO 8601 / RFC 3339（带时区）："2024-01-01T00:00:00+08:00"
* 2. 不带时区的格式（默认为北京时间 UTC+8）：
*    - "2026-02-25 14:30"
*    - "2026-02-25 14:30:00"
*    - "2026-02-25T14:30:00"
*
* @param input - 时间字符串
* @returns Unix 时间戳字符串（毫秒），解析失败返回 null
*
* @example
* ```typescript
* parseTimeToTimestampMs("2026-02-25T14:30:00+08:00")  // => "1740459000000"
* parseTimeToTimestampMs("2026-02-25 14:30")           // => "1740459000000" (默认北京时间)
* parseTimeToTimestampMs("2026-02-25T14:30:00")        // => "1740459000000" (默认北京时间)
* parseTimeToTimestampMs("invalid")                    // => null
* ```
*/
function parseTimeToTimestampMs(input) {
	try {
		const trimmed = input.trim();
		if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
			const date = new Date(trimmed);
			if (isNaN(date.getTime())) return null;
			return date.getTime().toString();
		}
		const match = trimmed.replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (!match) {
			const date = new Date(trimmed);
			if (isNaN(date.getTime())) return null;
			return date.getTime().toString();
		}
		const [, year, month, day, hour, minute, second] = match;
		return new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour) - 8, parseInt(minute), parseInt(second ?? "0"))).getTime().toString();
	} catch {
		return null;
	}
}
/**
* 解析时间字符串为 RFC 3339 格式（用于 freebusy API）
*
* 支持多种格式：
* 1. ISO 8601 / RFC 3339（带时区）："2024-01-01T00:00:00+08:00" - 直接返回
* 2. 不带时区的格式（默认为北京时间 UTC+8）：
*    - "2026-02-25 14:30" - 转换为 "2026-02-25T14:30:00+08:00"
*    - "2026-02-25 14:30:00" - 转换为 "2026-02-25T14:30:00+08:00"
*    - "2026-02-25T14:30:00" - 转换为 "2026-02-25T14:30:00+08:00"
*
* @param input - 时间字符串
* @returns RFC 3339 格式的时间字符串，解析失败返回 null
*
* @example
* ```typescript
* parseTimeToRFC3339("2026-02-25T14:30:00+08:00")  // => "2026-02-25T14:30:00+08:00"
* parseTimeToRFC3339("2026-02-25 14:30")           // => "2026-02-25T14:30:00+08:00"
* parseTimeToRFC3339("2026-02-25T14:30:00")        // => "2026-02-25T14:30:00+08:00"
* ```
*/
function parseTimeToRFC3339(input) {
	try {
		const trimmed = input.trim();
		if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
			const date = new Date(trimmed);
			if (isNaN(date.getTime())) return null;
			return trimmed;
		}
		const match = trimmed.replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (!match) {
			const date = new Date(trimmed);
			if (isNaN(date.getTime())) return null;
			return trimmed.includes("T") ? `${trimmed}+08:00` : trimmed;
		}
		const [, year, month, day, hour, minute, second] = match;
		return `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}+08:00`;
	} catch {
		return null;
	}
}
/**
* 转换时间范围对象（用于 search 等 API）
*
* 将包含 ISO 8601 格式时间字符串的时间范围转换为时间戳。
*
* @param timeRange - 时间范围对象，包含可选的 start 和 end 字段
* @param unit - 时间戳单位，'s' 为秒，'ms' 为毫秒，默认为 's'
* @returns 转换后的时间范围对象，包含数字类型的时间戳
* @throws 如果时间格式错误
*
* @example
* ```typescript
* convertTimeRange({ start: "2026-02-25T14:00:00+08:00", end: "2026-02-25T18:00:00+08:00" })
* // => { start: 1740459000, end: 1740473400 }
*
* convertTimeRange({ start: "2026-02-25T14:00:00+08:00" }, 'ms')
* // => { start: 1740459000000 }
* ```
*/
function convertTimeRange(timeRange, unit = "s") {
	if (!timeRange) return void 0;
	const result = {};
	const parseFn = unit === "ms" ? parseTimeToTimestampMs : parseTimeToTimestamp;
	if (timeRange.start) {
		const ts = parseFn(timeRange.start);
		if (!ts) throw new Error(`Invalid time format for start. Must use ISO 8601 / RFC 3339 with timezone, e.g. "2024-01-01T00:00:00+08:00". Received: ${timeRange.start}`);
		result.start = parseInt(ts, 10);
	}
	if (timeRange.end) {
		const ts = parseFn(timeRange.end);
		if (!ts) throw new Error(`Invalid time format for end. Must use ISO 8601 / RFC 3339 with timezone, e.g. "2024-01-01T00:00:00+08:00". Received: ${timeRange.end}`);
		result.end = parseInt(ts, 10);
	}
	return Object.keys(result).length > 0 ? result : void 0;
}
const SHANGHAI_OFFSET_SUFFIX = "+08:00";
function pad2(value) {
	return String(value).padStart(2, "0");
}
/**
* Convert a Unix timestamp (seconds or milliseconds) to ISO 8601 string
* in the Asia/Shanghai timezone.
*
* Auto-detects seconds vs milliseconds based on magnitude.
*
* @returns e.g. `"2026-02-25T14:30:00+08:00"`, or `null` on invalid input
*/
function unixTimestampToISO8601(raw) {
	if (raw === void 0 || raw == null) return null;
	const text = typeof raw === "number" ? String(raw) : String(raw).trim();
	if (!/^-?\d+$/.test(text)) return null;
	const num = Number(text);
	if (!Number.isFinite(num)) return null;
	const utcMs = Math.abs(num) >= 0xe8d4a51000 ? num : num * 1e3;
	const beijingDate = new Date(utcMs + 480 * 60 * 1e3);
	if (Number.isNaN(beijingDate.getTime())) return null;
	return `${beijingDate.getUTCFullYear()}-${pad2(beijingDate.getUTCMonth() + 1)}-${pad2(beijingDate.getUTCDate())}T${pad2(beijingDate.getUTCHours())}:${pad2(beijingDate.getUTCMinutes())}:${pad2(beijingDate.getUTCSeconds())}${SHANGHAI_OFFSET_SUFFIX}`;
}
/**
* Check whether an error is a structured invoke-level auth/permission error.
*
* Useful in intermediate catch blocks that need to let auth errors bubble up
* to the outer `handleInvokeErrorWithAutoAuth`.
*
* For "allow-to-fail" sub-operations, prefer `client.tryInvoke()` over
* manual `isInvokeError` + throw.
*/
function isInvokeError(err) {
	return err instanceof UserAuthRequiredError || err instanceof AppScopeMissingError || err instanceof UserScopeInsufficientError;
}
/**
* 创建 LLM 友好的字符串枚举 schema。
*
* 与 `Type.Union([Type.Literal('a'), Type.Literal('b')])` 不同，
* 本函数生成 `{ type: 'string', enum: ['a', 'b'] }` 格式，
* 兼容性更好。
*/
function StringEnum(values, options) {
	return Type.Unsafe({
		type: "string",
		enum: values,
		...options
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/mcp/shared.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* MCP 工具的共享代码（所有业务域共享）
* 包含：MCP 客户端、类型定义、通用辅助函数
*/
function isRecord(v) {
	return typeof v === "object" && v != null;
}
/**
* 从配置对象中提取 MCP endpoint URL
*/
function extractMcpUrlFromConfig(cfg) {
	if (!isRecord(cfg)) return void 0;
	const channels = cfg.channels;
	if (!isRecord(channels)) return void 0;
	const feishu = channels.feishu;
	if (!isRecord(feishu)) return void 0;
	const url = feishu.mcpEndpoint;
	const legacyUrl = feishu.mcp_url;
	const chosen = typeof url === "string" ? url : typeof legacyUrl === "string" ? legacyUrl : void 0;
	if (typeof chosen !== "string") return void 0;
	const trimmed = chosen.trim();
	return trimmed ? trimmed : void 0;
}
/**
* 部分 MCP 网关/代理会在 result 内再次包一层 JSON-RPC envelope。
* 这里做一次递归解包，确保工具最终返回的是纯 result JSON（不包含 jsonrpc/id）。
*/
function unwrapJsonRpcResult(v) {
	if (!isRecord(v)) return v;
	const hasJsonRpc = typeof v.jsonrpc === "string";
	const hasId = "id" in v;
	const hasResult = "result" in v;
	const hasError = "error" in v;
	if (hasJsonRpc && (hasResult || hasError)) {
		if (hasError) {
			const err = v.error;
			if (isRecord(err) && typeof err.message === "string") throw new Error(err.message);
			throw new Error("MCP 返回 error，但无法解析 message");
		}
		return unwrapJsonRpcResult(v.result);
	}
	if (!hasJsonRpc && !hasId && hasResult && !hasError) return unwrapJsonRpcResult(v.result);
	return v;
}
let mcpEndpointOverride;
const _penv = process["env"];
function setMcpEndpointOverride(endpoint) {
	mcpEndpointOverride = endpoint;
}
function readMcpUrlFromOpenclawJson() {
	try {
		const p = path.join(process.cwd(), ".openclaw", "openclaw.json");
		if (!fs.existsSync(p)) return void 0;
		const raw = fs.readFileSync(p, "utf8");
		return extractMcpUrlFromConfig(JSON.parse(raw));
	} catch {
		return;
	}
}
function getMcpEndpoint(brand) {
	return mcpEndpointOverride || readMcpUrlFromOpenclawJson() || _penv.FEISHU_MCP_ENDPOINT?.trim() || `${mcpDomain(brand)}/mcp`;
}
function buildAuthHeader() {
	const token = _penv.FEISHU_MCP_BEARER_TOKEN?.trim() || _penv.FEISHU_MCP_TOKEN?.trim();
	if (!token) return void 0;
	return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}
/**
* 调用 MCP 工具
* @param name MCP 工具名称
* @param args 工具参数
* @param toolCallId 工具调用 ID
* @param uat 用户访问令牌(由 invoke 权限检查后传入)
* @param brand 当前账号品牌，用于选择 MCP 端点域名
*/
async function callMcpTool(name, args, toolCallId, uat, brand) {
	const endpoint = getMcpEndpoint(brand);
	const auth = buildAuthHeader();
	const body = {
		jsonrpc: "2.0",
		id: toolCallId,
		method: "tools/call",
		params: {
			name,
			arguments: args
		}
	};
	const headers = {
		"Content-Type": "application/json",
		"X-Lark-MCP-UAT": uat,
		"X-Lark-MCP-Allowed-Tools": name,
		"User-Agent": getUserAgent()
	};
	if (auth) headers.authorization = auth;
	const res = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${text.slice(0, 4e3)}`);
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`MCP 返回非 JSON：${text.slice(0, 4e3)}`);
	}
	if ("error" in data) throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
	return unwrapJsonRpcResult(data.result);
}
/**
* 注册 MCP 工具的通用函数 (使用 invoke 机制进行权限检查)
*/
function registerMcpTool(api, config) {
	const { toolClient, log } = createToolContext(api, config.name);
	return registerTool(api, {
		name: config.name,
		label: config.label,
		description: config.description,
		parameters: config.schema,
		async execute(toolCallId, params) {
			const p = params;
			try {
				log.debug?.(`Calling ${config.mcpToolName} (toolCallId: ${toolCallId})`);
				const startTime = Date.now();
				config.validate?.(p);
				const client = toolClient();
				const brand = client.account.brand;
				const result = await client.invoke(config.toolActionKey, async (_sdk, _opts, uat) => {
					if (!uat) throw new Error("UAT not available");
					return callMcpTool(config.mcpToolName, p, toolCallId, uat, brand);
				}, { as: "user" });
				const duration = Date.now() - startTime;
				log.debug?.(`${config.mcpToolName} succeeded in ${duration}ms`);
				if (isRecord(result) && Array.isArray(result.content)) {
					const mcpContent = result.content;
					let details = result;
					if (mcpContent.length === 1 && mcpContent[0]?.type === "text") try {
						details = JSON.parse(mcpContent[0].text);
					} catch {}
					return {
						content: mcpContent.map((c) => ({
							type: "text",
							text: c.text
						})),
						details
					};
				}
				return formatToolResult(result);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.error(`${config.mcpToolName} failed: ${errMsg}`);
				return handleInvokeErrorWithAutoAuth(err, api.config);
			}
		}
	}, { name: config.name });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/mcp/doc/fetch.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* MCP fetch-doc 工具
* 查看云文档内容（返回标题与 Markdown，支持分页）
*/
const FetchDocSchema = Type.Object({
	doc_id: Type.String({ description: "文档 ID 或 URL（支持自动解析）" }),
	offset: Type.Optional(Type.Integer({
		description: "字符偏移量（可选，默认0）。用于大文档分页获取。",
		minimum: 0
	})),
	limit: Type.Optional(Type.Integer({
		description: "返回的最大字符数（可选）。仅在用户明确要求分页时使用。",
		minimum: 1
	}))
});
/**
* 注册 fetch-doc 工具
*/
function registerFetchDocTool(api) {
	return registerMcpTool(api, {
		name: "feishu_fetch_doc",
		mcpToolName: "fetch-doc",
		toolActionKey: "feishu_fetch_doc.default",
		label: "Feishu MCP: fetch-doc",
		description: "获取飞书云文档内容，返回文档标题和 Markdown 格式内容。支持分页获取大文档。",
		schema: FetchDocSchema
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/mcp/doc/create.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* MCP create-doc 工具
* 从 Markdown 创建云文档（支持异步 task_id 查询）
*/
const CreateDocSchema = Type.Object({
	markdown: Type.Optional(Type.String({ description: "Markdown 内容" })),
	title: Type.Optional(Type.String({ description: "文档标题" })),
	folder_token: Type.Optional(Type.String({ description: "父文件夹 token（可选）" })),
	wiki_node: Type.Optional(Type.String({ description: "知识库节点 token 或 URL（可选，传入则在该节点下创建文档）" })),
	wiki_space: Type.Optional(Type.String({ description: "知识空间 ID（可选，特殊值 my_library）" })),
	task_id: Type.Optional(Type.String({ description: "异步任务 ID。提供此参数将查询任务状态而非创建新文档" }))
});
function validateCreateDocParams(p) {
	if (p.task_id) return;
	if (!p.markdown || !p.title) throw new Error("create-doc：未提供 task_id 时，至少需要提供 markdown 和 title");
	if ([
		p.folder_token,
		p.wiki_node,
		p.wiki_space
	].filter(Boolean).length > 1) throw new Error("create-doc：folder_token / wiki_node / wiki_space 三者互斥，请只提供一个");
}
/**
* 注册 create-doc 工具
*/
function registerCreateDocTool(api) {
	return registerMcpTool(api, {
		name: "feishu_create_doc",
		mcpToolName: "create-doc",
		toolActionKey: "feishu_create_doc.default",
		label: "Feishu MCP: create-doc",
		description: "从 Markdown 创建云文档（支持异步 task_id 查询）",
		schema: CreateDocSchema,
		validate: validateCreateDocParams
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/mcp/doc/update.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* MCP update-doc 工具
* 更新云文档（overwrite/append/replace_range/replace_all/insert_before/insert_after/delete_range，支持异步 task_id 查询）
*/
const UpdateDocSchema = Type.Object({
	doc_id: Type.Optional(Type.String({ description: "文档 ID 或 URL" })),
	markdown: Type.Optional(Type.String({ description: "Markdown 内容" })),
	mode: Type.Union([
		Type.Literal("overwrite"),
		Type.Literal("append"),
		Type.Literal("replace_range"),
		Type.Literal("replace_all"),
		Type.Literal("insert_before"),
		Type.Literal("insert_after"),
		Type.Literal("delete_range")
	], { description: "更新模式（必填）" }),
	selection_with_ellipsis: Type.Optional(Type.String({ description: "定位表达式：开头内容...结尾内容（与 selection_by_title 二选一）" })),
	selection_by_title: Type.Optional(Type.String({ description: "标题定位：例如 ## 章节标题（与 selection_with_ellipsis 二选一）" })),
	new_title: Type.Optional(Type.String({ description: "新的文档标题（可选）" })),
	task_id: Type.Optional(Type.String({ description: "异步任务 ID，用于查询任务状态" }))
});
function validateUpdateDocParams(p) {
	if (p.task_id) return;
	if (!p.doc_id) throw new Error("update-doc：未提供 task_id 时必须提供 doc_id");
	if (p.mode === "replace_range" || p.mode === "insert_before" || p.mode === "insert_after" || p.mode === "delete_range") {
		const hasEllipsis = Boolean(p.selection_with_ellipsis);
		const hasTitle = Boolean(p.selection_by_title);
		if (hasEllipsis && hasTitle || !hasEllipsis && !hasTitle) throw new Error("update-doc：mode 为 replace_range/insert_before/insert_after/delete_range 时，selection_with_ellipsis 与 selection_by_title 必须二选一");
	}
	if (p.mode !== "delete_range" && !p.markdown) throw new Error(`update-doc：mode=${p.mode} 时必须提供 markdown`);
}
/**
* 注册 update-doc 工具
*/
function registerUpdateDocTool(api) {
	return registerMcpTool(api, {
		name: "feishu_update_doc",
		mcpToolName: "update-doc",
		toolActionKey: "feishu_update_doc.default",
		label: "Feishu MCP: update-doc",
		description: "更新云文档（overwrite/append/replace_range/replace_all/insert_before/insert_after/delete_range，支持异步 task_id 查询）",
		schema: UpdateDocSchema,
		validate: validateUpdateDocParams
	});
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/mcp/doc/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* MCP Doc 工具集
* 统一导出所有 doc 相关工具的注册函数
*/
/**
* 注册 MCP Doc 工具（仅保留 create/fetch/update，search/list 已由 OAPI 替代）
*/
function registerFeishuMcpDocTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_doc: No config available, skipping");
		return;
	}
	const accounts = getEnabledLarkAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_doc: No Feishu accounts configured, skipping");
		return;
	}
	if (!resolveAnyEnabledToolsConfig(accounts).doc) {
		api.logger.debug?.("feishu_doc: doc tool disabled in all accounts");
		return;
	}
	setMcpEndpointOverride(extractMcpUrlFromConfig(api.config));
	const registered = [];
	if (registerFetchDocTool(api)) registered.push("feishu_fetch_doc");
	if (registerCreateDocTool(api)) registered.push("feishu_create_doc");
	if (registerUpdateDocTool(api)) registered.push("feishu_update_doc");
	if (registered.length > 0) api.logger.debug?.(`feishu_doc: Registered ${registered.join(", ")}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/tat/im/resource.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_im_bot_image 工具
*
* 以机器人身份下载飞书 IM 消息中的图片/文件资源到本地。
*
* 飞书 API:
*   - 下载资源: GET  /open-apis/im/v1/messages/:message_id/resources/:file_key
* 权限: im:resource
* 凭证: tenant_access_token
*/
/** MIME type → 文件扩展名（下载时使用） */
const MIME_TO_EXT$2 = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/tiff": ".tiff",
	"video/mp4": ".mp4",
	"video/mpeg": ".mpeg",
	"video/quicktime": ".mov",
	"video/x-msvideo": ".avi",
	"video/webm": ".webm",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"audio/mp4": ".m4a",
	"application/pdf": ".pdf",
	"application/msword": ".doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"application/zip": ".zip",
	"application/x-rar-compressed": ".rar",
	"text/plain": ".txt",
	"application/json": ".json"
};
/**
* 从二进制响应中提取 Buffer、Content-Type。
* SDK 的二进制响应可能有 getReadableStream()，也可能直接是 Buffer 等格式。
*/
async function extractBuffer(res) {
	let chunks;
	if (typeof res.getReadableStream === "function") {
		const stream = res.getReadableStream();
		chunks = [];
		for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	} else if (Buffer.isBuffer(res)) chunks = [res];
	else if (Buffer.isBuffer(res?.data)) chunks = [res.data];
	else throw new Error("无法从响应中提取二进制数据");
	return {
		buffer: Buffer.concat(chunks),
		contentType: res.headers?.["content-type"] ?? ""
	};
}
/**
* 将 buffer 保存到临时文件，返回路径。
*/
async function saveToTempFile(buffer, contentType, prefix) {
	const mimeType = contentType ? contentType.split(";")[0].trim() : "";
	const filePath = buildRandomTempFilePath({
		prefix,
		extension: mimeType ? MIME_TO_EXT$2[mimeType] : void 0
	});
	await fsPromises.mkdir(path$1.dirname(filePath), { recursive: true });
	await fsPromises.writeFile(filePath, buffer);
	return filePath;
}
const FeishuImBotImageSchema = Type.Object({
	message_id: Type.String({ description: "消息 ID（om_xxx 格式），引用消息可从上下文中的 [message_id=om_xxx] 提取" }),
	file_key: Type.String({ description: "资源 Key，图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）" }),
	type: StringEnum(["image", "file"], { description: "资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）" })
});
function registerFeishuImBotImageTool(api) {
	if (!api.config) return false;
	const { getClient, log } = createToolContext(api, "feishu_im_bot_image");
	return registerTool(api, {
		name: "feishu_im_bot_image",
		label: "Feishu: IM Bot Image Download",
		description: "【以机器人身份】下载飞书 IM 消息中的图片或文件资源到本地。\n\n适用场景：用户直接发送给机器人的消息、用户引用的消息、机器人收到的群聊消息中的图片/文件。即当前对话上下文中出现的 message_id 和 image_key/file_key，应使用本工具下载。\n引用消息的 message_id 可从上下文中的 [message_id=om_xxx] 提取，无需向用户询问。\n\n文件自动保存到 /tmp/openclaw/ 下，返回值中的 saved_path 为实际保存路径。",
		parameters: FeishuImBotImageSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = getClient();
				log.info(`download: message_id="${p.message_id}", file_key="${p.file_key}", type="${p.type}"`);
				const { buffer, contentType } = await extractBuffer(await client.im.messageResource.get({
					path: {
						message_id: p.message_id,
						file_key: p.file_key
					},
					params: { type: p.type }
				}));
				log.info(`download: ${buffer.length} bytes, content-type=${contentType}`);
				const savedPath = await saveToTempFile(buffer, contentType, "bot-resource");
				log.info(`download: saved to ${savedPath}`);
				return json({
					message_id: p.message_id,
					file_key: p.file_key,
					type: p.type,
					size_bytes: buffer.length,
					content_type: contentType,
					saved_path: savedPath
				});
			} catch (err) {
				log.error(`Error: ${formatLarkError(err)}`);
				return json({ error: formatLarkError(err) });
			}
		}
	}, { name: "feishu_im_bot_image" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/tat/im/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* IM 工具集
* 统一导出所有即时通讯相关工具的注册函数
*/
/**
* 注册所有 IM 工具
*
* Note: feishu_im_message_reaction 和 feishu_im_message_recall 已移除，
* 其功能由 ChannelMessageActionAdapter (actions.ts) 的 react/delete action 统一覆盖。
*/
function registerFeishuImTools$1(api) {
	if (registerFeishuImBotImageTool(api)) api.logger.debug?.("feishu_im: Registered feishu_im_bot_image");
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/calendar/calendar.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_calendar_calendar tool -- Manage Feishu calendars.
*
* P0 Actions: list, get, primary
*
* Uses the Feishu Calendar API:
*   - list:    GET  /open-apis/calendar/v4/calendars
*   - get:     GET  /open-apis/calendar/v4/calendars/:calendar_id
*   - primary: POST /open-apis/calendar/v4/calendars/primary
*/
const FeishuCalendarCalendarSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		page_size: Type.Optional(Type.Number({ description: "Number of calendars to return per page (default: 50, max: 1000)" })),
		page_token: Type.Optional(Type.String({ description: "Pagination token for next page" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		calendar_id: Type.String({ description: "Calendar ID" })
	}),
	Type.Object({ action: Type.Literal("primary") })
]);
function registerFeishuCalendarCalendarTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_calendar_calendar");
	registerTool(api, {
		name: "feishu_calendar_calendar",
		label: "Feishu Calendar Management",
		description: "【以用户身份】飞书日历管理工具。用于查询日历列表、获取日历信息、查询主日历。Actions: list（查询日历列表）, get（查询指定日历信息）, primary（查询主日历信息）。",
		parameters: FeishuCalendarCalendarSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "list": {
						log.info(`list: page_size=${p.page_size ?? 50}, page_token=${p.page_token ?? "none"}`);
						const res = await client.invoke("feishu_calendar_calendar.list", (sdk, opts) => sdk.calendar.calendar.list({ params: {
							page_size: p.page_size,
							page_token: p.page_token
						} }, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						const calendars = data?.calendar_list ?? [];
						log.info(`list: returned ${calendars.length} calendars`);
						return json({
							calendars,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "get": {
						if (!p.calendar_id) return json({ error: "calendar_id is required for 'get' action" });
						log.info(`get: calendar_id=${p.calendar_id}`);
						const res = await client.invoke("feishu_calendar_calendar.get", (sdk, opts) => sdk.calendar.calendar.get({ path: { calendar_id: p.calendar_id } }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get: retrieved calendar ${p.calendar_id}`);
						const data = res.data;
						return json({ calendar: data?.calendar ?? res.data });
					}
					case "primary": {
						log.info(`primary: querying primary calendar`);
						const res = await client.invoke("feishu_calendar_calendar.primary", (sdk, opts) => sdk.calendar.calendar.primary({}, opts), { as: "user" });
						assertLarkOk(res);
						const calendars = res.data?.calendars ?? [];
						log.info(`primary: returned ${calendars.length} primary calendars`);
						return json({ calendars });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_calendar_calendar" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/calendar/event.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_calendar_event tool -- Manage Feishu calendar events.
*
* P0 Actions: create, list, get
*
* Uses the Feishu Calendar API:
*   - create: POST /open-apis/calendar/v4/calendars/:calendar_id/events
*             POST /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees/batch_create
*   - list:   GET  /open-apis/calendar/v4/calendars/:calendar_id/events/instance_view
*   - get:    GET  /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id
*/
const FeishuCalendarEventSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		start_time: Type.String({ description: "开始时间（必填）。ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'" }),
		end_time: Type.String({ description: "结束时间（必填）。格式同 start_time。如果用户未指定时长，默认为开始时间后1小时。" }),
		summary: Type.Optional(Type.String({ description: "日程标题（可选，但强烈建议提供）" })),
		user_open_id: Type.Optional(Type.String({ description: "当前请求用户的 open_id（可选，但强烈建议提供）。从消息上下文的 SenderId 字段获取，格式为 ou_xxx。日程创建在应用日历上，必须通过此参数将用户加为参会人，日程才会出现在用户的飞书日历中。" })),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		description: Type.Optional(Type.String({ description: "日程描述" })),
		attendees: Type.Optional(Type.Array(Type.Object({
			type: StringEnum([
				"user",
				"chat",
				"resource",
				"third_party"
			]),
			id: Type.String({ description: "Attendee open_id, chat_id, resource_id, or email" })
		}), { description: "参会人列表（强烈建议提供，否则日程只在应用日历上，用户看不到）。type='user' 时 id 填 open_id，type='third_party' 时 id 填邮箱。" })),
		vchat: Type.Optional(Type.Object({
			vc_type: Type.Optional(StringEnum([
				"vc",
				"third_party",
				"no_meeting"
			], { description: "视频会议类型：vc（飞书视频会议）、third_party（第三方链接）、no_meeting（无视频会议）。默认为空，首次添加参与人时自动生成飞书视频会议。" })),
			icon_type: Type.Optional(StringEnum([
				"vc",
				"live",
				"default"
			], { description: "第三方视频会议 icon 类型（仅 vc_type=third_party 时有效）。" })),
			description: Type.Optional(Type.String({ description: "第三方视频会议文案（仅 vc_type=third_party 时有效）。" })),
			meeting_url: Type.Optional(Type.String({ description: "第三方视频会议链接（仅 vc_type=third_party 时有效）。" }))
		}, { description: "视频会议信息。不传则默认在首次添加参与人时自动生成飞书视频会议。" })),
		visibility: Type.Optional(StringEnum([
			"default",
			"public",
			"private"
		], { description: "日程公开范围。default（默认，跟随日历权限）、public（公开详情）、private（私密，仅自己可见）。默认值：default。" })),
		attendee_ability: Type.Optional(StringEnum([
			"none",
			"can_see_others",
			"can_invite_others",
			"can_modify_event"
		], { description: "参与人权限。none（无法编辑、邀请、查看）、can_see_others（可查看参与人列表）、can_invite_others（可邀请其他人）、can_modify_event（可编辑日程）。默认值：none。" })),
		free_busy_status: Type.Optional(StringEnum(["busy", "free"], { description: "日程占用的忙闲状态。busy（忙碌）、free（空闲）。默认值：busy。" })),
		location: Type.Optional(Type.Object({
			name: Type.Optional(Type.String({ description: "地点名称" })),
			address: Type.Optional(Type.String({ description: "地点地址" })),
			latitude: Type.Optional(Type.Number({ description: "地点坐标纬度（国内采用 GCJ-02 标准，海外采用 WGS84 标准）" })),
			longitude: Type.Optional(Type.Number({ description: "地点坐标经度（国内采用 GCJ-02 标准，海外采用 WGS84 标准）" }))
		}, { description: "日程地点信息" })),
		reminders: Type.Optional(Type.Array(Type.Object({ minutes: Type.Number({ description: "日程提醒时间的偏移量（分钟）。正数表示在日程开始前提醒，负数表示在日程开始后提醒。范围：-20160 ~ 20160。" }) }), { description: "日程提醒列表" })),
		recurrence: Type.Optional(Type.String({ description: "重复日程的重复性规则（RFC5545 RRULE 格式）。例如：'FREQ=DAILY;INTERVAL=1' 表示每天重复。" }))
	}),
	Type.Object({
		action: Type.Literal("list"),
		start_time: Type.String({ description: "开始时间。ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。注意：start_time 与 end_time 之间的时间区间需要小于 40 天。" }),
		end_time: Type.String({ description: "结束时间。格式同 start_time。注意：start_time 与 end_time 之间的时间区间需要小于 40 天。" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		event_id: Type.String({ description: "Event ID" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" }))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		event_id: Type.String({ description: "Event ID" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		summary: Type.Optional(Type.String({ description: "新的日程标题" })),
		description: Type.Optional(Type.String({ description: "新的日程描述" })),
		start_time: Type.Optional(Type.String({ description: "新的开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" })),
		end_time: Type.Optional(Type.String({ description: "新的结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" })),
		location: Type.Optional(Type.String({ description: "新的地点" }))
	}),
	Type.Object({
		action: Type.Literal("delete"),
		event_id: Type.String({ description: "Event ID" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		need_notification: Type.Optional(Type.Boolean({ description: "是否通知参会人（默认 true）" }))
	}),
	Type.Object({
		action: Type.Literal("search"),
		query: Type.String({ description: "搜索关键词" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		page_size: Type.Optional(Type.Number({ description: "每页数量" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("reply"),
		event_id: Type.String({ description: "Event ID" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		rsvp_status: StringEnum([
			"accept",
			"decline",
			"tentative"
		])
	}),
	Type.Object({
		action: Type.Literal("instances"),
		event_id: Type.String({ description: "重复日程的 Event ID" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		start_time: Type.String({ description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
		end_time: Type.String({ description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
		page_size: Type.Optional(Type.Number({ description: "每页数量" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("instance_view"),
		start_time: Type.String({ description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
		end_time: Type.String({ description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
		calendar_id: Type.Optional(Type.String({ description: "Calendar ID (optional; primary calendar used if omitted)" })),
		page_size: Type.Optional(Type.Number({ description: "每页数量" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	})
]);
function normalizeCalendarTimeValue(value) {
	if (value == null || value === void 0) return void 0;
	if (typeof value === "string") return unixTimestampToISO8601(value) ?? value;
	if (typeof value !== "object") return void 0;
	const timeObj = value;
	const fromTimestamp = unixTimestampToISO8601(timeObj.timestamp);
	if (fromTimestamp) return fromTimestamp;
	if (typeof timeObj.date === "string") return timeObj.date;
}
function normalizeEventTimeFields(event) {
	if (!event) return event;
	const normalized = { ...event };
	const startTime = normalizeCalendarTimeValue(event.start_time);
	if (startTime) normalized.start_time = startTime;
	const endTime = normalizeCalendarTimeValue(event.end_time);
	if (endTime) normalized.end_time = endTime;
	const createTime = unixTimestampToISO8601(event.create_time);
	if (createTime) normalized.create_time = createTime;
	return normalized;
}
function normalizeEventListTimeFields(events) {
	if (!events) return events;
	return events.map((item) => normalizeEventTimeFields(item));
}
function registerFeishuCalendarEventTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_calendar_event");
	const resolveCalendarId = async (client) => {
		const cid = (await client.invoke("feishu_calendar_calendar.primary", (sdk, opts) => sdk.calendar.calendar.primary({}, opts), { as: "user" })).data?.calendars?.[0]?.calendar?.calendar_id;
		if (cid) {
			log.info(`resolveCalendarId: primary() returned calendar_id=${cid}`);
			return cid;
		}
		return null;
	};
	const resolveCalendarIdOrFail = async (calendarId, client) => {
		if (calendarId) return calendarId;
		const resolved = await resolveCalendarId(client);
		if (!resolved) throw new Error("Could not determine primary calendar");
		return resolved;
	};
	registerTool(api, {
		name: "feishu_calendar_event",
		label: "Feishu Calendar Events",
		description: "【以用户身份】飞书日程管理工具。当用户要求查看日程、创建会议、约会议、修改日程、删除日程、搜索日程、回复日程邀请时使用。Actions: create（创建日历事件）, list（查询时间范围内的日程，自动展开重复日程）, get（获取日程详情）, patch（更新日程）, delete（删除日程）, search（搜索日程）, reply（回复日程邀请）, instances（获取重复日程的实例列表，仅对重复日程有效）, instance_view（查看展开后的日程列表）。【重要】create 时必须传 user_open_id 参数，值为消息上下文中的 SenderId（格式 ou_xxx），否则日程只在应用日历上，用户完全看不到。list 操作使用 instance_view 接口，会自动展开重复日程为多个实例，时间区间不能超过40天，返回实例数量上限1000。时间参数使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
		parameters: FeishuCalendarEventSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						if (!p.summary) return json({ error: "summary is required" });
						if (!p.start_time) return json({ error: "start_time is required" });
						if (!p.end_time) return json({ error: "end_time is required" });
						const startTs = parseTimeToTimestamp(p.start_time);
						const endTs = parseTimeToTimestamp(p.end_time);
						if (!startTs || !endTs) return json({
							error: "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'. Do not pass Unix timestamp numbers.",
							received_start: p.start_time,
							received_end: p.end_time
						});
						log.info(`create: summary=${p.summary}, start_time=${p.start_time} -> ts=${startTs}, end_time=${p.end_time} -> ts=${endTs}, user_open_id=${p.user_open_id ?? "MISSING"}, attendees=${JSON.stringify(p.attendees ?? [])}, vchat=${p.vchat?.vc_type ?? "auto"}, location=${p.location?.name ?? "none"}`);
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						const eventData = {
							summary: p.summary,
							start_time: { timestamp: startTs },
							end_time: { timestamp: endTs },
							need_notification: true,
							attendee_ability: p.attendee_ability ?? "can_modify_event"
						};
						if (p.description) eventData.description = p.description;
						if (p.vchat) {
							eventData.vchat = {};
							if (p.vchat.vc_type) eventData.vchat.vc_type = p.vchat.vc_type;
							if (p.vchat.icon_type) eventData.vchat.icon_type = p.vchat.icon_type;
							if (p.vchat.description) eventData.vchat.description = p.vchat.description;
							if (p.vchat.meeting_url) eventData.vchat.meeting_url = p.vchat.meeting_url;
						}
						if (p.visibility) eventData.visibility = p.visibility;
						if (p.free_busy_status) eventData.free_busy_status = p.free_busy_status;
						if (p.location) {
							eventData.location = {};
							if (p.location.name) eventData.location.name = p.location.name;
							if (p.location.address) eventData.location.address = p.location.address;
							if (p.location.latitude !== void 0) eventData.location.latitude = p.location.latitude;
							if (p.location.longitude !== void 0) eventData.location.longitude = p.location.longitude;
						}
						if (p.reminders) eventData.reminders = p.reminders.map((r) => ({ minutes: r.minutes }));
						if (p.recurrence) eventData.recurrence = p.recurrence;
						const res = await client.invoke("feishu_calendar_event.create", (sdk, opts) => sdk.calendar.calendarEvent.create({
							path: { calendar_id: calendarId },
							data: eventData
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`event created: event_id=${res.data?.event?.event_id}`);
						const allAttendees = [...p.attendees ?? []];
						if (p.user_open_id) {
							if (!allAttendees.some((a) => a.type === "user" && a.id === p.user_open_id)) allAttendees.push({
								type: "user",
								id: p.user_open_id
							});
						}
						log.info(`allAttendees=${JSON.stringify(allAttendees)}`);
						let attendeeError;
						const operateId = p.user_open_id ?? p.attendees?.find((a) => a.type === "user")?.id;
						if (allAttendees.length > 0 && res.data?.event?.event_id) {
							const attendeeData = allAttendees.map((a) => ({
								type: a.type,
								user_id: a.type === "user" ? a.id : void 0,
								chat_id: a.type === "chat" ? a.id : void 0,
								room_id: a.type === "resource" ? a.id : void 0,
								third_party_email: a.type === "third_party" ? a.id : void 0,
								operate_id: operateId
							}));
							try {
								const attendeeRes = await client.invoke("feishu_calendar_event.create", (sdk, opts) => sdk.calendar.calendarEventAttendee.create({
									path: {
										calendar_id: calendarId,
										event_id: res.data?.event?.event_id ?? ""
									},
									params: { user_id_type: "open_id" },
									data: {
										attendees: attendeeData,
										need_notification: true
									}
								}, opts), { as: "user" });
								assertLarkOk(attendeeRes);
								log.info(`attendee API response: ${JSON.stringify(attendeeRes.data)}`);
							} catch (attendeeErr) {
								attendeeError = formatLarkError(attendeeErr);
								log.info(`attendee add FAILED: ${attendeeError}`);
							}
						}
						const appLink = res.data?.event?.app_link;
						const result = {
							event: res.data?.event ? {
								event_id: res.data.event.event_id,
								summary: res.data.event.summary,
								app_link: appLink,
								start_time: unixTimestampToISO8601(startTs) ?? p.start_time,
								end_time: unixTimestampToISO8601(endTs) ?? p.end_time
							} : void 0,
							attendees: allAttendees.map((a) => ({
								type: a.type,
								id: a.id
							})),
							_debug: {
								calendar_id: calendarId,
								operate_id: operateId,
								start_input: p.start_time,
								start_iso8601: unixTimestampToISO8601(startTs) ?? p.start_time,
								end_input: p.end_time,
								end_iso8601: unixTimestampToISO8601(endTs) ?? p.end_time,
								attendees_count: allAttendees.length
							}
						};
						if (attendeeError) result.warning = `日程已创建，但添加参会人失败：${attendeeError}`;
						else if (allAttendees.length === 0) result.error = "日程已创建在应用日历上，但未添加任何参会人，用户看不到此日程。请重新调用时传入 user_open_id 参数。";
						else result.note = `已成功添加 ${allAttendees.length} 位参会人，日程应出现在参会人的飞书日历中。`;
						return json(result);
					}
					case "list": {
						if (!p.start_time) return json({ error: "start_time is required" });
						if (!p.end_time) return json({ error: "end_time is required" });
						const startTs = parseTimeToTimestamp(p.start_time);
						const endTs = parseTimeToTimestamp(p.end_time);
						if (!startTs || !endTs) return json({
							error: "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'. Do not pass Unix timestamps.",
							received_start: p.start_time,
							received_end: p.end_time
						});
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						log.info(`list: calendar_id=${calendarId}, start_time=${startTs}, end_time=${endTs} (using instance_view)`);
						const res = await client.invoke("feishu_calendar_event.instance_view", (sdk, opts) => sdk.calendar.calendarEvent.instanceView({
							path: { calendar_id: calendarId },
							params: {
								start_time: startTs,
								end_time: endTs,
								user_id_type: "open_id"
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} event instances`);
						return json({
							events: normalizeEventListTimeFields(data?.items),
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "get": {
						if (!p.event_id) return json({ error: "event_id is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						log.info(`get: calendar_id=${calendarId}, event_id=${p.event_id}`);
						const res = await client.invoke("feishu_calendar_event.get", (sdk, opts) => sdk.calendar.calendarEvent.get({ path: {
							calendar_id: calendarId,
							event_id: p.event_id
						} }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get: retrieved event ${p.event_id}`);
						return json({ event: normalizeEventTimeFields(res.data?.event) });
					}
					case "patch": {
						if (!p.event_id) return json({ error: "event_id is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						const updateData = {};
						if (p.start_time) {
							const startTs = parseTimeToTimestamp(p.start_time);
							if (!startTs) return json({
								error: "start_time 格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
								received: p.start_time
							});
							updateData.start_time = { timestamp: startTs };
						}
						if (p.end_time) {
							const endTs = parseTimeToTimestamp(p.end_time);
							if (!endTs) return json({
								error: "end_time 格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
								received: p.end_time
							});
							updateData.end_time = { timestamp: endTs };
						}
						if (p.summary) updateData.summary = p.summary;
						if (p.description) updateData.description = p.description;
						if (p.location) updateData.location = { name: p.location };
						log.info(`patch: calendar_id=${calendarId}, event_id=${p.event_id}, fields=${Object.keys(updateData).join(",")}`);
						const res = await client.invoke("feishu_calendar_event.patch", (sdk, opts) => sdk.calendar.calendarEvent.patch({
							path: {
								calendar_id: calendarId,
								event_id: p.event_id
							},
							data: updateData
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`patch: updated event ${p.event_id}`);
						return json({ event: normalizeEventTimeFields(res.data?.event) });
					}
					case "delete": {
						if (!p.event_id) return json({ error: "event_id is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						log.info(`delete: calendar_id=${calendarId}, event_id=${p.event_id}, notify=${p.need_notification ?? true}`);
						assertLarkOk(await client.invoke("feishu_calendar_event.delete", (sdk, opts) => sdk.calendar.calendarEvent.delete({
							path: {
								calendar_id: calendarId,
								event_id: p.event_id
							},
							params: { need_notification: p.need_notification ?? true }
						}, opts), { as: "user" }));
						log.info(`delete: deleted event ${p.event_id}`);
						return json({
							success: true,
							event_id: p.event_id
						});
					}
					case "search": {
						if (!p.query) return json({ error: "query is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						log.info(`search: calendar_id=${calendarId}, query=${p.query}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_calendar_event.search", (sdk, opts) => sdk.calendar.calendarEvent.search({
							path: { calendar_id: calendarId },
							params: {
								page_size: p.page_size,
								page_token: p.page_token
							},
							data: { query: p.query }
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`search: found ${data?.items?.length ?? 0} events`);
						return json({
							events: normalizeEventListTimeFields(data?.items),
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "reply": {
						if (!p.event_id) return json({ error: "event_id is required" });
						if (!p.rsvp_status) return json({ error: "rsvp_status is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						log.info(`reply: calendar_id=${calendarId}, event_id=${p.event_id}, rsvp=${p.rsvp_status}`);
						assertLarkOk(await client.invoke("feishu_calendar_event.reply", (sdk, opts) => sdk.calendar.calendarEvent.reply({
							path: {
								calendar_id: calendarId,
								event_id: p.event_id
							},
							data: { rsvp_status: p.rsvp_status }
						}, opts), { as: "user" }));
						log.info(`reply: replied to event ${p.event_id} with ${p.rsvp_status}`);
						return json({
							success: true,
							event_id: p.event_id,
							rsvp_status: p.rsvp_status
						});
					}
					case "instances": {
						if (!p.event_id) return json({ error: "event_id is required" });
						if (!p.start_time) return json({ error: "start_time is required" });
						if (!p.end_time) return json({ error: "end_time is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						const startTs = parseTimeToTimestamp(p.start_time);
						const endTs = parseTimeToTimestamp(p.end_time);
						if (!startTs || !endTs) return json({
							error: "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00'",
							received_start: p.start_time,
							received_end: p.end_time
						});
						log.info(`instances: calendar_id=${calendarId}, event_id=${p.event_id}, start=${startTs}, end=${endTs}`);
						const res = await client.invoke("feishu_calendar_event.instances", (sdk, opts) => sdk.calendar.calendarEvent.instances({
							path: {
								calendar_id: calendarId,
								event_id: p.event_id
							},
							params: {
								start_time: startTs,
								end_time: endTs,
								page_size: p.page_size,
								page_token: p.page_token
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`instances: returned ${data?.items?.length ?? 0} instances`);
						return json({
							instances: normalizeEventListTimeFields(data?.items),
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "instance_view": {
						if (!p.start_time) return json({ error: "start_time is required" });
						if (!p.end_time) return json({ error: "end_time is required" });
						const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);
						const startTs = parseTimeToTimestamp(p.start_time);
						const endTs = parseTimeToTimestamp(p.end_time);
						if (!startTs || !endTs) return json({
							error: "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00'",
							received_start: p.start_time,
							received_end: p.end_time
						});
						log.info(`instance_view: calendar_id=${calendarId}, start=${startTs}, end=${endTs}`);
						const res = await client.invoke("feishu_calendar_event.instance_view", (sdk, opts) => sdk.calendar.calendarEvent.instanceView({
							path: { calendar_id: calendarId },
							params: {
								start_time: startTs,
								end_time: endTs,
								user_id_type: "open_id"
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`instance_view: returned ${data?.items?.length ?? 0} events`);
						return json({
							events: normalizeEventListTimeFields(data?.items),
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_calendar_event" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/calendar/event-attendee.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_calendar_event_attendee tool -- Manage Feishu calendar event attendees.
*
* P0 Actions: create, list
*
* Uses the Feishu Calendar API:
*   - create: POST /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees
*   - list:   GET  /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees
*/
const FeishuCalendarEventAttendeeSchema = Type.Union([Type.Object({
	action: Type.Literal("create"),
	calendar_id: Type.String({ description: "日历 ID" }),
	event_id: Type.String({ description: "日程 ID" }),
	attendees: Type.Array(Type.Object({
		type: StringEnum([
			"user",
			"chat",
			"resource",
			"third_party"
		]),
		attendee_id: Type.String({ description: "参会人 ID。type=user 时为 open_id，type=chat 时为 chat_id，type=resource 时为会议室 ID，type=third_party 时为邮箱地址" })
	}), { description: "参会人列表" }),
	need_notification: Type.Optional(Type.Boolean({ description: "是否给参会人发送通知（默认 true）" })),
	attendee_ability: Type.Optional(StringEnum([
		"none",
		"can_see_others",
		"can_invite_others",
		"can_modify_event"
	]))
}), Type.Object({
	action: Type.Literal("list"),
	calendar_id: Type.String({ description: "日历 ID" }),
	event_id: Type.String({ description: "日程 ID" }),
	page_size: Type.Optional(Type.Number({ description: "每页数量（默认 50，最大 500）" })),
	page_token: Type.Optional(Type.String({ description: "分页标记" })),
	user_id_type: Type.Optional(StringEnum([
		"open_id",
		"union_id",
		"user_id"
	]))
})]);
function registerFeishuCalendarEventAttendeeTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_calendar_event_attendee");
	registerTool(api, {
		name: "feishu_calendar_event_attendee",
		label: "Feishu Calendar Event Attendees",
		description: "飞书日程参会人管理工具。当用户要求邀请/添加参会人、查看参会人列表时使用。Actions: create（添加参会人）, list（查询参会人列表）。",
		parameters: FeishuCalendarEventAttendeeSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						if (!p.attendees || p.attendees.length === 0) return json({ error: "attendees is required and cannot be empty" });
						log.info(`create: calendar_id=${p.calendar_id}, event_id=${p.event_id}, attendees_count=${p.attendees.length}`);
						const attendeeData = p.attendees.map((a) => {
							const base = {
								type: a.type,
								is_optional: false
							};
							if (a.type === "user") base.user_id = a.attendee_id;
							else if (a.type === "chat") base.chat_id = a.attendee_id;
							else if (a.type === "resource") base.room_id = a.attendee_id;
							else if (a.type === "third_party") base.third_party_email = a.attendee_id;
							return base;
						});
						const res = await client.invoke("feishu_calendar_event.create", (sdk, opts) => sdk.calendar.calendarEventAttendee.create({
							path: {
								calendar_id: p.calendar_id,
								event_id: p.event_id
							},
							params: { user_id_type: "open_id" },
							data: {
								attendees: attendeeData,
								need_notification: p.need_notification ?? true
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: added ${p.attendees.length} attendees to event ${p.event_id}`);
						return json({ attendees: res.data?.attendees });
					}
					case "list": {
						log.info(`list: calendar_id=${p.calendar_id}, event_id=${p.event_id}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_calendar_event_attendee.list", (sdk, opts) => sdk.calendar.calendarEventAttendee.list({
							path: {
								calendar_id: p.calendar_id,
								event_id: p.event_id
							},
							params: {
								page_size: p.page_size,
								page_token: p.page_token,
								user_id_type: p.user_id_type || "open_id"
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} attendees`);
						return json({
							attendees: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_calendar_event_attendee" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/calendar/freebusy.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_calendar_freebusy tool -- Query user/room calendar free/busy status.
*
* P0 Actions: list
*
* Uses the Feishu Calendar API:
*   - list: POST /open-apis/calendar/v4/freebusy/batch (批量查询接口)
*/
const FeishuCalendarFreebusySchema = Type.Object({
	action: Type.Literal("list"),
	time_min: Type.String({ description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
	time_max: Type.String({ description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
	user_ids: Type.Array(Type.String({ description: "用户 open_id" }), {
		description: "要查询忙闲的用户 ID 列表（1-10 个用户）",
		minItems: 1,
		maxItems: 10
	})
});
function registerFeishuCalendarFreebusyTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_calendar_freebusy");
	registerTool(api, {
		name: "feishu_calendar_freebusy",
		label: "Feishu Calendar Free/Busy Status",
		description: "【以用户身份】飞书日历忙闲查询工具。当用户要求查询某时间段内某人是否空闲、查看忙闲状态时使用。支持批量查询 1-10 个用户的主日历忙闲信息，用于安排会议时间。",
		parameters: FeishuCalendarFreebusySchema,
		async execute(_toolCallId, params) {
			const p = params;
			log.info(`[FREEBUSY] Execute called with params: ${JSON.stringify(p)}`);
			try {
				const client = toolClient();
				if (p.action !== "list") {
					log.warn(`[FREEBUSY] Unknown action: ${p.action}`);
					return json({ error: `Unknown action: ${p.action}` });
				}
				if (!p.user_ids || p.user_ids.length === 0) {
					log.warn(`[FREEBUSY] user_ids is empty`);
					return json({ error: "user_ids is required (1-10 user IDs)" });
				}
				if (p.user_ids.length > 10) {
					log.warn(`[FREEBUSY] user_ids exceeds limit: ${p.user_ids.length}`);
					return json({ error: `user_ids count exceeds limit, maximum 10 users (current: ${p.user_ids.length})` });
				}
				log.info(`[FREEBUSY] Validation passed, user_ids count: ${p.user_ids.length}`);
				const timeMin = parseTimeToRFC3339(p.time_min);
				const timeMax = parseTimeToRFC3339(p.time_max);
				if (!timeMin || !timeMax) {
					log.warn(`[FREEBUSY] Time format error: time_min=${p.time_min}, time_max=${p.time_max}`);
					return json({
						error: "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'.",
						received_time_min: p.time_min,
						received_time_max: p.time_max
					});
				}
				log.info(`[FREEBUSY] Calling batch API: time_min=${p.time_min} -> ${timeMin}, time_max=${p.time_max} -> ${timeMax}, user_ids=${p.user_ids.length}`);
				const res = await client.invoke("feishu_calendar_freebusy.list", (sdk, opts) => sdk.calendar.freebusy.batch({ data: {
					time_min: timeMin,
					time_max: timeMax,
					user_ids: p.user_ids,
					include_external_calendar: true,
					only_busy: true
				} }, opts), { as: "user" });
				assertLarkOk(res);
				const freebusyLists = res.data?.freebusy_lists ?? [];
				log.info(`[FREEBUSY] Success: returned ${freebusyLists.length} user(s) freebusy data`);
				return json({
					freebusy_lists: freebusyLists,
					_debug: {
						time_min_input: p.time_min,
						time_min_rfc3339: timeMin,
						time_max_input: p.time_max,
						time_max_rfc3339: timeMax,
						user_count: p.user_ids.length
					}
				});
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_calendar_freebusy" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/task.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_task tool -- Manage Feishu tasks.
*
* P0 Actions: create, get, list, patch
* P1 Actions: add_members, append_steps
*
* Uses the Feishu Task v2 API:
*   - create: POST /open-apis/task/v2/tasks
*   - get:    GET  /open-apis/task/v2/tasks/:task_guid
*   - list:   GET  /open-apis/task/v2/tasks
*   - patch:  PATCH /open-apis/task/v2/tasks/:task_guid
*   - add_members: POST /open-apis/task/v2/tasks/:task_guid/add_members
*   - append_steps: POST /open-apis/task/v2/agent_task_step_info/append_task_steps
*/
const FeishuTaskTaskSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		summary: Type.String({ description: "任务标题" }),
		current_user_id: Type.Optional(Type.String({ description: "当前用户的 open_id（强烈建议，从消息上下文的 SenderId 获取）。如果 members 中不包含此用户，工具会自动添加为 follower，确保创建者可以编辑任务。" })),
		description: Type.Optional(Type.String({ description: "任务描述" })),
		due: Type.Optional(Type.Object({
			timestamp: Type.String({ description: "截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
			is_all_day: Type.Optional(Type.Boolean({ description: "是否为全天任务" }))
		})),
		start: Type.Optional(Type.Object({
			timestamp: Type.String({ description: "开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
			is_all_day: Type.Optional(Type.Boolean({ description: "是否为全天" }))
		})),
		members: Type.Optional(Type.Array(Type.Object({
			id: Type.String({ description: "成员 ID（通常为 open_id）" }),
			type: Type.Optional(StringEnum(["user", "app"])),
			role: Type.Optional(StringEnum(["assignee", "follower"]))
		}), { description: "任务成员列表（assignee=负责人，follower=关注人）。成员类型（type）支持 user 和 app，默认为 user。机器人和应用应该使用app" })),
		repeat_rule: Type.Optional(Type.String({ description: "重复规则（RRULE 格式）" })),
		tasklists: Type.Optional(Type.Array(Type.Object({
			tasklist_guid: Type.String({ description: "清单 GUID" }),
			section_guid: Type.Optional(Type.String({ description: "分组 GUID" }))
		}), { description: "任务所属清单列表" })),
		auth_type: Type.Optional(StringEnum(["tenant", "user"], { description: "授权类型，默认 user。使用 user 时为用户身份（只能查看/操作自己有权限的任务），使用 tenant 时为应用身份。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("get"),
		task_guid: Type.String({ description: "Task GUID" }),
		auth_type: Type.Optional(StringEnum(["tenant", "user"], { description: "授权类型，默认 user。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("list"),
		page_size: Type.Optional(Type.Number({ description: "每页数量（默认 50，最大 100）。" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" })),
		completed: Type.Optional(Type.Boolean({ description: "是否筛选已完成任务" })),
		agent_task_status: Type.Optional(Type.Integer({ description: "Agent 任务状态" })),
		auth_type: Type.Optional(StringEnum(["tenant", "user"], { description: "授权类型，默认 user。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		task_guid: Type.String({ description: "Task GUID" }),
		summary: Type.Optional(Type.String({ description: "新的任务标题" })),
		description: Type.Optional(Type.String({ description: "新的任务描述" })),
		due: Type.Optional(Type.Object({
			timestamp: Type.String({ description: "新的截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
			is_all_day: Type.Optional(Type.Boolean({ description: "是否为全天任务" }))
		})),
		start: Type.Optional(Type.Object({
			timestamp: Type.String({ description: "新的开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
			is_all_day: Type.Optional(Type.Boolean({ description: "是否为全天" }))
		})),
		completed_at: Type.Optional(Type.String({ description: "完成时间。支持三种格式：1) ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'（设为已完成）；2) '0'（反完成，任务变为未完成）；3) 毫秒时间戳字符串。" })),
		agent_task_progress: Type.Optional(Type.String({ description: "Agent 任务进度" })),
		agent_task_status: Type.Optional(Type.Integer({ description: "Agent 任务状态" })),
		text_deliveries: Type.Optional(Type.Array(Type.String(), { description: "文本交付列表" })),
		members: Type.Optional(Type.Array(Type.Object({
			id: Type.String({ description: "成员 ID（通常为 open_id）" }),
			type: Type.Optional(StringEnum(["user", "app"])),
			role: Type.Optional(StringEnum(["assignee", "follower"]))
		}), { description: "新的任务成员列表。成员类型支持 user 和 app，默认为 user。" })),
		repeat_rule: Type.Optional(Type.String({ description: "新的重复规则（RRULE 格式）" })),
		auth_type: Type.Optional(StringEnum(["tenant", "user"], { description: "授权类型，默认 user。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("add_members"),
		task_guid: Type.String({ description: "Task GUID" }),
		members: Type.Array(Type.Object({
			id: Type.String({ description: "成员 ID（通常为 open_id）" }),
			type: Type.Optional(StringEnum(["user", "app"])),
			role: Type.Optional(StringEnum(["assignee", "follower"]))
		}), { description: "要添加的成员列表（assignee=负责人，follower=关注人）。成员类型支持 user 和 app，默认为 user。" }),
		client_token: Type.Optional(Type.String({ description: "幂等token，如果提供则实现幂等行为" })),
		auth_type: Type.Optional(StringEnum(["tenant", "user"], { description: "授权类型，默认 user。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("append_steps"),
		task_guid: Type.String({ description: "任务 GUID" }),
		idempotent_key: Type.String({ description: "幂等键" }),
		task_steps: Type.Array(Type.Object({
			quote: Type.String({ description: "步骤引用信息" }),
			content: Type.String({ description: "步骤内容" }),
			timestamp: Type.Integer({ description: "步骤时间戳" })
		}), {
			description: "要追加的任务步骤列表",
			minItems: 1
		})
	})
]);
function registerFeishuTaskTaskTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_task_task");
	registerTool(api, {
		name: "feishu_task_task",
		label: "Feishu Task Management",
		description: "【以用户或应用身份】飞书任务管理工具。用于创建、查询、更新任务。Actions: create（创建任务）, get（获取任务详情）, list（查询任务列表，仅返回我负责的任务）, patch（更新任务）, add_members（添加任务成员）, append_steps（追加任务步骤记录）。时间参数使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。支持通过 auth_type 参数切换用户(user)或应用(tenant)身份；append_steps 固定使用应用身份。",
		parameters: FeishuTaskTaskSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: summary=${p.summary}`);
						const taskData = { summary: p.summary };
						if (p.description) taskData.description = p.description;
						if (p.due?.timestamp) {
							const dueTs = parseTimeToTimestampMs(p.due.timestamp);
							if (!dueTs) return json({
								error: "due 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，例如 '2026-02-25 18:00'。",
								received: p.due.timestamp
							});
							taskData.due = {
								timestamp: dueTs,
								is_all_day: p.due.is_all_day ?? false
							};
							log.info(`create: due time converted: ${p.due.timestamp} -> ${dueTs}ms`);
						}
						if (p.start?.timestamp) {
							const startTs = parseTimeToTimestampMs(p.start.timestamp);
							if (!startTs) return json({
								error: "start 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
								received: p.start.timestamp
							});
							taskData.start = {
								timestamp: startTs,
								is_all_day: p.start.is_all_day ?? false
							};
						}
						if (p.members) taskData.members = p.members;
						if (p.repeat_rule) taskData.repeat_rule = p.repeat_rule;
						if (p.tasklists) taskData.tasklists = p.tasklists;
						const authType = p.auth_type || "user";
						const res = await client.invoke("feishu_task_task.create", (sdk, opts) => sdk.task.v2.task.create({
							data: taskData,
							params: { user_id_type: p.user_id_type || "open_id" }
						}, opts), { as: authType });
						assertLarkOk(res);
						const data = res.data;
						log.info(`create: task created: task_guid=${data?.task?.guid}`);
						return json({ task: res.data?.task });
					}
					case "get": {
						log.info(`get: task_guid=${p.task_guid}`);
						const authType = p.auth_type || "user";
						const res = await client.invoke("feishu_task_task.get", (sdk, opts) => sdk.task.v2.task.get({
							path: { task_guid: p.task_guid },
							params: { user_id_type: p.user_id_type || "open_id" }
						}, opts), { as: authType });
						assertLarkOk(res);
						log.info(`get: retrieved task ${p.task_guid}`);
						return json({ task: res.data?.task });
					}
					case "list": {
						log.info(`list: page_size=${p.page_size ?? 50}, completed=${p.completed ?? false}`);
						const authType = p.auth_type || "user";
						const res = await client.invoke("feishu_task_task.list", (sdk, opts) => sdk.task.v2.task.list({ params: {
							page_size: p.page_size,
							page_token: p.page_token,
							completed: p.completed,
							agent_task_status: p.agent_task_status,
							user_id_type: p.user_id_type || "open_id"
						} }, opts), { as: authType });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} tasks`);
						return json({
							tasks: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "patch": {
						log.info(`patch: task_guid=${p.task_guid}`);
						const updateData = {};
						if (p.summary) updateData.summary = p.summary;
						if (p.description !== void 0) updateData.description = p.description;
						if (p.due?.timestamp) {
							const dueTs = parseTimeToTimestampMs(p.due.timestamp);
							if (!dueTs) return json({
								error: "due 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
								received: p.due.timestamp
							});
							updateData.due = {
								timestamp: dueTs,
								is_all_day: p.due.is_all_day ?? false
							};
						}
						if (p.start?.timestamp) {
							const startTs = parseTimeToTimestampMs(p.start.timestamp);
							if (!startTs) return json({
								error: "start 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
								received: p.start.timestamp
							});
							updateData.start = {
								timestamp: startTs,
								is_all_day: p.start.is_all_day ?? false
							};
						}
						if (p.completed_at !== void 0) if (p.completed_at === "0") updateData.completed_at = "0";
						else if (/^\d+$/.test(p.completed_at)) updateData.completed_at = p.completed_at;
						else {
							const completedTs = parseTimeToTimestampMs(p.completed_at);
							if (!completedTs) return json({
								error: "completed_at 格式错误！支持：1) ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'；2) '0'（反完成）；3) 毫秒时间戳字符串。",
								received: p.completed_at
							});
							updateData.completed_at = completedTs;
						}
						if (p.agent_task_progress !== void 0) updateData.agent_task_progress = p.agent_task_progress;
						if (p.agent_task_status !== void 0) updateData.agent_task_status = p.agent_task_status;
						if (p.text_deliveries !== void 0) updateData.text_deliveries = p.text_deliveries;
						if (p.members) updateData.members = p.members;
						if (p.repeat_rule) updateData.repeat_rule = p.repeat_rule;
						const updateFields = Object.keys(updateData);
						if (updateFields.length === 0) return json({ error: "patch 至少需要提供一个可更新字段：summary、description、due、start、completed_at、agent_task_progress、agent_task_status、text_deliveries、members、repeat_rule" });
						const authType = p.auth_type || "user";
						const res = await client.invoke("feishu_task_task.patch", (sdk, opts) => sdk.task.v2.task.patch({
							path: { task_guid: p.task_guid },
							data: {
								task: updateData,
								update_fields: updateFields
							},
							params: { user_id_type: p.user_id_type || "open_id" }
						}, opts), { as: authType });
						assertLarkOk(res);
						log.info(`patch: task ${p.task_guid} updated`);
						return json({ task: res.data?.task });
					}
					case "add_members": {
						if (!p.members || p.members.length === 0) return json({ error: "members is required and cannot be empty" });
						log.info(`add_members: task_guid=${p.task_guid}, members_count=${p.members.length}`);
						const requestData = { members: p.members.map((m) => ({
							id: m.id,
							type: m.type || "user",
							role: m.role || "follower"
						})) };
						if (p.client_token) requestData.client_token = p.client_token;
						const authType = p.auth_type || "user";
						const res = await client.invoke("feishu_task_task.add_members", (sdk, opts) => sdk.task.v2.task.addMembers({
							path: { task_guid: p.task_guid },
							params: { user_id_type: p.user_id_type || "open_id" },
							data: requestData
						}, opts), { as: authType });
						assertLarkOk(res);
						log.info(`add_members: added ${p.members.length} members to task ${p.task_guid}`);
						return json({ task: res.data?.task });
					}
					case "append_steps": {
						if (!p.task_steps.length) return json({ error: "task_steps is required and cannot be empty" });
						const token = (await rawLarkRequest({
							brand: client.account.brand,
							path: "/open-apis/auth/v3/tenant_access_token/internal/",
							method: "POST",
							body: {
								app_id: client.sdk.appId,
								app_secret: client.sdk.appSecret
							}
						}))?.tenant_access_token ?? "";
						return json(await client.invokeByPath("feishu_task_task.append_steps", "/open-apis/task/v2/agent_task_step_info/append_task_steps", {
							method: "POST",
							as: "tenant",
							body: {
								task_guid: p.task_guid,
								idempotent_key: p.idempotent_key,
								task_steps: p.task_steps
							},
							headers: { "authorization": `Bearer ${token}` }
						}));
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_task" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/tasklist.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_tasklist tool -- Manage Feishu task lists.
*
* P0 Actions: create, get, list, tasks 支持通过 auth_type 参数切换用户(user)或应用(tenant)身份。
* P1 Actions: patch, add_members
*
* Uses the Feishu Task v2 API:
*   - create: POST /open-apis/task/v2/tasklists
*   - get:    GET  /open-apis/task/v2/tasklists/:tasklist_guid
*   - list:   GET  /open-apis/task/v2/tasklists
*   - tasks:  GET  /open-apis/task/v2/tasklists/:tasklist_guid/tasks
*   - patch:  PATCH /open-apis/task/v2/tasklists/:tasklist_guid
*   - add_members: POST /open-apis/task/v2/tasklists/:tasklist_guid/add_members
*/
const FeishuTaskTasklistAuthType = Type.Optional(StringEnum(["tenant", "user"], { description: "调用 API 时使用的 Token 类型。可选值：\"tenant\"（应用身份） 或 \"user\"（用户身份）。默认使用 \"user\"。" }));
const FeishuTaskTasklistSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		auth_type: FeishuTaskTasklistAuthType,
		name: Type.String({ description: "清单名称" }),
		members: Type.Optional(Type.Array(Type.Object({
			id: Type.String({ description: "成员 ID（通常为 open_id）" }),
			type: Type.Optional(StringEnum(["user", "app"])),
			role: Type.Optional(StringEnum(["editor", "viewer"]))
		}), { description: "清单成员列表（editor=可编辑，viewer=可查看）。注意：创建人自动成为 owner，如在 members 中也指定创建人，该用户最终成为 owner 并从 members 中移除（同一用户只能有一个角色）。成员类型支持 user 和 app，默认为 user。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("get"),
		auth_type: FeishuTaskTasklistAuthType,
		tasklist_guid: Type.String({ description: "清单 GUID" }),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("list"),
		auth_type: FeishuTaskTasklistAuthType,
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("tasks"),
		auth_type: FeishuTaskTasklistAuthType,
		tasklist_guid: Type.String({ description: "清单 GUID" }),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" })),
		completed: Type.Optional(Type.Boolean({ description: "是否只返回已完成的任务（默认返回所有）" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		auth_type: FeishuTaskTasklistAuthType,
		tasklist_guid: Type.String({ description: "清单 GUID" }),
		name: Type.Optional(Type.String({ description: "新的清单名称" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("add_members"),
		auth_type: FeishuTaskTasklistAuthType,
		tasklist_guid: Type.String({ description: "清单 GUID" }),
		members: Type.Array(Type.Object({
			id: Type.String({ description: "成员 ID（通常为 open_id）" }),
			type: Type.Optional(StringEnum(["user", "app"])),
			role: Type.Optional(StringEnum(["editor", "viewer"]))
		}), { description: "要添加的成员列表" }),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	})
]);
function registerFeishuTaskTasklistTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_task_tasklist");
	registerTool(api, {
		name: "feishu_task_tasklist",
		label: "Feishu Task Lists",
		description: "【以用户或应用身份】飞书任务清单管理工具。当用户要求创建/查询/管理清单、查看清单内的任务时使用。Actions: create（创建清单）, get（获取清单详情）, list（列出所有可读取的清单，包括我创建的和他人共享给我的）, tasks（列出清单内的任务）, patch（更新清单）, add_members（添加成员）。",
		parameters: FeishuTaskTasklistSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: name=${p.name}, members_count=${p.members?.length ?? 0}`);
						const data = { name: p.name };
						if (p.members && p.members.length > 0) data.members = p.members.map((m) => ({
							id: m.id,
							type: m.type || "user",
							role: m.role || "editor"
						}));
						const res = await client.invoke("feishu_task_tasklist.create", (sdk, opts) => sdk.task.v2.tasklist.create({
							params: { user_id_type: "open_id" },
							data
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`create: created tasklist ${res.data?.tasklist?.guid}`);
						return json({ tasklist: res.data?.tasklist });
					}
					case "get": {
						log.info(`get: tasklist_guid=${p.tasklist_guid}`);
						const res = await client.invoke("feishu_task_tasklist.get", (sdk, opts) => sdk.task.v2.tasklist.get({
							path: { tasklist_guid: p.tasklist_guid },
							params: { user_id_type: "open_id" }
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`get: returned tasklist ${p.tasklist_guid}`);
						return json({ tasklist: res.data?.tasklist });
					}
					case "list": {
						log.info(`list: page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_task_tasklist.list", (sdk, opts) => sdk.task.v2.tasklist.list({ params: {
							page_size: p.page_size,
							page_token: p.page_token,
							user_id_type: "open_id"
						} }, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} tasklists`);
						return json({
							tasklists: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "tasks": {
						log.info(`tasks: tasklist_guid=${p.tasklist_guid}, completed=${p.completed ?? "all"}`);
						const res = await client.invoke("feishu_task_tasklist.tasks", (sdk, opts) => sdk.task.v2.tasklist.tasks({
							path: { tasklist_guid: p.tasklist_guid },
							params: {
								page_size: p.page_size,
								page_token: p.page_token,
								completed: p.completed,
								user_id_type: "open_id"
							}
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`tasks: returned ${data?.items?.length ?? 0} tasks`);
						return json({
							tasks: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "patch": {
						log.info(`patch: tasklist_guid=${p.tasklist_guid}, name=${p.name}`);
						const tasklistData = {};
						const updateFields = [];
						if (p.name !== void 0) {
							tasklistData.name = p.name;
							updateFields.push("name");
						}
						if (updateFields.length === 0) return json({ error: "No fields to update" });
						const res = await client.invoke("feishu_task_tasklist.patch", (sdk, opts) => sdk.task.v2.tasklist.patch({
							path: { tasklist_guid: p.tasklist_guid },
							params: { user_id_type: "open_id" },
							data: {
								tasklist: tasklistData,
								update_fields: updateFields
							}
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`patch: updated tasklist ${p.tasklist_guid}`);
						return json({ tasklist: res.data?.tasklist });
					}
					case "add_members": {
						if (!p.members || p.members.length === 0) return json({ error: "members is required and cannot be empty" });
						log.info(`add_members: tasklist_guid=${p.tasklist_guid}, members_count=${p.members.length}`);
						const memberData = p.members.map((m) => ({
							id: m.id,
							type: m.type || "user",
							role: m.role || "editor"
						}));
						const res = await client.invoke("feishu_task_tasklist.add_members", (sdk, opts) => sdk.task.v2.tasklist.addMembers({
							path: { tasklist_guid: p.tasklist_guid },
							params: { user_id_type: "open_id" },
							data: { members: memberData }
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`add_members: added ${p.members.length} members to tasklist ${p.tasklist_guid}`);
						return json({ tasklist: res.data?.tasklist });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_tasklist" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/attachment.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_attachment tool -- Manage task attachments.
*
* Actions:
* - upload: Upload task attachment (tenant identity)
*/
const FeishuTaskAttachmentSchema = Type.Union([Type.Object({
	action: Type.Literal("upload"),
	resource_type: Type.Optional(StringEnum(["task", "task_delivery"], {
		description: "资源类型，可选值：task、task_delivery。默认 task。",
		default: "task"
	})),
	resource_id: Type.String({ description: "资源 ID。" }),
	file: Type.String({ description: "文件内容base64编码字符串" }),
	name: Type.Optional(Type.String({ description: "文件名。" }))
})]);
function resolvePathForAction$1(action) {
	if (action === "upload") return {
		path: "/open-apis/task/v2/attachments/upload",
		env: []
	};
	return {
		path: "/open-apis/task/v2/attachments/upload",
		env: []
	};
}
function registerFeishuTaskAttachmentTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient } = createToolContext(api, "feishu_task_attachment");
	registerTool(api, {
		name: "feishu_task_attachment",
		label: "Feishu Task Attachment",
		description: "飞书任务附件工具。当前提供 upload action，用于上传任务附件。",
		parameters: FeishuTaskAttachmentSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const resolved = resolvePathForAction$1(p.action);
				const client = toolClient();
				const resourceType = p.resource_type ?? "task";
				const formData = new FormData();
				formData.append("resource_type", resourceType);
				formData.append("resource_id", p.resource_id);
				const fileBuffer = Buffer.from(p.file, "base64");
				const file = new File([fileBuffer], p.name ?? "attachment");
				formData.append("file", file);
				const as = "tenant";
				const tatRes = await rawLarkRequest({
					brand: client.account.brand,
					path: "/open-apis/auth/v3/tenant_access_token/internal/",
					method: "POST",
					body: {
						app_id: client.account.appId,
						app_secret: client.account.appSecret
					}
				});
				const token = tatRes?.tenant_access_token;
				if (!token) return json({
					error: "Failed to get tenant_access_token.",
					response: tatRes
				});
				return json(await client.invokeByPath("feishu_task_attachment.upload", resolved.path, {
					method: "POST",
					as,
					body: formData,
					headers: { "Authorization": `Bearer ${token}` }
				}));
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_attachment" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/comment.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_comment tool -- Manage Feishu task comments.
*
* P1 Actions: create, list, get 支持通过 auth_type 参数切换用户(user)或应用(tenant)身份。
*
* Uses the Feishu Task v2 API:
*   - create: POST /open-apis/task/v2/tasks/:task_guid/comments
*   - list:   GET  /open-apis/task/v2/tasks/:task_guid/comments
*   - get:    GET  /open-apis/task/v2/comments/:comment_id
*/
const FeishuTaskCommentAuthType = Type.Optional(StringEnum(["tenant", "user"], { description: "调用 API 时使用的 Token 类型。可选值：\"tenant\"（应用身份） 或 \"user\"（用户身份）。默认使用 \"user\"。" }));
const FeishuTaskCommentSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		auth_type: FeishuTaskCommentAuthType,
		task_guid: Type.String({ description: "任务 GUID" }),
		content: Type.String({ description: "评论内容（纯文本，最长 3000 字符）" }),
		reply_to_comment_id: Type.Optional(Type.String({ description: "要回复的评论 ID（用于回复评论）" }))
	}),
	Type.Object({
		action: Type.Literal("list"),
		auth_type: FeishuTaskCommentAuthType,
		resource_id: Type.String({ description: "要获取评论的资源 ID（任务 GUID）" }),
		direction: Type.Optional(StringEnum(["asc", "desc"], { description: "排序方式（asc=从旧到新，desc=从新到旧，默认 asc）" })),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		auth_type: FeishuTaskCommentAuthType,
		comment_id: Type.String({ description: "评论 ID" })
	})
]);
function registerFeishuTaskCommentTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_task_comment");
	registerTool(api, {
		name: "feishu_task_comment",
		label: "Feishu Task Comments",
		description: "【以用户或应用身份】飞书任务评论管理工具。当用户要求添加/查询任务评论、回复评论时使用。Actions: create（添加评论）, list（列出任务的所有评论）, get（获取单个评论详情）。",
		parameters: FeishuTaskCommentSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: task_guid=${p.task_guid}, reply_to=${p.reply_to_comment_id ?? "none"}`);
						const data = {
							content: p.content,
							resource_type: "task",
							resource_id: p.task_guid
						};
						if (p.reply_to_comment_id) data.reply_to_comment_id = p.reply_to_comment_id;
						const res = await client.invoke("feishu_task_comment.create", (sdk, opts) => sdk.task.v2.comment.create({
							params: { user_id_type: "open_id" },
							data
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`create: created comment ${res.data?.comment?.id}`);
						return json({ comment: res.data?.comment });
					}
					case "list": {
						log.info(`list: resource_id=${p.resource_id}, direction=${p.direction ?? "asc"}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_task_comment.list", (sdk, opts) => sdk.task.v2.comment.list({ params: {
							resource_type: "task",
							resource_id: p.resource_id,
							direction: p.direction,
							page_size: p.page_size,
							page_token: p.page_token,
							user_id_type: "open_id"
						} }, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} comments`);
						return json({
							comments: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "get": {
						log.info(`get: comment_id=${p.comment_id}`);
						const res = await client.invoke("feishu_task_comment.get", (sdk, opts) => sdk.task.v2.comment.get({
							path: { comment_id: p.comment_id },
							params: { user_id_type: "open_id" }
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`get: returned comment ${p.comment_id}`);
						return json({ comment: res.data?.comment });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_comment" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/subtask.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_subtask tool -- Manage Feishu task subtasks.
*
* P1 Actions: create, list 支持通过 auth_type 参数切换用户(user)或应用(tenant)身份。
*
* Uses the Feishu Task v2 API:
*   - create: POST /open-apis/task/v2/tasks/:task_guid/subtasks
*   - list:   GET  /open-apis/task/v2/tasks/:task_guid/subtasks
*/
const FeishuTaskSubtaskAuthType = Type.Optional(StringEnum(["tenant", "user"], { description: "调用 API 时使用的 Token 类型。可选值：\"tenant\"（应用身份） 或 \"user\"（用户身份）。默认使用 \"user\"。" }));
const FeishuTaskSubtaskSchema = Type.Union([Type.Object({
	action: Type.Literal("create"),
	auth_type: FeishuTaskSubtaskAuthType,
	task_guid: Type.String({ description: "父任务 GUID" }),
	summary: Type.String({ description: "子任务标题" }),
	description: Type.Optional(Type.String({ description: "子任务描述" })),
	due: Type.Optional(Type.Object({
		timestamp: Type.String({ description: "截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
		is_all_day: Type.Optional(Type.Boolean({ description: "是否为全天任务" }))
	})),
	start: Type.Optional(Type.Object({
		timestamp: Type.String({ description: "开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）" }),
		is_all_day: Type.Optional(Type.Boolean({ description: "是否为全天" }))
	})),
	members: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ description: "成员 ID（通常为 open_id）" }),
		type: Type.Optional(StringEnum(["user", "app"])),
		role: Type.Optional(StringEnum(["assignee", "follower"]))
	}), { description: "子任务成员列表（assignee=负责人，follower=关注人）" }))
}), Type.Object({
	action: Type.Literal("list"),
	auth_type: FeishuTaskSubtaskAuthType,
	task_guid: Type.String({ description: "父任务 GUID" }),
	page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
	page_token: Type.Optional(Type.String({ description: "分页标记" }))
})]);
function registerFeishuTaskSubtaskTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_task_subtask");
	registerTool(api, {
		name: "feishu_task_subtask",
		label: "Feishu Task Subtasks",
		description: "【以用户或应用身份】飞书任务的子任务管理工具。当用户要求创建子任务、查询任务的子任务列表时使用。Actions: create（创建子任务）, list（列出任务的所有子任务）。",
		parameters: FeishuTaskSubtaskSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: task_guid=${p.task_guid}, summary=${p.summary}`);
						const data = { summary: p.summary };
						if (p.description) data.description = p.description;
						if (p.due) {
							const dueTs = parseTimeToTimestampMs(p.due.timestamp);
							if (!dueTs) return json({ error: `时间格式错误！due.timestamp 必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，当前值：${p.due.timestamp}` });
							data.due = {
								timestamp: dueTs,
								is_all_day: p.due.is_all_day ?? false
							};
						}
						if (p.start) {
							const startTs = parseTimeToTimestampMs(p.start.timestamp);
							if (!startTs) return json({ error: `时间格式错误！start.timestamp 必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，当前值：${p.start.timestamp}` });
							data.start = {
								timestamp: startTs,
								is_all_day: p.start.is_all_day ?? false
							};
						}
						if (p.members && p.members.length > 0) data.members = p.members.map((m) => ({
							id: m.id,
							type: m.type || "user",
							role: m.role || "assignee"
						}));
						const res = await client.invoke("feishu_task_subtask.create", (sdk, opts) => sdk.task.v2.taskSubtask.create({
							path: { task_guid: p.task_guid },
							params: { user_id_type: "open_id" },
							data
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`create: created subtask ${res.data?.subtask?.guid ?? "unknown"}`);
						return json({ subtask: res.data?.subtask });
					}
					case "list": {
						log.info(`list: task_guid=${p.task_guid}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_task_subtask.list", (sdk, opts) => sdk.task.v2.taskSubtask.list({
							path: { task_guid: p.task_guid },
							params: {
								page_size: p.page_size,
								page_token: p.page_token,
								user_id_type: "open_id"
							}
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} subtasks`);
						return json({
							subtasks: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_subtask" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/section.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_section tool -- Manage Feishu task sections.
*
* P0 Actions: create, get, list, patch, tasks 支持通过 auth_type 参数切换用户(user)或应用(tenant)身份。
*
* Uses the Feishu Task v2 API:
*   - create: POST /open-apis/task/v2/sections
*   - get:    GET  /open-apis/task/v2/sections/:section_guid
*   - patch:  PATCH /open-apis/task/v2/sections/:section_guid
*   - list:   GET  /open-apis/task/v2/sections
*   - tasks:  GET  /open-apis/task/v2/sections/:section_guid/tasks
*/
const FeishuTaskSectionAuthType = Type.Optional(StringEnum(["tenant", "user"], { description: "调用 API 时使用的 Token 类型。可选值：\"tenant\"（应用身份） 或 \"user\"（用户身份）。默认使用 \"user\"。" }));
const FeishuTaskSectionSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		auth_type: FeishuTaskSectionAuthType,
		name: Type.String({ description: "自定义分组名。不允许为空，最大100个utf8字符。" }),
		resource_type: StringEnum(["tasklist", "my_tasks"]),
		resource_id: Type.Optional(Type.String({ description: "自定义分组要归属的资源id。当resource_type为\"tasklist\"时这里需要填写清单的GUID；当resource_type为\"my_tasks\"时，无需填写。" })),
		insert_before: Type.Optional(Type.String({ description: "要将新分组插入到自定义分分组的前面的目标分组的guid。" })),
		insert_after: Type.Optional(Type.String({ description: "要将新分组插入到自定义分分组的后面的目标分组的guid。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("get"),
		auth_type: FeishuTaskSectionAuthType,
		section_guid: Type.String({ description: "要获取的自定义分组GUID" }),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		auth_type: FeishuTaskSectionAuthType,
		section_guid: Type.String({ description: "要更新的自定义分组GUID" }),
		name: Type.Optional(Type.String({ description: "自定义字段名字" })),
		insert_before: Type.Optional(Type.String({ description: "要让当前自定义分组放到某个自定义分组前面的secion_guid，用于改变当前自定义分组的位置。" })),
		insert_after: Type.Optional(Type.String({ description: "要让当前自定义分组放到某个自定义分组后面的secion_guid，用于改变当前自定义分组的位置。" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("list"),
		auth_type: FeishuTaskSectionAuthType,
		resource_type: StringEnum(["tasklist", "my_tasks"]),
		resource_id: Type.Optional(Type.String({ description: "如resource_type为\"tasklist\"，这里需要填写要列取自定义分组的清单的GUID。" })),
		page_size: Type.Optional(Type.Number({ description: "分页大小" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	}),
	Type.Object({
		action: Type.Literal("tasks"),
		auth_type: FeishuTaskSectionAuthType,
		section_guid: Type.String({ description: "要获取任务的自定义分组全局唯一ID" }),
		page_size: Type.Optional(Type.Number({ description: "分页大小" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" })),
		completed: Type.Optional(Type.Boolean({ description: "按照任务状态过滤，如果不填写则表示不按完成状态过滤" })),
		created_from: Type.Optional(Type.String({ description: "按照创建时间筛选的起始时间（支持 ISO 8601 或毫秒时间戳）" })),
		created_to: Type.Optional(Type.String({ description: "按照创建时间筛选的结束时间（支持 ISO 8601 或毫秒时间戳）" })),
		user_id_type: Type.Optional(StringEnum([
			"open_id",
			"union_id",
			"user_id"
		]))
	})
]);
function registerFeishuTaskSectionTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_task_section");
	registerTool(api, {
		name: "feishu_task_section",
		label: "Feishu Task Section Management",
		description: "【以用户或应用身份】飞书任务自定义分组管理工具。用于创建、查询、更新自定义分组，以及列出分组内的任务。Actions: create（创建分组）, get（获取分组详情）, patch（更新分组）, list（获取分组列表）, tasks（获取分组任务列表）。",
		parameters: FeishuTaskSectionSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: name=${p.name}, resource_type=${p.resource_type}`);
						const data = {
							name: p.name,
							resource_type: p.resource_type
						};
						if (p.resource_id) data.resource_id = p.resource_id;
						if (p.insert_before) data.insert_before = p.insert_before;
						if (p.insert_after) data.insert_after = p.insert_after;
						const res = await client.invoke("feishu_task_section.create", (sdk, opts) => sdk.task.v2.section.create({
							data,
							params: { user_id_type: p.user_id_type || "open_id" }
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`create: section created: section_guid=${res.data?.section?.guid}`);
						return json({ section: res.data?.section });
					}
					case "get": {
						log.info(`get: section_guid=${p.section_guid}`);
						const res = await client.invoke("feishu_task_section.get", (sdk, opts) => sdk.task.v2.section.get({
							path: { section_guid: p.section_guid },
							params: { user_id_type: p.user_id_type || "open_id" }
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`get: retrieved section ${p.section_guid}`);
						return json({ section: res.data?.section });
					}
					case "patch": {
						log.info(`patch: section_guid=${p.section_guid}`);
						const sectionData = {};
						const updateFields = [];
						if (p.name !== void 0) {
							sectionData.name = p.name;
							updateFields.push("name");
						}
						if (p.insert_before !== void 0) {
							sectionData.insert_before = p.insert_before;
							updateFields.push("insert_before");
						}
						if (p.insert_after !== void 0) {
							sectionData.insert_after = p.insert_after;
							updateFields.push("insert_after");
						}
						if (updateFields.length === 0) return json({ error: "No fields to update" });
						const res = await client.invoke("feishu_task_section.patch", (sdk, opts) => sdk.task.v2.section.patch({
							path: { section_guid: p.section_guid },
							data: {
								section: sectionData,
								update_fields: updateFields
							},
							params: { user_id_type: p.user_id_type || "open_id" }
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						log.info(`patch: section ${p.section_guid} updated`);
						return json({ section: res.data?.section });
					}
					case "list": {
						log.info(`list: resource_type=${p.resource_type}, page_size=${p.page_size ?? 50}`);
						const paramsData = {
							resource_type: p.resource_type,
							user_id_type: p.user_id_type || "open_id"
						};
						if (p.resource_id) paramsData.resource_id = p.resource_id;
						if (p.page_size !== void 0) paramsData.page_size = p.page_size;
						if (p.page_token !== void 0) paramsData.page_token = p.page_token;
						const res = await client.invoke("feishu_task_section.list", (sdk, opts) => sdk.task.v2.section.list({ params: paramsData }, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} sections`);
						return json({
							sections: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "tasks": {
						log.info(`tasks: section_guid=${p.section_guid}`);
						const paramsData = { user_id_type: p.user_id_type || "open_id" };
						if (p.page_size !== void 0) paramsData.page_size = p.page_size;
						if (p.page_token !== void 0) paramsData.page_token = p.page_token;
						if (p.completed !== void 0) paramsData.completed = p.completed;
						if (p.created_from) {
							const ts = parseTimeToTimestampMs(p.created_from);
							if (ts) paramsData.created_from = ts;
							else paramsData.created_from = p.created_from;
						}
						if (p.created_to) {
							const ts = parseTimeToTimestampMs(p.created_to);
							if (ts) paramsData.created_to = ts;
							else paramsData.created_to = p.created_to;
						}
						const res = await client.invoke("feishu_task_section.tasks", (sdk, opts) => sdk.task.v2.section.tasks({
							path: { section_guid: p.section_guid },
							params: paramsData
						}, opts), { as: p.auth_type || "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`tasks: returned ${data?.items?.length ?? 0} tasks`);
						return json({
							tasks: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_section" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/task/task_agent.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_task_agent tool -- Manage Feishu Task Agent registration.
*
* Actions:
* - register:        Register task agent (tenant identity)
* - update_profile:  Update task agent profile (tenant identity)
*

*/
const FeishuTaskAgentSchema = Type.Union([Type.Object({ action: Type.Literal("register") }), Type.Object({
	action: Type.Literal("update_profile"),
	profile_content: Type.String()
})]);
function resolvePathForAction(action) {
	if (action === "register") return {
		path: "/open-apis/task/v2/agent/register_agent",
		env: []
	};
	return {
		path: "/open-apis/task/v2/agent/update_agent_profile",
		env: []
	};
}
function registerFeishuTaskAgentTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient } = createToolContext(api, "feishu_task_agent");
	registerTool(api, {
		name: "feishu_task_agent",
		label: "Feishu Task Agent Registration",
		description: "飞书任务 Agent 注册管理工具。用于注册/取消注册 Task Agent，以及查询已注册列表。",
		parameters: FeishuTaskAgentSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const normalizedAction = p.action;
				const resolved = resolvePathForAction(p.action);
				const client = toolClient();
				const token = (await rawLarkRequest({
					brand: client.account.brand,
					path: "/open-apis/auth/v3/tenant_access_token/internal/",
					method: "POST",
					body: {
						app_id: client.sdk.appId,
						app_secret: client.sdk.appSecret
					}
				}))?.tenant_access_token ?? "";
				const as = normalizedAction === "register" || normalizedAction === "update_profile" ? "tenant" : "user";
				if (normalizedAction === "update_profile") return json(await client.invokeByPath("feishu_task_agent.update_profile", resolved.path, {
					method: "POST",
					as,
					body: { profile_content: p.profile_content },
					headers: { "authorization": `Bearer ${token}` }
				}));
				if (normalizedAction === "register") return json(await client.invokeByPath("feishu_task_agent.register", resolved.path, {
					method: "POST",
					as,
					headers: { "authorization": `Bearer ${token}` }
				}));
				return json({ error: `p.action is invalid ${normalizedAction}` });
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_task_agent" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/bitable/app.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_bitable_app tool -- Manage Feishu Bitable apps (multidimensional tables).
*
* P0 Actions: create, get, list, patch
* P1 Actions: copy
*
* Uses the Feishu Bitable v1 API:
*   - create: POST /open-apis/bitable/v1/apps
*   - get:    GET  /open-apis/bitable/v1/apps/:app_token
*   - list:   GET  /open-apis/drive/v1/files (filtered by type=bitable)
*   - patch:  PATCH /open-apis/bitable/v1/apps/:app_token
*   - copy:   POST /open-apis/bitable/v1/apps/:app_token/copy
*/
const FeishuBitableAppSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		name: Type.String({ description: "多维表格名称" }),
		folder_token: Type.Optional(Type.String({ description: "所在文件夹 token（默认创建在我的空间）" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		app_token: Type.String({ description: "多维表格的唯一标识 token" })
	}),
	Type.Object({
		action: Type.Literal("list"),
		folder_token: Type.Optional(Type.String({ description: "文件夹 token（默认列出我的空间）" })),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 200" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		app_token: Type.String({ description: "多维表格 token" }),
		name: Type.Optional(Type.String({ description: "新的名称" })),
		is_advanced: Type.Optional(Type.Boolean({ description: "是否开启高级权限" }))
	}),
	Type.Object({
		action: Type.Literal("copy"),
		app_token: Type.String({ description: "源多维表格 token" }),
		name: Type.String({ description: "新的名称" }),
		folder_token: Type.Optional(Type.String({ description: "目标文件夹 token" }))
	})
]);
function registerFeishuBitableAppTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_bitable_app");
	registerTool(api, {
		name: "feishu_bitable_app",
		label: "Feishu Bitable Apps",
		description: "【以用户身份】飞书多维表格应用管理工具。当用户要求创建/查询/管理多维表格时使用。Actions: create（创建多维表格）, get（获取多维表格元数据）, list（列出多维表格）, patch（更新元数据）, delete（删除多维表格）, copy（复制多维表格）。",
		parameters: FeishuBitableAppSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: name=${p.name}, folder_token=${p.folder_token ?? "my_space"}`);
						const data = { name: p.name };
						if (p.folder_token) data.folder_token = p.folder_token;
						const res = await client.invoke("feishu_bitable_app.create", (sdk, opts) => sdk.bitable.app.create({ data }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: created app ${res.data?.app?.app_token}`);
						return json({ app: res.data?.app });
					}
					case "get": {
						log.info(`get: app_token=${p.app_token}`);
						const res = await client.invoke("feishu_bitable_app.get", (sdk, opts) => sdk.bitable.app.get({ path: { app_token: p.app_token } }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get: returned app ${p.app_token}`);
						return json({ app: res.data?.app });
					}
					case "list": {
						log.info(`list: folder_token=${p.folder_token ?? "my_space"}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_bitable_app.list", (sdk, opts) => sdk.drive.v1.file.list({ params: {
							folder_token: p.folder_token || "",
							page_size: p.page_size,
							page_token: p.page_token
						} }, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						const bitables = data?.files?.filter((f) => f.type === "bitable") || [];
						log.info(`list: returned ${bitables.length} bitable apps`);
						return json({
							apps: bitables,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "patch": {
						log.info(`patch: app_token=${p.app_token}, name=${p.name}, is_advanced=${p.is_advanced}`);
						const updateData = {};
						if (p.name !== void 0) updateData.name = p.name;
						if (p.is_advanced !== void 0) updateData.is_advanced = p.is_advanced;
						const res = await client.invoke("feishu_bitable_app.patch", (sdk, opts) => sdk.bitable.app.update({
							path: { app_token: p.app_token },
							data: updateData
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`patch: updated app ${p.app_token}`);
						return json({ app: res.data?.app });
					}
					case "copy": {
						log.info(`copy: app_token=${p.app_token}, name=${p.name}, folder_token=${p.folder_token ?? "my_space"}`);
						const data = { name: p.name };
						if (p.folder_token) data.folder_token = p.folder_token;
						const res = await client.invoke("feishu_bitable_app.copy", (sdk, opts) => sdk.bitable.app.copy({
							path: { app_token: p.app_token },
							data
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`copy: created copy ${res.data?.app?.app_token}`);
						return json({ app: res.data?.app });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_bitable_app" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/bitable/app-table.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_bitable_app_table tool -- Manage Feishu Bitable tables.
*
* P0 Actions: create, list, patch
* P1 Actions: batch_create
*
* Uses the Feishu Bitable v1 API:
*   - create: POST /open-apis/bitable/v1/apps/:app_token/tables
*   - list:   GET  /open-apis/bitable/v1/apps/:app_token/tables
*   - patch:  PATCH /open-apis/bitable/v1/apps/:app_token/tables/:table_id
*   - batch_create: POST /open-apis/bitable/v1/apps/:app_token/tables/batch_create
*/
const FeishuBitableAppTableSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		app_token: Type.String({ description: "多维表格 token" }),
		table: Type.Object({
			name: Type.String({ description: "数据表名称" }),
			default_view_name: Type.Optional(Type.String({ description: "默认视图名称" })),
			fields: Type.Optional(Type.Array(Type.Object({
				field_name: Type.String({ description: "字段名称" }),
				type: Type.Number({ description: "字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，11=人员，13=电话，15=超链接，17=附件，1001=创建时间，1002=修改时间等）" }),
				property: Type.Optional(Type.Any({ description: "字段属性配置（根据类型而定）" }))
			}), { description: "字段列表（可选，但强烈建议在创建表时就传入所有字段，避免后续逐个添加）。不传则创建空表。" }))
		})
	}),
	Type.Object({
		action: Type.Literal("list"),
		app_token: Type.String({ description: "多维表格 token" }),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		name: Type.Optional(Type.String({ description: "新的表名" }))
	}),
	Type.Object({
		action: Type.Literal("batch_create"),
		app_token: Type.String({ description: "多维表格 token" }),
		tables: Type.Array(Type.Object({ name: Type.String({ description: "数据表名称" }) }), { description: "要批量创建的数据表列表" })
	})
]);
function registerFeishuBitableAppTableTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_bitable_app_table");
	registerTool(api, {
		name: "feishu_bitable_app_table",
		label: "Feishu Bitable Tables",
		description: "【以用户身份】飞书多维表格数据表管理工具。当用户要求创建/查询/管理数据表时使用。\n\nActions: create（创建数据表，可选择在创建时传入 fields 数组定义字段，或后续逐个添加）, list（列出所有数据表）, patch（更新数据表）, batch_create（批量创建）。\n\n【字段定义方式】支持两种模式：1) 明确需求时，在 create 中通过 table.fields 一次性定义所有字段（减少 API 调用）；2) 探索式场景时，使用默认表 + feishu_bitable_app_table_field 逐步修改字段（更稳定，易调整）。",
		parameters: FeishuBitableAppTableSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: app_token=${p.app_token}, table_name=${p.table.name}, fields_count=${p.table.fields?.length ?? 0}`);
						const tableData = { ...p.table };
						if (tableData.fields) tableData.fields = tableData.fields.map((field) => {
							if ((field.type === 7 || field.type === 15) && field.property !== void 0) {
								const fieldTypeName = field.type === 15 ? "URL" : "Checkbox";
								log.warn(`create: ${fieldTypeName} field (type=${field.type}, name="${field.field_name}") detected with property parameter. Removing property to avoid API error. ${fieldTypeName} fields must omit the property parameter entirely.`);
								const { property: _property, ...fieldWithoutProperty } = field;
								return fieldWithoutProperty;
							}
							return field;
						});
						const res = await client.invoke("feishu_bitable_app_table.create", (sdk, opts) => sdk.bitable.appTable.create({
							path: { app_token: p.app_token },
							data: { table: tableData }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: created table ${res.data?.table_id}`);
						return json({
							table_id: res.data?.table_id,
							default_view_id: res.data?.default_view_id,
							field_id_list: res.data?.field_id_list
						});
					}
					case "list": {
						log.info(`list: app_token=${p.app_token}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_bitable_app_table.list", (sdk, opts) => sdk.bitable.appTable.list({
							path: { app_token: p.app_token },
							params: {
								page_size: p.page_size,
								page_token: p.page_token
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} tables`);
						return json({
							tables: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "patch": {
						log.info(`patch: app_token=${p.app_token}, table_id=${p.table_id}, name=${p.name}`);
						const res = await client.invoke("feishu_bitable_app_table.patch", (sdk, opts) => sdk.bitable.appTable.patch({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							data: { name: p.name }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`patch: updated table ${p.table_id}`);
						return json({ name: res.data?.name });
					}
					case "batch_create": {
						if (!p.tables || p.tables.length === 0) return json({ error: "tables is required and cannot be empty" });
						log.info(`batch_create: app_token=${p.app_token}, tables_count=${p.tables.length}`);
						const res = await client.invoke("feishu_bitable_app_table.batch_create", (sdk, opts) => sdk.bitable.appTable.batchCreate({
							path: { app_token: p.app_token },
							data: { tables: p.tables }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`batch_create: created ${p.tables.length} tables in app ${p.app_token}`);
						return json({ table_ids: res.data?.table_ids });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_bitable_app_table" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/bitable/app-table-record.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_bitable_app_table_record tool -- Manage Feishu Bitable records.
*
* P0 Actions: create, list, update, delete
* P1 Actions: batch_create, batch_update, batch_delete
*
* Uses the Feishu Bitable v1 API:
*   - create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records
*   - list:   POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/search (旧 list API 已废弃)
*   - update: PUT  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id
*   - delete: DELETE /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id
*   - batch_create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_create
*   - batch_update: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_update
*   - batch_delete: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_delete
*/
const FeishuBitableAppTableRecordSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		fields: Type.Object({}, {
			additionalProperties: true,
			description: "记录字段（单条记录）。键为字段名，值根据字段类型而定：\n- 文本：string\n- 数字：number\n- 单选：string（选项名）\n- 多选：string[]（选项名数组）\n- 日期：number（毫秒时间戳，如 1740441600000）\n- 复选框：boolean\n- 人员：[{id: 'ou_xxx'}]\n- 附件：[{file_token: 'xxx'}]\n⚠️ 注意：create 只创建单条记录；批量创建请使用 batch_create"
		})
	}),
	Type.Object({
		action: Type.Literal("update"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		record_id: Type.String({ description: "记录 ID" }),
		fields: Type.Object({}, {
			additionalProperties: true,
			description: "要更新的字段"
		})
	}),
	Type.Object({
		action: Type.Literal("delete"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		record_id: Type.String({ description: "记录 ID" })
	}),
	Type.Object({
		action: Type.Literal("batch_create"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		records: Type.Array(Type.Object({ fields: Type.Object({}, { additionalProperties: true }) }), { description: "要批量创建的记录列表（最多 500 条）" })
	}),
	Type.Object({
		action: Type.Literal("batch_update"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		records: Type.Array(Type.Object({
			record_id: Type.String(),
			fields: Type.Object({}, { additionalProperties: true })
		}), { description: "要批量更新的记录列表（最多 500 条）" })
	}),
	Type.Object({
		action: Type.Literal("batch_delete"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		record_ids: Type.Array(Type.String(), { description: "要删除的记录 ID 列表（最多 500 条）" })
	}),
	Type.Object({
		action: Type.Literal("list"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		view_id: Type.Optional(Type.String({ description: "视图 ID（可选，建议指定以获得更好的性能）" })),
		field_names: Type.Optional(Type.Array(Type.String(), { description: "要返回的字段名列表（可选，不指定则返回所有字段）" })),
		filter: Type.Optional(Type.Object({
			conjunction: StringEnum(["and", "or"], { description: "条件逻辑：and（全部满足）or（任一满足）" }),
			conditions: Type.Array(Type.Object({
				field_name: Type.String({ description: "字段名" }),
				operator: StringEnum([
					"is",
					"isNot",
					"contains",
					"doesNotContain",
					"isEmpty",
					"isNotEmpty",
					"isGreater",
					"isGreaterEqual",
					"isLess",
					"isLessEqual"
				], { description: "运算符" }),
				value: Type.Optional(Type.Array(Type.String(), { description: "条件值（isEmpty/isNotEmpty 时可省略）" }))
			}), { description: "筛选条件列表" })
		}, { description: "筛选条件（必须是结构化对象）。示例：{conjunction: 'and', conditions: [{field_name: '文本', operator: 'is', value: ['测试']}]}" })),
		sort: Type.Optional(Type.Array(Type.Object({
			field_name: Type.String({ description: "排序字段名" }),
			desc: Type.Boolean({ description: "是否降序" })
		}), { description: "排序规则" })),
		automatic_fields: Type.Optional(Type.Boolean({ description: "是否返回自动字段（created_time, last_modified_time, created_by, last_modified_by），默认 false" })),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 500" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	})
]);
function registerFeishuBitableAppTableRecordTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_bitable_app_table_record");
	registerTool(api, {
		name: "feishu_bitable_app_table_record",
		label: "Feishu Bitable Records",
		description: "【以用户身份】飞书多维表格记录（行）管理工具。当用户要求创建/查询/更新/删除记录、搜索数据时使用。\n\nActions:\n- create（创建单条记录，使用 fields 参数）\n- batch_create（批量创建记录，使用 records 数组参数）\n- list（列出/搜索记录）\n- update（更新记录）\n- delete（删除记录）\n- batch_update（批量更新）\n- batch_delete（批量删除）\n\n⚠️ 注意参数区别：\n- create 使用 'fields' 对象（单条）\n- batch_create 使用 'records' 数组（批量）",
		parameters: FeishuBitableAppTableRecordSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						if (p.records) return json({
							error: "create action does not accept 'records' parameter",
							hint: "Use 'fields' for single record creation. For batch creation, use action: 'batch_create' with 'records' parameter.",
							correct_format: {
								action: "create",
								fields: { 字段名: "字段值" }
							},
							batch_create_format: {
								action: "batch_create",
								records: [{ fields: { 字段名: "字段值" } }]
							}
						});
						if (!p.fields || Object.keys(p.fields).length === 0) return json({
							error: "fields is required and cannot be empty",
							hint: "create action requires 'fields' parameter, e.g. { 'field_name': 'value', ... }"
						});
						log.info(`create: app_token=${p.app_token}, table_id=${p.table_id}`);
						const res = await client.invoke("feishu_bitable_app_table_record.create", (sdk, opts) => sdk.bitable.appTableRecord.create({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							params: { user_id_type: "open_id" },
							data: { fields: p.fields }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: created record ${res.data?.record?.record_id}`);
						return json({ record: res.data?.record });
					}
					case "update": {
						if (p.records) return json({
							error: "update action does not accept 'records' parameter",
							hint: "Use 'record_id' + 'fields' for single record update. For batch update, use action: 'batch_update' with 'records' parameter.",
							correct_format: {
								action: "update",
								record_id: "recXXX",
								fields: { 字段名: "字段值" }
							},
							batch_update_format: {
								action: "batch_update",
								records: [{
									record_id: "recXXX",
									fields: { 字段名: "字段值" }
								}]
							}
						});
						log.info(`update: app_token=${p.app_token}, table_id=${p.table_id}, record_id=${p.record_id}`);
						const res = await client.invoke("feishu_bitable_app_table_record.update", (sdk, opts) => sdk.bitable.appTableRecord.update({
							path: {
								app_token: p.app_token,
								table_id: p.table_id,
								record_id: p.record_id
							},
							params: { user_id_type: "open_id" },
							data: { fields: p.fields }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`update: updated record ${p.record_id}`);
						return json({ record: res.data?.record });
					}
					case "delete":
						log.info(`delete: app_token=${p.app_token}, table_id=${p.table_id}, record_id=${p.record_id}`);
						assertLarkOk(await client.invoke("feishu_bitable_app_table_record.delete", (sdk, opts) => sdk.bitable.appTableRecord.delete({ path: {
							app_token: p.app_token,
							table_id: p.table_id,
							record_id: p.record_id
						} }, opts), { as: "user" }));
						log.info(`delete: deleted record ${p.record_id}`);
						return json({ success: true });
					case "batch_create": {
						if (p.fields) return json({
							error: "batch_create action does not accept 'fields' parameter",
							hint: "Use 'records' array for batch creation. For single record, use action: 'create' with 'fields' parameter.",
							correct_format: {
								action: "batch_create",
								records: [{ fields: { 字段名: "字段值" } }]
							},
							single_create_format: {
								action: "create",
								fields: { 字段名: "字段值" }
							}
						});
						if (!p.records || p.records.length === 0) return json({
							error: "records is required and cannot be empty",
							hint: "batch_create requires 'records' array, e.g. [{ fields: {...} }, ...]"
						});
						if (p.records.length > 500) return json({
							error: "records count exceeds limit (maximum 500)",
							received_count: p.records.length
						});
						log.info(`batch_create: app_token=${p.app_token}, table_id=${p.table_id}, records_count=${p.records.length}`);
						const res = await client.invoke("feishu_bitable_app_table_record.batch_create", (sdk, opts) => sdk.bitable.appTableRecord.batchCreate({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							params: { user_id_type: "open_id" },
							data: { records: p.records }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`batch_create: created ${p.records.length} records in table ${p.table_id}`);
						return json({ records: res.data?.records });
					}
					case "batch_update": {
						if (p.record_id || p.fields) return json({
							error: "batch_update action does not accept 'record_id' or 'fields' parameters",
							hint: "Use 'records' array for batch update. For single record, use action: 'update' with 'record_id' + 'fields' parameters.",
							correct_format: {
								action: "batch_update",
								records: [{
									record_id: "recXXX",
									fields: { 字段名: "字段值" }
								}]
							},
							single_update_format: {
								action: "update",
								record_id: "recXXX",
								fields: { 字段名: "字段值" }
							}
						});
						if (!p.records || p.records.length === 0) return json({
							error: "records is required and cannot be empty",
							hint: "batch_update requires 'records' array, e.g. [{ record_id: 'recXXX', fields: {...} }, ...]"
						});
						if (p.records.length > 500) return json({ error: "records cannot exceed 500 items" });
						log.info(`batch_update: app_token=${p.app_token}, table_id=${p.table_id}, records_count=${p.records.length}`);
						const res = await client.invoke("feishu_bitable_app_table_record.batch_update", (sdk, opts) => sdk.bitable.appTableRecord.batchUpdate({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							params: { user_id_type: "open_id" },
							data: { records: p.records }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`batch_update: updated ${p.records.length} records in table ${p.table_id}`);
						return json({ records: res.data?.records });
					}
					case "batch_delete":
						if (!p.record_ids || p.record_ids.length === 0) return json({ error: "record_ids is required and cannot be empty" });
						if (p.record_ids.length > 500) return json({ error: "record_ids cannot exceed 500 items" });
						log.info(`batch_delete: app_token=${p.app_token}, table_id=${p.table_id}, record_ids_count=${p.record_ids.length}`);
						assertLarkOk(await client.invoke("feishu_bitable_app_table_record.batch_delete", (sdk, opts) => sdk.bitable.appTableRecord.batchDelete({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							data: { records: p.record_ids }
						}, opts), { as: "user" }));
						log.info(`batch_delete: deleted ${p.record_ids.length} records from table ${p.table_id}`);
						return json({ success: true });
					case "list": {
						log.info(`list: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id ?? "none"}, field_names=${p.field_names?.length ?? 0}, filter=${p.filter ? "yes" : "no"}`);
						const searchData = {};
						if (p.view_id !== void 0) searchData.view_id = p.view_id;
						if (p.field_names !== void 0) searchData.field_names = p.field_names;
						if (p.filter !== void 0) {
							const filter = { ...p.filter };
							if (filter.conditions) filter.conditions = filter.conditions.map((cond) => {
								if ((cond.operator === "isEmpty" || cond.operator === "isNotEmpty") && !cond.value) {
									log.warn(`list: ${cond.operator} operator detected without value. Auto-adding value=[] to avoid API error.`);
									return {
										...cond,
										value: []
									};
								}
								return cond;
							});
							searchData.filter = filter;
						}
						if (p.sort !== void 0) searchData.sort = p.sort;
						if (p.automatic_fields !== void 0) searchData.automatic_fields = p.automatic_fields;
						const res = await client.invoke("feishu_bitable_app_table_record.list", (sdk, opts) => sdk.bitable.appTableRecord.search({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							params: {
								user_id_type: "open_id",
								page_size: p.page_size,
								page_token: p.page_token
							},
							data: searchData
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} records`);
						return json({
							records: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token,
							total: data?.total
						});
					}
					default: return json({ error: `Unknown action: ${p.action}` });
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_bitable_app_table_record" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/bitable/app-table-field.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_bitable_app_table_field tool -- Manage Feishu Bitable fields (columns).
*
* P1 Actions: create, list, update, delete
*
* Uses the Feishu Bitable v1 API:
*   - create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields
*   - list:   GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields
*   - update: PUT  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields/:field_id
*   - delete: DELETE /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields/:field_id
*/
const FeishuBitableAppTableFieldSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		field_name: Type.String({ description: "字段名称" }),
		type: Type.Number({ description: "字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，11=人员，13=电话，15=超链接，17=附件，1001=创建时间，1002=修改时间等）" }),
		property: Type.Optional(Type.Any({ description: "字段属性配置（根据类型而定，例如单选/多选需要options，数字需要formatter等）。⚠️ 重要：超链接字段（type=15）必须完全省略此参数，传空对象 {} 也会报错（URLFieldPropertyError）。" }))
	}),
	Type.Object({
		action: Type.Literal("list"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		view_id: Type.Optional(Type.String({ description: "视图 ID（可选）" })),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("update"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		field_id: Type.String({ description: "字段 ID" }),
		field_name: Type.Optional(Type.String({ description: "字段名（可选，不传则不修改）" })),
		type: Type.Optional(Type.Number({ description: "字段类型（可选，不传则自动查询）：1=文本, 2=数字, 3=单选, 4=多选, 5=日期, 7=复选框, 11=人员, 13=电话, 15=超链接, 17=附件等" })),
		property: Type.Optional(Type.Any({ description: "字段属性配置（可选，不传则自动查询）" }))
	}),
	Type.Object({
		action: Type.Literal("delete"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		field_id: Type.String({ description: "字段 ID" })
	})
]);
function registerFeishuBitableAppTableFieldTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_bitable_app_table_field");
	registerTool(api, {
		name: "feishu_bitable_app_table_field",
		label: "Feishu Bitable Fields",
		description: "【以用户身份】飞书多维表格字段（列）管理工具。当用户要求创建/查询/更新/删除字段、调整表结构时使用。Actions: create（创建字段）, list（列出所有字段）, update（更新字段，支持只传 field_name 改名）, delete（删除字段）。",
		parameters: FeishuBitableAppTableFieldSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: app_token=${p.app_token}, table_id=${p.table_id}, field_name=${p.field_name}, type=${p.type}`);
						let propertyToSend = p.property;
						if ((p.type === 15 || p.type === 7) && p.property !== void 0) {
							const fieldTypeName = p.type === 15 ? "URL" : "Checkbox";
							log.warn(`create: ${fieldTypeName} field (type=${p.type}) detected with property parameter. Removing property to avoid API error. ${fieldTypeName} fields must omit the property parameter entirely.`);
							propertyToSend = void 0;
						}
						const res = await client.invoke("feishu_bitable_app_table_field.create", (sdk, opts) => sdk.bitable.appTableField.create({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							data: {
								field_name: p.field_name,
								type: p.type,
								property: propertyToSend
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`create: created field ${data?.field?.field_id ?? "unknown"}`);
						return json({ field: data?.field ?? res.data });
					}
					case "list": {
						log.info(`list: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id ?? "none"}`);
						const res = await client.invoke("feishu_bitable_app_table_field.list", (sdk, opts) => sdk.bitable.appTableField.list({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							params: {
								view_id: p.view_id,
								page_size: p.page_size,
								page_token: p.page_token
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} fields`);
						return json({
							fields: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "update": {
						log.info(`update: app_token=${p.app_token}, table_id=${p.table_id}, field_id=${p.field_id}`);
						let finalFieldName = p.field_name;
						let finalType = p.type;
						let finalProperty = p.property;
						if (!finalType || !finalFieldName) {
							log.info(`update: missing type or field_name, auto-querying field info`);
							const listRes = await client.invoke("feishu_bitable_app_table_field.update", (sdk, opts) => sdk.bitable.appTableField.list({
								path: {
									app_token: p.app_token,
									table_id: p.table_id
								},
								params: { page_size: 500 }
							}, opts), { as: "user" });
							assertLarkOk(listRes);
							const currentField = listRes.data?.items?.find((f) => f.field_id === p.field_id);
							if (!currentField) return json({
								error: `field ${p.field_id} does not exist`,
								hint: "Please verify field_id is correct. Use list action to view all fields."
							});
							finalFieldName = p.field_name || currentField.field_name;
							finalType = p.type ?? currentField.type;
							finalProperty = p.property !== void 0 ? p.property : currentField.property;
							log.info(`update: auto-filled type=${finalType}, field_name=${finalFieldName}`);
						}
						const updateData = {
							field_name: finalFieldName,
							type: finalType
						};
						if (finalProperty !== void 0) updateData.property = finalProperty;
						const res = await client.invoke("feishu_bitable_app_table_field.update", (sdk, opts) => sdk.bitable.appTableField.update({
							path: {
								app_token: p.app_token,
								table_id: p.table_id,
								field_id: p.field_id
							},
							data: updateData
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`update: updated field ${p.field_id}`);
						const updateData2 = res.data;
						return json({ field: updateData2?.field ?? res.data });
					}
					case "delete":
						log.info(`delete: app_token=${p.app_token}, table_id=${p.table_id}, field_id=${p.field_id}`);
						assertLarkOk(await client.invoke("feishu_bitable_app_table_field.delete", (sdk, opts) => sdk.bitable.appTableField.delete({ path: {
							app_token: p.app_token,
							table_id: p.table_id,
							field_id: p.field_id
						} }, opts), { as: "user" }));
						log.info(`delete: deleted field ${p.field_id}`);
						return json({ success: true });
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_bitable_app_table_field" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/bitable/app-table-view.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_bitable_app_table_view tool -- Manage Feishu Bitable views.
*
* P1 Actions: create, get, list, patch
*
* Uses the Feishu Bitable v1 API:
*   - create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views
*   - get:    GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views/:view_id
*   - list:   GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views
*   - patch:  PATCH /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views/:view_id
*/
const FeishuBitableAppTableViewSchema = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		view_name: Type.String({ description: "视图名称" }),
		view_type: Type.Optional(Type.Union([
			Type.Literal("grid"),
			Type.Literal("kanban"),
			Type.Literal("gallery"),
			Type.Literal("gantt"),
			Type.Literal("form")
		]))
	}),
	Type.Object({
		action: Type.Literal("get"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		view_id: Type.String({ description: "视图 ID" })
	}),
	Type.Object({
		action: Type.Literal("list"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		page_size: Type.Optional(Type.Number({ description: "每页数量，默认 50，最大 100" })),
		page_token: Type.Optional(Type.String({ description: "分页标记" }))
	}),
	Type.Object({
		action: Type.Literal("patch"),
		app_token: Type.String({ description: "多维表格 token" }),
		table_id: Type.String({ description: "数据表 ID" }),
		view_id: Type.String({ description: "视图 ID" }),
		view_name: Type.Optional(Type.String({ description: "新的视图名称" }))
	})
]);
function registerFeishuBitableAppTableViewTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_bitable_app_table_view");
	registerTool(api, {
		name: "feishu_bitable_app_table_view",
		label: "Feishu Bitable Views",
		description: "【以用户身份】飞书多维表格视图管理工具。当用户要求创建/查询/更新视图、切换展示方式时使用。Actions: create（创建视图）, get（获取视图详情）, list（列出所有视图）, patch（更新视图）。",
		parameters: FeishuBitableAppTableViewSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "create": {
						log.info(`create: app_token=${p.app_token}, table_id=${p.table_id}, view_name=${p.view_name}, view_type=${p.view_type ?? "grid"}`);
						const res = await client.invoke("feishu_bitable_app_table_view.create", (sdk, opts) => sdk.bitable.appTableView.create({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							data: {
								view_name: p.view_name,
								view_type: p.view_type || "grid"
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: created view ${res.data?.view?.view_id}`);
						return json({ view: res.data?.view });
					}
					case "get": {
						log.info(`get: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id}`);
						const res = await client.invoke("feishu_bitable_app_table_view.get", (sdk, opts) => sdk.bitable.appTableView.get({ path: {
							app_token: p.app_token,
							table_id: p.table_id,
							view_id: p.view_id
						} }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get: returned view ${p.view_id}`);
						return json({ view: res.data?.view });
					}
					case "list": {
						log.info(`list: app_token=${p.app_token}, table_id=${p.table_id}`);
						const res = await client.invoke("feishu_bitable_app_table_view.list", (sdk, opts) => sdk.bitable.appTableView.list({
							path: {
								app_token: p.app_token,
								table_id: p.table_id
							},
							params: {
								page_size: p.page_size,
								page_token: p.page_token
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} views`);
						return json({
							views: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "patch": {
						log.info(`patch: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id}, view_name=${p.view_name}`);
						const res = await client.invoke("feishu_bitable_app_table_view.patch", (sdk, opts) => sdk.bitable.appTableView.patch({
							path: {
								app_token: p.app_token,
								table_id: p.table_id,
								view_id: p.view_id
							},
							data: { view_name: p.view_name }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`patch: updated view ${p.view_id}`);
						return json({ view: res.data?.view });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_bitable_app_table_view" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/common/get-user.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_get_user tool -- 获取用户信息
*
* 支持两种模式:
* 1. 不传 user_id: 获取当前用户自己的信息 (sdk.authen.userInfo.get)
* 2. 传 user_id: 获取指定用户的信息 (sdk.contact.v3.user.get)
*/
const GetUserSchema = Type.Object({
	user_id: Type.Optional(Type.String({ description: "用户 ID（格式如 ou_xxx）。若不传入，则获取当前用户自己的信息" })),
	user_id_type: Type.Optional(StringEnum([
		"open_id",
		"union_id",
		"user_id"
	]))
});
function registerGetUserTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_get_user");
	registerTool(api, {
		name: "feishu_get_user",
		label: "Feishu: Get User Info",
		description: "获取用户信息。不传 user_id 时获取当前用户自己的信息；传 user_id 时获取指定用户的信息。返回用户姓名、头像、邮箱、手机号、部门等信息。",
		parameters: GetUserSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				if (!p.user_id) {
					log.info("get_user: fetching current user info");
					try {
						const res = await client.invoke("feishu_get_user.default", (sdk, opts) => sdk.authen.userInfo.get({}, opts), { as: "user" });
						assertLarkOk(res);
						log.info("get_user: current user fetched successfully");
						return json({ user: res.data });
					} catch (invokeErr) {
						if (invokeErr && typeof invokeErr === "object") {
							if (invokeErr.response?.data?.code === 41050) return json({ error: "无权限查询该用户信息。\n\n说明：使用用户身份调用通讯录 API 时，可操作的权限范围不受应用的通讯录权限范围影响，而是受当前用户的组织架构可见范围影响。该范围限制了用户在企业内可见的组织架构数据范围。" });
						}
						throw invokeErr;
					}
				}
				log.info(`get_user: fetching user ${p.user_id}`);
				const userIdType = p.user_id_type || "open_id";
				try {
					const res = await client.invoke("feishu_get_user.default", (sdk, opts) => sdk.contact.v3.user.get({
						path: { user_id: p.user_id },
						params: { user_id_type: userIdType }
					}, opts), { as: "user" });
					assertLarkOk(res);
					log.info(`get_user: user ${p.user_id} fetched successfully`);
					return json({ user: res.data?.user });
				} catch (invokeErr) {
					if (invokeErr && typeof invokeErr === "object") {
						if (invokeErr.response?.data?.code === 41050) return json({ error: "无权限查询该用户信息。\n\n说明：使用用户身份调用通讯录 API 时，可操作的权限范围不受应用的通讯录权限范围影响，而是受当前用户的组织架构可见范围影响。该范围限制了用户在企业内可见的组织架构数据范围。\n\n建议：请联系管理员调整当前用户的组织架构可见范围，或使用应用身份（tenant_access_token）调用 API。" });
					}
					throw invokeErr;
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_get_user" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/common/search-user.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_search_user tool -- 搜索员工
*
* 通过关键词搜索员工，结果按亲密度排序
* 使用搜索接口（/open-apis/search/v1/user）
*/
const SearchUserSchema = Type.Object({
	query: Type.String({ description: "搜索关键词，用于匹配用户名（必填）" }),
	page_size: Type.Optional(Type.Integer({
		description: "分页大小，控制每次返回的用户数量（默认20，最大200）",
		minimum: 1,
		maximum: 200
	})),
	page_token: Type.Optional(Type.String({ description: "分页标识。首次请求无需填写；当返回结果中包含 page_token 时，可传入该值继续请求下一页" }))
});
function registerSearchUserTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_search_user");
	registerTool(api, {
		name: "feishu_search_user",
		label: "Feishu: Search User",
		description: "搜索员工信息（通过关键词搜索姓名、手机号、邮箱）。返回匹配的员工列表，包含姓名、部门、open_id 等信息。",
		parameters: SearchUserSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				log.info(`search_user: query="${p.query}", page_size=${p.page_size ?? 20}`);
				const requestQuery = {
					query: p.query,
					page_size: String(p.page_size ?? 20)
				};
				if (p.page_token) requestQuery.page_token = p.page_token;
				const res = await client.invokeByPath("feishu_search_user.default", "/open-apis/search/v1/user", {
					method: "GET",
					query: requestQuery,
					as: "user"
				});
				assertLarkOk(res);
				const data = res.data;
				const users = data?.users ?? [];
				const userCount = users.length;
				log.info(`search_user: found ${userCount} users`);
				return json({
					users,
					has_more: data?.has_more ?? false,
					page_token: data?.page_token
				});
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_search_user" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/search/doc-search.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_search_doc_wiki tool -- Search Feishu documents and wikis.
*
* Actions: search
*
* Uses the Feishu Search API:
*   - search: POST /open-apis/search/v2/doc_wiki/search
*/
const TimeRangeSchema = Type.Object({
	start: Type.Optional(Type.String({ description: "时间范围的起始时间，ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'" })),
	end: Type.Optional(Type.String({ description: "时间范围的截止时间，ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'" }))
});
const DocTypeEnum = StringEnum([
	"DOC",
	"SHEET",
	"BITABLE",
	"MINDNOTE",
	"FILE",
	"WIKI",
	"DOCX",
	"FOLDER",
	"CATALOG",
	"SLIDES",
	"SHORTCUT"
]);
const SortTypeEnum = StringEnum([
	"DEFAULT_TYPE",
	"OPEN_TIME",
	"EDIT_TIME",
	"EDIT_TIME_ASC",
	"CREATE_TIME"
], { description: "排序方式。EDIT_TIME=编辑时间降序（最新文档在前，推荐），EDIT_TIME_ASC=编辑时间升序，CREATE_TIME=按文档创建时间排序，OPEN_TIME=打开时间，DEFAULT_TYPE=默认排序" });
const FeishuSearchDocWikiSchema = Type.Object({
	action: Type.Literal("search"),
	query: Type.Optional(Type.String({
		description: "搜索关键词（可选）。不传或传空字符串表示空搜，也可以支持排序规则与筛选，默认根据最近浏览时间返回结果",
		maxLength: 50
	})),
	filter: Type.Optional(Type.Object({
		creator_ids: Type.Optional(Type.Array(Type.String(), {
			description: "创建者 OpenID 列表（最多 20 个）",
			maxItems: 20
		})),
		doc_types: Type.Optional(Type.Array(DocTypeEnum, {
			description: "文档类型列表：DOC（文档）、SHEET（表格）、BITABLE（多维表格）、MINDNOTE（思维导图）、FILE（文件）、WIKI（维基）、DOCX（新版文档）、FOLDER（space文件夹）、CATALOG（wiki2.0文件夹）、SLIDES（新版幻灯片）、SHORTCUT（快捷方式）",
			maxItems: 10
		})),
		only_title: Type.Optional(Type.Boolean({ description: "仅搜索标题（默认 false，搜索标题和正文）" })),
		open_time: Type.Optional(TimeRangeSchema),
		sort_type: Type.Optional(SortTypeEnum),
		create_time: Type.Optional(TimeRangeSchema)
	}, { description: "搜索过滤条件（可选）。不传则搜索所有文档和 Wiki；传了则同时对文档和 Wiki 应用相同的过滤条件。" })),
	page_token: Type.Optional(Type.String({ description: "分页标记。首次请求不填；当返回结果中 has_more 为 true 时，可传入返回的 page_token 继续请求下一页" })),
	page_size: Type.Optional(Type.Integer({
		description: "分页大小（默认 15，最大 20）",
		minimum: 0,
		maximum: 20
	}))
});
function normalizeSearchResultTimeFields(value, converted) {
	if (Array.isArray(value)) return value.map((item) => normalizeSearchResultTimeFields(item, converted));
	if (!value || typeof value !== "object") return value;
	const source = value;
	const normalized = {};
	for (const [key, item] of Object.entries(source)) {
		if (key.endsWith("_time")) {
			const iso = unixTimestampToISO8601(item);
			if (iso) {
				normalized[key] = iso;
				converted.count += 1;
				continue;
			}
		}
		normalized[key] = normalizeSearchResultTimeFields(item, converted);
	}
	return normalized;
}
function registerFeishuSearchDocWikiTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_search_doc_wiki");
	return registerTool(api, {
		name: "feishu_search_doc_wiki",
		label: "Feishu Document & Wiki Search",
		description: "【以用户身份】飞书文档与 Wiki 统一搜索工具。同时搜索云空间文档和知识库 Wiki。Actions: search。【重要】query 参数是搜索关键词（必填），filter 参数可选。【重要】filter 不传时，搜索所有文档和 Wiki；传了则同时对文档和 Wiki 应用相同的过滤条件。【重要】支持按文档类型、创建者、创建时间、打开时间等多维度筛选。【重要】返回结果包含标题和摘要高亮（<h>标签包裹匹配关键词）。",
		parameters: FeishuSearchDocWikiSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "search": {
						const query = p.query ?? "";
						log.info(`search: query="${query}", has_filter=${!!p.filter}, page_size=${p.page_size ?? 15}`);
						const requestData = {
							query,
							page_size: p.page_size,
							page_token: p.page_token
						};
						if (p.filter) {
							const filter = { ...p.filter };
							if (filter.open_time) filter.open_time = convertTimeRange(filter.open_time);
							if (filter.create_time) filter.create_time = convertTimeRange(filter.create_time);
							requestData.doc_filter = { ...filter };
							requestData.wiki_filter = { ...filter };
							log.info(`search: applying filter to both doc and wiki: doc_types=${filter.doc_types?.join(",") || "all"}, only_title=${filter.only_title ?? false}`);
						} else {
							requestData.doc_filter = {};
							requestData.wiki_filter = {};
							log.info(`search: no filter provided, using empty filters (required by API)`);
						}
						const res = await client.invoke("feishu_search_doc_wiki.search", async (sdk, _opts, uat) => {
							return sdk.request({
								method: "POST",
								url: "/open-apis/search/v2/doc_wiki/search",
								data: requestData,
								headers: {
									Authorization: `Bearer ${uat}`,
									"Content-Type": "application/json; charset=utf-8"
								}
							}, _opts);
						}, { as: "user" });
						if (res.code !== 0) throw new Error(`API Error: code=${res.code}, msg=${res.msg}`);
						const data = res.data || {};
						log.info(`search: found ${data.res_units?.length ?? 0} results, total=${data.total ?? 0}, has_more=${data.has_more ?? false}`);
						const converted = { count: 0 };
						const normalizedResults = normalizeSearchResultTimeFields(data.res_units, converted);
						log.info(`search: normalized ${converted.count} timestamp fields to ISO8601`);
						return json({
							total: data.total,
							has_more: data.has_more,
							results: normalizedResults,
							page_token: data.page_token
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_search_doc_wiki" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/search/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Search 工具集
* 统一导出所有搜索相关工具的注册函数
*/
/**
* 注册所有 Search 工具
*/
function registerFeishuSearchTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_search: No config available, skipping");
		return;
	}
	const accounts = getEnabledLarkAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_search: No Feishu accounts configured, skipping");
		return;
	}
	if (!resolveAnyEnabledToolsConfig(accounts).doc) {
		api.logger.debug?.("feishu_search: search tool disabled in all accounts (controlled by doc config)");
		return;
	}
	if (registerFeishuSearchDocWikiTool(api)) api.logger.debug?.("feishu_search: Registered feishu_search_doc_wiki");
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/drive/file.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_drive_file tool -- Manage Feishu Drive files.
*
* Actions: list, get_meta, copy, move, delete, upload, download
*
* Uses the Feishu Drive API:
*   - list:        GET    /open-apis/drive/v1/files
*   - get_meta:    POST   /open-apis/drive/v1/metas/batch_query
*   - copy:        POST   /open-apis/drive/v1/files/:file_token/copy
*   - move:        POST   /open-apis/drive/v1/files/:file_token/move
*   - delete:      DELETE /open-apis/drive/v1/files/:file_token
*   - upload:      POST   /open-apis/drive/v1/files/upload_all
*   - download:    GET    /open-apis/drive/v1/files/:file_token/download
*/
const SMALL_FILE_THRESHOLD = 15 * 1024 * 1024;
const FeishuDriveFileSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		folder_token: Type.Optional(Type.String({ description: "文件夹 token（可选）。不填写或填空字符串时，获取用户云空间根目录下的清单（注意：根目录模式不支持分页和返回快捷方式）" })),
		page_size: Type.Optional(Type.Integer({
			description: "分页大小（默认 200，最大 200）",
			minimum: 1,
			maximum: 200
		})),
		page_token: Type.Optional(Type.String({ description: "分页标记。首次请求无需填写" })),
		order_by: Type.Optional(StringEnum(["EditedTime", "CreatedTime"], { description: "排序方式：EditedTime（编辑时间）、CreatedTime（创建时间）" })),
		direction: Type.Optional(StringEnum(["ASC", "DESC"], { description: "排序方向：ASC（升序）、DESC（降序）" }))
	}),
	Type.Object({
		action: Type.Literal("get_meta"),
		request_docs: Type.Array(Type.Object({
			doc_token: Type.String({ description: "文档 token（从浏览器 URL 中获取，如 spreadsheet_token、doc_token 等）" }),
			doc_type: Type.Union([
				Type.Literal("doc"),
				Type.Literal("sheet"),
				Type.Literal("file"),
				Type.Literal("bitable"),
				Type.Literal("docx"),
				Type.Literal("folder"),
				Type.Literal("mindnote"),
				Type.Literal("slides")
			], { description: "文档类型：doc、sheet、file、bitable、docx、folder、mindnote、slides" })
		}), {
			description: "要查询的文档列表（批量查询，最多 50 个）。示例：[{doc_token: 'Z1FjxxxxxxxxxxxxxxxxxxxtnAc', doc_type: 'sheet'}]",
			minItems: 1,
			maxItems: 50
		})
	}),
	Type.Object({
		action: Type.Literal("copy"),
		file_token: Type.String({ description: "文件 token（必填）" }),
		name: Type.String({ description: "目标文件名（必填）" }),
		type: Type.Union([
			Type.Literal("doc"),
			Type.Literal("sheet"),
			Type.Literal("file"),
			Type.Literal("bitable"),
			Type.Literal("docx"),
			Type.Literal("folder"),
			Type.Literal("mindnote"),
			Type.Literal("slides")
		], { description: "文档类型（必填）" }),
		folder_token: Type.Optional(Type.String({ description: "目标文件夹 token。不传则复制到「我的空间」根目录" })),
		parent_node: Type.Optional(Type.String({ description: "【folder_token 的别名】目标文件夹 token（为兼容性保留，建议使用 folder_token）" }))
	}),
	Type.Object({
		action: Type.Literal("move"),
		file_token: Type.String({ description: "文件 token（必填）" }),
		type: Type.Union([
			Type.Literal("doc"),
			Type.Literal("sheet"),
			Type.Literal("file"),
			Type.Literal("bitable"),
			Type.Literal("docx"),
			Type.Literal("folder"),
			Type.Literal("mindnote"),
			Type.Literal("slides")
		], { description: "文档类型（必填）" }),
		folder_token: Type.String({ description: "目标文件夹 token（必填）" })
	}),
	Type.Object({
		action: Type.Literal("delete"),
		file_token: Type.String({ description: "文件 token（必填）" }),
		type: Type.Union([
			Type.Literal("doc"),
			Type.Literal("sheet"),
			Type.Literal("file"),
			Type.Literal("bitable"),
			Type.Literal("docx"),
			Type.Literal("folder"),
			Type.Literal("mindnote"),
			Type.Literal("slides")
		], { description: "文档类型（必填）" })
	}),
	Type.Object({
		action: Type.Literal("upload"),
		parent_node: Type.Optional(Type.String({ description: "父节点 token（可选）。explorer 类型填文件夹 token，bitable 类型填 app_token。不填写或填空字符串时，上传到云空间根目录" })),
		file_path: Type.Optional(Type.String({ description: "本地文件路径（与 file_content_base64 二选一）。优先使用此参数，会自动读取文件内容、计算大小、提取文件名。" })),
		file_content_base64: Type.Optional(Type.String({ description: "文件内容的 Base64 编码（与 file_path 二选一）。当不提供 file_path 时使用。" })),
		file_name: Type.Optional(Type.String({ description: "文件名（可选）。如果提供了 file_path，会自动从路径中提取文件名；如果使用 file_content_base64，则必须提供此参数。" })),
		size: Type.Optional(Type.Integer({ description: "文件大小（字节，可选）。如果提供了 file_path，会自动计算；如果使用 file_content_base64，则必须提供此参数。" }))
	}),
	Type.Object({
		action: Type.Literal("download"),
		file_token: Type.String({ description: "文件 token（必填）" }),
		output_path: Type.Optional(Type.String({ description: "本地保存的完整文件路径（可选）。必须包含文件名和扩展名，例如 '/tmp/file.pdf'。如果不提供，则返回 Base64 编码的文件内容。" }))
	})
]);
function registerFeishuDriveFileTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_drive_file");
	return registerTool(api, {
		name: "feishu_drive_file",
		label: "Feishu Drive Files",
		description: "【以用户身份】飞书云空间文件管理工具。当用户要求查看云空间(云盘)中的文件列表、获取文件信息、复制/移动/删除文件、上传/下载文件时使用。消息中的文件读写**禁止**使用该工具!\n\nActions:\n- list（列出文件）：列出文件夹下的文件。不提供 folder_token 时获取根目录清单\n- get_meta（批量获取元数据）：批量查询文档元信息，使用 request_docs 数组参数，格式：[{doc_token: '...', doc_type: 'sheet'}]\n- copy（复制文件）：复制文件到指定位置\n- move（移动文件）：移动文件到指定文件夹\n- delete（删除文件）：删除文件\n- upload（上传文件）：上传本地文件到云空间。提供 file_path（本地文件路径）或 file_content_base64（Base64 编码）\n- download（下载文件）：下载文件到本地。提供 output_path（本地保存路径）则保存到本地，否则返回 Base64 编码\n\n【重要】copy/move/delete 操作需要 file_token 和 type 参数。get_meta 使用 request_docs 数组参数。\n【重要】upload 优先使用 file_path（自动读取文件、提取文件名和大小），也支持 file_content_base64（需手动提供 file_name 和 size）。\n【重要】download 提供 output_path 时保存到本地（可以是文件路径或文件夹路径+file_name），不提供则返回 Base64。",
		parameters: FeishuDriveFileSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "list": {
						log.info(`list: folder_token=${p.folder_token || "(root)"}, page_size=${p.page_size ?? 200}`);
						const res = await client.invoke("feishu_drive_file.list", (sdk, opts) => sdk.drive.file.list({ params: {
							folder_token: p.folder_token,
							page_size: p.page_size,
							page_token: p.page_token,
							order_by: p.order_by,
							direction: p.direction
						} }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`list: returned ${res.data?.files?.length ?? 0} files`);
						const data = res.data;
						return json({
							files: data?.files,
							has_more: data?.has_more,
							page_token: data?.next_page_token
						});
					}
					case "get_meta": {
						if (!p.request_docs || !Array.isArray(p.request_docs) || p.request_docs.length === 0) return json({ error: "request_docs must be a non-empty array. Correct format: {action: 'get_meta', request_docs: [{doc_token: '...', doc_type: 'sheet'}]}" });
						log.info(`get_meta: querying ${p.request_docs.length} documents`);
						const res = await client.invoke("feishu_drive_file.get_meta", (sdk, opts) => sdk.drive.meta.batchQuery({ data: { request_docs: p.request_docs } }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get_meta: returned ${res.data?.metas?.length ?? 0} metas`);
						return json({ metas: res.data?.metas ?? [] });
					}
					case "copy": {
						const targetFolderToken = p.folder_token || p.parent_node;
						log.info(`copy: file_token=${p.file_token}, name=${p.name}, type=${p.type}, folder_token=${targetFolderToken ?? "(root)"}`);
						const res = await client.invoke("feishu_drive_file.copy", (sdk, opts) => sdk.drive.file.copy({
							path: { file_token: p.file_token },
							data: {
								name: p.name,
								type: p.type,
								folder_token: targetFolderToken
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`copy: new file_token=${data?.file?.token ?? "unknown"}`);
						return json({ file: data?.file });
					}
					case "move": {
						log.info(`move: file_token=${p.file_token}, type=${p.type}, folder_token=${p.folder_token}`);
						const res = await client.invoke("feishu_drive_file.move", (sdk, opts) => sdk.drive.file.move({
							path: { file_token: p.file_token },
							data: {
								type: p.type,
								folder_token: p.folder_token
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`move: success${data?.task_id ? `, task_id=${data.task_id}` : ""}`);
						return json({
							success: true,
							...data?.task_id ? { task_id: data.task_id } : {},
							file_token: p.file_token,
							target_folder_token: p.folder_token
						});
					}
					case "delete": {
						log.info(`delete: file_token=${p.file_token}, type=${p.type}`);
						const res = await client.invoke("feishu_drive_file.delete", (sdk, opts) => sdk.drive.file.delete({
							path: { file_token: p.file_token },
							params: { type: p.type }
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`delete: success${data?.task_id ? `, task_id=${data.task_id}` : ""}`);
						return json({
							success: true,
							...data?.task_id ? { task_id: data.task_id } : {},
							file_token: p.file_token
						});
					}
					case "upload": {
						let fileBuffer;
						let fileName;
						let fileSize;
						if (p.file_path) {
							log.info(`upload: reading from local file: ${p.file_path}`);
							try {
								fileBuffer = await fsPromises.readFile(p.file_path);
								fileName = p.file_name || path$1.basename(p.file_path);
								fileSize = p.size || fileBuffer.length;
								log.info(`upload: file_name=${fileName}, size=${fileSize}, parent=${p.parent_node || "(root)"}`);
							} catch (err) {
								return json({ error: `failed to read local file: ${err instanceof Error ? err.message : String(err)}` });
							}
						} else if (p.file_content_base64) {
							if (!p.file_name || !p.size) return json({ error: "file_name and size are required when using file_content_base64" });
							log.info(`upload: using base64 content, file_name=${p.file_name}, size=${p.size}, parent=${p.parent_node}`);
							fileBuffer = Buffer.from(p.file_content_base64, "base64");
							fileName = p.file_name;
							fileSize = p.size;
						} else return json({ error: "either file_path or file_content_base64 is required" });
						if (fileSize <= SMALL_FILE_THRESHOLD) {
							log.info(`upload: using upload_all (file size ${fileSize} <= 15MB)`);
							const res = await client.invoke("feishu_drive_file.upload", (sdk, opts) => sdk.drive.file.uploadAll({ data: {
								file_name: fileName,
								parent_type: "explorer",
								parent_node: p.parent_node || "",
								size: fileSize,
								file: fileBuffer
							} }, opts), { as: "user" });
							assertLarkOk(res);
							log.info(`upload: file_token=${res.data?.file_token}`);
							return json({
								file_token: res.data?.file_token,
								file_name: fileName,
								size: fileSize
							});
						} else {
							log.info(`upload: using chunked upload (file size ${fileSize} > 15MB)`);
							log.info(`upload: step 1 - prepare upload`);
							const prepareRes = await client.invoke("feishu_drive_file.upload", (sdk, opts) => sdk.drive.file.uploadPrepare({ data: {
								file_name: fileName,
								parent_type: "explorer",
								parent_node: p.parent_node || "",
								size: fileSize
							} }, opts), { as: "user" });
							log.info(`upload: prepareRes = ${JSON.stringify(prepareRes)}`);
							if (!prepareRes) return json({ error: "pre-upload failed: empty response" });
							assertLarkOk(prepareRes);
							const { upload_id, block_size, block_num } = prepareRes.data;
							log.info(`upload: got upload_id=${upload_id}, block_num=${block_num}, block_size=${block_size}`);
							log.info(`upload: step 2 - uploading ${block_num} chunks`);
							for (let seq = 0; seq < block_num; seq++) {
								const start = seq * block_size;
								const end = Math.min(start + block_size, fileSize);
								const chunkBuffer = fileBuffer.subarray(start, end);
								log.info(`upload: uploading chunk ${seq + 1}/${block_num} (${chunkBuffer.length} bytes)`);
								await client.invoke("feishu_drive_file.upload", (sdk, opts) => sdk.drive.file.uploadPart({ data: {
									upload_id: String(upload_id),
									seq: Number(seq),
									size: Number(chunkBuffer.length),
									file: chunkBuffer
								} }, opts), { as: "user" });
								log.info(`upload: chunk ${seq + 1}/${block_num} uploaded successfully`);
							}
							log.info(`upload: step 3 - finish upload`);
							const finishRes = await client.invoke("feishu_drive_file.upload", (sdk, opts) => sdk.drive.file.uploadFinish({ data: {
								upload_id,
								block_num
							} }, opts), { as: "user" });
							assertLarkOk(finishRes);
							log.info(`upload: file_token=${finishRes.data?.file_token}`);
							return json({
								file_token: finishRes.data?.file_token,
								file_name: fileName,
								size: fileSize,
								upload_method: "chunked",
								chunks_uploaded: block_num
							});
						}
					}
					case "download": {
						log.info(`download: file_token=${p.file_token}`);
						const stream = (await client.invoke("feishu_drive_file.download", (sdk, opts) => sdk.drive.file.download({ path: { file_token: p.file_token } }, opts), { as: "user" })).getReadableStream();
						const chunks = [];
						for await (const chunk of stream) chunks.push(chunk);
						const fileBuffer = Buffer.concat(chunks);
						log.info(`download: file size=${fileBuffer.length} bytes`);
						if (p.output_path) try {
							await fsPromises.mkdir(path$1.dirname(p.output_path), { recursive: true });
							await fsPromises.writeFile(p.output_path, fileBuffer);
							log.info(`download: saved to ${p.output_path}`);
							return json({
								saved_path: p.output_path,
								size: fileBuffer.length
							});
						} catch (err) {
							return json({ error: `failed to save file: ${err instanceof Error ? err.message : String(err)}` });
						}
						else return json({
							file_content_base64: fileBuffer.toString("base64"),
							size: fileBuffer.length
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_drive_file" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/drive/doc-comments.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_doc_comments tool -- 云文档评论管理
*
* 支持获取、创建、解决/恢复云文档评论
* 使用以下 SDK 接口:
* - sdk.drive.v1.fileComment.list - 获取评论列表
* - sdk.drive.v1.fileComment.create - 创建全文评论
* - sdk.drive.v1.fileComment.patch - 解决/恢复评论
* - sdk.drive.v1.fileCommentReply.list - 获取回复列表
*/
const ReplyElementSchema = Type.Object({
	type: StringEnum([
		"text",
		"mention",
		"link"
	]),
	text: Type.Optional(Type.String({ description: "文本内容(type=text时必填)" })),
	open_id: Type.Optional(Type.String({ description: "被@用户的open_id(type=mention时必填)" })),
	url: Type.Optional(Type.String({ description: "链接URL(type=link时必填)" }))
});
const DocCommentsSchema = Type.Object({
	action: StringEnum([
		"list",
		"list_replies",
		"create",
		"reply",
		"patch"
	]),
	file_token: Type.String({ description: "云文档token或wiki节点token(可从文档URL获取)。如果是wiki token，会自动转换为实际文档的obj_token" }),
	file_type: StringEnum([
		"doc",
		"docx",
		"sheet",
		"file",
		"slides",
		"wiki"
	], { description: "文档类型。wiki类型会自动解析为实际文档类型(docx/sheet/bitable等)" }),
	is_whole: Type.Optional(Type.Boolean({ description: "是否只获取全文评论(action=list时可选)" })),
	is_solved: Type.Optional(Type.Boolean({ description: "是否只获取已解决的评论(action=list时可选)" })),
	page_size: Type.Optional(Type.Integer({ description: "分页大小" })),
	page_token: Type.Optional(Type.String({ description: "分页标记" })),
	elements: Type.Optional(Type.Array(ReplyElementSchema, { description: "评论内容元素数组(action=create/reply时必填)。支持text(纯文本)、mention(@用户)、link(超链接)三种类型" })),
	comment_id: Type.Optional(Type.String({ description: "评论ID(action=list_replies/reply/patch时必填)" })),
	is_solved_value: Type.Optional(Type.Boolean({ description: "解决状态:true=解决,false=恢复(action=patch时必填)" })),
	user_id_type: Type.Optional(StringEnum([
		"open_id",
		"union_id",
		"user_id"
	]))
});
function convertElementsToSDKFormat(elements) {
	return elements.map((el) => {
		if (el.type === "text") return {
			type: "text_run",
			text_run: { text: el.text }
		};
		else if (el.type === "mention") return {
			type: "person",
			person: { user_id: el.open_id }
		};
		else if (el.type === "link") return {
			type: "docs_link",
			docs_link: { url: el.url }
		};
		return {
			type: "text_run",
			text_run: { text: "" }
		};
	});
}
/**
* 组装评论和回复数据
* 获取评论列表API会返回部分回复,但可能不完整
* 此函数会为每个评论获取完整的回复列表
*/
async function assembleCommentsWithReplies(client, file_token, file_type, comments, user_id_type, log) {
	const result = [];
	for (const comment of comments) {
		const assembled = { ...comment };
		if (comment.reply_list?.replies?.length > 0 || comment.has_more) try {
			const replies = [];
			let pageToken = void 0;
			let hasMore = true;
			while (hasMore) {
				const replyRes = await client.invoke("drive.v1.fileCommentReply.list", (sdk, opts) => sdk.drive.v1.fileCommentReply.list({
					path: {
						file_token,
						comment_id: comment.comment_id
					},
					params: {
						file_type,
						page_token: pageToken,
						page_size: 50,
						user_id_type
					}
				}, opts), { as: "tenant" });
				const replyData = replyRes.data;
				if (replyRes.code === 0 && replyData?.items) {
					replies.push(...replyData.items || []);
					hasMore = replyData.has_more || false;
					pageToken = replyData.page_token;
				} else break;
			}
			assembled.reply_list = { replies };
			log.info(`Assembled ${replies.length} replies for comment ${comment.comment_id}`);
		} catch (err) {
			log.warn(`Failed to fetch replies for comment ${comment.comment_id}: ${err}`);
		}
		result.push(assembled);
	}
	return result;
}
function registerDocCommentsTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_doc_comments");
	return registerTool(api, {
		name: "feishu_doc_comments",
		label: "Feishu: Doc Comments",
		description: "【以用户身份】管理云文档评论。支持: (1) list - 获取评论列表(含完整回复); (2) list_replies - 获取指定评论的回复列表; (3) create - 添加全文评论(支持文本、@用户、超链接); (4) reply - 回复已有评论; (5) patch - 解决/恢复评论。支持 wiki token。",
		parameters: DocCommentsSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				const userIdType = p.user_id_type || "open_id";
				let actualFileToken = p.file_token;
				let actualFileType = p.file_type;
				if (p.file_type === "wiki") {
					log.info(`doc_comments: detected wiki token="${p.file_token}", converting to obj_token...`);
					try {
						const wikiNodeRes = await client.invoke("feishu_wiki_space_node.get", (sdk, opts) => sdk.wiki.space.getNode({ params: {
							token: p.file_token,
							obj_type: "wiki"
						} }, opts), { as: "user" });
						assertLarkOk(wikiNodeRes);
						const node = wikiNodeRes.data?.node;
						if (!node || !node.obj_token || !node.obj_type) return json({
							error: `failed to resolve wiki token "${p.file_token}" to document object (may be a folder node rather than a document)`,
							wiki_node: node
						});
						actualFileToken = node.obj_token;
						actualFileType = node.obj_type;
						log.info(`doc_comments: wiki token converted, obj_type="${actualFileType}"`);
					} catch (err) {
						log.error(`doc_comments: failed to convert wiki token: ${err}`);
						return json({ error: `failed to resolve wiki token "${p.file_token}": ${err}` });
					}
				}
				if (p.action === "list") {
					log.info(`doc_comments.list: file_type=${actualFileType}`);
					const res = await client.invoke("feishu_doc_comments.list", (sdk, opts) => sdk.drive.v1.fileComment.list({
						path: { file_token: actualFileToken },
						params: {
							file_type: actualFileType,
							is_whole: p.is_whole,
							is_solved: p.is_solved,
							page_size: p.page_size || 50,
							page_token: p.page_token,
							user_id_type: userIdType
						}
					}, opts), { as: "tenant" });
					assertLarkOk(res);
					const items = res.data?.items || [];
					log.info(`doc_comments.list: found ${items.length} comments`);
					return json({
						items: await assembleCommentsWithReplies(client, actualFileToken, actualFileType, items, userIdType, log),
						has_more: res.data?.has_more ?? false,
						page_token: res.data?.page_token
					});
				}
				if (p.action === "list_replies") {
					if (!p.comment_id) return json({ error: "comment_id 参数必填" });
					log.info(`doc_comments.list_replies: comment_id="${p.comment_id}"`);
					const replyRes = await client.invoke("feishu_doc_comments.list_replies", (sdk, opts) => sdk.drive.v1.fileCommentReply.list({
						path: {
							file_token: actualFileToken,
							comment_id: p.comment_id
						},
						params: {
							file_type: actualFileType,
							page_token: p.page_token,
							page_size: p.page_size || 50,
							user_id_type: userIdType
						}
					}, opts), { as: "tenant" });
					assertLarkOk(replyRes);
					const replyData = replyRes.data;
					log.info(`doc_comments.list_replies: found ${replyData?.items?.length ?? 0} replies`);
					return json({
						items: replyData?.items ?? [],
						has_more: replyData?.has_more ?? false,
						page_token: replyData?.page_token
					});
				}
				if (p.action === "create") {
					if (!p.elements || p.elements.length === 0) return json({ error: "elements 参数必填且不能为空" });
					log.info(`doc_comments.create: file_type=${actualFileType}, elements=${p.elements.length}`);
					const commentData = { reply_list: { replies: [{ content: { elements: convertElementsToSDKFormat(p.elements) } }] } };
					const res = await client.invoke("feishu_doc_comments.create", (sdk, opts) => sdk.drive.v1.fileComment.create({
						path: { file_token: actualFileToken },
						params: {
							file_type: actualFileType,
							user_id_type: userIdType
						},
						data: commentData
					}, opts), { as: "tenant" });
					assertLarkOk(res);
					log.info(`doc_comments.create: created comment ${res.data?.comment_id}`);
					return json(res.data);
				}
				if (p.action === "reply") {
					if (!p.comment_id) return json({ error: "comment_id 参数必填" });
					if (!p.elements || p.elements.length === 0) return json({ error: "elements 参数必填且不能为空" });
					log.info(`doc_comments.reply: comment_id="${p.comment_id}", elements=${p.elements.length}`);
					const sdkElements = convertElementsToSDKFormat(p.elements);
					const replyUrl = `/open-apis/drive/v1/files/${actualFileToken}/comments/${p.comment_id}/replies`;
					const replyParams = {
						file_type: actualFileType,
						user_id_type: userIdType
					};
					let res;
					try {
						res = await client.invoke("feishu_doc_comments.reply", (sdk) => sdk.request({
							method: "POST",
							url: replyUrl,
							params: replyParams,
							data: { content: { elements: sdkElements } }
						}), { as: "tenant" });
					} catch (_firstErr) {
						log.info(`doc_comments.reply: first attempt failed, trying reply_elements format`);
						res = await client.invoke("feishu_doc_comments.reply", (sdk) => sdk.request({
							method: "POST",
							url: replyUrl,
							params: replyParams,
							data: { reply_elements: sdkElements }
						}), { as: "tenant" });
					}
					assertLarkOk(res);
					log.info(`doc_comments.reply: created reply`);
					return json(res.data ?? res);
				}
				if (p.action === "patch") {
					if (!p.comment_id) return json({ error: "comment_id 参数必填" });
					if (p.is_solved_value === void 0) return json({ error: "is_solved_value 参数必填" });
					log.info(`doc_comments.patch: comment_id="${p.comment_id}", is_solved=${p.is_solved_value}`);
					assertLarkOk(await client.invoke("feishu_doc_comments.patch", (sdk, opts) => sdk.drive.v1.fileComment.patch({
						path: {
							file_token: actualFileToken,
							comment_id: p.comment_id
						},
						params: { file_type: actualFileType },
						data: { is_solved: p.is_solved_value }
					}, opts), { as: "user" }));
					log.info(`doc_comments.patch: success`);
					return json({ success: true });
				}
				return json({ error: `未知的 action: ${p.action}` });
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_doc_comments" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/drive/doc-media.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_doc_media tool -- 文档媒体管理（插入 + 下载）
*
* Actions:
*   insert   - 在飞书文档末尾插入本地图片或文件（3 步流程）
*   download - 下载文档素材或画板缩略图到本地
*
* 使用以下 SDK 接口:
* - sdk.docx.documentBlockChildren.create - 创建子块
* - sdk.drive.v1.media.uploadAll - 上传素材
* - sdk.docx.documentBlock.batchUpdate - 批量更新块
* - sdk.drive.v1.media.download - 下载素材
* - sdk.board.v1.whiteboard.downloadAsImage - 下载画板缩略图
*/
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALIGN_MAP = {
	left: 1,
	center: 2,
	right: 3
};
/** 插入时的媒体类型配置 */
const MEDIA_CONFIG = {
	image: {
		block_type: 27,
		block_data: { image: {} },
		parent_type: "docx_image",
		label: "图片"
	},
	file: {
		block_type: 23,
		block_data: { file: { token: "" } },
		parent_type: "docx_file",
		label: "文件"
	}
};
/** MIME type → 扩展名映射 */
const MIME_TO_EXT$1 = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/tiff": ".tiff",
	"video/mp4": ".mp4",
	"video/mpeg": ".mpeg",
	"video/quicktime": ".mov",
	"video/x-msvideo": ".avi",
	"video/webm": ".webm",
	"application/pdf": ".pdf",
	"application/msword": ".doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"application/zip": ".zip",
	"application/x-rar-compressed": ".rar",
	"text/plain": ".txt",
	"application/json": ".json"
};
/**
* 从文档 URL 或纯 ID 中提取 document_id
*/
function extractDocumentId(input) {
	const trimmed = input.trim();
	const urlMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/);
	if (urlMatch) return urlMatch[1];
	return trimmed;
}
const DocMediaSchema = Type.Union([Type.Object({
	action: Type.Literal("insert"),
	doc_id: Type.String({ description: "文档 ID 或文档 URL（必填）。支持从 URL 自动提取 document_id" }),
	file_path: Type.String({ description: "本地文件的绝对路径（必填）。图片支持 jpg/png/gif/webp 等，文件支持任意格式，最大 20MB" }),
	type: Type.Optional(StringEnum(["image", "file"], { description: "媒体类型：\"image\"（图片，默认）或 \"file\"（文件附件）" })),
	align: Type.Optional(StringEnum([
		"left",
		"center",
		"right"
	], { description: "对齐方式（仅图片生效）：\"center\"（默认居中）、\"left\"（居左）、\"right\"（居右）" })),
	caption: Type.Optional(Type.String({ description: "图片描述/标题（可选，仅图片生效）" }))
}), Type.Object({
	action: Type.Literal("download"),
	resource_token: Type.String({ description: "资源的唯一标识（file_token 用于文档素材，whiteboard_id 用于画板）" }),
	resource_type: StringEnum(["media", "whiteboard"], { description: "资源类型：media（文档素材：图片、视频、文件等）或 whiteboard（画板缩略图）" }),
	output_path: Type.String({ description: "保存文件的完整本地路径。可以包含扩展名（如 /tmp/image.png），也可以不带扩展名，系统会根据 Content-Type 自动添加" })
})]);
async function handleInsert(p, client, log) {
	const documentId = extractDocumentId(p.doc_id);
	const mediaType = p.type ?? "image";
	const config = MEDIA_CONFIG[mediaType];
	const filePath = p.file_path;
	const DOC_MEDIA_ALLOWED_ROOTS = [os.tmpdir()];
	validateLocalMediaRoots(path$1.resolve(filePath), DOC_MEDIA_ALLOWED_ROOTS);
	let fileSize;
	try {
		fileSize = (await fsPromises.stat(filePath)).size;
	} catch (err) {
		return json({ error: `failed to read file: ${err instanceof Error ? err.message : String(err)}` });
	}
	if (fileSize > MAX_FILE_SIZE) return json({ error: `file ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit` });
	const fileName = path$1.basename(filePath);
	log.info(`insert: doc=${documentId}, type=${mediaType}, file=${fileName}, size=${fileSize}`);
	const createRes = await client.invoke("feishu_doc_media.insert", (sdk, opts) => sdk.docx.documentBlockChildren.create({
		path: {
			document_id: documentId,
			block_id: documentId
		},
		data: { children: [{
			block_type: config.block_type,
			...config.block_data
		}] },
		params: { document_revision_id: -1 }
	}, opts), { as: "user" });
	assertLarkOk(createRes);
	let blockId;
	if (mediaType === "file") blockId = createRes.data?.children?.[0]?.children?.[0];
	else blockId = createRes.data?.children?.[0]?.block_id;
	if (!blockId) return json({ error: `failed to create ${config.label} block: no block_id returned` });
	log.info(`insert: created ${mediaType} block ${blockId}`);
	const uploadRes = await client.invoke("feishu_doc_media.insert", (sdk, opts) => sdk.drive.v1.media.uploadAll({ data: {
		file_name: fileName,
		parent_type: config.parent_type,
		parent_node: blockId,
		size: fileSize,
		file: createReadStream(filePath),
		extra: JSON.stringify({ drive_route_token: documentId })
	} }, opts), { as: "user" });
	const fileToken = uploadRes?.file_token ?? uploadRes?.data?.file_token;
	if (!fileToken) return json({ error: `failed to upload ${config.label} media: no file_token returned` });
	log.info(`insert: uploaded media, file_token=${fileToken}`);
	const patchRequest = { block_id: blockId };
	if (mediaType === "image") {
		const alignNum = ALIGN_MAP[p.align ?? "center"];
		let width;
		let height;
		try {
			const dims = imageSize(await fsPromises.readFile(filePath));
			if (dims.width && dims.height) {
				width = dims.width;
				height = dims.height;
				log.info(`insert: detected image size ${width}x${height}`);
			}
		} catch {
			log.info("insert: could not detect image dimensions, skipping");
		}
		patchRequest.replace_image = {
			token: fileToken,
			align: alignNum,
			...width != null ? { width } : {},
			...height != null ? { height } : {},
			...p.caption ? { caption: { content: p.caption } } : {}
		};
	} else patchRequest.replace_file = { token: fileToken };
	assertLarkOk(await client.invoke("feishu_doc_media.insert", (sdk, opts) => sdk.docx.documentBlock.batchUpdate({
		path: { document_id: documentId },
		data: { requests: [patchRequest] },
		params: { document_revision_id: -1 }
	}, opts), { as: "user" }));
	log.info(`insert: patched ${mediaType} block with file_token`);
	return json({
		success: true,
		type: mediaType,
		document_id: documentId,
		block_id: blockId,
		file_token: fileToken,
		file_name: fileName
	});
}
async function handleDownload(p, client, log) {
	log.info(`download: resource_type=${p.resource_type}, token="${p.resource_token}"`);
	let res;
	if (p.resource_type === "media") res = await client.invoke("feishu_doc_media.download", (sdk, opts) => sdk.drive.v1.media.download({ path: { file_token: p.resource_token } }, opts), { as: "user" });
	else res = await client.invoke("feishu_doc_media.download", (sdk, opts) => sdk.board.v1.whiteboard.downloadAsImage({ path: { whiteboard_id: p.resource_token } }, opts), { as: "user" });
	const stream = res.getReadableStream();
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	const buffer = Buffer.concat(chunks);
	log.info(`download: received ${buffer.length} bytes`);
	const contentType = res.headers?.["content-type"] || "";
	let finalPath = p.output_path;
	if (!path$1.extname(p.output_path) && contentType) {
		const mimeType = contentType.split(";")[0].trim();
		const defaultExt = p.resource_type === "whiteboard" ? ".png" : void 0;
		const suggestedExt = MIME_TO_EXT$1[mimeType] || defaultExt;
		if (suggestedExt) {
			finalPath = p.output_path + suggestedExt;
			log.info(`download: auto-detected extension ${suggestedExt}`);
		}
	}
	await fsPromises.mkdir(path$1.dirname(finalPath), { recursive: true });
	try {
		await fsPromises.writeFile(finalPath, buffer);
		log.info(`download: saved to ${finalPath}`);
	} catch (err) {
		return json({ error: `failed to save file: ${err instanceof Error ? err.message : String(err)}` });
	}
	return json({
		resource_type: p.resource_type,
		resource_token: p.resource_token,
		size_bytes: buffer.length,
		content_type: contentType,
		saved_path: finalPath
	});
}
function registerDocMediaTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_doc_media");
	return registerTool(api, {
		name: "feishu_doc_media",
		label: "Feishu: Document Media",
		description: "【以用户身份】文档媒体管理工具。支持两种操作：(1) insert - 在飞书文档末尾插入本地图片或文件（需要文档 ID + 本地文件路径）；(2) download - 下载文档素材或画板缩略图到本地（需要资源 token + 输出路径）。\n\n【重要】insert 仅支持本地文件路径。URL 图片请使用 create-doc/update-doc 的 <image url=\"...\"/> 语法。",
		parameters: DocMediaSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				if (p.action === "insert") return await handleInsert(p, client, log);
				if (p.action === "download") return await handleDownload(p, client, log);
				return json({ error: `unknown action: ${p.action}` });
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_doc_media" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/drive/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Drive 工具集
* 统一导出所有云空间相关工具的注册函数
*/
/**
* 注册所有 Drive 工具
*/
function registerFeishuDriveTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_drive: No config available, skipping");
		return;
	}
	const accounts = getEnabledLarkAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_drive: No Feishu accounts configured, skipping");
		return;
	}
	if (!resolveAnyEnabledToolsConfig(accounts).drive) {
		api.logger.debug?.("feishu_drive: drive tool disabled in all accounts");
		return;
	}
	const registered = [];
	if (registerFeishuDriveFileTool(api)) registered.push("feishu_drive_file");
	if (registerDocCommentsTool(api)) registered.push("feishu_doc_comments");
	if (registerDocMediaTool(api)) registered.push("feishu_doc_media");
	if (registered.length > 0) api.logger.debug?.(`feishu_drive: Registered ${registered.join(", ")}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/wiki/space.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_wiki_space tool -- Manage Feishu Wiki spaces.
*
* Actions: list, get, create
*
* Uses the Feishu Wiki API:
*   - list:   GET  /open-apis/wiki/v2/spaces
*   - get:    GET  /open-apis/wiki/v2/spaces/:space_id
*   - create: POST /open-apis/wiki/v2/spaces
*/
const FeishuWikiSpaceSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		page_size: Type.Optional(Type.Integer({
			description: "分页大小（默认 10，最大 50）",
			minimum: 1,
			maximum: 50
		})),
		page_token: Type.Optional(Type.String({ description: "分页标记。首次请求无需填写" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		space_id: Type.String({ description: "知识空间 ID（必填）" })
	}),
	Type.Object({
		action: Type.Literal("create"),
		name: Type.Optional(Type.String({ description: "知识空间名称" })),
		description: Type.Optional(Type.String({ description: "知识空间描述" }))
	})
]);
function registerFeishuWikiSpaceTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_wiki_space");
	return registerTool(api, {
		name: "feishu_wiki_space",
		label: "Feishu Wiki Spaces",
		description: "飞书知识空间管理工具。当用户要求查看知识库列表、获取知识库信息、创建知识库时使用。Actions: list（列出知识空间）, get（获取知识空间信息）, create（创建知识空间）。【重要】space_id 可以从浏览器 URL 中获取，或通过 list 接口获取。【重要】知识空间（Space）是知识库的基本组成单位，包含多个具有层级关系的文档节点。",
		parameters: FeishuWikiSpaceSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "list": {
						log.info(`list: page_size=${p.page_size ?? 10}`);
						const res = await client.invoke("feishu_wiki_space.list", (sdk, opts) => sdk.wiki.space.list({ params: {
							page_size: p.page_size,
							page_token: p.page_token
						} }, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} spaces`);
						return json({
							spaces: data?.items,
							has_more: data?.has_more,
							page_token: data?.page_token
						});
					}
					case "get": {
						log.info(`get: space_id=${p.space_id}`);
						const res = await client.invoke("feishu_wiki_space.get", (sdk, opts) => sdk.wiki.space.get({ path: { space_id: p.space_id } }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get: retrieved space ${p.space_id}`);
						return json({ space: res.data?.space });
					}
					case "create": {
						log.info(`create: name=${p.name ?? "(empty)"}, description=${p.description ?? "(empty)"}`);
						const res = await client.invoke("feishu_wiki_space.create", (sdk, opts) => sdk.wiki.space.create({ data: {
							name: p.name,
							description: p.description
						} }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: created space_id=${res.data?.space?.space_id}`);
						return json({ space: res.data?.space });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_wiki_space" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/wiki/space-node.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_wiki_space_node tool -- Manage Feishu Wiki space nodes.
*
* Actions: list, get, create, move, copy
*
* Uses the Feishu Wiki API:
*   - list:   GET  /open-apis/wiki/v2/spaces/:space_id/nodes
*   - get:    GET  /open-apis/wiki/v2/spaces/get_node
*   - create: POST /open-apis/wiki/v2/spaces/:space_id/nodes
*   - move:   POST /open-apis/wiki/v2/spaces/:space_id/nodes/:node_token/move
*   - copy:   POST /open-apis/wiki/v2/spaces/:space_id/nodes/:node_token/copy
*/
const FeishuWikiSpaceNodeSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		space_id: Type.String({ description: "space_id" }),
		parent_node_token: Type.Optional(Type.String({ description: "parent_node_token" })),
		page_size: Type.Optional(Type.Integer({
			description: "page_size",
			minimum: 1
		})),
		page_token: Type.Optional(Type.String({ description: "page_token" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		token: Type.String({ description: "node token" }),
		obj_type: Type.Optional(StringEnum([
			"doc",
			"sheet",
			"mindnote",
			"bitable",
			"file",
			"docx",
			"slides",
			"wiki"
		], { description: "obj_type" }))
	}),
	Type.Object({
		action: Type.Literal("create"),
		space_id: Type.String({ description: "space_id" }),
		obj_type: StringEnum([
			"sheet",
			"mindnote",
			"bitable",
			"file",
			"docx",
			"slides"
		], { description: "obj_type" }),
		parent_node_token: Type.Optional(Type.String({ description: "parent_node_token" })),
		node_type: StringEnum(["origin", "shortcut"], { description: "node_type" }),
		origin_node_token: Type.Optional(Type.String({ description: "origin_node_token" })),
		title: Type.Optional(Type.String({ description: "title" }))
	}),
	Type.Object({
		action: Type.Literal("move"),
		space_id: Type.String({ description: "space_id" }),
		node_token: Type.String({ description: "node_token" }),
		target_parent_token: Type.Optional(Type.String({ description: "target_parent_token" }))
	}),
	Type.Object({
		action: Type.Literal("copy"),
		space_id: Type.String({ description: "space_id" }),
		node_token: Type.String({ description: "node_token" }),
		target_space_id: Type.Optional(Type.String({ description: "target_space_id" })),
		target_parent_token: Type.Optional(Type.String({ description: "target_parent_token" })),
		title: Type.Optional(Type.String({ description: "title" }))
	})
]);
function registerFeishuWikiSpaceNodeTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_wiki_space_node");
	return registerTool(api, {
		name: "feishu_wiki_space_node",
		label: "Feishu Wiki Space Nodes",
		description: "飞书知识库节点管理工具。操作：list（列表）、get（获取）、create（创建）、move（移动）、copy（复制）。节点是知识库中的文档，包括 doc、bitable(多维表表格)、sheet(电子表格) 等类型。node_token 是节点的唯一标识符，obj_token 是实际文档的 token。可通过 get 操作将 wiki 类型的 node_token 转换为实际文档的 obj_token。",
		parameters: FeishuWikiSpaceNodeSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "list": {
						log.info(`list: space_id=${p.space_id}, parent=${p.parent_node_token ?? "(root)"}, page_size=${p.page_size ?? 50}`);
						const res = await client.invoke("feishu_wiki_space_node.list", (sdk, opts) => sdk.wiki.spaceNode.list({
							path: { space_id: p.space_id },
							params: {
								page_size: p.page_size,
								page_token: p.page_token,
								parent_node_token: p.parent_node_token
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`list: returned ${data?.items?.length ?? 0} nodes`);
						return json({
							nodes: data?.items,
							has_more: data?.has_more,
							page_token: data?.page_token
						});
					}
					case "get": {
						log.info(`get: token=${p.token}, obj_type=${p.obj_type ?? "wiki"}`);
						const res = await client.invoke("feishu_wiki_space_node.get", (sdk, opts) => sdk.wiki.space.getNode({ params: {
							token: p.token,
							obj_type: p.obj_type || "wiki"
						} }, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`get: retrieved node ${p.token}`);
						return json({ node: res.data?.node });
					}
					case "create": {
						log.info(`create: space_id=${p.space_id}, obj_type=${p.obj_type}, parent=${p.parent_node_token ?? "(root)"}, title=${p.title ?? "(empty)"}, node_type=${p.node_type}, original_node_token=${p.origin_node_token ?? "(empty)"}`);
						const res = await client.invoke("feishu_wiki_space_node.create", (sdk, opts) => sdk.wiki.spaceNode.create({
							path: { space_id: p.space_id },
							data: {
								obj_type: p.obj_type,
								parent_node_token: p.parent_node_token,
								node_type: p.node_type,
								origin_node_token: p.origin_node_token,
								title: p.title
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`create: created node_token=${res.data?.node?.node_token}`);
						return json({ node: res.data?.node });
					}
					case "move": {
						log.info(`move: space_id=${p.space_id}, node_token=${p.node_token}, target_parent=${p.target_parent_token ?? "(root)"}`);
						const res = await client.invoke("feishu_wiki_space_node.move", (sdk, opts) => sdk.wiki.spaceNode.move({
							path: {
								space_id: p.space_id,
								node_token: p.node_token
							},
							data: { target_parent_token: p.target_parent_token }
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`move: moved node ${p.node_token}`);
						return json({ node: res.data?.node });
					}
					case "copy": {
						log.info(`copy: space_id=${p.space_id}, node_token=${p.node_token}, target_space=${p.target_space_id ?? "(same)"}, target_parent=${p.target_parent_token ?? "(root)"}`);
						const res = await client.invoke("feishu_wiki_space_node.copy", (sdk, opts) => sdk.wiki.spaceNode.copy({
							path: {
								space_id: p.space_id,
								node_token: p.node_token
							},
							data: {
								target_space_id: p.target_space_id,
								target_parent_token: p.target_parent_token,
								title: p.title
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						log.info(`copy: copied to node_token=${res.data?.node?.node_token}`);
						return json({ node: res.data?.node });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_wiki_space_node" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/wiki/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Wiki 工具集
* 统一导出所有知识库相关工具的注册函数
*/
/**
* 注册所有 Wiki 工具
*/
function registerFeishuWikiTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_wiki: No config available, skipping");
		return;
	}
	const accounts = getEnabledLarkAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_wiki: No Feishu accounts configured, skipping");
		return;
	}
	if (!resolveAnyEnabledToolsConfig(accounts).wiki) {
		api.logger.debug?.("feishu_wiki: wiki tool disabled in all accounts");
		return;
	}
	const registered = [];
	if (registerFeishuWikiSpaceTool(api)) registered.push("feishu_wiki_space");
	if (registerFeishuWikiSpaceNodeTool(api)) registered.push("feishu_wiki_space_node");
	if (registered.length > 0) api.logger.debug?.(`feishu_wiki: Registered ${registered.join(", ")}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/sheets/sheet.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_sheet — 飞书电子表格统一工具。
*
* Actions: info, read, write, append, find, create, export
*
* 设计原则：
*   - 接受 URL 或 spreadsheet_token（工具层自动解析）
*   - read 不指定 range 时自动读取第一个工作表全部数据
*   - create 支持带表头和初始数据一步创建
*   - info 一次返回表格信息 + 全部工作表列表
*/
const MAX_READ_ROWS = 200;
const MAX_WRITE_ROWS = 5e3;
const MAX_WRITE_COLS = 100;
const EXPORT_POLL_INTERVAL_MS = 1e3;
const EXPORT_POLL_MAX_RETRIES = 30;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* 从飞书电子表格 URL 中解析 token 和可选的 sheet_id。
*
* 支持格式：
*   https://www.feishu.cn/sheets/TOKEN
*   https://xxx.feishu.cn/sheets/TOKEN?sheet=SHEET_ID
*   https://xxx.feishu.cn/wiki/TOKEN（知识库中的电子表格）
*/
function parseSheetUrl(url) {
	try {
		const u = new URL(url);
		const match = u.pathname.match(/\/(?:sheets|wiki)\/([^/?#]+)/);
		if (!match) return null;
		return {
			token: match[1],
			sheetId: u.searchParams.get("sheet") || void 0
		};
	} catch {
		return null;
	}
}
/**
* 飞书已知的 token 类型前缀。
* 新版 token：第 5/10/15 位字符（1-indexed）组成前缀。
* 旧版 token：前 3 个字符即为前缀。
*
* 常见类型：dox=云文档, sht=电子表格, bas=多维表格, wik=知识库
*/
const KNOWN_TOKEN_TYPES = new Set([
	"dox",
	"doc",
	"sht",
	"bas",
	"app",
	"sld",
	"bmn",
	"fld",
	"nod",
	"box",
	"jsn",
	"img",
	"isv",
	"wik",
	"wia",
	"wib",
	"wic",
	"wid",
	"wie",
	"dsb"
]);
/**
* 从 token 中提取类型前缀（如 "sht"、"wik"、"doc" 等）。
* 先检测新版格式（第 5/10/15 位），再回退旧版格式（前 3 位）。
*/
function getTokenType(token) {
	if (token.length >= 15) {
		const prefix = token[4] + token[9] + token[14];
		if (KNOWN_TOKEN_TYPES.has(prefix)) return prefix;
	}
	if (token.length >= 3) {
		const prefix = token.substring(0, 3);
		if (KNOWN_TOKEN_TYPES.has(prefix)) return prefix;
	}
	return null;
}
/**
* 从参数中解析 spreadsheet_token（支持 url 和直接 token 两种方式）。
* 如果检测到 wiki token，自动通过 wiki API 获取真实的 spreadsheet_token。
*/
async function resolveToken(p, client, log) {
	let token;
	let urlSheetId;
	if (p.spreadsheet_token) token = p.spreadsheet_token;
	else if (p.url) {
		const parsed = parseSheetUrl(p.url);
		if (!parsed) throw new Error(`Failed to parse spreadsheet_token from URL: ${p.url}`);
		token = parsed.token;
		urlSheetId = parsed.sheetId;
	} else throw new Error("url or spreadsheet_token is required");
	if (getTokenType(token) === "wik") {
		log.info(`resolveToken: detected wiki token, resolving obj_token...`);
		const wikiNodeRes = await client.invoke("feishu_sheet.info", (sdk, opts) => sdk.wiki.space.getNode({ params: {
			token,
			obj_type: "wiki"
		} }, opts), { as: "user" });
		assertLarkOk(wikiNodeRes);
		const objToken = wikiNodeRes.data?.node?.obj_token;
		if (!objToken) throw new Error(`Failed to resolve spreadsheet token from wiki token: ${token}`);
		log.info(`resolveToken: wiki resolved ${token} -> ${objToken}`);
		token = objToken;
	}
	return {
		token,
		urlSheetId
	};
}
/**
* Resolve the target range for read/write/append operations.
*
* Priority: explicit range > sheet_id param / URL sheet > first sheet via API.
* Throws if the spreadsheet has no worksheets.
*/
async function resolveRange(token, range, sheetId, client, apiName) {
	if (range) return range;
	if (sheetId) return sheetId;
	const sheetsRes = await client.invoke(apiName, (sdk, opts) => sdk.sheets.spreadsheetSheet.query({ path: { spreadsheet_token: token } }, opts), { as: "user" });
	assertLarkOk(sheetsRes);
	const firstSheet = (sheetsRes.data?.sheets ?? [])[0];
	if (!firstSheet?.sheet_id) throw new Error("spreadsheet has no worksheets");
	return firstSheet.sheet_id;
}
/**
* 将列号（1-based）转换为 Excel 列字母（A, B, ..., Z, AA, AB, ...）。
*/
function colLetter(n) {
	let result = "";
	while (n > 0) {
		n--;
		result = String.fromCharCode(65 + n % 26) + result;
		n = Math.floor(n / 26);
	}
	return result;
}
/**
* 将单元格值中的富文本 segment 数组拍平为纯文本字符串。
*
* 飞书 Sheets API 对带样式的单元格返回 [{type:"text", text:"...", segmentStyle:{...}}, ...] 格式，
* 极其冗余。此函数将其拼接为单个字符串，大幅减少 token 消耗。
*/
function flattenCellValue(cell) {
	if (!Array.isArray(cell)) return cell;
	if (cell.length > 0 && cell.every((seg) => seg != null && typeof seg === "object" && "text" in seg)) return cell.map((seg) => seg.text).join("");
	return cell;
}
function flattenValues(values) {
	if (!values) return values;
	return values.map((row) => row.map(flattenCellValue));
}
function truncateRows(values, maxRows) {
	if (!values) return {
		values,
		truncated: false,
		total_rows: 0
	};
	const total = values.length;
	if (total <= maxRows) return {
		values,
		truncated: false,
		total_rows: total
	};
	return {
		values: values.slice(0, maxRows),
		truncated: true,
		total_rows: total
	};
}
const UrlOrToken = [Type.Optional(Type.String({ description: "电子表格 URL，例如 https://xxx.feishu.cn/sheets/TOKEN 或 https://xxx.feishu.cn/wiki/TOKEN（与 spreadsheet_token 二选一）" })), Type.Optional(Type.String({ description: "电子表格 token（与 url 二选一）" }))];
const ValueRenderOption = Type.Optional(Type.Union([
	Type.Literal("ToString"),
	Type.Literal("FormattedValue"),
	Type.Literal("Formula"),
	Type.Literal("UnformattedValue")
], { description: "值渲染方式：ToString（默认）、FormattedValue（按格式）、Formula（公式）、UnformattedValue（原始值）" }));
const FeishuSheetSchema = Type.Union([
	Type.Object({
		action: Type.Literal("info"),
		url: UrlOrToken[0],
		spreadsheet_token: UrlOrToken[1]
	}),
	Type.Object({
		action: Type.Literal("read"),
		url: UrlOrToken[0],
		spreadsheet_token: UrlOrToken[1],
		range: Type.Optional(Type.String({ description: "读取范围（可选）。格式：<sheetId>!A1:D10 或 <sheetId>（sheetId 通过 info 获取）。不填则自动读取第一个工作表全部数据" })),
		sheet_id: Type.Optional(Type.String({ description: "工作表 ID（可选）。仅当不提供 range 时生效，指定要读取的工作表。不填则读取第一个工作表" })),
		value_render_option: ValueRenderOption
	}),
	Type.Object({
		action: Type.Literal("write"),
		url: UrlOrToken[0],
		spreadsheet_token: UrlOrToken[1],
		range: Type.Optional(Type.String({ description: "写入范围（可选）。格式：<sheetId>!A1:D10（sheetId 通过 info 获取）。不填则写入第一个工作表（从 A1 开始）" })),
		sheet_id: Type.Optional(Type.String({ description: "工作表 ID（可选）。仅当不提供 range 时生效。不填则使用第一个工作表" })),
		values: Type.Array(Type.Array(Type.Any()), { description: "二维数组，每个元素是一行。例如 [[\"姓名\",\"年龄\"],[\"张三\",25]]" })
	}),
	Type.Object({
		action: Type.Literal("append"),
		url: UrlOrToken[0],
		spreadsheet_token: UrlOrToken[1],
		range: Type.Optional(Type.String({ description: "追加范围（可选）。格式同 write。不填则追加到第一个工作表末尾" })),
		sheet_id: Type.Optional(Type.String({ description: "工作表 ID（可选）。仅当不提供 range 时生效" })),
		values: Type.Array(Type.Array(Type.Any()), { description: "要追加的二维数组数据" })
	}),
	Type.Object({
		action: Type.Literal("find"),
		url: UrlOrToken[0],
		spreadsheet_token: UrlOrToken[1],
		sheet_id: Type.String({ description: "工作表 ID（必填，可通过 info action 获取）" }),
		find: Type.String({ description: "查找内容（字符串或正则表达式）" }),
		range: Type.Optional(Type.String({ description: "查找范围。格式：A1:D10（不含 sheetId 前缀）。不填则搜索整个工作表" })),
		match_case: Type.Optional(Type.Boolean({ description: "是否区分大小写（默认 true）" })),
		match_entire_cell: Type.Optional(Type.Boolean({ description: "是否完全匹配整个单元格（默认 false）" })),
		search_by_regex: Type.Optional(Type.Boolean({ description: "是否使用正则表达式（默认 false）" })),
		include_formulas: Type.Optional(Type.Boolean({ description: "是否搜索公式（默认 false）" }))
	}),
	Type.Object({
		action: Type.Literal("create"),
		title: Type.String({ description: "电子表格标题" }),
		folder_token: Type.Optional(Type.String({ description: "文件夹 token（可选）。不填时创建到「我的空间」根目录" })),
		headers: Type.Optional(Type.Array(Type.String(), { description: "表头列名（可选）。例如 [\"姓名\", \"部门\", \"入职日期\"]。提供后会写入第一行" })),
		data: Type.Optional(Type.Array(Type.Array(Type.Any()), { description: "初始数据（可选）。二维数组，写在表头之后。例如 [[\"张三\", \"工程\", \"2026-01-01\"]]" }))
	}),
	Type.Object({
		action: Type.Literal("export"),
		url: UrlOrToken[0],
		spreadsheet_token: UrlOrToken[1],
		file_extension: StringEnum(["xlsx", "csv"], { description: "导出格式：xlsx 或 csv" }),
		output_path: Type.Optional(Type.String({ description: "本地保存路径（含文件名）。不填则只返回文件信息" })),
		sheet_id: Type.Optional(Type.String({ description: "工作表 ID。导出 CSV 时必填（CSV 一次只能导出一个工作表），导出 xlsx 时可选" }))
	})
]);
function registerFeishuSheetTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_sheet");
	return registerTool(api, {
		name: "feishu_sheet",
		label: "Feishu Spreadsheet",
		description: "【以用户身份】飞书电子表格工具。支持创建、读写、查找、导出电子表格。\n\n电子表格（Sheets）类似 Excel/Google Sheets，与多维表格（Bitable/Airtable）是不同产品。\n\n所有 action（除 create 外）均支持传入 url 或 spreadsheet_token，工具会自动解析。支持知识库 wiki URL，自动解析为电子表格 token。\n\nActions:\n- info：获取表格信息 + 全部工作表列表（一次调用替代 get_info + list_sheets）\n- read：读取数据。不填 range 自动读取第一个工作表全部数据\n- write：覆盖写入,高危,请谨慎使用该操作。不填 range 自动写入第一个工作表（从 A1 开始）\n- append：在已有数据末尾追加行\n- find：在工作表中查找单元格\n- create：创建电子表格。支持带 headers + data 一步创建含数据的表格\n- export：导出为 xlsx 或 csv（csv 必须指定 sheet_id）",
		parameters: FeishuSheetSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				const brand = client.account.brand;
				switch (p.action) {
					case "info": {
						const { token } = await resolveToken(p, client, log);
						log.info(`info: token=${token}`);
						const [spreadsheetRes, sheetsRes] = await Promise.all([client.invoke("feishu_sheet.info", (sdk, opts) => sdk.sheets.spreadsheet.get({ path: { spreadsheet_token: token } }, opts), { as: "user" }), client.invoke("feishu_sheet.info", (sdk, opts) => sdk.sheets.spreadsheetSheet.query({ path: { spreadsheet_token: token } }, opts), { as: "user" })]);
						assertLarkOk(spreadsheetRes);
						assertLarkOk(sheetsRes);
						const spreadsheet = spreadsheetRes.data?.spreadsheet;
						const sheets = (sheetsRes.data?.sheets ?? []).map((s) => ({
							sheet_id: s.sheet_id,
							title: s.title,
							index: s.index,
							row_count: s.grid_properties?.row_count,
							column_count: s.grid_properties?.column_count,
							frozen_row_count: s.grid_properties?.frozen_row_count,
							frozen_column_count: s.grid_properties?.frozen_column_count
						}));
						log.info(`info: title="${spreadsheet?.title}", ${sheets.length} sheets`);
						return json({
							title: spreadsheet?.title,
							spreadsheet_token: token,
							url: `${wwwDomain(brand)}/sheets/${token}`,
							sheets
						});
					}
					case "read": {
						const { token, urlSheetId } = await resolveToken(p, client, log);
						const range = await resolveRange(token, p.range, p.sheet_id ?? urlSheetId, client, "feishu_sheet.read");
						log.info(`read: token=${token}, range=${range}`);
						const query = {
							valueRenderOption: p.value_render_option ?? "ToString",
							dateTimeRenderOption: "FormattedString"
						};
						const res = await client.invokeByPath("feishu_sheet.read", `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`, {
							method: "GET",
							query,
							as: "user"
						});
						if (res.code && res.code !== 0) return json({ error: res.msg || `API error code: ${res.code}` });
						const valueRange = res.data?.valueRange;
						const { values, truncated, total_rows } = truncateRows(flattenValues(valueRange?.values), MAX_READ_ROWS);
						log.info(`read: ${total_rows} rows${truncated ? ` (truncated to ${MAX_READ_ROWS})` : ""}`);
						return json({
							range: valueRange?.range,
							values,
							...truncated ? {
								truncated: true,
								total_rows,
								hint: `Data exceeds ${MAX_READ_ROWS} rows, truncated. Please narrow the range and read again.`
							} : {}
						});
					}
					case "write": {
						const { token, urlSheetId } = await resolveToken(p, client, log);
						if (p.values && p.values.length > MAX_WRITE_ROWS) return json({ error: `write row count ${p.values.length} exceeds limit ${MAX_WRITE_ROWS}` });
						if (p.values && p.values.some((row) => Array.isArray(row) && row.length > MAX_WRITE_COLS)) return json({ error: `write column count exceeds limit ${MAX_WRITE_COLS}` });
						const range = await resolveRange(token, p.range, p.sheet_id ?? urlSheetId, client, "feishu_sheet.write");
						log.info(`write: token=${token}, range=${range}, rows=${p.values?.length}`);
						const res = await client.invokeByPath("feishu_sheet.write", `/open-apis/sheets/v2/spreadsheets/${token}/values`, {
							method: "PUT",
							body: { valueRange: {
								range,
								values: p.values
							} },
							as: "user"
						});
						if (res.code && res.code !== 0) return json({ error: res.msg || `API error code: ${res.code}` });
						log.info(`write: updated ${res.data?.updatedCells ?? 0} cells`);
						return json({
							updated_range: res.data?.updatedRange,
							updated_rows: res.data?.updatedRows,
							updated_columns: res.data?.updatedColumns,
							updated_cells: res.data?.updatedCells,
							revision: res.data?.revision
						});
					}
					case "append": {
						const { token, urlSheetId } = await resolveToken(p, client, log);
						if (p.values && p.values.length > MAX_WRITE_ROWS) return json({ error: `append row count ${p.values.length} exceeds limit ${MAX_WRITE_ROWS}` });
						const range = await resolveRange(token, p.range, p.sheet_id ?? urlSheetId, client, "feishu_sheet.append");
						log.info(`append: token=${token}, range=${range}, rows=${p.values?.length}`);
						const res = await client.invokeByPath("feishu_sheet.append", `/open-apis/sheets/v2/spreadsheets/${token}/values_append`, {
							method: "POST",
							body: { valueRange: {
								range,
								values: p.values
							} },
							as: "user"
						});
						if (res.code && res.code !== 0) return json({ error: res.msg || `API error code: ${res.code}` });
						const updates = res.data?.updates;
						log.info(`append: updated ${updates?.updatedCells ?? 0} cells`);
						return json({
							table_range: res.data?.tableRange,
							updated_range: updates?.updatedRange,
							updated_rows: updates?.updatedRows,
							updated_columns: updates?.updatedColumns,
							updated_cells: updates?.updatedCells,
							revision: updates?.revision
						});
					}
					case "find": {
						const { token } = await resolveToken(p, client, log);
						log.info(`find: token=${token}, sheet_id=${p.sheet_id}, find="${p.find}"`);
						const findCondition = { range: p.range ? `${p.sheet_id}!${p.range}` : p.sheet_id };
						if (p.match_case !== void 0) findCondition.match_case = !p.match_case;
						if (p.match_entire_cell !== void 0) findCondition.match_entire_cell = p.match_entire_cell;
						if (p.search_by_regex !== void 0) findCondition.search_by_regex = p.search_by_regex;
						if (p.include_formulas !== void 0) findCondition.include_formulas = p.include_formulas;
						const res = await client.invoke("feishu_sheet.find", (sdk, opts) => sdk.sheets.spreadsheetSheet.find({
							path: {
								spreadsheet_token: token,
								sheet_id: p.sheet_id
							},
							data: {
								find_condition: findCondition,
								find: p.find
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const findResult = res.data?.find_result;
						log.info(`find: matched ${findResult?.matched_cells?.length ?? 0} cells`);
						return json({
							matched_cells: findResult?.matched_cells,
							matched_formula_cells: findResult?.matched_formula_cells,
							rows_count: findResult?.rows_count
						});
					}
					case "create": {
						log.info(`create: title="${p.title}", folder=${p.folder_token ?? "(root)"}, headers=${!!p.headers}, data=${p.data?.length ?? 0} rows`);
						const createRes = await client.invoke("feishu_sheet.create", (sdk, opts) => sdk.sheets.spreadsheet.create({ data: {
							title: p.title,
							folder_token: p.folder_token
						} }, opts), { as: "user" });
						assertLarkOk(createRes);
						const token = (createRes.data?.spreadsheet)?.spreadsheet_token;
						if (!token) return json({ error: "failed to create spreadsheet: no token returned" });
						const url = `${wwwDomain(brand)}/sheets/${token}`;
						log.info(`create: token=${token}`);
						if (p.headers || p.data) {
							const allRows = [];
							if (p.headers) allRows.push(p.headers);
							if (p.data) allRows.push(...p.data);
							if (allRows.length > 0) {
								const sheetsRes = await client.invoke("feishu_sheet.create", (sdk, opts) => sdk.sheets.spreadsheetSheet.query({ path: { spreadsheet_token: token } }, opts), { as: "user" });
								assertLarkOk(sheetsRes);
								const firstSheet = (sheetsRes.data?.sheets ?? [])[0];
								if (firstSheet?.sheet_id) {
									const sheetId = firstSheet.sheet_id;
									const numRows = allRows.length;
									const range = `${sheetId}!A1:${colLetter(Math.max(...allRows.map((r) => r.length)))}${numRows}`;
									log.info(`create: writing ${numRows} rows to ${range}`);
									const writeRes = await client.invokeByPath("feishu_sheet.create", `/open-apis/sheets/v2/spreadsheets/${token}/values`, {
										method: "PUT",
										body: { valueRange: {
											range,
											values: allRows
										} },
										as: "user"
									});
									if (writeRes.code && writeRes.code !== 0) {
										log.info(`create: initial data write failed: ${writeRes.msg}`);
										return json({
											spreadsheet_token: token,
											url,
											warning: `spreadsheet created but failed to write initial data: ${writeRes.msg}`
										});
									}
								}
							}
						}
						return json({
							spreadsheet_token: token,
							title: p.title,
							url
						});
					}
					case "export": {
						const { token } = await resolveToken(p, client, log);
						if (p.file_extension === "csv" && !p.sheet_id) return json({ error: "sheet_id is required for CSV export (CSV can only export one worksheet at a time). Use info action to get the worksheet list." });
						log.info(`export: token=${token}, format=${p.file_extension}, output=${p.output_path ?? "(info only)"}`);
						const createRes = await client.invoke("feishu_sheet.export", (sdk, opts) => sdk.drive.exportTask.create({ data: {
							file_extension: p.file_extension,
							token,
							type: "sheet",
							sub_id: p.sheet_id
						} }, opts), { as: "user" });
						assertLarkOk(createRes);
						const ticket = createRes.data?.ticket;
						if (!ticket) return json({ error: "failed to create export task: no ticket returned" });
						log.info(`export: ticket=${ticket}`);
						let fileToken;
						let fileName;
						let fileSize;
						for (let i = 0; i < EXPORT_POLL_MAX_RETRIES; i++) {
							await sleep(EXPORT_POLL_INTERVAL_MS);
							const pollRes = await client.invoke("feishu_sheet.export", (sdk, opts) => sdk.drive.exportTask.get({
								path: { ticket },
								params: { token }
							}, opts), { as: "user" });
							assertLarkOk(pollRes);
							const result = pollRes.data?.result;
							const jobStatus = result?.job_status;
							if (jobStatus === 0) {
								fileToken = result?.file_token;
								fileName = result?.file_name;
								fileSize = result?.file_size;
								log.info(`export: done, file_token=${fileToken}, size=${fileSize}`);
								break;
							}
							if (jobStatus !== void 0 && jobStatus >= 3) return json({ error: result?.job_error_msg || `export failed (status=${jobStatus})` });
							log.info(`export: polling ${i + 1}/${EXPORT_POLL_MAX_RETRIES}, status=${jobStatus}`);
						}
						if (!fileToken) return json({ error: "export timeout: task did not complete within 30 seconds" });
						if (p.output_path) {
							const stream = (await client.invoke("feishu_sheet.export", (sdk, opts) => sdk.drive.exportTask.download({ path: { file_token: fileToken } }, opts), { as: "user" })).getReadableStream();
							const chunks = [];
							for await (const chunk of stream) chunks.push(chunk);
							await fsPromises.mkdir(path$1.dirname(p.output_path), { recursive: true });
							await fsPromises.writeFile(p.output_path, Buffer.concat(chunks));
							log.info(`export: saved to ${p.output_path}`);
							return json({
								file_path: p.output_path,
								file_name: fileName,
								file_size: fileSize
							});
						}
						return json({
							file_token: fileToken,
							file_name: fileName,
							file_size: fileSize,
							hint: "File exported. Provide output_path parameter to download locally."
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_sheet" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/sheets/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Sheets 工具集
* 注册飞书电子表格工具
*/
/**
* 注册 Sheets 工具
*/
function registerFeishuSheetsTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_sheets: No config available, skipping");
		return;
	}
	const accounts = getEnabledLarkAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_sheets: No Feishu accounts configured, skipping");
		return;
	}
	if (!resolveAnyEnabledToolsConfig(accounts).sheets) {
		api.logger.debug?.("feishu_sheets: sheets tool disabled in all accounts");
		return;
	}
	if (registerFeishuSheetTool(api)) api.logger.debug?.("feishu_sheets: Registered feishu_sheet");
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/chat/chat.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_chat tool -- 管理飞书群聊
*
* Actions:
*   - search: 搜索对用户或机器人可见的群列表
*   - get:    获取指定群的详细信息
*
* Uses the Feishu IM v1 API:
*   - search: GET /open-apis/im/v1/chats/search
*   - get:    GET /open-apis/im/v1/chats/:chat_id
*/
const FeishuChatSchema = Type.Union([Type.Object({
	action: Type.Literal("search"),
	query: Type.String({ description: "搜索关键词（必填）。支持匹配群名称、群成员名称。支持多语种、拼音、前缀等模糊搜索。" }),
	page_size: Type.Optional(Type.Integer({
		description: "分页大小（默认20）",
		minimum: 1
	})),
	page_token: Type.Optional(Type.String({ description: "分页标记。首次请求无需填写" })),
	user_id_type: Type.Optional(StringEnum([
		"open_id",
		"union_id",
		"user_id"
	], { description: "用户 ID 类型（默认 open_id）" }))
}), Type.Object({
	action: Type.Literal("get"),
	chat_id: Type.String({ description: "群 ID（格式如 oc_xxx）" }),
	user_id_type: Type.Optional(StringEnum([
		"open_id",
		"union_id",
		"user_id"
	], { description: "用户 ID 类型（默认 open_id）" }))
})]);
function registerChatSearchTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_chat");
	return registerTool(api, {
		name: "feishu_chat",
		label: "Feishu: Chat Management",
		description: "以用户身份调用飞书群聊管理工具。Actions: search（搜索群列表，支持关键词匹配群名称、群成员）, get（获取指定群的详细信息，包括群名称、描述、头像、群主、权限配置等）。",
		parameters: FeishuChatSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "search": {
						log.info(`search: query="${p.query}", page_size=${p.page_size ?? 20}`);
						const res = await client.invoke("feishu_chat.search", (sdk, opts) => sdk.im.v1.chat.search({ params: {
							user_id_type: p.user_id_type || "open_id",
							query: p.query,
							page_size: p.page_size,
							page_token: p.page_token
						} }, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						const chatCount = data?.items?.length ?? 0;
						log.info(`search: found ${chatCount} chats`);
						return json({
							items: data?.items,
							has_more: data?.has_more ?? false,
							page_token: data?.page_token
						});
					}
					case "get": {
						log.info(`get: chat_id=${p.chat_id}, user_id_type=${p.user_id_type ?? "open_id"}`);
						const res = await client.invoke("feishu_chat.get", (sdk, opts) => sdk.im.v1.chat.get({
							path: { chat_id: p.chat_id },
							params: { user_id_type: p.user_id_type || "open_id" }
						}, {
							...opts ?? {},
							headers: {
								...opts?.headers ?? {},
								"X-Chat-Custom-Header": "enable_chat_list_security_check"
							}
						}), { as: "user" });
						assertLarkOk(res);
						log.info(`get: retrieved chat info for ${p.chat_id}`);
						return json({ chat: res.data });
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_chat" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/chat/members.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_chat_members tool -- 获取群成员列表
*
* 获取指定群组的成员信息，包括成员名字与 ID
* 使用 sdk.im.v1.chatMembers.get 接口
*/
const ChatMembersSchema = Type.Object({
	chat_id: Type.String({ description: "群 ID（格式如 oc_xxx）。可以通过 feishu_chat_search 工具搜索获取" }),
	member_id_type: Type.Optional(StringEnum([
		"open_id",
		"union_id",
		"user_id"
	])),
	page_size: Type.Optional(Type.Integer({
		description: "分页大小（默认20）",
		minimum: 1
	})),
	page_token: Type.Optional(Type.String({ description: "分页标记。首次请求无需填写" }))
});
function registerChatMembersTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_chat_members");
	return registerTool(api, {
		name: "feishu_chat_members",
		label: "Feishu: Get Chat Members",
		description: "以用户的身份获取指定群组的成员列表。返回成员信息，包含成员 ID、姓名等。注意：不会返回群组内的机器人成员。",
		parameters: ChatMembersSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				log.info(`chat_members: chat_id="${p.chat_id}", page_size=${p.page_size ?? 20}`);
				const res = await client.invoke("feishu_chat_members.default", (sdk, opts) => sdk.im.v1.chatMembers.get({
					path: { chat_id: p.chat_id },
					params: {
						member_id_type: p.member_id_type || "open_id",
						page_size: p.page_size,
						page_token: p.page_token
					}
				}, {
					...opts ?? {},
					headers: {
						...opts?.headers ?? {},
						"X-Chat-Custom-Header": "enable_chat_list_security_check"
					}
				}), { as: "user" });
				assertLarkOk(res);
				const data = res.data;
				const memberCount = data?.items?.length ?? 0;
				const memberTotal = data?.member_total ?? 0;
				log.info(`chat_members: found ${memberCount} members (total: ${memberTotal})`);
				return json({
					items: data?.items,
					has_more: data?.has_more ?? false,
					page_token: data?.page_token,
					member_total: memberTotal
				});
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_chat_members" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/chat/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Chat Tools Index
*
* 群组相关工具
*/
function registerFeishuChatTools(api) {
	const registered = [];
	if (registerChatSearchTool(api)) registered.push("feishu_chat");
	if (registerChatMembersTool(api)) registered.push("feishu_chat_members");
	if (registered.length > 0) api.logger.debug?.(`feishu_chat: Registered ${registered.join(", ")}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/message.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_im_user_message tool -- 以用户身份发送/回复 IM 消息
*
* Actions: send, reply
*
* Uses the Feishu IM API:
*   - send:  POST /open-apis/im/v1/messages?receive_id_type=...
*   - reply: POST /open-apis/im/v1/messages/:message_id/reply
*
* 全部以用户身份（user_access_token）调用，scope 来自 real-scope.json。
*/
const FeishuImMessageSchema = Type.Union([Type.Object({
	action: Type.Literal("send"),
	receive_id_type: StringEnum(["open_id", "chat_id"], { description: "接收者 ID 类型：open_id（私聊，ou_xxx）、chat_id（群聊，oc_xxx）" }),
	receive_id: Type.String({ description: "接收者 ID，与 receive_id_type 对应。open_id 填 'ou_xxx'，chat_id 填 'oc_xxx'" }),
	msg_type: StringEnum([
		"text",
		"post",
		"image",
		"file",
		"audio",
		"media",
		"interactive",
		"share_chat",
		"share_user"
	], { description: "消息类型：text（纯文本）、post（富文本）、image（图片）、file（文件）、interactive（消息卡片）、share_chat（群名片）、share_user（个人名片）等" }),
	content: Type.String({ description: "消息内容（JSON 字符串），格式取决于 msg_type。示例：text → '{\"text\":\"你好\"}'，image → '{\"image_key\":\"img_xxx\"}'，share_chat → '{\"chat_id\":\"oc_xxx\"}'，post → '{\"zh_cn\":{\"title\":\"标题\",\"content\":[[{\"tag\":\"text\",\"text\":\"正文\"}]]}}'" }),
	uuid: Type.Optional(Type.String({ description: "幂等唯一标识。同一 uuid 在 1 小时内只会发送一条消息，用于去重" }))
}), Type.Object({
	action: Type.Literal("reply"),
	message_id: Type.String({ description: "被回复消息的 ID（om_xxx 格式）" }),
	msg_type: StringEnum([
		"text",
		"post",
		"image",
		"file",
		"audio",
		"media",
		"interactive",
		"share_chat",
		"share_user"
	], { description: "消息类型：text（纯文本）、post（富文本）、image（图片）、interactive（消息卡片）等" }),
	content: Type.String({ description: "回复消息内容（JSON 字符串），格式同 send 的 content" }),
	reply_in_thread: Type.Optional(Type.Boolean({ description: "是否以话题形式回复。true 则消息出现在该消息的话题中，false（默认）则出现在聊天主流" })),
	uuid: Type.Optional(Type.String({ description: "幂等唯一标识" }))
})]);
function registerFeishuImUserMessageTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_im_user_message");
	return registerTool(api, {
		name: "feishu_im_user_message",
		label: "Feishu: IM User Message",
		description: "飞书用户身份 IM 消息工具。**有且仅当用户明确要求以自己身份发消息、回复消息时使用，当没有明确要求时优先使用message系统工具**。\n\nActions:\n- send（发送消息）：发送消息到私聊或群聊。私聊用 receive_id_type=open_id，群聊用 receive_id_type=chat_id\n- reply（回复消息）：回复指定 message_id 的消息，支持话题回复（reply_in_thread=true）\n\n【重要】content 必须是合法 JSON 字符串，格式取决于 msg_type。最常用：text 类型 content 为 '{\"text\":\"消息内容\"}'。\n\n【安全约束】此工具以用户身份发送消息，发出后对方看到的发送者是用户本人。调用前必须先向用户确认：1) 发送对象（哪个人或哪个群）2) 消息内容。禁止在用户未明确同意的情况下自行发送消息。",
		parameters: FeishuImMessageSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				switch (p.action) {
					case "send": {
						log.info(`send: receive_id_type=${p.receive_id_type}, receive_id=${p.receive_id}, msg_type=${p.msg_type}`);
						const res = await client.invoke("feishu_im_user_message.send", (sdk, opts) => sdk.im.v1.message.create({
							params: { receive_id_type: p.receive_id_type },
							data: {
								receive_id: p.receive_id,
								msg_type: p.msg_type,
								content: p.content,
								uuid: p.uuid
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`send: message sent, message_id=${data?.message_id}`);
						return json({
							message_id: data?.message_id,
							chat_id: data?.chat_id,
							create_time: data?.create_time
						});
					}
					case "reply": {
						log.info(`reply: message_id=${p.message_id}, msg_type=${p.msg_type}, reply_in_thread=${p.reply_in_thread ?? false}`);
						const res = await client.invoke("feishu_im_user_message.reply", (sdk, opts) => sdk.im.v1.message.reply({
							path: { message_id: p.message_id },
							data: {
								content: p.content,
								msg_type: p.msg_type,
								reply_in_thread: p.reply_in_thread,
								uuid: p.uuid
							}
						}, opts), { as: "user" });
						assertLarkOk(res);
						const data = res.data;
						log.info(`reply: message sent, message_id=${data?.message_id}`);
						return json({
							message_id: data?.message_id,
							chat_id: data?.chat_id,
							create_time: data?.create_time
						});
					}
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_im_user_message" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/resource.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_im_user_fetch_resource tool -- 以用户身份下载 IM 消息中的文件/图片资源
*
* 使用飞书 API:
*   - im.v1.messageResource.get: GET /open-apis/im/v1/messages/:message_id/resources/:file_key
*
* 全部以用户身份（user_access_token）调用，scope 来自 real-scope.json。
*/
const MIME_TO_EXT = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/tiff": ".tiff",
	"video/mp4": ".mp4",
	"video/mpeg": ".mpeg",
	"video/quicktime": ".mov",
	"video/x-msvideo": ".avi",
	"video/webm": ".webm",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"audio/mp4": ".m4a",
	"application/pdf": ".pdf",
	"application/msword": ".doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"application/zip": ".zip",
	"application/x-rar-compressed": ".rar",
	"text/plain": ".txt",
	"application/json": ".json"
};
const FetchResourceSchema = Type.Object({
	message_id: Type.String({ description: "消息 ID（om_xxx 格式），从消息事件或消息列表中获取" }),
	file_key: Type.String({ description: "资源 Key，从消息体中获取。图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）" }),
	type: StringEnum(["image", "file"], { description: "资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）" })
});
function registerFeishuImUserFetchResourceTool(api) {
	if (!api.config) return false;
	const cfg = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_im_user_fetch_resource");
	return registerTool(api, {
		name: "feishu_im_user_fetch_resource",
		label: "Feishu: IM Fetch Resource",
		description: "【以用户身份】下载飞书 IM 消息中的文件或图片资源到本地文件。需要用户 OAuth 授权。\n\n适用场景：当你以用户身份调用了消息列表/搜索等 API 获取到 message_id 和 file_key 时，应使用本工具以同样的用户身份下载资源。\n注意：如果 message_id 来自当前对话上下文（用户发给机器人的消息、引用的消息），请使用 feishu_im_bot_image 工具以机器人身份下载，无需用户授权。\n\n参数说明：\n- message_id：消息 ID（om_xxx），从消息事件或消息列表中获取\n- file_key：资源 Key，从消息体中获取。图片用 image_key（img_xxx），文件用 file_key（file_xxx）\n- type：图片用 image，文件/音频/视频用 file\n\n文件自动保存到 /tmp/openclaw/ 下，返回值中的 saved_path 为实际保存路径。\n限制：文件大小不超过 100MB。不支持下载表情包、合并转发消息、卡片中的资源。",
		parameters: FetchResourceSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				log.info(`fetch_resource: message_id="${p.message_id}", file_key="${p.file_key}", type="${p.type}"`);
				const res = await client.invoke("feishu_im_user_fetch_resource.default", (sdk, opts) => sdk.im.v1.messageResource.get({
					params: { type: p.type },
					path: {
						message_id: p.message_id,
						file_key: p.file_key
					}
				}, opts), { as: "user" });
				const stream = res.getReadableStream();
				const chunks = [];
				for await (const chunk of stream) chunks.push(chunk);
				const buffer = Buffer.concat(chunks);
				log.info(`fetch_resource: downloaded ${buffer.length} bytes`);
				const contentType = res.headers?.["content-type"] || "";
				log.info(`fetch_resource: content-type=${contentType}`);
				const mimeType = contentType ? contentType.split(";")[0].trim() : "";
				const finalPath = buildRandomTempFilePath({
					prefix: "im-resource",
					extension: mimeType ? MIME_TO_EXT[mimeType] : void 0
				});
				log.info(`fetch_resource: saving to ${finalPath}`);
				await fsPromises.mkdir(path$1.dirname(finalPath), { recursive: true });
				try {
					await fsPromises.writeFile(finalPath, buffer);
					log.info(`fetch_resource: saved to ${finalPath}`);
					return json({
						message_id: p.message_id,
						file_key: p.file_key,
						type: p.type,
						size_bytes: buffer.length,
						content_type: contentType,
						saved_path: finalPath
					});
				} catch (err) {
					log.error(`fetch_resource: failed to save file: ${err}`);
					return json({ error: `保存文件失败: ${err instanceof Error ? err.message : String(err)}` });
				}
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, cfg);
			}
		}
	}, { name: "feishu_im_user_fetch_resource" });
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/time-utils.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 时间工具函数 — 对齐 Go 实现 (time.go + timerange.go)
*
* 以 ISO 8601 (RFC 3339) 作为标准时间交换格式，
* 提供 ISO 8601 ↔ Unix 转换工具及时间范围解析。
*/
const BJ_OFFSET_MS = 480 * 60 * 1e3;
/** 将 Date 格式化为北京时间 ISO 8601 字符串 */
function formatBeijingISO(d) {
	const bj = new Date(d.getTime() + BJ_OFFSET_MS);
	return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, "0")}-${String(bj.getUTCDate()).padStart(2, "0")}T${String(bj.getUTCHours()).padStart(2, "0")}:${String(bj.getUTCMinutes()).padStart(2, "0")}:${String(bj.getUTCSeconds()).padStart(2, "0")}+08:00`;
}
/** Unix 毫秒（数字）→ ISO 8601 北京时间 */
function millisToDateTime(millis) {
	return formatBeijingISO(new Date(millis));
}
/** Unix 毫秒（字符串）→ ISO 8601 北京时间 */
function millisStringToDateTime(millis) {
	return millisToDateTime(parseInt(millis, 10));
}
/** ISO 8601 → Unix 秒（数字） */
function dateTimeToSeconds(datetime) {
	const d = new Date(datetime);
	if (isNaN(d.getTime())) throw new Error(`无法解析 ISO 8601 时间: "${datetime}"。格式示例: 2026-02-27T14:30:00+08:00`);
	return Math.floor(d.getTime() / 1e3);
}
/** ISO 8601 → Unix 秒（字符串） */
function dateTimeToSecondsString(datetime) {
	return dateTimeToSeconds(datetime).toString();
}
/**
* 解析时间范围标识，返回 ISO 8601 字符串对。
*
* 支持的格式：
* - `today` / `yesterday` / `day_before_yesterday`
* - `this_week` / `last_week` / `this_month` / `last_month`
* - `last_{N}_{unit}` — unit: minutes / hours / days
*
* 所有计算基于北京时间 (UTC+8)。
*/
function parseTimeRange(input) {
	const now = /* @__PURE__ */ new Date();
	const bjNow = toBeijingDate(now);
	let start;
	let end;
	switch (input) {
		case "today":
			start = beijingStartOfDay(bjNow);
			end = now;
			break;
		case "yesterday": {
			const d = new Date(bjNow);
			d.setUTCDate(d.getUTCDate() - 1);
			start = beijingStartOfDay(d);
			end = beijingEndOfDay(d);
			break;
		}
		case "day_before_yesterday": {
			const d = new Date(bjNow);
			d.setUTCDate(d.getUTCDate() - 2);
			start = beijingStartOfDay(d);
			end = beijingEndOfDay(d);
			break;
		}
		case "this_week": {
			const day = bjNow.getUTCDay();
			const diffToMon = day === 0 ? 6 : day - 1;
			const monday = new Date(bjNow);
			monday.setUTCDate(monday.getUTCDate() - diffToMon);
			start = beijingStartOfDay(monday);
			end = now;
			break;
		}
		case "last_week": {
			const day = bjNow.getUTCDay();
			const diffToMon = day === 0 ? 6 : day - 1;
			const thisMonday = new Date(bjNow);
			thisMonday.setUTCDate(thisMonday.getUTCDate() - diffToMon);
			const lastMonday = new Date(thisMonday);
			lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
			const lastSunday = new Date(thisMonday);
			lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
			start = beijingStartOfDay(lastMonday);
			end = beijingEndOfDay(lastSunday);
			break;
		}
		case "this_month":
			start = beijingStartOfDay(new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1)));
			end = now;
			break;
		case "last_month": {
			const firstDayThisMonth = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1));
			const lastDayPrevMonth = new Date(firstDayThisMonth);
			lastDayPrevMonth.setUTCDate(lastDayPrevMonth.getUTCDate() - 1);
			start = beijingStartOfDay(new Date(Date.UTC(lastDayPrevMonth.getUTCFullYear(), lastDayPrevMonth.getUTCMonth(), 1)));
			end = beijingEndOfDay(lastDayPrevMonth);
			break;
		}
		default: {
			const match = input.match(/^last_(\d+)_(minutes?|hours?|days?)$/);
			if (!match) throw new Error(`不支持的 relative_time 格式: "${input}"。支持: today, yesterday, day_before_yesterday, this_week, last_week, this_month, last_month, last_{N}_{unit}（unit: minutes/hours/days）`);
			start = subtractFromNow(now, parseInt(match[1], 10), match[2].replace(/s$/, ""));
			end = now;
			break;
		}
	}
	return {
		start: formatBeijingISO(start),
		end: formatBeijingISO(end)
	};
}
/**
* 解析时间范围标识，返回 Unix 秒字符串对（供 SDK 调用）。
*/
function parseTimeRangeToSeconds(input) {
	const range = parseTimeRange(input);
	return {
		start: dateTimeToSecondsString(range.start),
		end: dateTimeToSecondsString(range.end)
	};
}
/** 将 UTC Date 转为「北京时间各部分存在 UTC 字段上」的 Date */
function toBeijingDate(d) {
	return new Date(d.getTime() + BJ_OFFSET_MS);
}
/** 北京时间当天 00:00:00 对应的真实 UTC Date */
function beijingStartOfDay(bjDate) {
	return new Date(Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate()) - BJ_OFFSET_MS);
}
/** 北京时间当天 23:59:59 对应的真实 UTC Date */
function beijingEndOfDay(bjDate) {
	return new Date(Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), 23, 59, 59) - BJ_OFFSET_MS);
}
function subtractFromNow(now, n, unit) {
	const d = new Date(now);
	switch (unit) {
		case "minute":
			d.setMinutes(d.getMinutes() - n);
			break;
		case "hour":
			d.setHours(d.getHours() - n);
			break;
		case "day":
			d.setDate(d.getDate() - n);
			break;
		default: throw new Error(`不支持的时间单位: ${unit}`);
	}
	return d;
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/user-name-uat.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* UAT 用户名解析模块
*
* 独立于 messaging/inbound 层的 TAT UserNameCache，
* 用于工具层以用户身份（UAT）批量解析用户显示名。
*
* 设计动机：TAT 调用 contact/v3/users/batch 缺少权限导致返回的用户
* 条目不含 name 字段，而工具层搜索消息等场景运行在 UAT 上下文中，
* 用户 token 可以读取其他用户的名称。
*
* 底层使用 contact/v3/users/basic_batch 接口（scope: contact:user.basic_profile:readonly），
* 每次最多查询 10 个用户。
*/
const UAT_MAX_SIZE = 500;
const UAT_TTL_MS = 1800 * 1e3;
const uatRegistry = /* @__PURE__ */ new Map();
function getOrCreateCache(accountId) {
	let cache = uatRegistry.get(accountId);
	if (!cache) {
		cache = /* @__PURE__ */ new Map();
		uatRegistry.set(accountId, cache);
	}
	return cache;
}
function evict(cache) {
	while (cache.size > UAT_MAX_SIZE) {
		const oldest = cache.keys().next().value;
		if (oldest !== void 0) cache.delete(oldest);
	}
}
/** 从 UAT 缓存中获取用户名 */
function getUATUserName(accountId, openId) {
	const cache = uatRegistry.get(accountId);
	if (!cache) return void 0;
	const entry = cache.get(openId);
	if (!entry) return void 0;
	if (entry.expireAt <= Date.now()) {
		cache.delete(openId);
		return;
	}
	cache.delete(openId);
	cache.set(openId, entry);
	return entry.name;
}
/** 批量写入 UAT 缓存 */
function setUATUserNames(accountId, entries) {
	const cache = getOrCreateCache(accountId);
	const now = Date.now();
	for (const [openId, name] of entries) {
		cache.delete(openId);
		cache.set(openId, {
			name,
			expireAt: now + UAT_TTL_MS
		});
	}
	evict(cache);
}
const BATCH_SIZE = 10;
async function batchResolveUserNamesAsUser(params) {
	const { client, openIds, log } = params;
	if (openIds.length === 0) return /* @__PURE__ */ new Map();
	const accountId = client.account.accountId;
	const cache = getOrCreateCache(accountId);
	const result = /* @__PURE__ */ new Map();
	const now = Date.now();
	const missing = [];
	for (const id of openIds) {
		const entry = cache.get(id);
		if (entry && entry.expireAt > now) result.set(id, entry.name);
		else {
			if (entry) cache.delete(id);
			missing.push(id);
		}
	}
	const uniqueMissing = [...new Set(missing)];
	if (uniqueMissing.length === 0) return result;
	const totalBatches = Math.ceil(uniqueMissing.length / BATCH_SIZE);
	log(`batchResolveUserNamesAsUser: resolving ${uniqueMissing.length} user(s) in ${totalBatches} batch(es), ${result.size} cache hit(s)`);
	for (let i = 0; i < uniqueMissing.length; i += BATCH_SIZE) {
		const chunk = uniqueMissing.slice(i, i + BATCH_SIZE);
		const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
		try {
			const users = (await client.invoke("feishu_get_user.basic_batch", (sdk, opts) => sdk.request({
				method: "POST",
				url: "/open-apis/contact/v3/users/basic_batch",
				data: { user_ids: chunk },
				params: { user_id_type: "open_id" }
			}, opts), { as: "user" }))?.data?.users ?? [];
			let resolved = 0;
			for (const user of users) {
				const openId = user.user_id;
				const rawName = user.name;
				const name = typeof rawName === "string" ? rawName : rawName?.value;
				if (openId && name) {
					cache.delete(openId);
					cache.set(openId, {
						name,
						expireAt: Date.now() + UAT_TTL_MS
					});
					result.set(openId, name);
					resolved++;
				}
			}
			const unresolvedCount = chunk.length - resolved;
			if (unresolvedCount > 0) log(`batchResolveUserNamesAsUser: batch ${batchIndex}/${totalBatches}: ${resolved} resolved, ${unresolvedCount} missing name`);
		} catch (err) {
			if (isInvokeError(err)) throw err;
			log(`batchResolveUserNamesAsUser: failed: ${String(err)}`);
		}
	}
	evict(cache);
	return result;
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/format-messages.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 消息格式化公共函数
*
* 将飞书 IM API 返回的原始消息对象转换为 AI 可读的 JSON 格式。
* 由 feishu_im_user_get_messages 和 feishu_im_user_get_thread_messages 共享。
*
* 所有 API 调用均通过 UAT（用户身份）进行。
*/
const log$1 = larkLogger("oapi/im/format-messages");
/** 通过 UAT 获取合并转发子消息 */
function createUATFetchSubMessages(client) {
	return async (messageId) => {
		const res = await client.invokeByPath("feishu_im_user_get_messages.default", `/open-apis/im/v1/messages/${messageId}`, {
			method: "GET",
			query: {
				user_id_type: "open_id",
				card_msg_content_type: "raw_card_content"
			},
			as: "user"
		});
		if (res.code !== 0) throw new Error(`API error: code=${res.code} msg=${res.msg}`);
		return res.data?.items ?? [];
	};
}
/**
* 格式化单条消息对象。
*
* 使用 convertMessageContent 将 body.content 转为 AI 可读文本，
* 并过滤掉 AI 不需要的字段（upper_message_id、tenant_key 等）。
*/
async function formatMessageItem(item, accountId, nameResolver, ctxOverrides) {
	const messageId = item.message_id ?? "";
	const msgType = item.msg_type ?? "unknown";
	let content = "";
	try {
		const rawContent = item.body?.content ?? "";
		if (rawContent) content = (await convertMessageContent(rawContent, msgType, {
			...buildConvertContextFromItem(item, messageId, accountId),
			...ctxOverrides
		})).content;
	} catch (err) {
		log$1.warn("converter failed, falling back to raw content", {
			messageId,
			msgType,
			error: err instanceof Error ? err.message : String(err)
		});
		content = item.body?.content ?? "";
	}
	const senderId = item.sender?.id ?? "";
	const senderType = item.sender?.sender_type ?? "unknown";
	let senderName;
	if (senderId && senderType === "user") senderName = nameResolver(senderId);
	const sender = {
		id: senderId,
		sender_type: senderType
	};
	if (senderName) sender.name = senderName;
	let mentions;
	if (item.mentions && item.mentions.length > 0) mentions = item.mentions.map((m) => ({
		key: m.key ?? "",
		id: extractMentionOpenId(m.id),
		name: m.name ?? ""
	}));
	const createTime = item.create_time ? millisStringToDateTime(item.create_time) : "";
	const formatted = {
		message_id: messageId,
		msg_type: msgType,
		content,
		sender,
		create_time: createTime,
		deleted: item.deleted ?? false,
		updated: item.updated ?? false
	};
	if (item.thread_id) formatted.thread_id = item.thread_id;
	else if (item.parent_id) formatted.reply_to = item.parent_id;
	if (mentions) formatted.mentions = mentions;
	return formatted;
}
/**
* 批量格式化消息列表（UAT 路径）。
*
* 先批量解析所有 sender 的名字（写入 UAT 缓存），再逐条格式化。
* 这样 formatMessageItem 中的 sender.name 和 converter 的
* resolveUserName 都能从 UAT 缓存中读到名字。
*/
async function formatMessageList(items, account, log, client) {
	const accountId = account.accountId;
	const nameResolver = (openId) => getUATUserName(accountId, openId);
	const mentionNames = /* @__PURE__ */ new Map();
	for (const item of items) for (const m of item.mentions ?? []) {
		const openId = extractMentionOpenId(m.id);
		if (openId && m.name) mentionNames.set(openId, m.name);
	}
	if (mentionNames.size > 0) setUATUserNames(accountId, mentionNames);
	const senderIds = [...new Set(items.map((item) => item.sender?.sender_type === "user" ? item.sender.id : void 0).filter((id) => !!id))];
	if (senderIds.length > 0) {
		const missing = senderIds.filter((id) => getUATUserName(accountId, id) === void 0);
		if (missing.length > 0) await batchResolveUserNamesAsUser({
			client,
			openIds: missing,
			log
		});
	}
	const uatBatchResolve = async (openIds) => {
		await batchResolveUserNamesAsUser({
			client,
			openIds,
			log
		});
	};
	const ctxOverrides = {
		account,
		accountId,
		resolveUserName: nameResolver,
		batchResolveNames: uatBatchResolve,
		fetchSubMessages: createUATFetchSubMessages(client)
	};
	return Promise.all(items.map((item) => formatMessageItem(item, accountId, nameResolver, ctxOverrides)));
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/message-read.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* 消息读取工具集 -- 以用户身份获取/搜索飞书消息
*
* 包含：
*   - feishu_im_user_get_messages       (chat_id / open_id → 会话消息)
*   - feishu_im_user_get_thread_messages (thread_id → 话题消息)
*   - feishu_im_user_search_messages     (跨会话关键词搜索)
*/
function sortRuleToSortType(rule) {
	return rule === "create_time_asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc";
}
/** open_id → chat_id (P2P 单聊) */
async function resolveP2PChatId(client, openId, log) {
	const chats = (await client.invokeByPath("feishu_im_user_get_messages.default", "/open-apis/im/v1/chat_p2p/batch_query", {
		method: "POST",
		body: { chatter_ids: [openId] },
		query: { user_id_type: "open_id" },
		as: "user"
	})).data?.p2p_chats;
	if (!chats?.length) {
		log.info(`batch_query: no p2p chat found for open_id=${openId}`);
		throw new Error(`no 1-on-1 chat found with open_id=${openId}. You may not have chat history with this user.`);
	}
	log.info(`batch_query: resolved chat_id=${chats[0].chat_id}`);
	return chats[0].chat_id;
}
/** 解析时间参数，返回秒级时间戳字符串 */
function resolveTimeRange(p, logInfo) {
	if (p.relative_time) {
		const range = parseTimeRangeToSeconds(p.relative_time);
		logInfo(`relative_time="${p.relative_time}" → start=${range.start}, end=${range.end}`);
		return range;
	}
	return {
		start: p.start_time ? dateTimeToSecondsString(p.start_time) : void 0,
		end: p.end_time ? dateTimeToSecondsString(p.end_time) : void 0
	};
}
/** 格式化 message.list 结果并返回 */
async function formatAndReturn(res, config, log, client) {
	const messages = await formatMessageList(res.data?.items ?? [], getFirstAccount(config), (...args) => log.info(args.map(String).join(" ")), client);
	const hasMore = res.data?.has_more ?? false;
	const pageToken = res.data?.page_token;
	log.info(`list: returned ${messages.length} messages, has_more=${hasMore}`);
	return json({
		messages,
		has_more: hasMore,
		page_token: pageToken
	});
}
const GetMessagesSchema = Type.Object({
	open_id: Type.Optional(Type.String({ description: "用户 open_id（ou_xxx），获取与该用户的单聊消息。与 chat_id 互斥" })),
	chat_id: Type.Optional(Type.String({ description: "会话 ID（oc_xxx），支持单聊和群聊。与 open_id 互斥" })),
	sort_rule: Type.Optional(StringEnum(["create_time_asc", "create_time_desc"], { description: "排序方式，默认 create_time_desc（最新消息在前）" })),
	page_size: Type.Optional(Type.Number({
		description: "每页消息数（1-50），默认 50",
		minimum: 1,
		maximum: 50
	})),
	page_token: Type.Optional(Type.String({ description: "分页标记，用于获取下一页" })),
	relative_time: Type.Optional(Type.String({ description: "相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{unit}（unit: minutes/hours/days）。与 start_time/end_time 互斥" })),
	start_time: Type.Optional(Type.String({ description: "起始时间（ISO 8601 格式，如 2026-02-27T00:00:00+08:00）。与 relative_time 互斥" })),
	end_time: Type.Optional(Type.String({ description: "结束时间（ISO 8601 格式，如 2026-02-27T23:59:59+08:00）。与 relative_time 互斥" }))
});
function registerGetMessages(api) {
	if (!api.config) return false;
	const config = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_im_user_get_messages");
	return registerTool(api, {
		name: "feishu_im_user_get_messages",
		label: "Feishu: Get IM Messages",
		description: "【以用户身份】获取群聊或单聊的历史消息。\n\n用法：\n- 通过 chat_id 获取群聊/单聊消息\n- 通过 open_id 获取与指定用户的单聊消息（自动解析 chat_id）\n- 支持时间范围过滤：relative_time（如 today、last_3_days）或 start_time/end_time（ISO 8601 格式）\n- 支持分页：page_size + page_token\n\n【参数约束】\n- open_id 和 chat_id 必须二选一，不能同时提供\n- relative_time 和 start_time/end_time 不能同时使用\n- page_size 范围 1-50，默认 50\n\n返回消息列表，每条消息包含 message_id、msg_type、content（AI 可读文本）、sender、create_time 等字段。",
		parameters: GetMessagesSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				if (p.open_id && p.chat_id) return json({ error: "cannot provide both open_id and chat_id, please provide only one" });
				if (!p.open_id && !p.chat_id) return json({ error: "either open_id or chat_id is required" });
				if (p.relative_time && (p.start_time || p.end_time)) return json({ error: "cannot use both relative_time and start_time/end_time" });
				const client = toolClient();
				let chatId = p.chat_id ?? "";
				if (p.open_id) {
					log.info(`resolving P2P chat for open_id=${p.open_id}`);
					chatId = await resolveP2PChatId(client, p.open_id, log);
				}
				const time = resolveTimeRange(p, log.info);
				log.info(`list: chat_id=${chatId}, sort=${p.sort_rule ?? "create_time_desc"}, page_size=${p.page_size ?? 50}`);
				const res = await client.invoke("feishu_im_user_get_messages.default", (sdk, opts) => sdk.im.v1.message.list({ params: {
					container_id_type: "chat",
					container_id: chatId,
					start_time: time.start,
					end_time: time.end,
					sort_type: sortRuleToSortType(p.sort_rule),
					page_size: p.page_size ?? 50,
					page_token: p.page_token,
					card_msg_content_type: "raw_card_content"
				} }, opts), { as: "user" });
				assertLarkOk(res);
				return await formatAndReturn(res, config, log, client);
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, config);
			}
		}
	}, { name: "feishu_im_user_get_messages" });
}
const GetThreadMessagesSchema = Type.Object({
	thread_id: Type.String({ description: "话题 ID（omt_xxx 格式）" }),
	sort_rule: Type.Optional(StringEnum(["create_time_asc", "create_time_desc"], { description: "排序方式，默认 create_time_desc（最新消息在前）" })),
	page_size: Type.Optional(Type.Number({
		description: "每页消息数（1-50），默认 50",
		minimum: 1,
		maximum: 50
	})),
	page_token: Type.Optional(Type.String({ description: "分页标记，用于获取下一页" }))
});
function registerGetThreadMessages(api) {
	if (!api.config) return false;
	const config = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_im_user_get_thread_messages");
	return registerTool(api, {
		name: "feishu_im_user_get_thread_messages",
		label: "Feishu: Get Thread Messages",
		description: "【以用户身份】获取话题（thread）内的消息列表。\n\n用法：\n- 通过 thread_id（omt_xxx）获取话题内的所有消息\n- 支持分页：page_size + page_token\n\n【注意】话题消息不支持时间范围过滤（飞书 API 限制）\n\n返回消息列表，格式同 feishu_im_user_get_messages。",
		parameters: GetThreadMessagesSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = toolClient();
				log.info(`list: thread_id=${p.thread_id}, sort=${p.sort_rule ?? "create_time_desc"}, page_size=${p.page_size ?? 50}`);
				const res = await client.invoke("feishu_im_user_get_messages.default", (sdk, opts) => sdk.im.v1.message.list({ params: {
					container_id_type: "thread",
					container_id: p.thread_id,
					sort_type: sortRuleToSortType(p.sort_rule),
					page_size: p.page_size ?? 50,
					page_token: p.page_token,
					card_msg_content_type: "raw_card_content"
				} }, opts), { as: "user" });
				assertLarkOk(res);
				return await formatAndReturn(res, config, log, client);
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, config);
			}
		}
	}, { name: "feishu_im_user_get_thread_messages" });
}
const SearchMessagesSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "搜索关键词，匹配消息内容。可为空字符串表示不按内容过滤" })),
	sender_ids: Type.Optional(Type.Array(Type.String({ description: "发送者的 open_id（ou_xxx）" }), { description: "发送者 open_id 列表。如需根据用户名查找 open_id，请先使用 search_user 工具" })),
	chat_id: Type.Optional(Type.String({ description: "限定搜索范围的会话 ID（oc_xxx）" })),
	mention_ids: Type.Optional(Type.Array(Type.String({ description: "被@用户的 open_id（ou_xxx）" }), { description: "被@用户的 open_id 列表" })),
	message_type: Type.Optional(StringEnum([
		"file",
		"image",
		"media"
	], { description: "消息类型过滤：file / image / media。为空则搜索所有类型" })),
	sender_type: Type.Optional(StringEnum([
		"user",
		"bot",
		"all"
	], { description: "发送者类型：user / bot / all。默认 user" })),
	chat_type: Type.Optional(StringEnum(["group", "p2p"], { description: "会话类型：group（群聊）/ p2p（单聊）" })),
	relative_time: Type.Optional(Type.String({ description: "相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{unit}（unit: minutes/hours/days）。与 start_time/end_time 互斥" })),
	start_time: Type.Optional(Type.String({ description: "起始时间（ISO 8601 格式，如 2026-02-27T00:00:00+08:00）。与 relative_time 互斥" })),
	end_time: Type.Optional(Type.String({ description: "结束时间（ISO 8601 格式，如 2026-02-27T23:59:59+08:00）。与 relative_time 互斥" })),
	page_size: Type.Optional(Type.Number({
		description: "每页消息数（1-50），默认 50",
		minimum: 1,
		maximum: 50
	})),
	page_token: Type.Optional(Type.String({ description: "分页标记，用于获取下一页" }))
});
function buildSearchData(p, time) {
	const data = {
		query: p.query ?? "",
		start_time: time.start,
		end_time: time.end
	};
	if (p.sender_ids?.length) data.from_ids = p.sender_ids;
	if (p.chat_id) data.chat_ids = [p.chat_id];
	if (p.mention_ids?.length) data.at_chatter_ids = p.mention_ids;
	if (p.message_type) data.message_type = p.message_type;
	if (p.sender_type && p.sender_type !== "all") data.from_type = p.sender_type;
	if (p.chat_type) data.chat_type = p.chat_type === "group" ? "group_chat" : "p2p_chat";
	return data;
}
async function fetchChatContexts(client, chatIds, logInfo, logWarn) {
	const map = /* @__PURE__ */ new Map();
	if (chatIds.length === 0) return map;
	try {
		logInfo(`batch_query: requesting ${chatIds.length} chat_ids: ${chatIds.join(", ")}`);
		const res = await client.invokeByPath("feishu_im_user_search_messages.default", "/open-apis/im/v1/chats/batch_query", {
			method: "POST",
			body: { chat_ids: chatIds },
			query: { user_id_type: "open_id" },
			as: "user"
		});
		logInfo(`batch_query: response code=${res.code}, msg=${res.msg}, items=${res.data?.items?.length ?? 0}`);
		if (res.code !== 0) logWarn(`batch_query: API returned error code=${res.code}, msg=${res.msg}`);
		for (const c of res.data?.items ?? []) if (c.chat_id) map.set(c.chat_id, {
			name: c.name ?? "",
			chat_mode: c.chat_mode ?? "",
			p2p_target_id: c.p2p_target_id
		});
	} catch (err) {
		logInfo(`batch_query chats failed, skipping: ${err}`);
	}
	return map;
}
async function resolveP2PTargetNames(chatMap, client, logFn) {
	const ids = [...new Set([...chatMap.values()].map((c) => c.p2p_target_id).filter((id) => !!id))];
	if (ids.length > 0) await batchResolveUserNamesAsUser({
		client,
		openIds: ids,
		log: logFn
	});
}
function enrichMessages(messages, items, chatMap, nameResolver) {
	return messages.map((msg, idx) => {
		const chatId = items[idx]?.chat_id;
		const ctx = chatId ? chatMap.get(chatId) : void 0;
		if (!chatId || !ctx) return {
			...msg,
			chat_id: chatId
		};
		if (ctx.chat_mode === "p2p" && ctx.p2p_target_id) {
			const name = nameResolver(ctx.p2p_target_id);
			return {
				...msg,
				chat_id: chatId,
				chat_type: "p2p",
				chat_name: name || void 0,
				chat_partner: {
					open_id: ctx.p2p_target_id,
					name: name || void 0
				}
			};
		}
		return {
			...msg,
			chat_id: chatId,
			chat_type: ctx.chat_mode,
			chat_name: ctx.name || void 0
		};
	});
}
function registerSearchMessages(api) {
	if (!api.config) return false;
	const config = api.config;
	const { toolClient, log } = createToolContext(api, "feishu_im_user_search_messages");
	return registerTool(api, {
		name: "feishu_im_user_search_messages",
		label: "Feishu: Search Messages",
		description: "【以用户身份】跨会话搜索飞书消息。\n\n用法：\n- 按关键词搜索消息内容\n- 按发送者、被@用户、消息类型过滤\n- 按时间范围过滤：relative_time 或 start_time/end_time\n- 限定在某个会话内搜索（chat_id）\n- 支持分页：page_size + page_token\n\n【参数约束】\n- 所有参数均可选，但至少应提供一个过滤条件\n- relative_time 和 start_time/end_time 不能同时使用\n- page_size 范围 1-50，默认 50\n\n返回消息列表，每条消息包含 message_id、msg_type、content、sender、create_time 等字段。\n每条消息还包含 chat_id、chat_type（p2p/group）、chat_name（群名或单聊对方名字）。\n单聊消息额外包含 chat_partner（对方 open_id 和名字）。\n搜索结果中的 chat_id 和 thread_id 可配合 feishu_im_user_get_messages / feishu_im_user_get_thread_messages 查看上下文。",
		parameters: SearchMessagesSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				if (p.relative_time && (p.start_time || p.end_time)) return json({ error: "cannot use both relative_time and start_time/end_time" });
				const client = toolClient();
				const account = getFirstAccount(config);
				const logFn = (...args) => log.info(args.map(String).join(" "));
				const time = resolveTimeRange(p, log.info);
				const searchData = buildSearchData(p, {
					start: time.start ?? "978307200",
					end: time.end ?? Math.floor(Date.now() / 1e3).toString()
				});
				log.info(`search: query="${p.query ?? ""}", page_size=${p.page_size ?? 50}`);
				const searchRes = await client.invoke("feishu_im_user_search_messages.default", (sdk, opts) => sdk.search.message.create({
					data: searchData,
					params: {
						user_id_type: "open_id",
						page_size: p.page_size ?? 50,
						page_token: p.page_token
					}
				}, opts), { as: "user" });
				assertLarkOk(searchRes);
				const messageIds = searchRes.data?.items ?? [];
				const hasMore = searchRes.data?.has_more ?? false;
				const pageToken = searchRes.data?.page_token;
				log.info(`search: found ${messageIds.length} IDs, has_more=${hasMore}`);
				if (messageIds.length === 0) return json({
					messages: [],
					has_more: hasMore,
					page_token: pageToken
				});
				const queryStr = messageIds.map((id) => `message_ids=${encodeURIComponent(id)}`).join("&");
				const items = (await client.invokeByPath("feishu_im_user_search_messages.default", `/open-apis/im/v1/messages/mget?${queryStr}`, {
					method: "GET",
					query: {
						user_id_type: "open_id",
						card_msg_content_type: "raw_card_content"
					},
					as: "user"
				})).data?.items ?? [];
				log.info(`mget: ${items.length} details`);
				const chatIds = [...new Set(items.map((i) => i.chat_id).filter(Boolean))];
				const chatMap = await fetchChatContexts(client, chatIds, log.info, log.warn);
				const p2pChats = [...chatMap.entries()].filter(([, v]) => v.chat_mode === "p2p");
				log.info(`chats: ${chatMap.size}/${chatIds.length} resolved, p2p=${p2pChats.length}`);
				const messages = await formatMessageList(items, account, logFn, client);
				await resolveP2PTargetNames(chatMap, client, logFn);
				const uatNameResolver = (id) => getUATUserName(account.accountId, id);
				const result = enrichMessages(messages, items, chatMap, uatNameResolver);
				log.info(`result: ${result.length} messages, has_more=${hasMore}`);
				return json({
					messages: result,
					has_more: hasMore,
					page_token: pageToken
				});
			} catch (err) {
				return await handleInvokeErrorWithAutoAuth(err, config);
			}
		}
	}, { name: "feishu_im_user_search_messages" });
}
function registerMessageReadTools(api) {
	const registered = [];
	if (registerGetMessages(api)) registered.push("feishu_im_user_get_messages");
	if (registerGetThreadMessages(api)) registered.push("feishu_im_user_get_thread_messages");
	if (registerSearchMessages(api)) registered.push("feishu_im_user_search_messages");
	return registered;
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/im/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* IM Tools Index
*
* 即时通讯相关工具
*/
function registerFeishuImTools(api) {
	const registered = [];
	if (registerFeishuImUserMessageTool(api)) registered.push("feishu_im_user_message");
	if (registerFeishuImUserFetchResourceTool(api)) registered.push("feishu_im_user_fetch_resource");
	registered.push(...registerMessageReadTools(api));
	if (registered.length > 0) api.logger.debug?.(`feishu_im: Registered ${registered.join(", ")}`);
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oapi/index.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* OAPI Tools Index
*
* This module registers all tools that directly use Feishu Open API (OAPI).
* These tools are placed here to distinguish them from MCP-based tools.
*/
function registerOapiTools(api) {
	registerGetUserTool(api);
	registerSearchUserTool(api);
	registerFeishuChatTools(api);
	registerFeishuImTools(api);
	registerFeishuCalendarCalendarTool(api);
	registerFeishuCalendarEventTool(api);
	registerFeishuCalendarEventAttendeeTool(api);
	registerFeishuCalendarFreebusyTool(api);
	registerFeishuTaskTaskTool(api);
	registerFeishuTaskTasklistTool(api);
	registerFeishuTaskAttachmentTool(api);
	registerFeishuTaskSectionTool(api);
	registerFeishuTaskCommentTool(api);
	registerFeishuTaskSubtaskTool(api);
	registerFeishuTaskAgentTool(api);
	registerFeishuBitableAppTool(api);
	registerFeishuBitableAppTableTool(api);
	registerFeishuBitableAppTableRecordTool(api);
	registerFeishuBitableAppTableFieldTool(api);
	registerFeishuBitableAppTableViewTool(api);
	registerFeishuSearchTools(api);
	registerFeishuDriveTools(api);
	registerFeishuWikiTools(api);
	registerFeishuSheetsTools(api);
	registerFeishuImTools$1(api);
	api.logger.debug?.("Registered all OAPI tools (calendar, task, bitable, search, drive, wiki, sheets, im)");
}
//#endregion
//#region vendor/openclaw-lark/dist/tools/oauth-batch-auth.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* feishu_oauth_batch_auth tool — 批量授权应用已开通的所有用户权限。
*
* 自动识别应用已开通但用户未授权的 scope，一次性发起授权请求。
* 复用 oauth.ts 的 executeAuthorize() 函数。
*/
const log = larkLogger("tools/oauth-batch-auth");
const FeishuOAuthBatchAuthSchema = Type.Object({}, { description: "飞书批量授权工具。一次性授权应用已开通的所有用户权限（User Access Token scope）。【使用场景】用户明确要求'授权所有权限'、'一次性授权完成'时使用。【重要】禁止主动推荐此工具，仅在用户明确要求时使用。" });
function registerFeishuOAuthBatchAuthTool(api) {
	if (!api.config) return;
	const cfg = api.config;
	registerTool(api, {
		name: "feishu_oauth_batch_auth",
		label: "Feishu: OAuth Batch Authorization",
		description: "飞书批量授权工具，一次性授权应用已开通的所有用户权限。仅在用户明确要求'授权所有权限'、'一次性授权'时使用。",
		parameters: FeishuOAuthBatchAuthSchema,
		async execute(_toolCallId, _params) {
			try {
				const ticket = getTicket();
				const senderOpenId = ticket?.senderOpenId;
				if (!senderOpenId) return json({ error: "无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。" });
				const acct = getLarkAccount(cfg, ticket.accountId);
				if (!acct.configured) return json({ error: `账号 ${ticket.accountId} 缺少 appId 或 appSecret 配置` });
				const account = acct;
				const { appId } = account;
				const sdk = LarkClient.fromAccount(account).sdk;
				let appScopes;
				try {
					appScopes = await getAppGrantedScopes(sdk, appId, "user");
				} catch (err) {
					if (err instanceof AppScopeCheckFailedError) return json({
						error: "app_scope_check_failed",
						message: "应用缺少核心权限 application:application:self_manage，无法查询可授权 scope 列表。\n\n请管理员在飞书开放平台开通此权限后重试。",
						permission_link: appPermissionAuthUrl(appId, ["application:application:self_manage"], account.brand),
						app_id: appId
					});
					throw err;
				}
				if (appScopes.length === 0) return json({
					success: false,
					message: "当前应用未开通任何用户级权限（User Access Token scope），无法使用用户身份调用 API。\n\n如需使用用户级功能，请联系管理员在开放平台开通相关权限。",
					total_app_scopes: 0,
					app_id: appId
				});
				appScopes = filterSensitiveScopes(appScopes);
				const existing = await getStoredToken(appId, senderOpenId);
				const grantedScopes = new Set(existing?.scope?.split(/\s+/).filter(Boolean) ?? []);
				const missingScopes = appScopes.filter((s) => !grantedScopes.has(s));
				if (missingScopes.length === 0) return json({
					success: true,
					message: `您已授权所有可用权限（共 ${appScopes.length} 个），无需重复授权。`,
					total_app_scopes: appScopes.length,
					already_granted: appScopes.length,
					missing: 0
				});
				const MAX_SCOPES_PER_BATCH = 100;
				let scopesToAuthorize = missingScopes;
				let batchInfo = "";
				if (missingScopes.length > MAX_SCOPES_PER_BATCH) {
					scopesToAuthorize = missingScopes.slice(0, MAX_SCOPES_PER_BATCH);
					batchInfo = `\n\n由于飞书限制（单次最多 ${MAX_SCOPES_PER_BATCH} 个 scope），本次将授权前 ${MAX_SCOPES_PER_BATCH} 个权限。\n授权完成后，还需授权剩余 ${missingScopes.length - MAX_SCOPES_PER_BATCH} 个权限`;
				}
				const alreadyGrantedScopes = appScopes.filter((s) => grantedScopes.has(s));
				log.info(`scope check: total=${appScopes.length}, granted=${alreadyGrantedScopes.length}, missing=${missingScopes.length}`);
				const result = await executeAuthorize({
					account,
					senderOpenId,
					scope: scopesToAuthorize.join(" "),
					isBatchAuth: true,
					totalAppScopes: appScopes.length,
					alreadyGranted: alreadyGrantedScopes.length,
					batchInfo,
					cfg,
					ticket
				});
				if (batchInfo && result.details) {
					const details = result.details;
					if (details.message) details.message = details.message + batchInfo;
				}
				return result;
			} catch (err) {
				api.logger.error?.(`feishu_oauth_batch_auth: ${err}`);
				return json({ error: formatLarkError(err) });
			}
		}
	}, { name: "feishu_oauth_batch_auth" });
	api.logger.debug?.("feishu_oauth_batch_auth: Registered feishu_oauth_batch_auth tool");
}
//#endregion
//#region src/tools.ts
/** Session-scoped Feishu identity used by user-token and proactive tools. */
var OfficialToolContexts = class {
	sessions = /* @__PURE__ */ new Map();
	/** Remember the latest accepted inbound message for one DSH session. */
	bind(sessionId, ticket) {
		this.sessions.set(sessionId, ticket);
	}
	/** Resolve a session binding for the tool adapter. */
	get(sessionId) {
		return this.sessions.get(sessionId);
	}
	/** Drop all bindings when the surface is disposed. */
	clear() {
		this.sessions.clear();
	}
};
/** Build the OpenClaw-shaped config consumed by the untouched official modules. */
function officialConfig(config, credentials) {
	const configuredAccounts = config.accounts !== null && typeof config.accounts === "object" ? config.accounts : {};
	const botAccounts = Object.fromEntries((Array.isArray(config.bots) ? config.bots : []).map((entry) => {
		const bot = entry;
		return [String(bot.accountId).toLowerCase(), {
			...bot,
			accountId: String(bot.accountId).toLowerCase(),
			enabled: true,
			connectionMode: "websocket"
		}];
	}));
	return { channels: { feishu: {
		...config,
		appId: credentials.appId,
		appSecret: credentials.appSecret,
		accounts: {
			...configuredAccounts,
			...botAccounts
		},
		enabled: true,
		connectionMode: "websocket"
	} } };
}
/** Convert TypeBox's JSON Schema dialect to DSH's supported schema subset. */
function toDshSchema(schema) {
	const output = {};
	for (const key of [
		"type",
		"enum",
		"const",
		"required",
		"description",
		"title",
		"default",
		"examples"
	]) if (key in schema) output[key] = schema[key];
	if (schema.properties !== null && typeof schema.properties === "object") output.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, toDshSchema(child)]));
	if (schema.items !== null && typeof schema.items === "object") output.items = toDshSchema(schema.items);
	if (typeof schema.additionalProperties === "boolean") output.additionalProperties = schema.additionalProperties;
	else if (schema.additionalProperties !== void 0 || schema.patternProperties !== void 0) output.additionalProperties = true;
	const union = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(union)) output.oneOf = union.map((entry) => toDshSchema(entry));
	return output;
}
function jsonValue(value) {
	if (value === void 0) return null;
	try {
		return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
	} catch {
		return String(value);
	}
}
function adaptTool(tool, contexts) {
	let parameters = toDshSchema(tool.parameters);
	if (Array.isArray(parameters.oneOf)) {
		const branches = parameters.oneOf;
		const properties = {};
		for (const branch of branches) for (const [name, schema] of Object.entries(branch.properties ?? {})) if (!(name in properties)) properties[name] = schema;
		else if (name === "action") properties[name] = {
			type: "string",
			enum: branches.map((item) => item.properties?.[name]?.const).filter((value) => value !== void 0)
		};
		const required = branches.map((branch) => new Set(branch.required ?? []));
		parameters = {
			type: "object",
			properties,
			required: [...required[0] ?? /* @__PURE__ */ new Set()].filter((name) => required.every((branch) => branch.has(name))),
			additionalProperties: true
		};
	}
	parameters.type ??= "object";
	return {
		name: tool.name,
		description: tool.description,
		parameters,
		output: {
			schema: {},
			render(_args, value) {
				const envelope = value;
				return envelope.content ?? [{
					type: "text",
					text: JSON.stringify(envelope.details ?? null, null, 2)
				}];
			}
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.session.id;
			const ticket = sessionId === void 0 ? void 0 : contexts.get(sessionId);
			const invoke = () => tool.execute(exec.callId, args);
			const result = ticket === void 0 ? await invoke() : await withTicket(ticket, invoke);
			return {
				content: jsonValue(result.content ?? []),
				details: jsonValue(result.details)
			};
		}
	};
}
/**
* Register OAPI, MCP document and OAuth tools. DSH's native `ask_user`
* remains the interactive-question implementation, so the OpenClaw-specific
* synthetic-card tool is deliberately not mounted.
*/
function registerOfficialTools(ctx, config, credentials, contexts, hostConfig = officialConfig(config, credentials), mode = "all") {
	const tools = ctx.get("tools");
	if (tools === void 0) {
		ctx.logger.warn("[feishu] tools service unavailable; official Lark tools not registered");
		return () => {};
	}
	const disposers = [];
	const registered = [];
	const host = {
		config: hostConfig,
		logger: ctx.logger,
		registerTool(tool) {
			if (mode === "messages" && ![
				"feishu_im_user_message",
				"feishu_im_user_fetch_resource",
				"feishu_im_bot_image",
				"feishu_send_file"
			].includes(tool.name)) return;
			disposers.push(tools.register(adaptTool(tool, contexts)));
			registered.push(tool.name);
			ctx.logger.debug(`[feishu] official tool registered: ${tool.name}`);
		}
	};
	disposers.push(tools.register({
		name: "feishu_send_image",
		description: "把本地图片发送到当前飞书对话。支持 ths_qr_login 的 output、image_generate/image_edit 的 image_path，以及 feishu_group_image、browser_screenshot 等工作区图片。",
		parameters: {
			type: "object",
			properties: { path: {
				type: "string",
				description: "图片文件路径"
			} },
			required: ["path"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args, exec) {
			const { path: inputPath } = args;
			const sessionId = exec.agent?.session.id;
			const ticket = sessionId === void 0 ? void 0 : contexts.get(sessionId);
			if (!ticket) throw new Error("当前对话没有可信飞书用户身份");
			const { realpathSync } = await import("node:fs");
			const path = realpathSync(resolve(String(inputPath)));
			const agentsRoot = realpathSync(resolve(process.env.DSH_HOME ?? "/data/dsh", "home", "agents"));
			const isQr = path.startsWith(`${realpathSync("/tmp/openclaw-ths-qr")}/`) && /\/qr-[a-f0-9]+\.png$/.test(path);
			const isGenerated = path.startsWith(`${realpathSync("/data/dsh/tmp/media-images")}/`) && /\.(png|jpe?g|webp)$/i.test(path);
			const isWorkspace = path.startsWith(`${agentsRoot}/`) && /\.(png|jpe?g|webp|gif|bmp)$/i.test(path);
			if (!isQr && !isGenerated && !isWorkspace) throw new Error("图片路径不属于受支持的扫码、生图或工作区目录");
			const client = LarkClient.fromCfg(host.config, ticket.accountId);
			const response = await client.sdk.im.image.create({ data: {
				image_type: "message",
				image: createReadStream(path)
			} });
			const imageKey = response?.data?.image_key ?? response?.image_key;
			if (response?.code !== void 0 && response.code !== 0 || !imageKey) throw new Error(`图片上传失败: ${response?.msg ?? response?.code ?? "missing image_key"}`);
			const sent = await client.sdk.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: ticket.chatId,
					msg_type: "image",
					content: JSON.stringify({ image_key: imageKey })
				}
			});
			if (sent.code !== 0) throw new Error(`图片发送失败: ${sent.msg ?? sent.code}`);
			return {
				sent: true,
				messageId: sent.data?.message_id
			};
		}
	}));
	disposers.push(tools.register({
		name: "feishu_send_file",
		description: "把本地文件(csv/xlsx/pdf/txt 等)发送到当前飞书对话。文件需在当前用户工作区 agents/ 目录下。",
		parameters: {
			type: "object",
			properties: { path: {
				type: "string",
				description: "文件路径"
			} },
			required: ["path"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args, exec) {
			const { path: inputPath } = args;
			const sessionId = exec.agent?.session.id;
			const ticket = sessionId === void 0 ? void 0 : contexts.get(sessionId);
			if (!ticket) throw new Error("当前对话没有可信飞书用户身份");
			const { realpathSync } = await import("node:fs");
			const path = realpathSync(resolve(String(inputPath)));
			const agentsRoot = realpathSync(resolve(process.env.DSH_HOME ?? "/data/dsh", "home", "agents"));
			if (!path.startsWith(`${agentsRoot}/`)) throw new Error("文件路径必须在当前用户工作区 agents/ 目录下");
			const { stat } = await import("node:fs/promises");
			const info = await stat(path);
			if (!info.isFile() || info.size > 30 * 1024 * 1024) throw new Error("文件不存在或超过 30MB 限制");
			const client = LarkClient.fromCfg(host.config, ticket.accountId);
			const fileType = /\.(pdf)$/i.test(path) ? "pdf" : /\.(xlsx?|csv)$/i.test(path) ? "xls" : /\.(docx?)$/i.test(path) ? "doc" : "stream";
			const response = await client.sdk.im.file.create({ data: {
				file_type: fileType,
				file_name: path.split("/").pop() ?? "file",
				file: createReadStream(path)
			} });
			const fileKey = response?.data?.file_key ?? response?.file_key;
			if (response?.code !== void 0 && response.code !== 0 || !fileKey) throw new Error(`文件上传失败: ${response?.msg ?? response?.code ?? "missing file_key"}`);
			const sent = await client.sdk.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: ticket.chatId,
					msg_type: "file",
					content: JSON.stringify({ file_key: fileKey })
				}
			});
			if (sent.code !== 0) throw new Error(`文件发送失败: ${sent.msg ?? sent.code}`);
			return {
				sent: true,
				messageId: sent.data?.message_id,
				fileName: path.split("/").pop()
			};
		}
	}));
	const api = host;
	registerOapiTools(api);
	registerFeishuMcpDocTools(api);
	registerFeishuOAuthTool(api);
	registerFeishuOAuthBatchAuthTool(api);
	ctx.logger.info(`[feishu] registered ${disposers.length} official Lark tools: ${registered.join(", ")}`);
	for (const name of [
		"feishu_search_doc_wiki",
		"feishu_search_user",
		"feishu_im_user_search_messages"
	]) if (tools.get(name) === void 0) ctx.logger.warn(`[feishu] search tool is not visible: ${name}`);
	return () => {
		contexts.clear();
		for (const dispose of disposers.reverse()) dispose();
	};
}
//#endregion
//#region src/index.ts
const name = "feishu";
/** One Agent runtime, one WebSocket per Feishu application, isolated session stores. */
/** Resolve the shared agents root: the first bot's derived identity directory minus its agentId tier. */
function resolveAgentsRoot(config, bots) {
	if (config.workspaceRoot) return config.workspaceRoot;
	const first = bots.find((bot) => bot.agentId && bot.workspaceRoot);
	if (first && first.agentId && first.workspaceRoot?.endsWith(first.agentId)) return first.workspaceRoot.slice(0, -first.agentId.length - 1);
	return agentsRootDefault();
}
function apply(ctx, config) {
	ctx.logger.exporter(consoleExporter());
	const bots = resolveBots(config);
	const credentials = resolveCredentials(config) ?? (bots.find((bot) => bot.accountId !== "default") && bots[0]?.appId && bots[0]?.appSecret ? {
		appId: bots[0].appId,
		appSecret: bots[0].appSecret
	} : void 0);
	if (!credentials) {
		ctx.logger.warn("[lark] appId/appSecret are required; channel not started");
		return;
	}
	const upstream = officialConfig({
		...config,
		bots: bots.filter((bot) => bot.accountId !== "default")
	}, credentials);
	LarkClient.setRuntime({
		config: { loadConfig: () => upstream },
		logging: { getChildLogger: () => ctx.logger }
	});
	LarkClient.setGlobalConfig(upstream);
	const toolContexts = new OfficialToolContexts();
	const disposeTools = config.officialTools === false ? () => {} : registerOfficialTools(ctx, config, credentials, toolContexts, upstream, config.officialTools === "messages" ? "messages" : "all");
	const selections = new ModelSelectionRegistry();
	const appForAccount = new Map(bots.map((bot) => [bot.accountId ?? "default", bot.appId]));
	const agentForAccount = new Map(bots.map((bot) => [bot.accountId ?? "default", bot.agentId]));
	const userForSession = (sessionId) => {
		const ticket = toolContexts.get(sessionId);
		return ticket?.senderOpenId ? {
			openId: ticket.senderOpenId,
			chatId: ticket.chatId,
			accountId: ticket.accountId,
			appId: appForAccount.get(ticket.accountId),
			agentId: agentForAccount.get(ticket.accountId)
		} : void 0;
	};
	const channels = [];
	let registeredController = false;
	const agentsRoot = resolveAgentsRoot(config, bots);
	for (const bot of bots) {
		const sessions = new SessionStore(dataDirectory(bot), bot.defaultCwd ?? process.cwd(), agentsRoot);
		const extras = {
			selections,
			modelOverride: (sessionId) => sessions.overrideFor(sessionId),
			userForSession
		};
		const resolveBound = (sessionId, cwd) => resolveAgent(ctx, bot, sessionId, cwd, extras);
		if (bot.accountId === "default" || !registeredController) {
			registeredController = true;
			registerSessionController(ctx, bot, bot.defaultCwd ?? process.cwd(), extras);
		}
		const models = new ModelCommands({
			getLlm: () => ctx.get("llm"),
			getDefaultModel: () => ctx.get("agentDefaultModel"),
			getLiveAgent: (sessionId) => ctx.get("agents")?.get(sessionId),
			resolveAgent: resolveBound,
			registry: selections,
			sessions,
			logger: ctx.logger
		});
		channels.push(new LarkChannel({
			config: bot,
			officialConfig: upstream,
			sessions,
			toolContexts,
			logger: ctx.logger,
			resolveAgent: resolveBound,
			models
		}));
	}
	ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		for (const channel of channels) channel.assistantFrame(agent.session.id, frame);
	});
	ctx.on("agent/created", async ({ agent }) => {
		const tools = ctx.get("tools");
		const names = tools?.schemas(agent).map((tool) => tool.name).sort() ?? [];
		ctx.logger.info(`[lark] ${names.length} tools enabled for session ${agent.session.id}: ${names.join(", ")}`);
		for (const name of [
			"web_search",
			"web_fetch",
			"browser_health",
			"ths_quote"
		]) if (tools?.get(name, agent) === void 0) ctx.logger.warn(`[lark] ${name} is not visible to session ${agent.session.id}`);
		else ctx.logger.info(`[lark] ${name} enabled for session ${agent.session.id}`);
	});
	ctx.on("session/event", (session, event) => {
		for (const channel of channels) channel.sessionEvent(session.id, event).catch((error) => {
			ctx.logger.warn(`[lark] session event failed: ${String(error)}`);
		});
	});
	ctx.effect(() => async () => {
		disposeTools();
		toolContexts.clear();
		await Promise.all(channels.map((channel) => channel.stop()));
	});
	for (const channel of channels) channel.start().catch((error) => ctx.logger.error(`[lark] official WebSocket failed: ${String(error)}`));
	ctx.logger.info(`[lark] official channel and CardKit streaming configured for ${channels.length} bot(s)`);
}
//#endregion
export { Config, LarkChannel, OfficialTurnStream, apply, name };
