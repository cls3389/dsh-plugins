/**
 * @dsh-friends/session-title-keeper — 会话标题增量更新引擎
 *
 * 背景(为什么需要它):
 *   内置的 @deepseek-ai/dsh-session-title-all-prompts-llm 有两处硬伤,导致
 *   标题长期停留在 fallback 截断版:
 *     1) maxOutputTokens: 64 —— 当前网关(cpa / deepseek-v4-flash)即使
 *        reasoningEffort=off 也会先输出 reasoning summary,64 token 被思考
 *        吃光,返回 finish=max-tokens,provider 直接抛错,标题永不更新。
 *     2) maxInputBytes: 4096 —— 长会话累计的用户消息一旦超限,输入被拒。
 *   结果:新建会话标题是「新建一个自动化任务 定时增量」这类被截断的
 *   fallback(5 词 / 40 字节上限),而标题本应概览整个会话。
 *
 * 本插件的做法(不碰内置插件的既有语义,只做增量补算):
 *   - 常驻定时器(默认每小时)扫描会话语料(ctx.sessionQuery.listSessions);
 *   - 对每个会话判定「是否需要重算」:
 *       · 当前没有标题,或
 *       · 标题来源是 fallback(= 截断兜底,不是模型生成的),或
 *       · 标题覆盖的消息 seq 未包含最新的用户消息(会话又推进了);
 *   - 只对需要的会话调 LLM 生成标题,并把结果作为 session/title 事件
 *     追加到该会话日志(fold 后就是列表里显示的那一条);
 *   - 用户手动改过的标题(source.kind === 'user')永远不覆盖 —— 尊重人工。
 *
 * 安全边界:
 *   - 不发任何委托/下单,不碰交易;
 *   - 单轮最多重算 maxPerRun 个会话,且相邻两次 LLM 调用间隔 paceMs,
 *     避免打满网关;
 *   - 单个会话失败只记日志,不影响其它会话;
 *   - 写回前重新读取当前标题,若期间被用户改名/已被别的路径更新则放弃
 *     (避免用旧结果覆盖新状态)。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const name = 'session-title-keeper';
// 注意:不 inject 'timer' —— 本插件用原生 setTimeout/setInterval,
// 并在 ctx.effect 的 disposer 里清理;inject 未实际使用的服务会阻塞加载。
const inject = ['tools', 'sessions', 'sessionQuery', 'llm'];

const CONFIG_DEFAULTS = {
	/** 是否启用定时引擎 */
	enabled: true,
	/** 扫描间隔(毫秒),默认 1 小时 */
	intervalMs: 3600_000,
	/** 启动后首次运行延迟(毫秒),避开启动风暴 */
	initialDelayMs: 60_000,
	/** 单轮最多重算多少个会话 */
	maxPerRun: 12,
	/** 相邻两次 LLM 调用的最小间隔(毫秒) */
	paceMs: 1200,
	/** 标题请求的输出上限(必须远大于 64:网关会先吐 reasoning) */
	maxOutputTokens: 512,
	/** 单次标题调用超时(毫秒) */
	timeoutMs: 60_000,
	/** 送入模型的消息正文最大字节数(超出按从新到旧截取) */
	maxInputBytes: 24_000,
	/** 每个会话最多取最近多少条用户消息 */
	maxMessages: 24,
	/** 目标标题长度(中文按字,英文按词,由提示词约束) */
	targetCjkCharacters: 14,
	targetWords: 6,
	/** 标题最大 UTF-8 字节(与 session-title 服务的 maxTitleBytes 一致) */
	maxTitleBytes: 80,
	/**
	 * 标题格式(对齐 Codex 命名规则):
	 *   'structured' = 「项目｜主题｜动作或结果」,普通会话省略时间,时间只在最后
	 *   'free'       = 自由文本短标题(旧行为)
	 */
	format: 'structured',
	/** structured 模式下是否允许追加时间段(默认关:只有跨天/定时类会话才带) */
	includeTime: false,
	/** 项目名推断:按工具实际触碰的路径段统计,取最高频且不低于该占比者为项目 */
	projectMinShare: 0.4,
	/** structured 模式下用于识别项目的工作区根;留空则用会话 cwd */
	workspaceRoot: '',
	/** 格式迁移台账:记录已尝试过的会话,避免重复重写 */
	stateFile: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.title-keeper-state.json'),
	/** 模型路由;留空则用该会话自己最后一次请求的路由 */
	provider: '',
	model: '',
};

/* ───────────────────────── 工具函数 ───────────────────────── */

function nowMs() {
	return Date.now();
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason); return; }
		const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
		signal?.addEventListener('abort', abort, { once: true });
	});
}

/** 从事件里取“用户真人输入”的文本(排除 system/工具/委托注入的 runtime 上下文) */
function userTextOf(event) {
	if (event.type !== 'user/message') return undefined;
	const source = event.data?.source;
	if (source?.kind !== 'user') return undefined;
	const blocks = event.data.content;
	if (!Array.isArray(blocks)) return undefined;
	const text = blocks
		.filter((b) => b?.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n')
		.trim();
	if (text.length === 0) return undefined;
	// 纯 runtime-context / 时间戳类系统注入,不作为标题依据
	if (/^Current runtime context\b/.test(text)) return undefined;
	if (/^Time sampled while preparing turn\b/.test(text)) return undefined;
	return text;
}

/** 折叠出最新标题事件 */
function latestTitleEvent(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		if (events[i].type === 'session/title') return events[i];
	}
	return undefined;
}

/** 按 UTF-8 字节安全截断(不切坏多字节字符) */
function truncateUtf8(input, maxBytes) {
	if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
	let used = 0;
	let out = '';
	for (const ch of input) {
		const size = Buffer.byteLength(ch, 'utf8');
		if (used + size > maxBytes) break;
		out += ch;
		used += size;
	}
	return out;
}

/** 标题规范化:压成一行、去掉控制字符与包裹的引号/星号 */
function normalizeTitle(raw, maxBytes) {
	// 先取第一条非空行，再压空白；顺序反过来会把模型的解释也拼进标题。
	const firstLine = String(raw ?? '')
		.split(/\r?\n/u)
		.map((s) => s.trim())
		.find((s) => s.length > 0) ?? '';
	let text = firstLine
		// 去掉 ANSI OSC/CSI、不可见/双向控制，避免终端欺骗性标题。
		.replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]/gu, '')
		.replace(/[\u0000-\u001f\u007f-\u009f\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
	// 去掉整体包裹的引号/反引号/星号
	text = text.replace(/^[`'"]+|[`'"]+$/gu, '').trim();
	text = text.replace(/^\*{1,3}(.+)\*{1,3}$/u, '$1').trim();
	// 去掉常见前缀
	text = text.replace(/^(标题|会话标题|Title|Session title)\s*[:：]\s*/iu, '').trim();
	if (text.length === 0) return '';
	return truncateUtf8(text, maxBytes).trim();
}

/** 非项目目录:技能库、临时/测试夹具,不作为标题里的项目名 */
const NOISE_SEGMENTS = new Set([
	'skills',
	'test',
	'tests',
	'tmp',
	'temp',
	'dshtest',
	'verify',
	'downloads',
	'attachments',
]);

/**
 * 从会话事件里推断「项目」:统计工具调用实际触碰的路径段。
 * 只认工作区根下的第一级目录名(如 ths-trade / dsh-feishu / web-providers),
 * 排除文件与点目录;最高频者占比达标才认定为项目,否则返回 undefined
 * (宁可不写项目,也不猜错)。
 *
 * @param {Array} events 会话完整事件
 * @param {string} workspaceRoot 工作区根路径
 * @param {number} minShare 最低占比
 * @returns {string|undefined}
 */
function inferProject(events, workspaceRoot, minShare) {
	const root = workspaceRoot.endsWith('/') ? workspaceRoot : `${workspaceRoot}/`;
	const counts = new Map();
	const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`${escaped}([A-Za-z0-9_\\-]+)`, 'g');
	for (const event of events) {
		if (event.type !== 'tool/call') continue;
		const args = event.data?.arguments;
		if (typeof args !== 'string') continue;
		for (const match of args.matchAll(re)) {
			const seg = match[1];
			// 排除点目录(.tools/.backup)、文件名,以及非项目目录(技能库/临时测试夹具)
			if (!seg || seg.startsWith('.') || seg.includes('.')) continue;
			if (NOISE_SEGMENTS.has(seg)) continue;
			counts.set(seg, (counts.get(seg) ?? 0) + 1);
		}
	}
	if (counts.size === 0) return undefined;
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const [topName, topCount] = sorted[0];
	const total = sorted.reduce((sum, [, n]) => sum + n, 0);
	if (topCount / total < minShare) return undefined;
	return topName;
}

/**
 * 把模型返回的自由文本整理成「项目｜主题｜动作或结果[｜时间]」。
 * - 若模型已按格式返回,保留其分段;
 * - 若模型只给了主题/动作,用推断出的项目补第一段;
 * - 时间段仅在 includeTime 且模型确实给出时保留,且永远放在最后。
 *
 * @param {string} raw 模型原文
 * @param {string|undefined} project 推断出的项目名
 * @param {{includeTime:boolean, maxBytes:number}} options
 * @returns {string}
 */
function shapeTitle(raw, project, options) {
	const cleaned = normalizeTitle(raw, options.maxBytes * 2);
	if (cleaned.length === 0) return '';
	const parts = cleaned
		.split(/[｜|]/u)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	let segments;
	if (parts.length >= 2) {
		// 模型自己分了段:沿用,但要修正项目段
		segments = [...parts];
		if (project !== undefined) {
			// 首段若是项目位且明显不同,替换为更可靠的项目名
			if (segments.length >= 2) segments[0] = project;
			else segments.unshift(project);
		}
	} else {
		// 模型只给了一句话:按「主题｜动作」拆不动就整体作主题
		segments = project === undefined ? [cleaned] : [project, cleaned];
	}

	// 时间段处理:识别明显的时间片段,只有 includeTime 才保留并置于末尾
	const timeLike = /^(\d{1,2}:\d{2}([-~]\d{1,2}:\d{2})?|\d{4}-\d{2}-\d{2}([ T]\d{1,2}:\d{2})?|上午|下午|早上|晚|今天|昨天|周[一二三四五六日])/u;
	const times = segments.filter((s) => timeLike.test(s));
	const rest = segments.filter((s) => !timeLike.test(s));
	const finalSegments = options.includeTime && times.length > 0 ? [...rest, times.join('/')] : rest;

	const joined = finalSegments.filter((s) => s.length > 0).join('｜');
	return truncateUtf8(joined, options.maxBytes).trim();
}

/* ───────────────────────── 主逻辑 ───────────────────────── */
function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	const stats = {
		runs: 0,
		lastRunAt: null,
		lastDurationMs: null,
		scanned: 0,
		recomputed: 0,
		skippedFresh: 0,
		skippedUser: 0,
		failures: 0,
		lastError: null,
		recent: [],
	};
	let running = false;
	const lifecycle = new AbortController();
	const activeRuns = new Set();

	/* ── 格式迁移台账 ──
	 * 记录『已尝试过把该会话标题改成结构化格式』。
	 * 目的:内置 provider 或旧版本引擎写下的自由文本标题,需要重写一次;
	 * 但若重写后仍推不出项目(单段、无 ｜),不能每小时再来一次。
	 * 按被处理时的标题事件 seq 记账,标题再变动时自然失效。 */
	let ledger = {};
	try {
		ledger = JSON.parse(readFileSync(cfg.stateFile, 'utf8'));
	} catch {
		ledger = {};
	}
	let ledgerDirty = false;
	function ledgerKey(sessionId) {
		return sessionId;
	}
	function ledgerDone(sessionId, titleSeq) {
		return ledger[ledgerKey(sessionId)] === titleSeq;
	}
	function markLedger(sessionId, titleSeq) {
		ledger[ledgerKey(sessionId)] = titleSeq;
		ledgerDirty = true;
	}
	function flushLedger() {
		if (!ledgerDirty) return;
		try {
			mkdirSync(dirname(cfg.stateFile), { recursive: true });
			writeFileSync(`${cfg.stateFile}.tmp`, JSON.stringify(ledger, null, 1), 'utf8');
			renameSync(`${cfg.stateFile}.tmp`, cfg.stateFile);
			ledgerDirty = false;
		} catch (error) {
			ctx.logger.warn(`session-title-keeper: 状态文件写入失败:${error?.message ?? error}`);
		}
	}

	function noteRecent(entry) {
		stats.recent.push(entry);
		if (stats.recent.length > 20) stats.recent.shift();
	}

	/** 判定一个会话是否需要重算;返回原因字符串或 null(= 不需要) */
	async function needsRecompute(sessionId) {
		let observation;
		try {
			// 走带缓存的点查询:冷会话按 stat revision 复用,不必每次重扫全库
			observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
		} catch (error) {
			return { error: `读取会话失败:${error?.message ?? error}` };
		}
		try {
			const events = observation.events ?? [];
			if (events.length === 0) return null;
			// 工作区根:优先用会话自己的 cwd,回退到配置值
			const workspaceRoot = observation.header?.cwd ?? cfg.workspaceRoot;

			// 会话自身的路由:取最后一条 request/header
			let sessionRoute;
			for (let i = events.length - 1; i >= 0; i -= 1) {
				const e = events[i];
				if (e.type === 'request/header' && e.data?.header?.config?.provider) {
					sessionRoute = {
						provider: e.data.header.config.provider,
						model: e.data.header.config.model,
					};
					break;
				}
			}

			// 收集真人用户消息(排除 runtime-context 等系统注入)
			const users = [];
			for (const event of events) {
				const text = userTextOf(event);
				if (text !== undefined) users.push({ seq: event.seq, text });
			}
			if (users.length === 0) return null;

			const current = latestTitleEvent(events);
			const lastUserSeq = users[users.length - 1].seq;
			// 项目名:从工具实际触碰的路径推断(宁可不写,也不猜错)
			const project = inferProject(events, workspaceRoot, cfg.projectMinShare);
			const base = { users, current, lastUserSeq, sessionRoute, project };

			// 用户手动改名 → 永不覆盖
			if (current !== undefined && current.data?.source?.kind === 'user') {
				return { skip: 'user-pinned' };
			}
			// 没有标题 → 需要
			if (current === undefined) return { ...base, reason: 'no-title' };
			// fallback 截断兜底 → 需要(最主要的目标)
			if (current.data?.source?.kind === 'fallback') return { ...base, reason: 'fallback' };
			// 模型标题但没覆盖到最新用户消息 → 会话推进了,需要
			const covered = Array.isArray(current.data?.messageSeqs) ? current.data.messageSeqs : [];
			if (covered.length === 0 || !covered.includes(lastUserSeq)) {
				return { ...base, reason: 'stale' };
			}
			// 标题已跟上进度,但格式不是本引擎的结构化格式(例如由内置 provider
			// 写的自由文本) → 仍需重写一次,保证全库标题风格一致。
			// 仅当标题由本引擎生成且已是结构化格式时才算 fresh。
			const titleText = current.data?.title ?? '';
			// 非结构化标题 → 重写一次。但用台账按【当前标题事件的 seq】记账:
			// 同一个标题只会被尝试迁移一次,避免「推不出项目 → 每小时重写」的死循环;
			// 一旦标题再变化(seq 变了),台账自然失效,又会重新评估。
			if (cfg.format === 'structured' && titleText.split('｜').length !== 3 && !ledgerDone(sessionId, current.seq)) {
				return { ...base, reason: 'format', titleSeq: current.seq };
			}
			return { skip: 'fresh', current };
		} finally {
			try {
				observation[Symbol.dispose]();
			} catch {
				/* ignore */
			}
		}
	}

	/** 组装提示词并调用模型生成标题 */
	async function generateTitle(users, previousTitle, sessionRoute, project, signal) {
		signal?.throwIfAborted();
		// 保留最早背景和最近消息；按完整 JSON 请求计字节，长会话不会超限。
		const recent = users.slice(-cfg.maxMessages);
		const candidates = [recent.at(-1), ...(recent[0]?.seq !== users[0]?.seq ? [users[0]] : []), ...recent.slice(0, -1).reverse()]
			.filter((item, index, list) => item && list.findIndex((other) => other.seq === item.seq) === index);
		const picked = [];
		const requestBytes = (messages) => Buffer.byteLength(`Generate the session title from this JSON:\n${JSON.stringify({
			...(project === undefined ? {} : { project }),
			...(previousTitle === undefined ? {} : { currentTitle: previousTitle }),
			messages,
		})}`, 'utf8');
		for (const item of candidates) {
			if (picked.length >= cfg.maxMessages) break;
			const text = item === candidates[0] && item.seq !== recent.at(-1)?.seq ? `最早背景消息: ${item.text}` : item.text;
			const attempt = [...picked, text];
			if (requestBytes(attempt.map((m) => typeof m === 'string' ? m : m.text)) <= cfg.maxInputBytes) {
				picked.push({ seq: item.seq, text });
				continue;
			}
			// 没有可选消息时，或最新一条本身过长时，保留一个有界的 UTF-8 前缀。
			if (picked.length === 0 || item.seq === recent.at(-1)?.seq) {
				const emptyBytes = requestBytes([...picked.map((m) => m.text), '']);
				const shortened = truncateUtf8(text, Math.max(0, cfg.maxInputBytes - emptyBytes));
				if (shortened) picked.push({ seq: item.seq, text: shortened });
			}
		}
		if (picked.length === 0) throw new Error('没有可用的用户消息');

		const structured = cfg.format === 'structured';
		const system = structured
			? [
					'You name an AI coding-assistant session using a FIXED structured format.',
					'Return ONLY the title, on one line, in plain natural language text.',
					'No quotes, no prefix, no explanation, no Markdown, no code, no terminal control characters.',
					'',
					'FORMAT: 项目｜主题｜动作或结果',
					'- Segment 1 = 项目 (project/repository/area). Use the supplied project name when one is given.',
					'- Segment 2 = 主题 (the concrete topic or object being worked on).',
					'- Segment 3 = 动作或结果 (what was done or achieved: 修复/新增/排查/审查/部署/得出结论).',
					'- Separate exactly three segments with the full-width character ｜ (U+FF5C). No spaces around it.',
					...(cfg.includeTime
						? ['- An optional 4th segment may hold a time range, and it MUST be the last segment.']
						: ['- Omit time entirely. Do NOT add any date or time segment for an ordinary session.']),
					'',
					'Use the language of the messages.',
					`Keep each segment short; the whole title should stay around ${cfg.targetCjkCharacters} CJK characters.`,
					'Describe the whole session topic or task, not just the last message.',
					...(previousTitle === undefined
						? []
						: [
								`The current title is: ${previousTitle}`,
								'If it still accurately describes the session topic and already fits the format, return it unchanged.',
								'Only replace it when the messages clearly changed or broadened the topic.',
							]),
				].join('\n')
			: [
					'You name an AI coding-assistant session from its human messages.',
					'Return ONLY the title, on one line, in plain natural language text.',
					'No quotes, no prefix, no explanation, no Markdown, no code, no terminal control characters.',
					'Use the language of the messages.',
					`Aim for at most about ${cfg.targetCjkCharacters} CJK characters, or ${cfg.targetWords} words in non-CJK languages.`,
					'Describe the whole session topic or task, not just the last message.',
					...(previousTitle === undefined
						? []
						: [
								`The current title is: ${previousTitle}`,
								'If it still accurately describes the session topic, return it unchanged.',
								'Only replace it when the messages clearly changed or broadened the topic.',
							]),
				].join('\n');

		const payload = JSON.stringify({
			...(project === undefined ? {} : { project }),
			...(previousTitle === undefined ? {} : { currentTitle: previousTitle }),
			messages: picked.map((m) => m.text),
		});
		const input = `Generate the session title from this JSON:\n${payload}`;
		if (Buffer.byteLength(input, 'utf8') > cfg.maxInputBytes) {
			throw new Error(`标题输入超过 maxInputBytes(${cfg.maxInputBytes})`);
		}

		// 路由:优先配置;否则用会话自己最后一次请求的 provider/model
		let provider = cfg.provider;
		let model = cfg.model;
		if (!provider || !model) {
			if (!sessionRoute) throw new Error('无法确定模型路由(未配置且会话没有 request/header)');
			provider = sessionRoute.provider;
			model = sessionRoute.model;
		}

		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener('abort', abort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(new Error(`标题生成超时(${cfg.timeoutMs}ms)`)), cfg.timeoutMs);
		const abortError = () => new Error(controller.signal.aborted ? String(controller.signal.reason?.message ?? controller.signal.reason) : '标题生成已取消');
		let call;
		try {
			// 路由准备也必须在超时和重载取消范围内。
		// 2026-10-30:reasoningEffort 可配(cfg.reasoningEffort,默认不发送字段走路由默认)。
		// 硬编码 'off' 在模型表删掉 off 档后会 UNSUPPORTED_REASONING_EFFORT。
		const preparation = ctx.llm.prepareCall({
				provider,
				model,
				maxTokens: cfg.maxOutputTokens,
				...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
			}, controller.signal);
			const timeout = new Promise((_, reject) => {
				controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
			});
			call = await Promise.race([preparation, timeout]);
			controller.signal.throwIfAborted();
			let text = '';
			let finishKind = 'unknown';
			let sawToolCall = false;
			const stream = call.stream({
				...call.config,
				system,
				messages: [
					{
						role: 'user',
						content: [{ type: 'text', text: input }],
					},
				],
				purpose: 'session-title',
				signal: controller.signal,
			});
			for await (const chunk of stream) {
				controller.signal.throwIfAborted();
				if (chunk.type === 'text-delta') text += chunk.text;
				else if (chunk.type === 'tool-call' || chunk.type === 'tool-calls') sawToolCall = true;
				else if (chunk.type === 'finish') finishKind = chunk.reason?.kind ?? 'unknown';
			}
			if (finishKind !== 'stop' || sawToolCall) {
				throw new Error(`模型未正常完成标题(finish=${finishKind}${sawToolCall ? ',tool-call' : ''})`);
			}
			const title = cfg.format === 'structured'
				? shapeTitle(text, project, { includeTime: cfg.includeTime, maxBytes: cfg.maxTitleBytes })
				: normalizeTitle(text, cfg.maxTitleBytes);
			if (title.length === 0) throw new Error(`模型未返回可用标题(finish=${finishKind})`);
			return { title, seqs: picked.map((m) => m.seq) };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
		}
	}

	/** 处理单个会话:判定 → 生成 → 写回 */
	async function processOne(sessionId, options = {}) {
		const dryRun = options.dryRun === true;
		const verdict = await needsRecompute(sessionId);
		if (verdict === null) return { sessionId, action: 'skip', why: 'no-user-messages' };
		if (verdict.error) return { sessionId, action: 'error', why: verdict.error };
		if (verdict.skip === 'user-pinned') {
			stats.skippedUser += 1;
			return { sessionId, action: 'skip', why: 'user-pinned' };
		}
		if (verdict.skip === 'fresh') {
			stats.skippedFresh += 1;
			return { sessionId, action: 'skip', why: 'fresh' };
		}
		if (dryRun) {
			return {
				sessionId,
				action: 'would-update',
				reason: verdict.reason,
				from: verdict.current?.data?.title ?? null,
				users: verdict.users.length,
			};
		}
		return { sessionId, action: 'generate', verdict };
	}

	/** 使用已判定的快照生成，并在提交前执行标题事件 CAS。 */
	async function writeGeneratedTitle(sessionId, verdict, options = {}) {
		const previousTitle = verdict.current?.data?.title;
		const generated = await generateTitle(verdict.users, previousTitle, verdict.sessionRoute, verdict.project, options.signal);
		options.signal?.throwIfAborted();
		lifecycle.signal.throwIfAborted();

		// 以最初读取的标题事件为 CAS 快照，而不是用“是否 fresh”猜测。
		// 生成期间任何新标题（provider/fallback/user）都不能被旧结果覆盖。
		const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
		try {
			const latest = latestTitleEvent(observation.events ?? []);
			if (latest?.seq !== verdict.current?.seq || latest?.data?.title !== previousTitle) {
				return { sessionId, action: 'skip', why: 'raced-title-changed' };
			}
		} finally {
			try { observation[Symbol.dispose](); } catch { /* ignore */ }
		}
		options.signal?.throwIfAborted();
		lifecycle.signal.throwIfAborted();

		const modelRoute = { provider: cfg.provider || verdict.sessionRoute?.provider || 'unknown', model: cfg.model || verdict.sessionRoute?.model || 'unknown' };
		const session = ctx.sessions.get(sessionId);
		let writtenSeq;
		if (session !== undefined) {
			// 活跃会话:走 Session.append,与运行中的循环共用同一日志
			const appended = session.append('session/title', {
				title: generated.title,
				messageSeqs: generated.seqs,
				source: { kind: 'provider', provider: name, model: modelRoute },
			});
			writtenSeq = appended?.seq;
			try {
				await ctx.sessions.flush(session);
			} catch {
				/* flush 失败不影响已 append 的事件,下次投影会补 */
			}
		} else {
			// 冷会话(不在内存里):直接打开写句柄追加,保持 seq 连续
			writtenSeq = await appendToStoredSession(sessionId, generated, modelRoute);
		}
		// 若本次是『格式迁移』,把当时看到的标题 seq 记账,
		// 表示这个标题已尝试过迁移,不再重复重写。
		// 记账必须用【本次写入的新标题事件 seq】。
		// 若记旧的 seq,标题 seq 一变台账就永远失配,导致每小时重写同一会话。
		if (verdict.reason === 'format' || !generated.title.includes('｜')) {
			markLedger(sessionId, writtenSeq);
		}
		stats.recomputed += 1;
		noteRecent({
			at: nowMs(),
			sessionId,
			reason: verdict.reason,
			from: previousTitle ?? null,
			to: generated.title,
		});
		return { sessionId, action: 'updated', reason: verdict.reason, title: generated.title };
	}

	/** 对不在内存中的会话追加一条 session/title 事件 */
	async function appendToStoredSession(sessionId, generated, modelRoute) {
		const persistence = ctx.get('sessionPersistence');
		if (!persistence) throw new Error('sessionPersistence 不可用,无法写回冷会话');
		let handle;
		try {
			handle = await persistence.open(sessionId, 'write');
			const read = await handle.read(0);
			const events = read.events ?? [];
			const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1;
			const nextSeq = lastSeq + 1;
			const event = {
				type: 'session/title',
				seq: nextSeq,
				time: nowMs(),
				data: {
					title: generated.title,
					messageSeqs: generated.seqs,
					source: { kind: 'provider', provider: name, model: modelRoute },
				},
			};
			await handle.append([event]);
			await handle.flush();
			return nextSeq;
		} finally {
			if (handle) {
				try {
					await handle.close();
				} catch {
					/* ignore */
				}
			}
		}
	}

	/** 一轮完整扫描 */
	async function runOnce(options = {}) {
		const dryRun = options.dryRun === true;
		if (running) return { skipped: 'already-running' };
		lifecycle.signal.throwIfAborted();
		running = true;
		const active = Symbol('title-run');
		activeRuns.add(active);
		const startedAt = nowMs();
		stats.runs += 1;
		stats.lastError = null;
		const summary = { dryRun, scanned: 0, updated: 0, skipped: 0, errors: 0, items: [] };
		try {
			const records = await ctx.sessionQuery.listSessions();
			stats.scanned = records.length;
			summary.scanned = records.length;

			let processed = 0;
			for (const record of records) {
				if (lifecycle.signal.aborted || options.signal?.aborted) break;
				if (processed >= (options.maxPerRun ?? cfg.maxPerRun)) break;
				const sessionId = record.header.id;
				const result = await processOne(sessionId, { dryRun, signal: options.signal ?? lifecycle.signal });
				if (result.action === 'skip') { summary.skipped += 1; continue; }
				if (result.action === 'would-update') { processed += 1; summary.items.push(result); continue; }
				if (result.action === 'error') {
					processed += 1; summary.errors += 1; stats.failures += 1; summary.items.push(result); continue;
				}
				processed += 1; // 失败、超时、取消同样占用本轮生成预算。
				try {
					const generated = dryRun
						? { action: 'would-update', sessionId, reason: result.verdict.reason, from: result.verdict.current?.data?.title ?? null, users: result.verdict.users.length }
						: await writeGeneratedTitle(sessionId, result.verdict, options);
					if (generated.action === 'updated' || generated.action === 'would-update') {
						if (generated.action === 'updated') summary.updated += 1;
						summary.items.push(generated);
						if (!dryRun && cfg.paceMs > 0) await sleep(cfg.paceMs, options.signal ?? lifecycle.signal).catch(() => {});
					} else summary.skipped += 1;
				} catch (error) {
					summary.errors += 1;
					stats.failures += 1;
					stats.lastError = `${sessionId}: ${error?.message ?? error}`;
					summary.items.push({ sessionId, action: 'error', why: String(error?.message ?? error) });
					if (!lifecycle.signal.aborted && !options.signal?.aborted) {
						ctx.logger.warn(`session-title-keeper: ${sessionId} 失败:${error?.message ?? error}`);
						if (!dryRun && cfg.paceMs > 0) await sleep(cfg.paceMs, options.signal ?? lifecycle.signal).catch(() => {});
					}
				}
			}
			return summary;
		} catch (error) {
			stats.lastError = String(error?.message ?? error);
			ctx.logger.warn(`session-title-keeper: 扫描失败:${stats.lastError}`);
			return { ...summary, errors: summary.errors + 1 };
		} finally {
			flushLedger();
			stats.lastRunAt = nowMs();
			stats.lastDurationMs = stats.lastRunAt - startedAt;
			// lastError 描述最近一次扫描，不让已恢复的瞬时错误长期误报。
			if (summary.errors === 0) stats.lastError = null;
			activeRuns.delete(active);
			running = false;
		}
	}

	/* 配置热重载会卸载旧实例：取消在途模型调用并等待退出，禁止旧结果写回。 */
	ctx.effect(() => async () => {
		lifecycle.abort(new Error('session-title-keeper 已卸载'));
		await Promise.allSettled([...activeRuns]);
	}, 'session-title-keeper.lifecycle');

	/* ── 定时器注册 ── */
	if (cfg.enabled) {
		ctx.effect(() => {
			let stopped = false;
			let loop;
			const tick = async () => {
				if (stopped || running) return;
				try {
					await runOnce();
				} catch (error) {
					ctx.logger.warn(`session-title-keeper tick: ${error?.message ?? error}`);
				}
			};
			const first = setTimeout(() => {
				if (stopped) return;
				void tick();
				loop = setInterval(() => void tick(), cfg.intervalMs);
			}, cfg.initialDelayMs);
			ctx.logger.info(
				`session-title-keeper: 已启用,首次运行 +${Math.round(cfg.initialDelayMs / 1000)}s,之后每 ${Math.round(cfg.intervalMs / 60000)} 分钟`,
			);
			return () => {
				stopped = true;
				clearTimeout(first);
				if (loop) clearInterval(loop);
				lifecycle.abort(new Error('session-title-keeper 定时器已卸载'));
			};
		}, 'session-title-keeper.timer');
	}

	/* ── 工具:手动触发 / 查看状态 ── */

	ctx.tools.register({
		name: 'session_titles_refresh',
		description:
			'立即执行一次会话标题增量更新(不等定时器):扫描所有会话,把仍停留在 fallback 截断版、或未覆盖最新用户消息的标题用 LLM 重算并写回。用户手动改过的标题不会被覆盖。返回本轮更新明细。',
		parameters: {
			type: 'object',
			properties: {
				dry_run: { type: 'boolean', description: '只看哪些会话会被更新,不实际写回,默认 false' },
				max: { type: 'integer', description: '本轮最多处理多少个会话,默认用配置值' },
			},
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1).slice(0, 12000) }],
		},
		async execute(args) {
			const options = { dryRun: args?.dry_run === true };
			if (args?.max != null) {
				options.maxPerRun = Math.max(1, Math.min(200, Number(args.max)));
			}
			const summary = await runOnce(options);
			return { ...summary, stats };
		},
	});

	ctx.tools.register({
		name: 'session_titles_status',
		description: '查看会话标题增量更新引擎的状态:是否启用、扫描间隔、下次运行时间、历史统计与最近更新明细。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1).slice(0, 8000) }],
		},
		async execute() {
			return {
				enabled: cfg.enabled,
				intervalMinutes: Math.round(cfg.intervalMs / 60000),
				initialDelayMinutes: Math.round(cfg.initialDelayMs / 60000),
				maxPerRun: cfg.maxPerRun,
				maxOutputTokens: cfg.maxOutputTokens,
				maxInputBytes: cfg.maxInputBytes,
				format: cfg.format,
				includeTime: cfg.includeTime,
				modelRoute: cfg.provider ? `${cfg.provider}/${cfg.model}` : '(跟随各会话最后一次请求的路由)',
				running,
				stats,
			};
		},
	});
}

export { apply, inject, name };
