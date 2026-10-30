/**
 * @local/feishu-group-reader — 飞书群消息读取(用户身份)
 *
 * 背景:
 *   dsh-lark 的官方工具 feishu_im_user_get_messages 只挂在 feishu profile 会话,
 *   web/复盘会话读不了飞书群消息;而 bot 身份(tenant_access_token)不在群里,
 *   im/v1/messages 直接 230002 拒绝。
 *
 * 实现(参考 openclaw-lark 官方插件 larksuite/openclaw-lark):
 *   - UAT(user_access_token)复用官方加密存储:
 *       ${XDG_DATA_HOME:-~/.local/share}/openclaw-feishu-uat/
 *       master.key + <appId>_<openId>.enc (AES-256-GCM,格式 [12B IV][16B tag][cipher])
 *     与 dsh-lark(feishu profile)共享同一份授权,不重复发 OAuth。
 *   - 过期自动 refresh(authen/v2/oauth/token,client_id + client_secret),
 *     refresh_token 轮转后回写存储,与 openclaw 的 uat-client.ts 语义一致。
 *   - 读消息走 GET /open-apis/im/v1/messages(container_id_type=chat),
 *     interactive 卡片按 openclaw format-messages 的思路抽取文本。
 *
 * 工具:
 *   feishu_group_messages — 按 chat_id / 群名(模糊)拉取群消息,支持相对时间。
 *   feishu_group_chats    — 列出当前用户可见的群(找 chat_id 用)。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { identityOf } from '../feishu-principal/index.js';

const name = 'feishu-messages';
const READ_MESSAGE_SCOPES = ['im:chat:read', 'im:message:readonly', 'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user'];
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	/** 飞书开放平台域名 */
	baseUrl: 'https://open.feishu.cn',
	/** openclaw 官方 UAT 存储目录(与 dsh-lark 共享) */
	uatDir: join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'openclaw-feishu-uat'),
	/** app 凭据:默认从 profile config 读;appSecretEnv 指定环境变量名(env→credentials refs 兜底) */
	appId: '',
	appSecret: '',
	appSecretEnv: '',
	/** 默认群(可配 chat_id 或群名) */
	defaultChatId: '',
	/** access_token 过期前提前刷新窗口 */
	refreshAheadMs: 5 * 60 * 1000,
	/** 单页消息数 */
	pageSize: 50,
	requestTimeoutMs: 20_000,
	/** 解析"今天/本周"与展示时间的时区(容器系统时区是 UTC,业务按北京时间) */
	timeZone: 'Asia/Shanghai',
};

/** 凭据 refs 直读:credentials 服务未挂载的 profile 用(env 未命中时) */
function readCredentialRef(ref) {
	try {
		const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
		const text = fs.readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
		const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		let inRefs = false;
		for (const line of text.split(/\r?\n/)) {
			if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
			if (!inRefs) continue;
			if (/^\S/.test(line)) break;
			const match = line.match(new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`));
			if (match?.[1] && !match[1].startsWith('"')) return match[1];
		}
	} catch { /* 文件缺失静默 */ }
	return undefined;
}

/* ─────────────────── UAT 存储(与 openclaw token-store.ts 同格式) ─────────────────── */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function linuxSafeFileName(account) {
	return account.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc';
}

async function ensureUatDir(dir) {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

async function getMasterKey(dir) {
	const path = join(dir, 'master.key');
	try {
		const key = await readFile(path);
		if (key.length === 32) return key;
	} catch {
		/* 不存在则生成 */
	}
	await ensureUatDir(dir);
	const { randomBytes } = await import('node:crypto');
	const key = randomBytes(32);
	await writeFile(path, key, { mode: 0o600 });
	await chmod(path, 0o600);
	return key;
}

function decryptData(data, key) {
	if (data.length < IV_BYTES + TAG_BYTES) return null;
	try {
		const iv = data.subarray(0, IV_BYTES);
		const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
	} catch {
		return null;
	}
}

function encryptData(plaintext, key) {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

/** Read only the trusted sender's encrypted token; never borrow another user's latest token. */
async function loadStoredToken(cfg, openId) {
	if (typeof openId !== 'string' || !/^ou_[a-f0-9]{32}$/i.test(openId)) {
		throw new Error('无法确认当前飞书用户身份，已拒绝读取任何用户授权或群消息');
	}
	try {
		const file = join(cfg.uatDir, linuxSafeFileName(`${cfg.appId}:${openId}`));
		const plain = decryptData(await readFile(file), await getMasterKey(cfg.uatDir));
		if (!plain) throw new Error('授权文件无法解密，请重新授权');
		const token = JSON.parse(plain);
		if (token.userOpenId !== openId) throw new Error('授权用户身份不匹配，请重新授权');
		return token;
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

async function saveStoredToken(cfg, token) {
	const key = await getMasterKey(cfg.uatDir);
	// openclaw 命名:account = appId:userOpenId → 文件 <appId>_<openId>.enc
	const path = join(cfg.uatDir, linuxSafeFileName(`${token.appId}:${token.userOpenId}`));
	const buf = encryptData(JSON.stringify(token), key);
	await ensureUatDir(cfg.uatDir);
	await writeFile(path, buf, { mode: 0o600 });
}

/* ─────────────────── token 获取与刷新(参考 uat-client.ts) ─────────────────── */

const tokenPromises = new Map();

async function refreshToken(cfg, stored) {
	const res = await fetch(`${cfg.baseUrl}/open-apis/authen/v2/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		signal: AbortSignal.timeout(cfg.requestTimeoutMs),
		body: JSON.stringify({
			grant_type: 'refresh_token',
			refresh_token: stored.refreshToken,
			client_id: cfg.appId,
			client_secret: cfg.appSecret,
		}),
	});
	const data = await res.json();
	if (data.error || !data.access_token) {
		const err = new Error(`UAT refresh failed: ${data.error ?? data.code} ${data.error_description ?? ''}`);
		err.clearToken = true;
		throw err;
	}
	const now = Date.now();
	const updated = {
		...stored,
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? stored.refreshToken,
		expiresAt: now + (data.expires_in ?? 7200) * 1000,
		refreshExpiresAt: data.refresh_token_expires_in
			? now + data.refresh_token_expires_in * 1000
			: stored.refreshExpiresAt,
		scope: data.scope ?? stored.scope,
	};
	await saveStoredToken(cfg, updated);
	return updated;
}

/** 获取可用 access_token(带过期刷新与并发去重)。 */
async function getAccessToken(cfg) {
	const openId = cfg.userOpenId;
	const pending = tokenPromises.get(openId);
	if (pending) return pending;
	const promise = (async () => {
		const stored = await loadStoredToken(cfg, openId);
		if (!stored) {
			throw new Error('当前用户尚未完成飞书用户授权。可调用 feishu_oauth(action=authorize)发送一次授权卡片；若飞书提示账号未在应用所在企业/可用范围，直接展示该原因并停止，不要重复授权或借用其他用户令牌。');
		}
		const now = Date.now();
		if (stored.expiresAt > now + cfg.refreshAheadMs) {
			const granted = new Set(String(stored.scope ?? '').split(/\s+/));
			const missing = READ_MESSAGE_SCOPES.filter((scope) => !granted.has(scope));
			if (missing.length) throw new Error(`当前用户授权缺少群消息权限：${missing.join('、')}。请调用 feishu_oauth(action=authorize)发送增量授权卡片；不要根据空结果推断用户退群。`);
			return stored;
		}
		cfg.logger?.info?.('[feishu-group-reader] sender UAT expired, refreshing');
		return refreshToken(cfg, stored);
	})().finally(() => tokenPromises.delete(openId));
	tokenPromises.set(openId, promise);
	return promise;
}

/* ─────────────────── 飞书 API ─────────────────── */

/** 按文件魔数判断图片扩展名;魔数识别失败退回 content-type,再兜底 png。 */
function sniffImageExt(buf) {
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
	if (buf.length >= 6 && (buf.slice(0, 6).toString('ascii').match(/^GIF8[79]a/))) return 'gif';
	if (buf.length >= 12 && buf[8] === 0x77 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
	if (buf.length >= 4 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
	return 'png';
}

async function larkGet(cfg, path, query = {}) {
	let data;
	try {
		data = await larkGetOnce(cfg, path, query);
	} catch (e) {
		// 瞬时失败重试一次(UAT 双进程共享,偶发 refresh 竞态;401/网络抖动)
		if (e.code === undefined && !/401|timeout|fetch failed/i.test(String(e.message))) throw e;
		await new Promise((r) => setTimeout(r, 800));
		data = await larkGetOnce(cfg, path, query);
	}
	return data;
}

async function larkGetOnce(cfg, path, query = {}, requiredScope) {
	const token = await getAccessToken(cfg);
	if (requiredScope && !String(token.scope ?? '').split(/\s+/).includes(requiredScope)) throw new Error(`当前用户授权缺少 ${requiredScope}，请调用 feishu_oauth(action=authorize)发送增量授权卡片`);
	const qs = new URLSearchParams(
		Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')),
	).toString();
	const res = await fetch(`${cfg.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
		headers: { Authorization: `Bearer ${token.accessToken}` },
		signal: AbortSignal.timeout(cfg.requestTimeoutMs),
	});
	const data = await res.json();
	if (data.code !== 0) {
		const err = new Error(`飞书 API ${path} 失败: code=${data.code} msg=${data.msg}`);
		err.code = data.code;
		throw err;
	}
	return data.data;
}

/** 用户身份 POST 飞书 Open API(返回 data 字段)。 */
async function larkPost(cfg, path, { query = {}, body } = {}) {
	const token = await getAccessToken(cfg);
	const qs = new URLSearchParams(
		Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')),
	).toString();
	const res = await fetch(`${cfg.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
		signal: AbortSignal.timeout(cfg.requestTimeoutMs),
	});
	const data = await res.json();
	if (data.code !== 0) {
		const err = new Error(`飞书 API ${path} 失败: code=${data.code} msg=${data.msg}`);
		err.code = data.code;
		throw err;
	}
	return data.data;
}

/* ─────────────────── 消息格式化(参考 format-messages.ts 的卡片抽取) ─────────────────── */

/** 从 interactive 卡片 JSON 里抽取全部文本。 */
function extractCardText(content, depth = 0) {
	if (depth > 8 || content == null) return '';
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((c) => extractCardText(c, depth + 1)).filter(Boolean).join(' ');
	if (typeof content === 'object') {
		const parts = [];
		if (typeof content.text === 'string') parts.push(content.text);
		if (typeof content.title === 'string') parts.push(content.title);
		for (const key of ['elements', 'content', 'children']) {
			if (content[key] !== undefined) {
				const t = extractCardText(content[key], depth + 1);
				if (t) parts.push(t);
			}
		}
		return parts.join(' ');
	}
	return '';
}

function formatTime(tsMs, timeZone) {
	const d = new Date(Number(tsMs));
	if (Number.isNaN(d.getTime())) return String(tsMs);
	// 毫秒时间戳 → 指定时区的可读时间(不带秒)
	const parts = new Intl.DateTimeFormat('zh-CN', {
		timeZone,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false,
	}).formatToParts(d);
	const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 单条消息 → {time, sender, type, text, images[]} */
function formatMessage(item, timeZone) {
	let text = '';
	const mt = item.msg_type;
	if (mt === 'text') {
		try {
			const c = JSON.parse(item.body?.content ?? '{}');
			text = c.text ?? '';
		} catch {
			text = item.body?.content ?? '';
		}
	} else if (mt === 'interactive' || mt === 'share_chat' || mt === 'share_user') {
		try {
			const c = JSON.parse(item.body?.content ?? '{}');
			const t = extractCardText(c);
			text = t || `[${mt} 卡片]`;
			// 标出图片(无法读文本)
			if (JSON.stringify(c).includes('"img"') || JSON.stringify(c).includes('image_key')) {
				text += ' [含图片]';
			}
		} catch {
			text = `[${mt} 卡片,无法解析]`;
		}
	} else if (mt === 'image') {
		text = '[图片]';
	} else if (mt === 'post' || mt === 'rich_text') {
		try {
			const c = JSON.parse(item.body?.content ?? '{}');
			text = extractCardText(c);
		} catch {
			text = `[${mt}]`;
		}
	} else {
		text = `[${mt}]`;
	}
	const sender = item.sender?.id_type === 'app'
		? 'app'
		: (item.sender?.id_type === 'user' ? `user:${String(item.sender?.id ?? '').slice(-8)}` : item.sender?.id_type ?? 'unknown');
	const imageKeys = extractImageKeys(item.body);
	return {
		// 精简字段:大群全量拉取时元数据是体积大头,只留模型真正用的
		message_id: item.message_id,
		time: formatTime(item.create_time, timeZone),
		sender,
		text: String(text).slice(0, 800),
		...(imageKeys.length ? { images: imageKeys } : {}),
	};
}

/** 从消息体解析全部 image_key(卡片/post/image 均支持)。 */
function extractImageKeys(body) {
	if (!body?.content) return [];
	let c;
	try {
		c = JSON.parse(body.content);
	} catch {
		return [];
	}
	const keys = [];
	const walk = (o) => {
		if (o === null || typeof o !== 'object') return;
		if (Array.isArray(o)) { for (const v of o) walk(v); return; }
		for (const [k, v] of Object.entries(o)) {
			if (k === 'image_key' && typeof v === 'string' && v.startsWith('img_')) keys.push(v);
			else walk(v);
		}
	};
	walk(c);
	return [...new Set(keys)];
}

/* ─────────────────── 相对时间解析(参考 time-utils.ts,支持时区) ─────────────────── */

/** 取某时刻在指定时区的 Y/M/D/H/Min(公历字段)。 */
function zonedParts(date, timeZone) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false,
	}).formatToParts(date);
	const get = (t) => Number(parts.find((p) => p.type === t)?.value);
	return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** 指定时区的"墙上时钟"字段 → UTC 时间戳(毫秒)。用偏移逼近法,处理 DST 边缘。 */
function zonedTime(y, m, d, h, min, timeZone) {
	const naive = Date.UTC(y, m - 1, d, h, min);
	// 一次校正:先算 naive 被解释为 UTC 时,该时区的实际偏移,再平移
	const off1 = naive - zonedWallMs(new Date(naive), timeZone);
	const guess = naive + off1;
	const off2 = guess - zonedWallMs(new Date(guess), timeZone);
	return new Date(naive + off2).getTime();
}

/** 时刻 → 该时区墙上时钟对应的"伪 UTC 毫秒"(即把字段当 UTC 拼出来的值)。 */
function zonedWallMs(date, timeZone) {
	const p = zonedParts(date, timeZone);
	return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
}

function parseRelativeTime(expr, timeZone, now = new Date()) {
	const wallNow = zonedWallMs(now, timeZone);
	const dayStart = () => {
		const p = zonedParts(now, timeZone);
		return zonedTime(p.y, p.m, p.d, 0, 0, timeZone);
	};
	const dayOffset = (n) => {
		const p = zonedParts(new Date(wallNow - n * 86400000), timeZone);
		return zonedTime(p.y, p.m, p.d, 0, 0, timeZone);
	};
	const weekStart = () => {
		// 周一为一周开始(ISO)。取时区今天的正午(稳),减去 (周几-1) 天。
		const p = zonedParts(now, timeZone);
		const noon = zonedTime(p.y, p.m, p.d, 12, 0, timeZone);
		// 用时区字段算星期:2000-01-03 是周一,算距它的天数
		const epoch = Date.UTC(2000, 0, 3);
		const days = Math.floor((noon - epoch) / 86400000);
		const dow = ((days % 7) + 7) % 7; // 0=周一
		return noon - dow * 86400000 - 12 * 3600000; // 回到周一 00:00
	};
	switch (expr) {
		case 'today':
			return [dayStart(), now.getTime()];
		case 'yesterday':
			return [dayOffset(1), dayStart()];
		case 'day_before_yesterday':
			return [dayOffset(2), dayOffset(1)];
		case 'this_week':
			return [weekStart(), now.getTime()];
		case 'last_week': {
			const ws = weekStart();
			return [ws - 7 * 86400000, ws];
		}
		case 'this_month': {
			const p = zonedParts(now, timeZone);
			return [zonedTime(p.y, p.m, 1, 0, 0, timeZone), now.getTime()];
		}
		case 'last_month': {
			const p = zonedParts(now, timeZone);
			const lm = p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 };
			return [zonedTime(lm.y, lm.m, 1, 0, 0, timeZone), zonedTime(p.y, p.m, 1, 0, 0, timeZone)];
		}
	}
	const m = /^last_(\d+)_(minutes?|hours?|days?)$/.exec(expr);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2].replace(/s$/, '');
		return [now.getTime() - n * (unit === 'minute' ? 60000 : unit === 'hour' ? 3600000 : 86400000), now.getTime()];
	}
	throw new Error(`无法解析相对时间 "${expr}":支持 today/yesterday/day_before_yesterday/this_week/last_week/this_month/last_month/last_{N}_{minutes|hours|days}`);
}

function dateToSec(d) {
	return msToSec(d.getTime());
}

/** 毫秒时间戳 → 秒字符串(飞书 API 用秒)。 */
function msToSec(ms) {
	return String(Math.floor(ms / 1000));
}

/** "YYYY-MM-DD HH:mm"(指定时区墙上时钟)→ Date。 */
function parseZonedDateTime(s, timeZone) {
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s.trim());
	if (!m) throw new Error(`时间格式错误 "${s}":应为 "YYYY-MM-DD HH:mm"`);
	return new Date(zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), timeZone));
}

/* ─────────────────── 工具实现 ─────────────────── */

/** 列出用户所在的群(翻页拉全)。 */
async function listChats(cfg) {
	const chats = [];
	let pageToken;
	do {
		const data = await larkGet(cfg, '/open-apis/im/v1/chats', {
			user_id_type: 'open_id',
			page_size: 100,
			...(pageToken ? { page_token: pageToken } : {}),
		}, 'im:chat:read');
		chats.push(...(data.items ?? []));
		pageToken = data.page_token;
	} while (pageToken);
	return chats;
}

async function resolveChatId(cfg, args) {
	// 0. open_id → p2p 单聊解析(参考 openclaw resolveP2PChatId)
	if (args.open_id) {
		const data = await larkPost(cfg, '/open-apis/im/v1/chat_p2p/batch_query', {
			query: { user_id_type: 'open_id' },
			body: { chatter_ids: [args.open_id] },
		});
		const chats = data?.p2p_chats ?? [];
		if (chats.length === 0) {
			throw new Error(`open_id ${args.open_id} 没有对应的单聊会话(可能无聊天记录)。`);
		}
		return { chatId: chats[0].chat_id };
	}
	// 1. 显式 chat_id
	if (args.chat_id) return { chatId: args.chat_id, name: undefined };
	// 2. 群名模糊匹配
	if (args.chat_name) {
		const chats = await listChats(cfg);
		const q = args.chat_name.toLowerCase();
		const exact = chats.find((c) => c.name?.toLowerCase() === q);
		if (exact) return { chatId: exact.chat_id, name: exact.name };
		const fuzzy = chats.filter((c) => c.name?.toLowerCase().includes(q));
		if (fuzzy.length === 0) {
			throw new Error(`未找到名称包含 "${args.chat_name}" 的群。可用 feishu_group_chats 列出全部群。`);
		}
		if (fuzzy.length > 1) {
			return {
				ambiguous: fuzzy.slice(0, 10).map((c) => ({ chat_id: c.chat_id, name: c.name })),
				hint: `有 ${fuzzy.length} 个群名包含 "${args.chat_name}",请用 chat_id 精确指定`,
			};
		}
		return { chatId: fuzzy[0].chat_id, name: fuzzy[0].name };
	}
	// 3. 默认群
	if (cfg.defaultChatId) {
		if (cfg.defaultChatId.startsWith('oc_')) return { chatId: cfg.defaultChatId };
		const chats = await listChats(cfg);
		const hit = chats.find((c) => c.name?.includes(cfg.defaultChatId));
		if (hit) return { chatId: hit.chat_id, name: hit.name };
		throw new Error(`默认群 "${cfg.defaultChatId}" 未匹配到任何群。`);
	}
	throw new Error('请提供 chat_id 或 chat_name(或配置 defaultChatId)。');
}

async function fetchMessages(cfg, args) {
	const { chatId, name, ambiguous } = await resolveChatId(cfg, args);
	if (ambiguous) {
		return { ambiguous, hint: '多个群匹配,请用 chat_id 精确指定' };
	}

	// 时间范围
	let startSec;
	let endSec;
	if (args.relative_time) {
		const [s, e] = parseRelativeTime(args.relative_time, cfg.timeZone);
		startSec = msToSec(s);
		endSec = msToSec(e);
	} else {
		if (args.start_time) startSec = dateToSec(parseZonedDateTime(args.start_time, cfg.timeZone));
		if (args.end_time) endSec = dateToSec(parseZonedDateTime(args.end_time, cfg.timeZone));
	}

	// 拉取(自动翻页;上限 500:三五百条/天的群全量无压力,几千条超活群取最新 500)
	const max = Math.min(args.max_messages ?? 200, 500);
	const messages = [];
	let pageToken;
	let hasMore = false;
	do {
		const data = await larkGet(cfg, '/open-apis/im/v1/messages', {
			container_id_type: 'chat',
			container_id: chatId,
			sort_type: args.sort_rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
			page_size: Math.min(cfg.pageSize, 50),
			...(startSec ? { start_time: startSec } : {}),
			...(endSec ? { end_time: endSec } : {}),
			...(pageToken ? { page_token: pageToken } : {}),
		});
		messages.push(...(data.items ?? []));
		hasMore = Boolean(data.has_more);
		pageToken = data.page_token;
	} while (pageToken && messages.length < max);

	const trimmed = messages.slice(0, max);
	const formatted = trimmed.map((item) => formatMessage(item, cfg.timeZone));
	// asc 时反转成时间正序展示(接口 desc 默认最新在前,统一输出正序易读)
	if (args.sort_rule !== 'create_time_asc') formatted.reverse();

	let chatName = name;
	if (!chatName) {
		try {
			const info = await larkGet(cfg, `/open-apis/im/v1/chats/${chatId}`, { user_id_type: 'open_id' });
			chatName = info.name;
		} catch {
			/* 群信息失败不阻断消息读取 */
		}
	}
	// p2p 单聊接口可能无 name 字段;undefined 会破坏工具输出的无损 JSON 校验,兜底成字符串
	if (typeof chatName !== 'string') chatName = '';
	// undefined 字段会破坏工具输出的无损 JSON 校验,按需携带
	const range = { ...(startSec ? { start: startSec } : {}), ...(endSec ? { end: endSec } : {}), ...(args.relative_time ? { relative: args.relative_time } : {}) };
	return {
		chat: { chat_id: chatId, name: chatName },
		range,
		count: formatted.length,
		has_more: hasMore || messages.length > max,
		messages: formatted,
	};
}

/* ─────────────────── 插件入口 ─────────────────── */

const anyJsonOutput = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => [renderJson(value)],
};

function renderJson(value, budget = 20000) {
	const text = JSON.stringify(value, null, 1);
	return text.length > budget
		? { type: 'text', text: `${text.slice(0, budget)}\n…(已截断,共 ${text.length} 字符)` }
		: { type: 'text', text };
}

export function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config, logger: ctx.logger };
	// appSecretEnv:env 优先,退 $DSH_HOME/.credentials.yaml refs: 段直读(与 channel/media-tools 同款)
	if (!cfg.appSecret && cfg.appSecretEnv) {
		cfg.appSecret = process.env[cfg.appSecretEnv] ?? readCredentialRef(cfg.appSecretEnv) ?? '';
	}
	const bots = cfg.botsFile ? JSON.parse(fs.readFileSync(cfg.botsFile, 'utf8')) : [];
	const forExecution = (exec) => {
		// 身份读取双轨(基座化过渡):larkUser 直读优先,回退 identityOf 合成 agent.identity
		// (subjectId→openId、context.chatId/accountId 补全旧字段形态)。
		const larkUser = exec?.agent?.larkUser;
		const identity = identityOf(exec?.agent);
		const user = larkUser ?? (identity ? {
			openId: identity.subjectId,
			...(identity.context?.chatId !== undefined ? { chatId: identity.context.chatId } : {}),
			...(identity.context?.accountId !== undefined ? { accountId: identity.context.accountId } : {}),
			...(identity.context?.chatType !== undefined ? { chatType: identity.context.chatType } : {}),
			...(identity.appId !== undefined ? { appId: identity.appId } : {}),
		} : undefined);
		const bot = user?.accountId && user.accountId !== 'default' ? bots.find((entry) => entry.accountId === user.accountId) : undefined;
		if (user?.accountId && user.accountId !== 'default' && (!bot || bot.appId !== user.appId || !bot.appSecret)) throw new Error('当前飞书应用未配置独立消息读取凭据，已拒绝回退默认应用');
		return { ...cfg, ...(bot ? { appId: bot.appId, appSecret: bot.appSecret } : {}), userOpenId: user?.openId, currentChatId: user?.chatId, currentChatType: user?.chatType };
	};
	if (!cfg.appId || !cfg.appSecret) {
		ctx.logger.warn('[feishu-group-reader] 缺少 appId/appSecret 配置,工具不可用');
		return;
	}

	ctx.tools.register({
		name: 'feishu_group_chats',
		description:
			'列出当前可信飞书用户实际可见的群聊(chat_id + 群名)。按发言人独立 OAuth，不使用其他用户令牌。0 个结果只表示接口可见列表为空，不能据此推断退群或授权不足；未授权会明确报错并指引 feishu_oauth(action=authorize)。',
		parameters: {
			type: 'object',
			properties: {
				keyword: { type: 'string', description: '可选,按群名过滤(包含匹配)' },
			},
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const scoped = forExecution(exec);
			let chats = await listChats(scoped);
			if (scoped.restrictGroupChats) chats = chats.filter((chat) => chat.chat_mode === 'group');
			if (args?.keyword) {
				const k = args.keyword.toLowerCase();
				chats = chats.filter((c) => c.name?.toLowerCase().includes(k));
			}
			// 所有字段都必须是 lossless JSON 安全值:undefined 会让工具输出
			// 校验直接报 "value is not lossless JSON"(2026-10-27 两次踩坑)
			return {
				count: chats.length,
				chats: chats.map((c) => ({
					chat_id: c.chat_id,
					name: c.name ?? null,
					owner_id: typeof c.owner_id === 'string' ? c.owner_id.slice(-8) : null,
					member_count: typeof c.member_count === 'number' ? c.member_count : null,
				})),
			};
		},
	});

	ctx.tools.register({
		name: 'feishu_group_messages',
		description:
			'【优先用本工具读飞书消息】按当前发言人独立 OAuth 读取飞书聊天消息。支持 chat_id / 群名模糊 / open_id(单聊)三种定位。显式指定目标后绝不能改读当前私聊；私聊中未指定目标必须先用 feishu_group_chats 定位群。0 条只表示该时间范围无可见消息，禁止据此猜测退群/权限不足。缺少授权时调用 feishu_oauth(action=authorize)向当前用户发送授权卡片，绝不借用其他用户令牌。',
		parameters: {
			type: 'object',
			properties: {
				chat_id: { type: 'string', description: '会话 ID(oc_ 开头,群聊或单聊)。与 chat_name/open_id 三选一;缺省用默认群' },
				chat_name: { type: 'string', description: '群名(模糊匹配)。与 chat_id/open_id 互斥' },
				open_id: { type: 'string', description: '用户 open_id(ou_ 开头),读取与该用户的单聊消息。与 chat_id/chat_name 互斥' },
				relative_time: {
					type: 'string',
					description: '相对时间:today/yesterday/this_week/last_week/this_month/last_month/last_{N}_{minutes|hours|days}。与 start_time/end_time 互斥',
				},
				start_time: { type: 'string', description: '起始时间 "YYYY-MM-DD HH:mm"(本地时区)。与 relative_time 互斥' },
				end_time: { type: 'string', description: '结束时间 "YYYY-MM-DD HH:mm"。与 relative_time 互斥' },
				sort_rule: { type: 'string', description: 'create_time_asc(输出时间正序,默认)或 create_time_desc(最新在前)' },
				max_messages: { type: 'integer', description: '最多返回条数(默认 200,上限 500)。超活群取最新 N 条' },
			},
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const scoped = forExecution(exec);
			// Only an omitted target means "this group". An explicit chat_name/chat_id
			// must never be silently replaced by a private-chat ID.
			if (scoped.restrictCurrentChat && !args?.chat_id && !args?.chat_name && !args?.open_id) {
				if (scoped.currentChatType !== 'group') throw new Error('当前是私聊。请提供目标 chat_name，或先用 feishu_group_chats 查找群；未指定目标时不默认读取其他群。');
				return fetchMessages(scoped, { ...(args ?? {}), chat_id: scoped.currentChatId });
			}
			return fetchMessages(scoped, args ?? {});
		},
	});

	ctx.tools.register({
		name: 'feishu_group_image',
		description:
			'下载飞书聊天消息里的图片到工作区(用户身份,群聊/单聊通用)。先用 feishu_group_messages 找到含 images 字段的消息,取其 message_id 和 image_key(或 index)。图片内容识别请派子代理(cpa/deepseek-v4-flash,read_image)。',
		parameters: {
			type: 'object',
			properties: {
				message_id: { type: 'string', description: '消息 ID(om_ 开头),来自 feishu_group_messages 的 message_id' },
				image_key: { type: 'string', description: 'image_key(img_ 开头)。缺省时下载该消息第一张图' },
				index: { type: 'integer', description: '消息内第几张图(0 起,默认 0)。image_key 优先' },
				save_path: { type: 'string', description: '保存路径(绝对路径,或相对当前会话工作目录的相对路径)。缺省 存到 <会话工作目录>/feishu_images/<时间>_<消息ID>_<n>.<真实格式扩展名>' },
			},
			required: ['message_id'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const mid = args?.message_id;
			if (!mid) throw new Error('message_id 必填');
			// 相对路径相对"调用方会话的工作目录"解析。
			// 不能用 process.cwd():web 进程 cwd 是只读的 /workspace,
			// 相对路径会解析过去导致 EROFS/ENOENT(2026-10-27 实际踩坑)。
			// workingDirectory 服务用运行时可选查找:缺该服务的 profile 里插件也能加载。
			let baseDir;
			try {
				baseDir = ctx.get('workingDirectory')?.get(exec?.agent?.session);
			} catch { /* 保持 undefined 走兜底 */ }
			if (typeof baseDir !== 'string' || !baseDir) {
				try {
					const { homedir } = await import('node:os');
					baseDir = homedir();
				} catch { baseDir = '.'; }
			}
			const { isAbsolute, resolve: presolve } = await import('node:path');
			const resolveSavePath = (p) => (isAbsolute(p) ? p : presolve(baseDir, p));
			// 取消息拿 image_key 列表
			const data = await larkGet(cfg, `/open-apis/im/v1/messages/${mid}`, { user_id_type: 'open_id' });
			const item = data.items?.[0];
			if (!item) throw new Error(`消息 ${mid} 不存在或不可见`);
			if (cfg.restrictCurrentChat && item.chat_id !== forExecution(exec).currentChatId) {
				throw new Error('只能读取当前对话中的图片');
			}
			let keys = extractImageKeys(item.body);
			if (args?.image_key) {
				if (!keys.includes(args.image_key)) throw new Error(`image_key ${args.image_key} 不在该消息中(可用: ${keys.join(', ') || '无'})`);
				keys = [args.image_key];
			} else {
				const idx = args?.index ?? 0;
				if (idx >= keys.length) throw new Error(`该消息只有 ${keys.length} 张图,索引 ${idx} 越界`);
				keys = [keys[idx]];
			}
			// 下载(结果带消息时间戳,识别/复盘时知道图是什么时候发的)
			const msgTime = formatTime(item.create_time, cfg.timeZone);
			const results = [];
			for (let i = 0; i < keys.length; i++) {
				const res = await fetch(
					`${cfg.baseUrl}/open-apis/im/v1/messages/${mid}/resources/${keys[i]}?type=image`,
					{
						headers: { Authorization: `Bearer ${(await getAccessToken(cfg)).accessToken}` },
						signal: AbortSignal.timeout(cfg.requestTimeoutMs * 3),
					},
				);
				if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
				const buf = Buffer.from(await res.arrayBuffer());
				const ctype = res.headers.get('content-type') ?? '';
				// 按文件魔数定扩展名(飞书 resources 接口的 content-type 不可靠,
				// 实测 JPEG 常被标成 image/png,错误扩展名会让 read_image 等失败)
				const ext = sniffImageExt(buf);
				const { mkdir, writeFile: wf } = await import('node:fs/promises');
				const { dirname } = await import('node:path');
				// 文件名含消息时间(1027_1642 = 10月27日 16:42),图片离线看也知道何时发的
				const p = zonedParts(new Date(Number(item.create_time)), cfg.timeZone);
				const timeTag = `${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}_${String(p.h).padStart(2, '0')}${String(p.min).padStart(2, '0')}`;
				let outPath = args?.save_path
					? resolveSavePath(args.save_path)
					: presolve(baseDir, 'feishu_images', `${timeTag}_${mid}_${args?.image_key ? i : (args?.index ?? 0)}.${ext}`);
				// save_path 未带扩展名时补上;带的扩展名与魔数嗅出的真实格式不符时纠正
				// (飞书 resources 接口 content-type 不可靠,save_path 写 .png 而字节是
				// JPEG 时,read_image 会拒读 —— 2026-10-27 的 5.png 踩坑,当时只能手工
				// 复制成 .jpg 才读出来)
				const extMatch = outPath.match(/\.(png|jpe?g|gif|webp|bmp)$/i);
				if (!extMatch) outPath += `.${ext}`;
				else {
					const given = extMatch[1].toLowerCase();
					const norm = (x) => (x === 'jpeg' ? 'jpg' : x);
					if (norm(given) !== norm(ext)) outPath = outPath.slice(0, outPath.length - extMatch[1].length) + ext;
				}
				await mkdir(dirname(outPath), { recursive: true });
				await wf(outPath, buf);
				results.push({ image_key: keys[i], path: outPath, bytes: buf.byteLength, format: ext, time: msgTime });
			}
			return { message_id: mid, count: results.length, images: results };
		},
	});

	ctx.logger.info('[feishu-group-reader] active: feishu_group_messages / feishu_group_chats / feishu_group_image registered');
	return () => {};
}

export { name, inject };
