/**
 * @dsh-friends/ths-trade — 同花顺账户与真实交易执行
 *
 * - ths_account：资产、持仓、委托、成交与可撤委托查询。
 * - ths_order_submit / ths_cancel_submit / ths_cancel_all：真实交易，无工具审批门。
 * - 每个飞书用户只读取自己的 trading 连接；无渠道身份的 Web 管理会话使用静态配置。
 * - 行情与盯盘在 ths-market，自选在 ths-favorites，智能交易系统在 ths-signal。
 */

import fsModule from 'node:fs';
import { connectionForExecution } from '../../lib/user-connections.js';

const name = 'ths-trade';
const inject = ['tools', 'sessions', 'sessionQuery'];

/**
 * 插件配置。不导出 schemastery `Config`:cordis 对无 `Config` 的插件原样透传
 * 用户配置(所有键都在 cordis.patch.yml 的 config 段里声明,缺省由 apply 内的
 * 默认值兜底),避免给纯 JS 插件引入构建依赖。
 */
const CONFIG_DEFAULTS = {
	xiadanBaseUrl: process.env.THS_XIADAN_BASE_URL || 'http://127.0.0.1:18710',
	xiadanApiKey: '',
	requestTimeoutMs: 15000,
	toolDeny: [],
	toolAllow: [],
};

/** 市场代码映射:常用市场名 -> FQGate market */
const MARKETS = {
	SH: 'USHA', SHA: 'USHA', 沪: 'USHA', 上海: 'USHA',
	SZ: 'USZA', SZA: 'USZA', 深: 'USZA', 深圳: 'USZA',
	BJ: 'USJB', 北: 'USJB', 北交: 'USJB',
	HK: 'USHK', 港: 'USHK', 香港: 'USHK',
	SHJ: 'USHJ', 沪基: 'USHJ', SHF: 'USHJ',
	SZJ: 'USZJ', 深基: 'USZJ', SZF: 'USZJ',
};

/** 按代码前缀推断 FQGate 市场(实测校准:510300/588000/511990→USHJ,159915→USZJ) */
function inferMarket(code) {
	if (code.length === 6) {
		if (/^4[38]/.test(code)) return 'USJB';  // 43/48 北交
		if (/^8[38]/.test(code)) return 'USJB';  // 83/87 北交
		if (/^[45]/.test(code)) return 'USHJ';   // 50/51/56/58 沪市基金/ETF
		if (/^1[56]/.test(code)) return 'USZJ';  // 15/16/18 深市基金/ETF
		if (/^[69]/.test(code)) return 'USHA';   // 60/68 沪股、90 B股
		if (/^[023]/.test(code)) return 'USZA';  // 00/30 深股、20 B股
		return 'USHA';
	}
	if (code.length === 5) return 'USJB';         // 北交 5 位
	if (code.length === 4) return 'USHK';        // 港股 4 位
	return 'USHA';
}

/** 规范化证券标识:支持 "600519"、"SH600519"、"沪600519" 等输入 */
function parseSecurity(input) {
	if (typeof input !== 'string' || !input.trim()) throw new Error('证券代码不能为空');
	const raw = input.trim().toUpperCase();
	const m = raw.match(/^(SH|SHA|SZ|SZA|BJ|USJB|HK|USHA|USZA|USHK|沪|深|北|港|上海|深圳|北交|香港)?(\d{4,6})$/);
	if (!m) throw new Error(`无法识别的证券代码: ${input}`);
	const alias = m[1] ?? '';
	let code = m[2];
	const market = MARKETS[alias] ?? inferMarket(code);
	// 港股前导零按需剥(1 位 ticker);A 股前导零是代码的一部分,必须保留
	if (market === 'USHK') code = code.replace(/^0+(?=\d)/, '');
	return { market, code };
}

/** 统一 REST 请求:超时、错误规范化 */
async function request(ctx, baseUrl, path, { method = 'GET', body, headers = {}, timeoutMs = 15000, signal } = {}) {
	const url = `${baseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`请求超时(${timeoutMs}ms): ${url}`)), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const response = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json', ...headers },
			body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await response.text();
		let json;
		try { json = JSON.parse(text); } catch { json = undefined; }
		if (!response.ok) {
			const detail = json?.error?.message ?? json?.error ?? text.slice(0, 200);
			throw new Error(`${baseUrl} HTTP ${response.status}: ${String(detail)}`);
		}
		return json;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

/** xiadan REST 客户端(自动带 Bearer + X-Xiadan-Intent) */
function xiadanClient(ctx, cfg) {
	const headers = cfg.xiadanApiKey ? { Authorization: `Bearer ${cfg.xiadanApiKey}` } : {};
	return {
		get: (path, intent) =>
			request(ctx, cfg.xiadanBaseUrl, path, { headers, timeoutMs: cfg.requestTimeoutMs })
				.then((envelope) => unwrapXiadan(envelope, path)),
		post: (path, body, intent) =>
			request(ctx, cfg.xiadanBaseUrl, path, {
				method: 'POST', body, headers: { ...headers, ...(intent ? { 'X-Xiadan-Intent': intent } : {}) },
				timeoutMs: cfg.requestTimeoutMs,
			}).then((envelope) => unwrapXiadan(envelope, path)),
	};
}

/** xiadan 的 ApiEnvelope{ok,data,error} 解包 */
function unwrapXiadan(envelope, path) {
	if (!envelope || typeof envelope !== 'object') throw new Error(`xiadan ${path}: 响应格式异常`);
	if (envelope.ok === false) {
		const err = envelope.error ?? {};
		throw new Error(`xiadan ${path}: ${err.code ?? 'error'} ${err.message ?? ''}`.trim());
	}
	return envelope.data;
}
/** 一次性唯一后缀(毫秒 + 随机),用于组合幂等键 */
function nowKey() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 工具输出:统一文本渲染(数据安全截断) */
function renderJson(value, budget = 6000) {
	const text = JSON.stringify(value, null, 1);
	return text.length > budget
		? { type: 'text', text: `${text.slice(0, budget)}\n…(已截断,共 ${text.length} 字符)` }
		: { type: 'text', text };
}

/** 工具输出 schema:宽松 JSON 值 */
const anyJsonOutput = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => [renderJson(value)],
};

/* ─────────────────────────── 工具注册 ─────────────────────────── */

/** Host-neutral fallback for CLI/Feishu, which have agents but no Web controller. */
async function resolveAgentFromRegistry(ctx, sessionId) {
	const agents = ctx.get('agents');
	if (!agents) throw new Error('agents service unavailable');
	const agent = agents.get(sessionId);
	if (agent) return { agent };
	const selection = ctx.get('agentDefaultModel')?.currentSelection();
	const agentOptions = selection ? { provider: selection.provider, model: selection.model } : {};
	try {
		return await agents.resume({ resumeSessionId: sessionId, agentOptions });
	} catch {
		return await agents.create({ sessionId, agentOptions });
	}
}

function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	if (!cfg.xiadanApiKey) ctx.logger.warn('ths-trade: xiadanApiKey 未配置,交易与账户工具将不可用');
	const xdFor = (exec) => xiadanClient(ctx, connectionForExecution(exec, cfg, 'trading'));

	// deny 优先于 allow;allow 为空数组=不过滤。照 dsh-lark channels.feishu.tools.deny 模式。
	const toolPattern = (p) => new RegExp('^' + String(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
	const toolAllowed = (n) => {
		if ((cfg.toolDeny ?? []).some((p) => toolPattern(p).test(n))) return false;
		const allow = cfg.toolAllow ?? [];
		if (allow.length > 0 && !allow.some((p) => toolPattern(p).test(n))) return false;
		return true;
	};
	const register = (def) => {
		if (toolAllowed(def.name)) ctx.tools.register(def);
		else ctx.logger.info?.(`[ths-trade] ${def.name}: skipped (toolDeny/toolAllow)`);
	};

	/* ── 行情查询(FQGate)────────────────────────── */

	register({
		name: 'ths_account',
		description: '通过 xiadan 网关查询当前用户已绑定的证券交易账户:assets(资产)/positions(持仓)/orders(当日委托)/deals(当日成交)/cancelable(可撤)。若提示未开通交易连接，应告知用户联系管理员配置 xiadan；不得将其解释为未登录自选，不得引导 ths_qr_login 扫码。自选登录与证券交易连接完全独立。',
		parameters: {
			type: 'object',
			properties: {
				kind: { type: 'string', description: 'assets | positions | orders | deals | cancelable' },
			},
			required: ['kind'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const path = {
				assets: '/api/v1/account/assets',
				positions: '/api/v1/account/positions',
				orders: '/api/v1/account/orders',
				deals: '/api/v1/account/deals',
				cancelable: '/api/v1/account/cancelable',
			}[args.kind];
			if (!path) throw new Error(`未知的账户查询 kind: ${args.kind}`);
			return { [args.kind]: await xdFor(exec).get(path) };
		},
	});

	register({
		name: 'ths_order_submit',
		description: '提交真实委托(xiadan 网关,真实资金!)。无工具审批门,调用即执行。幂等键规则:同一委托重试复用同一 key;修改参数必须换新 key;返回 pending 时不要换 key 重发,改用 ths_account(orders) 对账。',
		parameters: {
			type: 'object',
			properties: {
				code: { type: 'string', description: '六位证券代码' },
				side: { type: 'string', description: 'buy | sell' },
				price: { type: 'number', description: '委托价格(限价)' },
				quantity: { type: 'integer', description: '数量(股),与 amount 二选一' },
				amount: { type: 'number', description: '买入金额(元),与 quantity 二选一' },
				idempotency_key: { type: 'string', description: '幂等键,调用方生成,一次委托的唯一标识' },
				reduce_only: { type: 'boolean', description: '卖出超量时按可用持仓清仓' },
			},
			required: ['code', 'side', 'price', 'idempotency_key'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const userCfg = connectionForExecution(exec, cfg, 'trading');
			// REST body 不含幂等键(它走 X-Xiadan-Idempotency-Key header)
			const body = { code: args.code, side: args.side, price: args.price };
			if (args.quantity != null) body.quantity = args.quantity;
			if (args.amount != null) body.amount = args.amount;
			if (args.reduce_only != null) body.reduce_only = args.reduce_only;
			// REST 层要求幂等键在 header
			const result = await request(ctx, userCfg.xiadanBaseUrl, '/api/v1/trading/orders', {
				method: 'POST', body,
				headers: {
					Authorization: `Bearer ${userCfg.xiadanApiKey}`,
					'X-Xiadan-Intent': 'real-trade',
					'X-Xiadan-Idempotency-Key': args.idempotency_key,
				},
				timeoutMs: userCfg.requestTimeoutMs,
			}).then((envelope) => unwrapXiadan(envelope, 'trading/orders'));
			// pending / upstream_no_receipt 不是失败:上游已受理,只是快速回执窗口内未在委托簿命中。
			// 必须带明确对账指引,避免调用方误判为"下单失败"而换 key 重发(会真实双开仓)。
			if (result && result.ok !== true && (result.pending === true || result.accepted === true)) {
				return {
					order: result,
					outcome: 'accepted_but_unconfirmed',
					nextAction: `不得重复下单。先调 ths_account(orders) 按 ${args.code}/${args.side}/${args.price}/数量对账,或用同一幂等键 ${args.idempotency_key} 查终态后再决定。`,
				};
			}
			return { order: result };
		},
	});

	register({
		name: 'ths_cancel_submit',
		description: '撤销委托(xiadan,真实撤单,无工具审批门,调用即执行)。优先用 entrust_no(合同号);或 code+scope=code 撤销该代码全部可撤单。',
		parameters: {
			type: 'object',
			properties: {
				entrust_no: { type: 'string', description: '合同号 htbh(推荐)' },
				code: { type: 'string', description: '证券代码(配合 scope=code)' },
				scope: { type: 'string', description: 'contract(默认) | code' },
				idempotency_key: { type: 'string', description: '幂等键' },
			},
			required: ['idempotency_key'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const userCfg = connectionForExecution(exec, cfg, 'trading');
			// REST 端点用 camelCase(entrustNo/orderId);幂等键走 header,不进 body
			const body = {};
			if (args.entrust_no) body.entrustNo = args.entrust_no;
			if (args.code) body.code = args.code;
			if (args.scope) body.scope = args.scope;
			const result = await request(ctx, userCfg.xiadanBaseUrl, '/api/v1/trading/cancels', {
				method: 'POST', body,
				headers: {
					Authorization: `Bearer ${userCfg.xiadanApiKey}`,
					'X-Xiadan-Intent': 'real-trade',
					'X-Xiadan-Idempotency-Key': args.idempotency_key,
				},
				timeoutMs: userCfg.requestTimeoutMs,
			}).then((envelope) => unwrapXiadan(envelope, 'trading/cancels'));
			return { cancel: result };
		},
	});


	register({
		name: 'ths_cancel_all',
		description: '撤销全部可撤委托(应急清场),无审批门。工具内部先读取 cancelable 再逐笔撤销,无需用户二次确认。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(args, exec) {
			const userCfg = connectionForExecution(exec, cfg, 'trading');
			const cancelable = await xdFor(exec).get('/api/v1/account/cancelable');
			const orders = cancelable?.result?.data?.order ?? {};
			const flat = [];
			for (const [code, list] of Object.entries(orders)) {
				for (const o of list ?? []) flat.push({ code, htbh: o.htbh });
			}
			const results = [];
			for (const { code, htbh } of flat) {
				try {
					const r = await request(ctx, userCfg.xiadanBaseUrl, '/api/v1/trading/cancels', {
						method: 'POST',
						body: { entrustNo: String(htbh), scope: 'contract' },
						headers: {
							Authorization: `Bearer ${userCfg.xiadanApiKey}`,
							'X-Xiadan-Intent': 'real-trade',
							'X-Xiadan-Idempotency-Key': `cancelall-${htbh}-${nowKey()}`,
						},
						timeoutMs: userCfg.requestTimeoutMs,
					}).then((env) => unwrapXiadan(env, 'cancels'));
					results.push({ code, htbh: String(htbh), ok: true, result: r });
				} catch (error) {
					results.push({ code, htbh: String(htbh), ok: false, error: String(error?.message ?? error) });
				}
			}
			return { attempted: flat.length, results };
		},
	});
}

export { apply, inject, name, resolveAgentFromRegistry };
