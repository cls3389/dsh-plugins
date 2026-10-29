/**
 * @dsh-friends/asr-tools — 本地音视频转写(抖音/直链/本地文件)
 *
 * 薄封装:工具内部 HTTP 调 asr-mcp 服务(宿主机 docker 部署,见
 * /home/lin/workspace/ai-tools/mcp/asr-mcp),转写引擎 SenseVoice int8,
 * 抖音等页面链接由服务端经共享浏览器渲染解析(2026-10 起 yt-dlp 抖音通道
 * 被签名风控封死)。结果带缓存(命中 cached:true 秒回),只有转写文本与
 * 标题/作者元数据,适合"转写后交给大模型总结"的链路。
 *
 * 工具:
 *   asr_transcribe — source 支持:抖音整段分享文案 / 任意音视频 URL / 本地绝对路径
 *   asr_health     — 服务健康检查(引擎/缓存状态)
 */

const name = 'asr-tools';
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	/** asr-mcp 服务地址(DSH 容器内默认走宿主网关发布端口) */
	baseUrl: 'http://172.18.0.1:8410',
	/** 下载+转写整体超时;长视频/浏览器兜底解析耗时较长 */
	requestTimeoutMs: 300_000,
	healthTimeoutMs: 15_000,
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

async function callApi(cfg, path, { method = 'GET', body, timeoutMs, signal } = {}) {
	const res = await fetch(`${cfg.baseUrl}${path}`, {
		method,
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let data;
	try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
	if (!res.ok || data.ok === false) {
		throw new Error(`asr-mcp ${res.status}: ${data.error || data.raw || 'request failed'}`);
	}
	return data;
}

const { isAbsolute, resolve } = await import('node:path');
const { readFile, stat } = await import('node:fs/promises');

/** 本地上传单文件大小上限(读入内存再 multipart,语音/短视频音频足够) */
const MAX_INLINE_UPLOAD_MB = 100;

/**
 * source 是本容器可读的绝对路径时,读文件 multipart 上传
 * (asr-mcp 在独立容器内,看不到 DSH 容器的文件系统,直接传路径无效)。
 */
async function transcribe(cfg, args, exec) {
	const source = String(args?.source || '').trim();
	const language = args?.language ? String(args.language) : '';
	if (!source) throw new Error('source is required');

	// 抖音分享文案等长文本里抽 URL 后走远端转写;纯本地绝对路径走 multipart 上传
	const urlMatch = /https?:\/\/[^\s<>"']+/i.exec(source);
	if (!urlMatch && isAbsolute(source)) {
		const filePath = resolve(source);
		const st = await stat(filePath).catch(() => null);
		if (st && st.isFile()) {
			if (st.size > MAX_INLINE_UPLOAD_MB * 1024 * 1024) {
				throw new Error(`local file ${Math.round(st.size / 1048576)}MB exceeds inline upload limit ${MAX_INLINE_UPLOAD_MB}MB`);
			}
			const buf = await readFile(filePath);
			const form = new FormData();
			form.append('file', new Blob([buf]), filePath.split('/').pop() || 'audio.bin');
			if (language) form.append('language', language);
			if (args?.retranscribe) form.append('retranscribe', 'true');
			const res = await fetch(`${cfg.baseUrl}/transcribe`, {
				method: 'POST',
				body: form,
				signal: exec?.signal
					? AbortSignal.any([exec.signal, AbortSignal.timeout(cfg.requestTimeoutMs)])
					: AbortSignal.timeout(cfg.requestTimeoutMs),
			});
			const text = await res.text();
			let data;
			try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
			if (!res.ok || data.ok === false) throw new Error(`asr-mcp ${res.status}: ${data.error || data.raw || 'upload failed'}`);
			return data;
		}
		// 路径不存在(可能是含文案的字符串)→ 交给远端按 source 处理,报错信息更明确
	}

	return await callApi(cfg, '/transcribe', {
		method: 'POST',
		body: {
			source,
			...(language ? { language } : {}),
			...(args?.retranscribe ? { retranscribe: true } : {}),
		},
		timeoutMs: cfg.requestTimeoutMs,
		signal: exec?.signal,
	});
}

export function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };

	ctx.tools.register({
		name: 'asr_transcribe',
		description:
			'【音视频转文字(免费本地引擎)】把音频/视频/抖音链接转成文字。source 三种形态:①抖音分享文案——直接整段粘贴(含 v.douyin.com 短链即可,自动提取解析);②任意音视频 URL(直链或 B站/YouTube 等页面链接);③本机可读的音视频文件绝对路径(如飞书语音附件 MediaPath——自动读文件上传,不要求 asr 服务能访问本机文件系统)。返回转写文本 text + 标题/作者元数据,cached:true 表示缓存命中。拿到结果后可直接做总结/翻译/提取要点。retranscribe:true 强制重新转写。',
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: '抖音分享文案 / 音视频 URL / 本地绝对路径' },
				language: { type: 'string', enum: ['zh', 'en', 'ja', 'ko', 'yue', 'auto'], description: '默认 zh' },
				retranscribe: { type: 'boolean', description: '跳过缓存强制重转,默认 false' },
			},
			required: ['source'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return await transcribe(cfg, args, exec);
		},
	});

	ctx.tools.register({
		name: 'asr_health',
		description: '检查 asr-mcp 转写服务健康状态(引擎就绪、缓存配置、版本)。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(_args, exec) {
			return await callApi(cfg, '/health', { timeoutMs: cfg.healthTimeoutMs, signal: exec?.signal });
		},
	});

	ctx.logger.info(`[asr-tools] active: asr_transcribe / asr_health -> ${cfg.baseUrl}`);
	return () => {};
}

export { name, inject };
