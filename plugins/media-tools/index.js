/**
 * @dsh-friends/media-tools — 媒体工具
 *
 * 2026-10-29 自 OpenClaw(/opt/1panel/apps/openclaw)移植:
 *   image_generate    — 腾讯混元文生图(via CPA /v1/images/generations)
 *   image_edit        — 腾讯混元图生图/编辑(via CPA /v1/images/edits,1-3 参考图)
 *
 * 生成图片落盘 cfg.imageDir(默认 /data/dsh/tmp/media-images),1 小时 TTL 自动清理;
 * 返回本地路径,会话可用 read_image 查看。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';

const name = 'media-tools';
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	baseUrl: 'http://127.0.0.1:8317/v1',
	apiKey: '',
	apiKeyRef: 'CPA_API_KEY',
	apiKeyEnv: 'CPA_API_KEY',
	imageDir: '/data/dsh/tmp/media-images',
	allowedPathPrefixes: ['/tmp/', '/data/dsh/', '/home/'],
	requestTimeoutMs: 180_000,
};

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

/* ── 通用 HTTP ───────────────────────────── */

const NETWORK_RETRY_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'];

function isRetryableError(err) {
	if (err?.name === 'AbortError') return true;
	if (err?.code && NETWORK_RETRY_CODES.includes(err.code)) return true;
	if (err?.cause) return isRetryableError(err.cause);
	return false;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...opts, signal: controller.signal });
	} catch (err) {
		if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchWithRetry(url, opts, timeoutMs) {
	let lastErr;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await fetchWithTimeout(url, opts, timeoutMs);
		} catch (err) {
			lastErr = err;
			if (attempt === 0 && isRetryableError(err)) continue;
			throw err;
		}
	}
	throw lastErr;
}

/* ── SSRF 防护(自 OpenClaw 移植) ─────────────── */

// API base 允许:回环 + 桥网 + 公网域名;拦截私网段(防内网探测)。
const ALLOWED_BASE_URL_HOSTS = ['172.18.0.1', 'localhost', '127.0.0.1', '::1'];

function isAllowedBaseUrl(url) {
	if (!url) return true;
	try {
		const u = new URL(url);
		if (!['http:', 'https:'].includes(u.protocol)) return false;
		const hostname = u.hostname.toLowerCase();
		if (ALLOWED_BASE_URL_HOSTS.includes(hostname)) return true;
		if (/^(127\.|0{1,3}\.0{1,3}\.0{1,3}|169\.254\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) return false;
		if (/^0{1,4}:(:0{1,4}){0,4}:?7f00:1$/i.test(hostname)) return false;
		if (hostname.startsWith('fe80')) return false;
		// 数字/十六进制 IP 编码绕过拦截
		if (/^[0-9]+$|^0x[0-9a-f]+$/i.test(hostname)) return false;
		const ipEncoded = /\b(127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
		if (ipEncoded.test(hostname)) return false;
		return true;
	} catch {
		return false;
	}
}

// 编辑参考图远程 URL:仅公网 https。
function isAllowedImageUrl(url) {
	try {
		const u = new URL(url);
		const hostname = u.hostname.toLowerCase();
		if (u.protocol !== 'https:' || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
		if (hostname.includes(':')) return false;
		return !/^(127\.|0{1,3}\.0{1,3}\.0{1,3}|169\.254\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname);
	} catch {
		return false;
	}
}

/* ── 图片尺寸/探测(自 OpenClaw 移植) ──────────── */

const SIZE_MAP = {
	'1:1': '2048x2048',
	'16:9': '2752x1536',
	'9:16': '1536x2752',
	'4:3': '2368x1760',
	'3:4': '1760x2368',
	'3:2': '2496x1664',
	'2:3': '1664x2496',
	'4:5': '1824x2272',
	'5:4': '2272x1824',
	'21:9': '3072x1376',
	'9:21': '1344x3136',
};
const VALID_ASPECT_RATIOS = Object.keys(SIZE_MAP);
const VALID_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'];
const EDIT_MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/* 本地参考图解析:前缀白名单 + 魔数探测。
 * 2026-10-30 修复:原实现调用未定义的 readImageWithMagic 导致 image_edit 本地路径必报
 * "readImageWithMagic is not defined"(line 352 唯一引用处);内联重写,行为对齐。 */
async function readImageWithMagic(value, allowedPathPrefixes) {
	const raw = String(value ?? '').trim();
	if (!raw) throw new Error('empty path');
	const resolved = raw.startsWith('~/') ? path.join(homedir(), raw.slice(2)) : path.resolve(raw);
	const posix = resolved.replace(/\\/g, '/');
	const allowed = (allowedPathPrefixes || []).some((prefix) => {
		const p = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
		return posix === p || posix.startsWith(`${p}/`);
	});
	if (!allowed) throw new Error(`path not allowed: ${raw}`);
	const stat = await fs.promises.stat(resolved);
	if (!stat.isFile()) throw new Error(`not a file: ${raw}`);
	const buf = Buffer.alloc(32);
	const fh = await fs.promises.open(resolved, 'r');
	try { await fh.read(buf, 0, 32, 0); } finally { await fh.close(); }
	const magic = probeImage(buf);
	if (!magic) throw new Error(`not a PNG/JPEG/WebP image: ${raw}`);
	return { resolved, info: { ...magic, size: stat.size } };
}

const GEN_SMALL_TIMEOUT_MS = 30_000;
const GEN_LARGE_TIMEOUT_MS = 60_000;
const GEN_SMALL_MAX_DIM = 2048;
const EDIT_TIMEOUT_MS = 60_000;
const MAX_EDIT_IMAGES = 5;
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_EDIT_DIM = 256;
const MAX_EDIT_DIM = 4096;
const MAX_EDIT_ASPECT = 2;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const IMAGE_TTL_MS = 60 * 60 * 1000;

// 纯 JS 文件头探测 PNG/JPEG/WebP(无外部依赖)。
function probeImage(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
	if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		let off = 2;
		while (off + 9 < buf.length) {
			if (buf[off] !== 0xff) { off++; continue; }
			const marker = buf[off + 1];
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
			if (off + 4 > buf.length) return null;
			const segLen = buf.readUInt16BE(off + 2);
			if (segLen < 2 || off + 2 + segLen > buf.length) return null;
			const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isSof) return { format: 'jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
			off += 2 + segLen;
		}
		return null;
	}
	if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
		const chunk = buf.toString('ascii', 12, 16);
		if (chunk === 'VP8X') return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
		if (chunk === 'VP8 ') return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
		if (chunk === 'VP8L') {
			const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
			return {
				format: 'webp',
				width: 1 + (((b1 & 0x3f) << 8) | b0),
				height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
			};
		}
		return null;
	}
	return null;
}

function validateEditImageBuffer(buf, label) {
	const info = probeImage(buf);
	if (!info) return { error: `${label}: 不支持或不可读的图片数据(仅 PNG/JPEG/WebP)` };
	if (buf.length > MAX_EDIT_IMAGE_BYTES) return { error: `${label}: ${(buf.length / 1048576).toFixed(1)}MB 超过 10MB 限制` };
	const { width, height } = info;
	if (!width || !height || width < MIN_EDIT_DIM || height < MIN_EDIT_DIM || width > MAX_EDIT_DIM || height > MAX_EDIT_DIM) {
		return { error: `${label}: ${width}x${height}px 超出允许范围 [256,4096]px` };
	}
	const ratio = width >= height ? width / height : height / width;
	if (ratio > MAX_EDIT_ASPECT) return { error: `${label}: 宽高比 ${width}:${height} 超过 2:1` };
	return { info };
}

function extForFormat(fmt) {
	return fmt === 'jpeg' ? 'jpg' : fmt;
}

function genTimeoutForSize(sizeStr) {
	const m = /^(\d+)x(\d+)$/.exec(sizeStr || '');
	if (!m) return GEN_SMALL_TIMEOUT_MS;
	return Math.max(Number(m[1]), Number(m[2])) > GEN_SMALL_MAX_DIM ? GEN_LARGE_TIMEOUT_MS : GEN_SMALL_TIMEOUT_MS;
}

function normalizeGenSize(size) {
	const s = (size || '').trim();
	if (s === 'auto') return { size: s };
	if (!/^\d+x\d+$/.test(s)) return { error: `无效 size "${size}"。用 "auto" 或 WIDTHxHEIGHT(32 的倍数,512-4096)` };
	return { size: s };
}

/* ── 图片落盘与清理 ───────────────────── */

async function cleanupExpiredImages(dir, log) {
	try {
		const now = Date.now();
		for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const fp = path.join(dir, entry.name);
			try {
				const stat = await fs.promises.stat(fp);
				if (now - stat.mtimeMs > IMAGE_TTL_MS) await fs.promises.unlink(fp);
			} catch { /* 单文件失败忽略 */ }
		}
	} catch { /* 目录不存在等忽略 */ }
}

async function downloadImage(url) {
	if (!isAllowedImageUrl(url)) throw new Error('图片 API 返回了非法图片 URL');
	let nextUrl = url;
	for (let redirects = 0; redirects < 4; redirects++) {
		const resp = await fetchWithRetry(nextUrl, { headers: { Accept: 'image/*' }, redirect: 'manual' }, GEN_LARGE_TIMEOUT_MS);
		if (resp.status >= 300 && resp.status < 400) {
			const location = resp.headers.get('location');
			if (!location) throw new Error('图片下载重定向缺少 location');
			nextUrl = new URL(location, nextUrl).toString();
			if (!isAllowedImageUrl(nextUrl)) throw new Error('图片下载重定向目标非法');
			continue;
		}
		if (!resp.ok) throw new Error(`图片下载失败: HTTP ${resp.status}`);
		const contentLength = Number(resp.headers.get('content-length'));
		if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节`);
		const buffer = Buffer.from(await resp.arrayBuffer());
		if (!buffer.length) throw new Error('图片下载无数据');
		if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节`);
		return buffer;
	}
	throw new Error('图片下载重定向次数超限');
}

async function extractAndSaveImage(data, outputFormat, imageDir, log, prefix) {
	const images = data?.data || [];
	if (!images.length) return { error: '未生成图片' };
	const b64 = images[0].b64_json;
	const imageUrl = images[0].url;
	const imgBuffer =
		typeof b64 === 'string' && b64.trim()
			? Buffer.from(b64, 'base64')
			: typeof imageUrl === 'string' && imageUrl.trim()
				? await downloadImage(imageUrl)
				: null;
	if (!imgBuffer?.length) return { error: '生成 API 未返回 URL 或 base64 数据' };
	const savePath = path.join(imageDir, `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${extForFormat(outputFormat)}`);
	await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
	await fs.promises.writeFile(savePath, imgBuffer);
	cleanupExpiredImages(imageDir, log).catch(() => {});
	return { savePath, bytes: imgBuffer.length };
}

/* ── 凭据文件兜底(credentials 服务未挂载的 profile 用) ── */

async function readCredentialRef(refName) {
	try {
		const base = process.env.DSH_HOME ?? join(homedir(), '.dsh');
		const text = await fs.promises.readFile(join(base, '.credentials.yaml'), 'utf8');
		const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const lineRe = new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`);
		let inRefs = false;
		for (const line of text.split(/\r?\n/)) {
			if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
			if (!inRefs) continue;
			if (/^\S/.test(line)) break;
			const match = line.match(lineRe);
			if (match === null) continue;
			let value = match[1];
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			return value.length > 0 ? value : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/* ── 插件入口 ─────────────────────── */

export function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	const log = ctx.logger;

	/**
	 * 凭据解析(仿 browser-tools):credentials 服务优先;
	 * 未挂载的 profile(如 headless)直接读 $DSH_HOME/.credentials.yaml 的 refs 段;
	 * 最后 env 兜底(apiKeyEnv)。
	 */
	async function resolveApiKey() {
		if (cfg.apiKey) return cfg.apiKey;
		if (cfg.apiKeyRef) {
			const stored = await ctx.get('credentials')?.resolve(cfg.apiKeyRef);
			if (stored?.value) return stored.value;
			const fromFile = await readCredentialRef(cfg.apiKeyRef);
			if (fromFile) return fromFile;
		}
		if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv];
		return '';
	}

	/* ── 腾讯混元生图（原生移植 codebuddy-media-mcp，不再经过 MCP）── */

	const HUNYUAN_SIZES = ['1024x1024', '1024x1536', '1536x1024'];
	async function callHunyuan(pathName, args, editing) {
		if (!args.prompt?.trim()) return { error: 'prompt 必填' };
		const size = args.size || '1024x1024';
		if (!HUNYUAN_SIZES.includes(size)) return { error: `size 只支持 ${HUNYUAN_SIZES.join(' / ')}` };
		const n = Number(args.n ?? 1);
		if (!Number.isInteger(n) || n < 1 || n > 4) return { error: 'n 必须为 1-4 的整数' };
		const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
		if (!isAllowedBaseUrl(baseUrl)) return { error: 'baseUrl 非法(内网地址被拦截)' };
		const apiKey = await resolveApiKey();
		if (!apiKey) return { error: 'API key 未配置(apiKeyRef/apiKey)' };
		const payload = {
			model: args.model?.trim() || (editing ? 'hunyuan-image-alpha-edit' : 'hunyuan-image-alpha'),
			prompt: args.prompt.trim(), size, n,
		};
		if (editing) {
			if (!Array.isArray(args.images) || args.images.length < 1 || args.images.length > 3) return { error: 'images 必须为 1-3 张参考图' };
			const images = [];
			for (const [index, raw] of args.images.entries()) {
				const value = String(raw ?? '').trim();
				if (/^https?:\/\//i.test(value) || value.startsWith('data:image/')) {
					images.push(value);
					continue;
				}
				try {
					const { resolved, info } = await readImageWithMagic(value, cfg.allowedPathPrefixes);
					if (info.size > 10 * 1024 * 1024) return { error: `images[${index}] 超过 10MB` };
					images.push(`data:${EDIT_MIME_BY_FORMAT[info.format]};base64,${(await fs.readFile(resolved)).toString('base64')}`);
				} catch (error) {
					return { error: `images[${index}]: ${error.message}` };
				}
			}
			payload.image = images;
		}
		try {
			const resp = await fetchWithRetry(`${baseUrl}${pathName}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(payload),
			}, cfg.requestTimeoutMs);
			if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}` };
			const data = await resp.json();
			if (!Array.isArray(data?.data) || data.data.length === 0) return { error: '上游返回成功但没有图片数据' };
			const savedImages = [];
			for (const item of data.data) {
				const saved = await extractAndSaveImage({ data: [item] }, 'png', cfg.imageDir, log, editing ? 'hunyuan-edit' : 'hunyuan-t2i');
				if (saved.error) return { error: saved.error };
				savedImages.push({ image_path: saved.savePath, bytes: saved.bytes });
			}
			return { status: 'ok', model: payload.model, count: savedImages.length, images: savedImages, image_path: savedImages[0].image_path };
		} catch (error) {
			return { error: String(error?.message ?? error) };
		}
	}

	// 失败可见性:错误对象不 throw,统一在此记日志(2026-10-30)
	const callHunyuanLogged = async (pathName, args, editing) => {
		const result = await callHunyuan(pathName, args, editing);
		if (result?.error) ctx.logger?.warn?.(`hunyuan ${pathName} failed: ${String(result.error).slice(0, 200)} (prompt=${String(args?.prompt ?? '').slice(0, 60)})`);
		return result;
	};

	ctx.tools.register({
		name: 'image_generate',
		description: '腾讯混元文生图（原生 DSH 工具，经 CPA）。返回 1-4 张本地图片，可用 feishu_send_image 发送 image_path。',
		parameters: {
			type: 'object', properties: {
				prompt: { type: 'string', description: '图像描述' },
				size: { type: 'string', enum: HUNYUAN_SIZES, description: '输出尺寸，默认 1024x1024' },
				n: { type: 'integer', description: '生成数量 1-4，默认 1' },
				model: { type: 'string', description: '可选模型，默认 gpt-image-2.5' },
			}, required: ['prompt'],
		},
		output: anyJsonOutput,
		execute: (args) => callHunyuanLogged('/images/generations', args, false),
	});

	ctx.tools.register({
		name: 'image_edit',
		description: '腾讯混元图生图/图片编辑（原生 DSH 工具，经 CPA）。1-3 张本地图片、https URL 或 data URL，返回 1-4 张本地图片。',
		parameters: {
			type: 'object', properties: {
				prompt: { type: 'string', description: '编辑指令' },
				images: { type: 'array', items: { type: 'string' }, description: '1-3 张参考图' },
				size: { type: 'string', enum: HUNYUAN_SIZES, description: '输出尺寸，默认 1024x1024' },
				n: { type: 'integer', description: '生成数量 1-4，默认 1' },
				model: { type: 'string', description: '可选模型，默认 gpt-image-2.5-edit' },
			}, required: ['prompt', 'images'],
		},
		output: anyJsonOutput,
		execute: (args) => callHunyuanLogged('/images/edits', args, true),
	});

	log.info(`[media-tools] active: image_generate / image_edit（混元） -> ${cfg.baseUrl}`);
	return () => {};
}

export { name, inject };
