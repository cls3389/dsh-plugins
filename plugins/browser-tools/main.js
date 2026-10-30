/**
 * @local/browser-tools — 共享浏览器(docker browser-gateway)DSH 工具
 *
 * 安全与生命周期:
 *   - 网关调用使用配置中的 Bearer token;密钥不进入工具参数。
 *   - allowPrivateNetworks=true 时允许内网;false 只做字面地址初筛,
 *     不声称是完整的 DNS/redirect SSRF 边界。
 *   - 截图只写入会话工作区,默认不覆盖文件,并遵守会话 sandbox mode。
 *   - 同 profile 的长期页面共享 Cookie/localStorage;关闭最后页面会保存登录态。
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const name = 'browser-tools';
const inject = ['tools', 'workingDirectory', 'sandboxPolicy'];

/**
 * credentials store 文件兜底读取。
 *
 * 本 profile 下 `ctx.get('credentials')` 为 undefined(服务未挂载),原逻辑
 * 于是拿到 undefined token,请求带 `Bearer undefined` → 网关 401,所有
 * browser_* 工具失效。这里直接读 $DSH_HOME/.credentials.yaml 的 refs 段。
 * 最小解析:逐行扫 refs: 段,取 `<ref>: <value>` 裸标量;任何异常返回 undefined。
 */
async function readCredentialRef(refName) {
	try {
		const base = process.env.DSH_HOME ?? join(homedir(), '.dsh');
		// 覆盖文件优先:凭据库里的 BROWSER_GATEWAY_TOKEN 实测为过期旧值
		// (43 字符, 网关 /profiles 回 401),而容器内真实值 48 字符可通。
		// 允许 `.secrets/browser_gateway_token` 放覆盖值,这样修一个
		// token 不必改动全局凭据库。候选:$DSH_BROWSER_TOKEN_FILE 环境变量
		// 或 $DSH_HOME/.secrets/browser_gateway_token(可移植,不绑定机器)。
		const overrideFiles = [
			process.env.DSH_BROWSER_TOKEN_FILE,
			join(base, '.secrets', 'browser_gateway_token'),
		].filter((p) => typeof p === 'string' && p.length > 0);
		for (const overrideFile of overrideFiles) {
			try {
				const override = (await readFile(overrideFile, 'utf8')).trim();
				if (override.length > 0) return override;
			} catch { /* 该覆盖文件不存在:试下一个 */ }
		}
		const text = await readFile(join(base, '.credentials.yaml'), 'utf8');
		const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const lineRe = new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`);
		let inRefs = false;
		for (const line of text.split(/\r?\n/)) {
			if (/^refs:\s*$/.test(line)) {
				inRefs = true;
				continue;
			}
			if (!inRefs) continue;
			if (/^\S/.test(line)) break; // 下一个顶层键,refs 段结束
			const match = line.match(lineRe);
			if (match === null) continue;
			let value = match[1];
			if (
				(value.startsWith('"') && value.endsWith('"'))
				|| (value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			return value.length > 0 ? value : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

const CONFIG_DEFAULTS = {
	baseUrl: 'http://127.0.0.1:18090',
	apiToken: '',
	apiTokenRef: 'BROWSER_GATEWAY_TOKEN',
	// 网关排队 30s + 任务 120s + HTTP 开销。
	requestTimeoutMs: 190000,
	allowPrivateNetworks: false,
	maxResponseBytes: 10 * 1024 * 1024,
	maxScreenshotBytes: 20 * 1024 * 1024,
};

/* ─────────────────────────── 传输层 ─────────────────────────── */

/** 字面地址初筛。不是 DNS/redirect 防护。 */
function isPrivateUrl(raw) {
	let u;
	try { u = new URL(raw); } catch { return true; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
	const host = u.hostname.toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host === '0.0.0.0' || host === '[::1]' || host === '::1') return true;
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		if (a === 10 || a === 127 || (a === 192 && b === 168)) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 169 && b === 254) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
	}
	return /^(browser-gateway|host\.docker\.internal)$/.test(host);
}

function guardUrl(cfg, url) {
	if (typeof url !== 'string' || !url.trim()) throw new Error('url 不能为空');
	if (!cfg.allowPrivateNetworks && isPrivateUrl(url)) {
		throw new Error(`拒绝字面上的内网/回环地址: ${url}(当前配置不解析 DNS/重定向)`);
	}
	return url;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new Error('操作已取消');
}

/** 有界读取响应,防止完整大对象先进入内存。 */
async function readBoundedBody(response, maxBytes) {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`browser-gateway 响应 ${declared} 字节,超过上限 ${maxBytes}`);
	}
	if (!response.body) {
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > maxBytes) throw new Error(`browser-gateway 响应超过上限 ${maxBytes} 字节`);
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel('response exceeds configured limit').catch(() => {});
				throw new Error(`browser-gateway 响应超过上限 ${maxBytes} 字节`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

/** 统一请求:超时与调用方取消合并;响应有硬字节上限。 */
async function call(ctx, cfg, path, {
	method = 'GET', body, raw = false, signal, maxBytes,
} = {}) {
	let apiToken = cfg.apiToken;
	if (!apiToken && cfg.apiTokenRef) {
		const stored = await ctx.get('credentials')?.resolve(cfg.apiTokenRef);
		apiToken = stored?.value;
		// 兜底:credentials 服务未挂载或解析为空时,直接读 credentials store 文件。
		// 与 web-providers 同一处修复:否则请求带 `Bearer undefined`,网关回 401。
		if (!apiToken) apiToken = await readCredentialRef(cfg.apiTokenRef);
	}
	if (!apiToken) throw new Error(`browser-tools: apiToken 未配置${cfg.apiTokenRef ? ` (引用: ${cfg.apiTokenRef})` : ''}`);
	throwIfAborted(signal);
	const url = `${cfg.baseUrl}${path}`;
	const timeout = AbortSignal.timeout(cfg.requestTimeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const limit = maxBytes ?? (raw ? cfg.maxScreenshotBytes : cfg.maxResponseBytes);
	try {
		const res = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: combined,
		});
		const bytes = await readBoundedBody(res, limit);
		throwIfAborted(signal);
		if (!res.ok) {
			let detail = bytes.toString('utf8').slice(0, 1000);
			try {
				const json = JSON.parse(bytes.toString('utf8'));
				detail = json?.detail ?? json?.error ?? json?.message ?? detail;
			} catch { /* 保留原文 */ }
			throw new Error(`browser-gateway HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
		}
		if (raw) {
			return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
		}
		// 保留 null、字符串、数字、数组等任意合法 JSON 值。
		return JSON.parse(bytes.toString('utf8'));
	} catch (error) {
		if (combined.aborted) {
			const reason = signal?.aborted ? signal.reason : new Error(`请求超时(${cfg.requestTimeoutMs}ms): ${url}`);
			throw reason ?? error;
		}
		throw error;
	}
}

/* ─────────────────────────── 输出与工作区 ─────────────────────────── */

function renderValue(value, budget = 12000) {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
	if (text === undefined) return String(value);
	return text.length > budget ? `${text.slice(0, budget)}\n…(已截断,共 ${text.length} 字符)` : text;
}

const anyJsonOutput = {
	// dsh 0.2.x 的 schema 校验要求 additionalProperties 必须同时给出 type 或 oneOf,
	// 否则 JsonSchemaError: "schema.additionalProperties requires type or oneOf"。
	// 这里用 oneOf 覆盖任意 JSON 值(标量/数组/对象/null),保持「不限定返回形状」的原意。
	schema: {
		oneOf: [
			{ type: 'object', additionalProperties: true },
			{ type: 'array' },
			{ type: 'string' },
			{ type: 'number' },
			{ type: 'boolean' },
			{ type: 'null' },
		],
	},
	render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
};

const screenshotOutput = {
	schema: {
		type: 'object',
		required: ['path', 'contentType', 'bytes'],
		properties: {
			path: { type: 'string' },
			contentType: { type: 'string' },
			bytes: { type: 'integer' },
		},
		additionalProperties: false,
	},
	render: (_args, value) => [{
		type: 'text',
		text: `截图已保存: ${value.path} (${value.contentType}, ${value.bytes} 字节)`,
	}],
};

function isInside(root, target) {
	const rel = relative(root, target);
	return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function nearestExisting(path) {
	let current = path;
	for (;;) {
		try {
			await stat(current);
			return current;
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

/** 限制在工作区,检查 sandbox、已有符号链接与覆盖意图。 */
async function resolveWorkspaceWrite(ctx, exec, requested, overwrite) {
	throwIfAborted(exec?.signal);
	const policy = ctx.sandboxPolicy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session });
	if (policy.mode === 'read-only') throw new Error('当前会话为 read-only,不能保存截图');
	const base = exec?.agent === undefined
		? process.cwd()
		: await ctx.workingDirectory.ensure(exec.agent, exec.signal);
	const root = await realpath(base);
	if (typeof requested !== 'string' || !requested.trim()) throw new Error('save_path 不能为空');
	const candidate = resolve(root, requested.trim());
	if (!isInside(root, candidate)) throw new Error(`save_path 必须位于工作区内: ${root}`);
	if (policy.mode === 'workspace-write') {
		const policyRoot = await realpath(policy.workspaceRoot);
		if (!isInside(policyRoot, candidate)) throw new Error(`save_path 不在当前 sandbox 工作区内: ${policyRoot}`);
	}
	// mkdir 之前先检查最近的已存在祖先,避免经符号链接在外部建目录。
	const ancestor = await realpath(await nearestExisting(dirname(candidate)));
	if (!isInside(root, ancestor)) throw new Error('save_path 的祖先目录通过符号链接指向工作区外');
	await mkdir(dirname(candidate), { recursive: true });
	const parent = await realpath(dirname(candidate));
	if (!isInside(root, parent)) throw new Error('save_path 的父目录通过符号链接指向工作区外');
	const target = resolve(parent, basename(candidate));
	try {
		const info = await stat(target);
		if (!info.isFile()) throw new Error('save_path 目标不是普通文件');
		if (!overwrite) throw new Error(`目标文件已存在,拒绝覆盖: ${target}(可设置 overwrite: true)`);
		const actual = await realpath(target);
		if (!isInside(root, actual) || actual !== target) throw new Error('save_path 目标为符号链接,拒绝写入');
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
	throwIfAborted(exec?.signal);
	return target;
}

async function saveScreenshot(ctx, exec, args, bytes, contentType) {
	const ext = contentType.includes('jpeg') ? 'jpg' : 'png';
	const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
	const requested = args.save_path?.trim() || `browser-shot-${stamp}.${ext}`;
	const target = await resolveWorkspaceWrite(ctx, exec, requested, args.overwrite === true);
	// O_EXCL 防同名竞争覆盖;O_NOFOLLOW 防最终路径符号链接。
	const noFollow = fsConstants.O_NOFOLLOW ?? 0;
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | noFollow
		| (args.overwrite === true ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
	const handle = await open(target, flags, 0o600);
	try {
		throwIfAborted(exec?.signal);
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
	return { path: target, contentType, bytes: bytes.length };
}

/* ─────────────────────────── 工具注册 ─────────────────────────── */

function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	// 本机 profile 的完整覆盖可显式放开私网；公共默认则连网关地址也一起拦截，
	// 避免 baseUrl 绕过 allowPrivateNetworks=false。
	if (!cfg.allowPrivateNetworks && isPrivateUrl(cfg.baseUrl)) {
		throw new Error(`browser-tools: baseUrl 是内网/回环地址;确需本机网关时请显式配置 allowPrivateNetworks: true: ${cfg.baseUrl}`);
	}
	if (!cfg.apiToken && !cfg.apiTokenRef) ctx.logger.warn('browser-tools: apiToken 与 apiTokenRef 均未配置,工具调用会失败');

	ctx.tools.register({
		name: 'browser_health',
		description: '共享浏览器健康与占用状态:浏览器是否运行、活跃/排队任务、页面与上下文数量、资源限额。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(_args, exec) {
			return await call(ctx, cfg, '/health', { signal: exec.signal, maxBytes: 1024 * 1024 });
		},
	});

	ctx.tools.register({
		name: 'browser_scrape',
		description: '用共享浏览器打开页面并返回渲染结果(支持 JS/SPA)。大页面建议 include_html=false + include_text=true。响应有字节上限,超限会报错而非截断源数据。',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: '绝对 http(s) URL' },
				wait_until: { type: 'string', description: 'commit | domcontentloaded(默认) | load | networkidle' },
				timeout_ms: { type: 'integer', description: '导航超时毫秒,默认30000,上限120000' },
				include_html: { type: 'boolean', description: '返回渲染后HTML,默认true' },
				include_text: { type: 'boolean', description: '返回可见正文,默认false' },
			},
			required: ['url'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { url: guardUrl(cfg, args.url) };
			for (const k of ['wait_until', 'timeout_ms', 'include_html', 'include_text']) {
				if (args[k] != null) body[k] = args[k];
			}
			return await call(ctx, cfg, '/scrape', { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_screenshot',
		description: '截图并保存到当前会话工作区,返回文件路径。支持整页、视口、高DPI。默认不覆盖同名文件;save_path不能跳出工作区。',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: '绝对 http(s) URL' },
				wait_until: { type: 'string', description: 'commit | domcontentloaded(默认) | load | networkidle' },
				timeout_ms: { type: 'integer', description: '导航超时毫秒,默认30000' },
				full_page: { type: 'boolean', description: '截整页,默认false' },
				viewport: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
				device_scale_factor: { type: 'number', description: '缩放倍数1~3' },
				image_format: { type: 'string', description: 'png(默认) | jpeg' },
				quality: { type: 'integer', description: 'JPEG质量1~100' },
				save_path: { type: 'string', description: '工作区内路径;缺省自动生成唯一文件名' },
				overwrite: { type: 'boolean', description: '是否明确允许覆盖同工作区内已有普通文件,默认false' },
			},
			required: ['url'],
		},
		output: screenshotOutput,
		async execute(args, exec) {
			const body = { url: guardUrl(cfg, args.url) };
			for (const k of ['wait_until', 'timeout_ms', 'full_page', 'viewport', 'device_scale_factor', 'image_format', 'quality']) {
				if (args[k] != null) body[k] = args[k];
			}
			const { bytes, contentType } = await call(ctx, cfg, '/screenshot', {
				method: 'POST', body, raw: true, signal: exec.signal,
			});
			return await saveScreenshot(ctx, exec, args, bytes, contentType);
		},
	});

	ctx.tools.register({
		name: 'browser_run_js',
		description: '打开URL后在页面上下文执行JS,返回任意JSON值(字符串/数字/数组/对象/null均可)。',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: '绝对 http(s) URL' },
				script: { type: 'string', description: 'Playwright evaluate表达式或函数' },
				arg: { description: '可选JSON参数' },
				wait_until: { type: 'string', description: 'commit | domcontentloaded(默认) | load | networkidle' },
				timeout_ms: { type: 'integer', description: '导航超时毫秒' },
			},
			required: ['url', 'script'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { url: guardUrl(cfg, args.url), script: args.script };
			if (args.arg !== undefined) body.arg = args.arg;
			if (args.wait_until) body.wait_until = args.wait_until;
			if (args.timeout_ms != null) body.timeout_ms = args.timeout_ms;
			return await call(ctx, cfg, '/run-js', { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_page_open',
		description: '创建长期页面。注意:同profile且restore_state=true的页面共享Cookie/localStorage;false才是隔离上下文。返回page_id。',
		parameters: {
			type: 'object',
			properties: {
				profile: { type: 'string', description: 'profile名' },
				restore_state: { type: 'boolean', description: '是否恢复profile登录态,默认true' },
				viewport: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
				device_scale_factor: { type: 'number', description: '缩放倍数1~3' },
			},
			required: ['profile'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { profile: args.profile };
			for (const k of ['restore_state', 'viewport', 'device_scale_factor']) {
				if (args[k] != null) body[k] = args[k];
			}
			return await call(ctx, cfg, '/pages', { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_page_goto',
		description: '在长期页面导航并保留当前上下文登录态。',
		parameters: {
			type: 'object',
			properties: {
				page_id: { type: 'string' }, url: { type: 'string' },
				wait_until: { type: 'string' }, timeout_ms: { type: 'integer' },
			},
			required: ['page_id', 'url'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { url: guardUrl(cfg, args.url) };
			if (args.wait_until) body.wait_until = args.wait_until;
			if (args.timeout_ms != null) body.timeout_ms = args.timeout_ms;
			return await call(ctx, cfg, `/pages/${encodeURIComponent(args.page_id)}/goto`, { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_page_click',
		description: '点击长期页面中的CSS选择器。超时/取消不代表动作未发生,请读取页面复核。',
		parameters: {
			type: 'object',
			properties: { page_id: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'integer' } },
			required: ['page_id', 'selector'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { selector: args.selector };
			if (args.timeout_ms != null) body.timeout_ms = args.timeout_ms;
			return await call(ctx, cfg, `/pages/${encodeURIComponent(args.page_id)}/click`, { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_page_fill',
		description: '在长期页面的输入框填写内容。超时/取消不代表动作未发生,请读取页面复核。',
		parameters: {
			type: 'object',
			properties: {
				page_id: { type: 'string' }, selector: { type: 'string' },
				value: { type: 'string' }, timeout_ms: { type: 'integer' },
			},
			required: ['page_id', 'selector', 'value'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { selector: args.selector, value: args.value };
			if (args.timeout_ms != null) body.timeout_ms = args.timeout_ms;
			return await call(ctx, cfg, `/pages/${encodeURIComponent(args.page_id)}/fill`, { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_page_evaluate',
		description: '在长期页面当前上下文执行JS,返回任意JSON值,无需重新导航。',
		parameters: {
			type: 'object',
			properties: {
				page_id: { type: 'string' }, script: { type: 'string' },
				arg: { description: '可选JSON参数' },
			},
			required: ['page_id', 'script'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const body = { script: args.script };
			if (args.arg !== undefined) body.arg = args.arg;
			return await call(ctx, cfg, `/pages/${encodeURIComponent(args.page_id)}/evaluate`, { method: 'POST', body, signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_page_close',
		description: '关闭长期页面释放资源。若这是profile最后一个页面,网关会先自动保存其登录态再关闭共享上下文。',
		parameters: {
			type: 'object',
			properties: { page_id: { type: 'string' } },
			required: ['page_id'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return await call(ctx, cfg, `/pages/${encodeURIComponent(args.page_id)}`, { method: 'DELETE', signal: exec.signal });
		},
	});

	ctx.tools.register({
		name: 'browser_profiles',
		description: '列出已有浏览器profile(登录态名称,不返回敏感状态内容)。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(_args, exec) {
			return await call(ctx, cfg, '/profiles', { signal: exec.signal, maxBytes: 1024 * 1024 });
		},
	});

	ctx.tools.register({
		name: 'browser_profile_save',
		description: '保存当前活动profile的整个共享上下文登录态。先以restore_state=true打开页面;同profile其他页面的状态也会一起保存。page_id仅为旧版调用兼容参数,会被忽略,不会发送给网关。',
		parameters: {
			type: 'object',
			properties: {
				profile: { type: 'string', description: '要保存的活动profile名' },
				page_id: { type: 'string', description: '旧版兼容参数;忽略,保存整个活动profile而非单个页面' },
			},
			required: ['profile'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return await call(ctx, cfg, `/profiles/${encodeURIComponent(args.profile)}/save`, {
				method: 'POST', body: {}, signal: exec.signal,
			});
		},
	});
}

export { apply, inject, name, call as _callForTest };
