/**
 * @local/ths-trade — 同花顺行情+交易一体化插件
 *
 * 数据面:
 *   - 行情:直接调 FQGate REST(无鉴权,地址经 fqgateBaseUrl 配置;行情工具已拆至 @dsh-friends/ths-market)
 *   - 账户/交易:直接调 xiadan REST(Bearer,地址经 xiadanBaseUrl 配置)
 * 监控面(盯盘"眼睛" + 条件单"手",全在本插件内,零额外进程):
 *   - WS 直连 FQGate /v1/market/stream(Node 原生 WebSocket,零依赖)
 *   - 规则两类:
 *     · 提醒型(price/change/big_order):触发 → 唤醒 agent 复核决策
 *     · 条件单型(带 action):触发 → 自动执行下单(止损/进场/减仓/加仓)
 *       - 创建时用户已在对话中授权,执行时直通(不卡确认门)
 *       - 护栏:单笔/当日限额、价格偏离保护(跳空>2% 转人工复核)、
 *         涨跌停/极端价不追、每单独立幂等键、执行台账
 *   - 触发 → agent.followup 唤醒加规则的会话(归属会话消失回退最新会话);
 *     非交易时段(9:25-11:31 / 12:58-15:01 之外)只记录不执行/不唤醒
 *   - 规则持久化到 workspace JSON(watch-rules.json),插件重载自动恢复
 *   - 冷却:同规则默认 15 分钟内不重复触发
 * 安全面:
 *   - ths_order_submit / ths_cancel_submit 无工具审批门,可直接执行真实交易;
 *     幂等键与回执对账要求不变;
 *   - 条件单自动执行走引擎内部直调 REST,保留金额/偏离/涨跌停护栏。
 */

import fsModule from 'node:fs';
import { buildSignalExplanations } from './signal-explain.js';

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
	// ── ths-data-center(数据中心:L2 云端指标/秒K/异动/交易日历/自选股)──
	dataCenterBaseUrl: 'http://127.0.0.1:17890',
	// ── 工具面收窄(2026-10-29):按通配符选择性注册工具 ──
	// toolDeny 命中即不注册;toolAllow 非空时仅注册命中项;deny 优先于 allow。
	// 场景:普通用户实例只开行情/自选/两融查询,deny 交易与盯盘全家。
	// 例: toolDeny: ['ths_order_*','ths_cancel_*','ths_watch_*','ths_signal_*','ths_account','ths_level2']
	toolDeny: [],
	toolAllow: [],
	// 2026-10-27:feishu profile 的 ths-trade 无 config 段,dataCenterApiKey 落空导致
	// ths_market_pulse / ths_sec_kline / ths_wencai 全部 401。实测该 key 有效
	// (curl 直连 /api/market/change-distribution 返回 200)。此处补默认值兜底,
	// 并支持 THS_DATACENTER_API_KEY 环境变量覆盖;正式做法是写进 profile 的 config 段。
	dataCenterApiKey: process.env.THS_DATACENTER_API_KEY || '',
	// ── ths-ai-signal-trader(AI 分时信号引擎:动态参数条件单)──
	// CLS 实例(8011)/FSM 实例(8012);二选一或列表,默认 CLS
	signalTraderBaseUrl: process.env.THS_SIGNAL_TRADER_BASE_URL || 'http://127.0.0.1:8011',
	// 同上:缺 token 导致 ths_signal_status 的 todaySignals/activeConditions 401。
	// 实测 X-Access-Token 头 + 该 token → /api/signals/today 返回 200。
	signalTraderWebuiToken: process.env.THS_SIGNAL_WEBUI_TOKEN || '',
	signalTraderWebhookToken: process.env.THS_SIGNAL_WEBHOOK_TOKEN || '',
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

/** FQGate REST 客户端(无鉴权) */
function fqgateClient(ctx, cfg) {
	return {
		post: (path, body) =>
			request(ctx, cfg.fqgateBaseUrl, path, { method: 'POST', body, timeoutMs: cfg.requestTimeoutMs }),
	};
}

/** FQGate 字段编号 -> 可读名(经 600519 实测与 xiadan 客户端对照校准) */
const FQ_FIELDS = {
	5: 'code', 6: 'preClose', 7: 'open', 8: 'high', 9: 'low',
	10: 'price', 12: 'tickVolume', 13: 'volume', 18: 'turnoverBp', 19: 'amount',
	45: 'totalVolume', 48: 'momentum', 49: 'hands', 55: 'name',
};

/** ths_quote 默认请求字段(服务端要求必填) */
const DEFAULT_QUOTE_FIELDS = [5, 6, 7, 8, 9, 10, 13, 19, 55];

/** hxfile records -> 简化行对象 */
function decodeRows(data, fields) {
	const rows = [];
	if (!data || data.row_count === 0 || !Array.isArray(data.records)) return rows;
	for (const segment of data.records) {
		if (!Array.isArray(segment)) continue;
		for (const record of segment) {
			const row = {};
			for (const [key, cell] of Object.entries(record ?? {})) {
				if (!cell || cell.value === undefined) continue;
				const name = (fields ?? FQ_FIELDS)[key] ?? `f${key}`;
				row[name] = cell.value;
			}
			rows.push(row);
		}
	}
	return rows;
}

/** 触发文本用证券名:无效/乱码时回退空串 */
function safeName(name) {
	if (typeof name !== 'string') return '';
	if (name.includes('�')) return '';
	if (/[\u3400-\u4DBF\uE000-\uF8FF]{3,}/.test(name)) return '';
	return name;
}

/** 保留 4 位小数 */
function round4(value) {
	return Math.round(value * 10000) / 10000;
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
	const xd = xiadanClient(ctx, cfg);

	// 工具面收窄(2026-10-29):toolDeny/toolAllow 通配符(* 任意段)过滤,未过检的工具不注册。
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
		description: '查询同花顺账户:assets(资产)/ positions(持仓)/ orders(当日委托)/ deals(当日成交)/ cancelable(可撤)。kind 参数选择。',
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
			return { [args.kind]: await xd.get(path) };
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
			// REST body 不含幂等键(它走 X-Xiadan-Idempotency-Key header)
			const body = { code: args.code, side: args.side, price: args.price };
			if (args.quantity != null) body.quantity = args.quantity;
			if (args.amount != null) body.amount = args.amount;
			if (args.reduce_only != null) body.reduce_only = args.reduce_only;
			// REST 层要求幂等键在 header
			const result = await request(ctx, cfg.xiadanBaseUrl, '/api/v1/trading/orders', {
				method: 'POST', body,
				headers: {
					Authorization: `Bearer ${cfg.xiadanApiKey}`,
					'X-Xiadan-Intent': 'real-trade',
					'X-Xiadan-Idempotency-Key': args.idempotency_key,
				},
				timeoutMs: cfg.requestTimeoutMs,
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
			// REST 端点用 camelCase(entrustNo/orderId);幂等键走 header,不进 body
			const body = {};
			if (args.entrust_no) body.entrustNo = args.entrust_no;
			if (args.code) body.code = args.code;
			if (args.scope) body.scope = args.scope;
			const result = await request(ctx, cfg.xiadanBaseUrl, '/api/v1/trading/cancels', {
				method: 'POST', body,
				headers: {
					Authorization: `Bearer ${cfg.xiadanApiKey}`,
					'X-Xiadan-Intent': 'real-trade',
					'X-Xiadan-Idempotency-Key': args.idempotency_key,
				},
				timeoutMs: cfg.requestTimeoutMs,
			}).then((envelope) => unwrapXiadan(envelope, 'trading/cancels'));
			return { cancel: result };
		},
	});

	/* ── 数据中心工具(ths-data-center:L2 云端指标/秒K/异动)────────── */

	const dc = {
		get: (path) => request(ctx, cfg.dataCenterBaseUrl, path, {
			headers: { 'X-API-Key': cfg.dataCenterApiKey },
			timeoutMs: cfg.requestTimeoutMs,
		}).then((envelope) => {
			if (!envelope || envelope.ok === false) {
				throw new Error(`data-center: ${envelope?.error ?? 'unknown error'}`);
			}
			return envelope.data ?? envelope;
		}),
		post: (path, body) => request(ctx, cfg.dataCenterBaseUrl, path, {
			method: 'POST',
			headers: { 'X-API-Key': cfg.dataCenterApiKey, 'Content-Type': 'application/json' },
			body: body ?? {}, // request() 内部统一 JSON.stringify,这里传原始对象
			timeoutMs: Math.max(cfg.requestTimeoutMs ?? 10000, 30000), // 问财 AI 摘要生成较慢
		}).then((envelope) => {
			if (!envelope || envelope.ok === false) {
				throw new Error(`data-center: ${envelope?.error ?? 'unknown error'}`);
			}
			return envelope.data ?? envelope;
		}),
		/** 自选股写接口通用请求(REST;上游 200 + ok:false 表示业务失败,须检查) */
		favRequest: (method, path, body) => request(ctx, cfg.dataCenterBaseUrl, path, {
			method,
			headers: { 'X-API-Key': cfg.dataCenterApiKey, 'Content-Type': 'application/json' },
			body,
			timeoutMs: cfg.requestTimeoutMs,
		}),
	};

	register({
		name: 'ths_fav_list_groups',
		description: '查看同花顺自选分组列表(数据中心 REST)。默认只返回分组骨架(名称/id/是否只读/股票数),withStocks=true 带组内股票明细。',
		parameters: {
			type: 'object',
			properties: {
				include_self: { type: 'boolean', description: '包含"我的自选"(默认 true)' },
				withStocks: { type: 'boolean', description: '带组内股票明细(默认 false,只给骨架)' },
			},
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const env = favGuard(await dc.favRequest('GET', `/api/favorites/groups?include_self=${args.include_self !== false}`));
			return args.withStocks ? env : slimGroups(env);
		},
	});

	register({
		name: 'ths_fav_get_self',
		description: '查看"我的自选"股票列表(数据中心 REST),尽力带最新行情(价格/涨跌幅/高低价)。输出已瘦身省上下文。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(args, exec) {
			const env = favGuard(await dc.favRequest('GET', '/api/favorites/self'));
			return slimStocks(env);
		},
	});

	register({
		name: 'ths_fav_add_group',
		description: '新建同花顺静态自定义分组(1-64 个可见字符)。动态分组/我的自选不可建。',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string', description: '新分组名称' } },
			required: ['name'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return favGuard(await dc.favRequest('POST', '/api/favorites/groups', { name: args.name }));
		},
	});

	register({
		name: 'ths_fav_delete_group',
		description: '删除静态自定义分组(传名称或 group_id)。我的自选/动态分组不可删。',
		parameters: {
			type: 'object',
			properties: { group: { type: 'string', description: '分组名称或 group_id' } },
			required: ['group'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return favGuard(await dc.favRequest('DELETE', '/api/favorites/groups', { group: args.group }));
		},
	});

	register({
		name: 'ths_fav_add_stock',
		description: '批量添加股票到指定自选分组(数据中心 REST,直写手机同花顺自选)。支持 A股/ETF/北交/港股/美股,如 600519.SH / 510300 / 00700.HK / AAPL。单次最多 200 个,返回逐只成功/失败明细。',
		parameters: {
			type: 'object',
			properties: {
				group: { type: 'string', description: '分组名称或 group_id;"我的自选"用 __selfstock__' },
				symbols: { type: 'array', items: { type: 'string' }, description: '股票代码数组' },
			},
			required: ['group', 'symbols'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const env = await dc.favRequest('POST', '/api/favorites/stocks', { group: args.group, symbols: args.symbols });
			if (env?.ok === false && !Array.isArray(env?.results)) {
				throw new Error(`favorites: ${env?.error ?? 'add failed'}`);
			}
			// ok:false 但有 results = 部分成功,原样返回明细由调用方判断
			return {
				ok: env?.ok, succeeded: env?.succeeded, failed: env?.failed,
				message: env?.message,
				failures: (env?.results ?? []).filter((r) => r.status_code !== 0)
					.map((r) => ({ stock: r.stock, status_msg: r.status_msg })),
			};
		},
	});

	register({
		name: 'ths_fav_remove_stock',
		description: '批量删除指定自选分组中的股票(数据中心 REST)。单次最多 200 个,返回逐只成功/失败明细。',
		parameters: {
			type: 'object',
			properties: {
				group: { type: 'string', description: '分组名称或 group_id' },
				symbols: { type: 'array', items: { type: 'string' }, description: '股票代码数组' },
			},
			required: ['group', 'symbols'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const env = await dc.favRequest('DELETE', '/api/favorites/stocks', { group: args.group, symbols: args.symbols });
			if (env?.ok === false && !Array.isArray(env?.results)) {
				throw new Error(`favorites: ${env?.error ?? 'remove failed'}`);
			}
			return {
				ok: env?.ok, succeeded: env?.succeeded, failed: env?.failed,
				message: env?.message,
				failures: (env?.results ?? []).filter((r) => r.status_code !== 0)
					.map((r) => ({ stock: r.stock, status_msg: r.status_msg })),
			};
		},
	});

	register({
		name: 'ths_fav_sort_group',
		description: '保存静态自定义分组内排序(数据中心 REST)。ordered_symbols 是目标顺序;未列出的按原顺序追加。不支持我的自选/动态分组。',
		parameters: {
			type: 'object',
			properties: {
				group: { type: 'string', description: '分组名称或 group_id' },
				ordered_symbols: { type: 'array', items: { type: 'string' }, description: '目标顺序,如 ["000001.33","600519.17"]' },
			},
			required: ['group', 'ordered_symbols'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return favGuard(await dc.favRequest('POST', '/api/favorites/groups/sort', {
				group: args.group, ordered_symbols: args.ordered_symbols,
			}));
		},
	});

	register({
		name: 'ths_fav_share_group',
		description: '创建静态自定义分组分享链接(数据中心 REST)。valid_time 为有效期秒数(最大 10 年),分享地址在 result 中。',
		parameters: {
			type: 'object',
			properties: {
				group: { type: 'string', description: '分组名称或 group_id' },
				valid_time: { type: 'integer', description: '有效期(秒)' },
			},
			required: ['group', 'valid_time'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			return favGuard(await dc.favRequest('POST', '/api/favorites/groups/share', {
				group: args.group, valid_time: args.valid_time,
			}));
		},
	});

	/* ── AI 信号引擎(ths-ai-signal-trader:接收信号,评分动态定参,自动建条件单)── */

	/** 查询用管理 token;投递必须用独立 webhook token,不走同步 /api/signal。 */
	const st = {
		get: (path) => request(ctx, cfg.signalTraderBaseUrl, path, {
			headers: cfg.signalTraderWebuiToken ? { 'X-Access-Token': cfg.signalTraderWebuiToken } : {},
			timeoutMs: cfg.requestTimeoutMs,
		}),
		post: (path, body) => request(ctx, cfg.signalTraderBaseUrl, path, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(cfg.signalTraderWebuiToken ? { 'X-Access-Token': cfg.signalTraderWebuiToken } : {}),
			},
			body,
			timeoutMs: cfg.requestTimeoutMs,
		}),
		postWebhook: (path, body, raw = false) => request(ctx, cfg.signalTraderBaseUrl, path, {
			method: 'POST',
			headers: {
				'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json',
				'X-Webhook-Token': cfg.signalTraderWebhookToken,
			},
			body,
			timeoutMs: cfg.requestTimeoutMs,
		}),
	};

	register({
		name: 'ths_signal_status',
		description: '查看 AI 信号引擎(ths-ai-signal-trader)状态:健康、今日信号、本地在途条件单、动态重评调度。信号引擎接收 AI 分时顶底信号后按评分动态定参建拐点条件单(回落卖出/反弹买入)。',
		parameters: {
			type: 'object',
			properties: {
				limit: { type: 'integer', description: '今日信号/在途单返回条数上限(默认 10)' },
			},
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			if (!cfg.signalTraderBaseUrl) throw new Error('signalTraderBaseUrl 未配置');
			const limit = args.limit ?? 10;
			const [health, signals, local, reeval] = await Promise.all([
				st.get('/health').catch((e) => ({ error: String(e?.message ?? e) })),
				st.get('/api/signals/today').catch((e) => ({ error: String(e?.message ?? e) })),
				st.get('/api/local-execution/today').catch((e) => ({ error: String(e?.message ?? e) })),
				st.get('/api/dynamic-reeval/status').catch((e) => ({ error: String(e?.message ?? e) })),
			]);
			// 信号列表瘦身:保留决策摘要字段(undefined 一律不设键,过 lossless JSON 校验)
			const sigArr = Array.isArray(signals) ? signals : (signals?.items ?? signals?.signals ?? []);
			const slimSignals = (Array.isArray(sigArr) ? sigArr : []).slice(-limit).map((s) => {
				const row = {
					at: s.processed_at, name: s.stock_name, code: s.stock_code,
					type: s.signal_type, mode: s.execution_mode, outcome: s.outcome,
					signalPrice: s.signal_price, triggerPrice: s.trigger_price,
					quantity: s.entrust_quantity, turnBackPct: s.turn_back_percent,
					confirmTimes: s.confirm_times,
				};
				const score = s.decision?.score ?? s.decision?.detail?.score;
				if (score != null) row.score = score;
				const tier = s.decision?.tier ?? s.decision?.detail?.tier;
				if (tier != null) row.tier = tier;
				if (s.decision?.regime != null) row.regime = s.decision.regime;
				if (s.dedup_reason) row.dedup = s.dedup_reason;
				return row;
			});
			// 在途条件单瘦身
			const locArr = Array.isArray(local?.items) ? local.items : [];
			const slimLocal = locArr.slice(-limit).map((c) => {
				const row = {
					name: c.stock_name, code: c.stock_code, direction: c.direction,
					status: c.status, route: c.execution_route, mode: c.execution_mode,
					quantity: c.quantity, extreme: c.extreme_price,
					targetPct: c.target_pct, confirmSec: c.confirm_target_seconds,
					current: c.current_price,
					adjusts: (c.dynamic_adjust_history ?? []).length,
				};
				if (c.move_pct != null && Number.isFinite(c.move_pct)) {
					row.movePct = Math.round(c.move_pct * 100) / 100;
				}
				const lastAdjust = (c.dynamic_adjust_history ?? []).slice(-1)[0]?.reason;
				if (lastAdjust) row.lastAdjust = lastAdjust;
				return row;
			});
			const out = { baseUrl: cfg.signalTraderBaseUrl };
			if (health?.status === 'ok') {
				out.health = {
					status: 'ok',
					orderRoute: health.order_route,
					executionBackend: health.execution_backend,
					backendStatus: health.backend_status,
					backendReachable: health.backend_reachable,
					dryRun: health.dry_run,
					tradingTime: health.quote_observations?.trading_time ?? null,
					pollingAlive: health.quote_observations?.polling_alive ?? null,
				};
			} else {
				out.health = health ?? { status: 'unknown' };
			}
			out.todaySignals = (Array.isArray(signals) || (Array.isArray(sigArr) && sigArr.length))
				? { count: Array.isArray(sigArr) ? sigArr.length : 0, items: slimSignals }
				: (signals ?? { note: 'unavailable' });
			out.activeConditions = local?.enabled == null ? (local ?? { note: 'unavailable' }) : {
				count: locArr.length, route: local.execution_route, items: slimLocal,
			};
			out.dynamicReeval = reeval?.enabled == null ? (reeval ?? { note: 'unavailable' }) : {
				enabled: reeval.enabled,
				intervalSeconds: reeval.interval_seconds ?? null,
				tracking: (reeval.conditions ?? []).length,
			};
			return out;
		},
	});

	register({
		name: 'ths_signal_explain',
		description: '只读解释 AI 分时信号决策:初始评分/盘面证据、回落反弹阈值与确认、动态调参原因、当前触发进度、去重拦截和执行回报。按 code/condition_id 查询今日记录;不重新评分、不修改条件、不交易。区分信号接收/条件创建/委托成交,展示每笔实际 execution_route。',
		parameters: {
			type: 'object',
			properties: {
				code: { type: 'string', description: '六位证券代码(可选)' },
				condition_id: { type: 'string', description: '本地条件单 ID(可选,优先精确匹配)' },
				limit: { type: 'integer', description: '返回最近几条信号,默认 5,最大 20' },
			},
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const limit = Math.min(20, Math.max(1, args.limit ?? 5));
			const [signals, local] = await Promise.all([
				st.get('/api/signals/today'),
				st.get('/api/local-execution/today'),
			]);
			const signalRows = Array.isArray(signals?.items) ? signals.items : [];
			const conditionRows = Array.isArray(local?.items) ? local.items : [];
			const items = buildSignalExplanations(signalRows, conditionRows, { code: args.code, conditionId: args.condition_id, limit });
			return JSON.parse(JSON.stringify({
				date: signals?.date ?? null,
				count: items.length,
				items,
				note: '仅整理引擎已有审计记录;强度评分是动能评分,不是上涨概率。无本地条件记录不代表已下单或成交。',
			}));
		},
	});

	register({
		name: 'ths_signal_send',
		description: '向 AI 信号引擎(ths-ai-signal-trader)发送一条交易信号:引擎按 strategy_v2.0 评分(强弱+位置+MACD结构门禁)动态定参,自动建拐点条件单(回落卖出/反弹买入)并实盘下单。用法:stock_name+signal_type 直达,quantity 覆盖单次委托数量(缺省用引擎预设);或传 text 让引擎自己解析。触发参数由引擎动态决定。统一经持久化 webhook 入队(结构化走 /webhook/structured,原始文本走 /webhook),由后台 worker 评分和建条件。插件不预检运行路由/账户/网关;执行路由与实盘开关由用户手动配置。返回 queued 仅表示信号已接收/去重结果,不代表已建条件、已下单或成交;用 ths_signal_status/ths_signal_explain 跟踪。',
		parameters: {
			type: 'object',
			properties: {
				stock_name: { type: 'string', description: '股票名称(与 signal_type 一起直达,如 "兆威机电")' },
				signal_type: { type: 'string', description: 'fall_sell(高点信号→回落卖出)| rebound_buy(低点信号→反弹买入)' },
				stock_code: { type: 'string', description: '6 位证券代码(可选,避免同名歧义)' },
				quantity: { type: 'integer', description: '单次委托数量(股,可选;缺省用引擎预设数量)。比例类口述(卖一半)先查持仓换算成股数再传' },
				skip_dedup: { type: 'boolean', description: '绕过引擎去重窗口(默认 false)。显式指令重复下发时用' },
				trigger_price: { type: 'number', description: '信号价(可选;缺省由引擎按行情取)' },
				text: { type: 'string', description: '原始信号文本(可选,引擎自动解析,如同花顺推送原文)' },
			},
			required: [],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			if (!cfg.signalTraderBaseUrl) throw new Error('signalTraderBaseUrl 未配置');
			if (!cfg.signalTraderWebhookToken) throw new Error('signalTraderWebhookToken 未配置,无法使用持久化 webhook 投递');
			const body = {};
			if (args.stock_name && args.signal_type) {
				body.stock_name = args.stock_name;
				body.signal_type = args.signal_type;
				if (args.stock_code) body.stock_code = args.stock_code;
				if (args.quantity != null) body.quantity = args.quantity;
				if (args.skip_dedup) body.skip_dedup = true;
				if (args.trigger_price != null) body.trigger_price = args.trigger_price;
			} else if (args.text) {
				body.text = args.text;
				if (args.quantity != null) body.quantity = args.quantity;
				if (args.skip_dedup) body.skip_dedup = true;
			} else {
				throw new Error('需要 stock_name+signal_type,或 text');
			}
			const rawText = typeof body.text === 'string';
			const path = rawText ? '/webhook' : '/webhook/structured';
			const result = await st.postWebhook(path, rawText ? body.text : body, rawText);
			return { queued: true, transport: 'persistent_webhook', path, sent: body, result };
		},
	});

	// 规则管理工具:模型在会话里动态加删规则。
	// 两类:提醒型(无 action,触发唤醒复核)/条件单型(有 action,触发自动执行)。
	register({
		name: 'ths_cancel_all',
		description: '撤销全部可撤委托(应急清场),无审批门。工具内部先读取 cancelable 再逐笔撤销,无需用户二次确认。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(args, exec) {
			const cancelable = await xd.get('/api/v1/account/cancelable');
			const orders = cancelable?.result?.data?.order ?? {};
			const flat = [];
			for (const [code, list] of Object.entries(orders)) {
				for (const o of list ?? []) flat.push({ code, htbh: o.htbh });
			}
			const results = [];
			for (const { code, htbh } of flat) {
				try {
					const r = await request(ctx, cfg.xiadanBaseUrl, '/api/v1/trading/cancels', {
						method: 'POST',
						body: { entrustNo: String(htbh), scope: 'contract' },
						headers: {
							Authorization: `Bearer ${cfg.xiadanApiKey}`,
							'X-Xiadan-Intent': 'real-trade',
							'X-Xiadan-Idempotency-Key': `cancelall-${htbh}-${nowKey()}`,
						},
						timeoutMs: cfg.requestTimeoutMs,
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
