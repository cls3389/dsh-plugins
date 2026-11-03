/**
 * @dsh-friends/ths-market — DSH Cordis adapter.
 *
 * Market protocols, decoding and aggregation belong to ths-data-hub. This
 * module only registers the established tools, resolves per-user connections,
 * forwards watch rules, and delivers central watch notifications.
 */
import fs from 'node:fs';
import { createServer } from 'node:http';
import { connectionForExecution } from '../../lib/user-connections.js';
import { identityOf, principalKey } from '../feishu-principal/index.js';
import { deliverWatchWake } from './watch-wake.js';

const name = 'ths-market';
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	fqgateBaseUrl: '',
	fqgateInstanceId: '',
	dataCenterBaseUrl: '',
	dataCenterApiKey: '',
	dataCenterApiKeyFile: process.env.THS_DATA_HUB_TOKEN_FILE || '',
	// 身份簇默认应用：飞书用户 u_xxx 归属解析用（与 ths-favorites 一致）。
	defaultAppId: '',
	requestTimeoutMs: 15000,
	watchEnabled: false,
	watchServiceBaseUrl: '',
	watchServiceToken: '',
	watchServiceTokenFile: '',
	watchWakeBridgeEnabled: false,
	watchWakeBridgePort: 17921,
	toolDeny: [],
	toolAllow: [],
};

function readToken(direct, file) {
	const token = String(direct ?? '').trim();
	if (token) return token;
	if (!file) return '';
	try { return fs.readFileSync(file, 'utf8').trim(); }
	catch { return ''; }
}

/** 少数工具的专用超时（毫秒）：个别上游天生慢，不能用通用 requestTimeoutMs 卡死。
 *  ths_yield_curve：美国财政部官网 CSV 实测 TTFB 18.6s（DNS/连接均正常，是服务端慢），
 *  且该数据为官方每日发布（日频），等待成本可接受。2026-11-03 实测 15s 默认值必然超时。 */
const TOOL_TIMEOUT_OVERRIDE_MS = {
	ths_yield_curve: 45000,
};

function marketToken(cfg) {
	return readToken(cfg.dataCenterApiKey, cfg.dataCenterApiKeyFile)
		|| readToken(cfg.watchServiceToken, cfg.watchServiceTokenFile);
}

function watchToken(cfg) {
	return readToken(cfg.watchServiceToken, cfg.watchServiceTokenFile)
		|| readToken(cfg.dataCenterApiKey, cfg.dataCenterApiKeyFile);
}

function identityHeaders(agent) {
	return {
		'X-THS-Open-Id': agent?.larkUser?.openId ?? identityOf(agent)?.subjectId ?? '',
		'X-THS-App-Id': agent?.larkUser?.appId ?? identityOf(agent)?.appId ?? '',
		'X-THS-Session-Id': agent?.session?.header?.id ?? '',
	};
}

/** 每用户凭据归属（问财等）：飞书身份→u_xxx；Web(无飞书身份)→null 走中心 owner 映射。
 *  有飞书身份但解析不出 userId = 身份不可信，直接报错引导登录，绝不静默回退 owner。 */
function resolveUserId(exec, cfg) {
	const identity = identityOf(exec?.agent);
	const openId = exec?.agent?.larkUser?.openId ?? identity?.subjectId;
	if (typeof openId !== 'string' || !openId.startsWith('ou_')) return null; // Web：走 owner
	const appId = exec?.agent?.larkUser?.appId ?? identity?.appId;
	// 未配 defaultAppId 时身份簇就是该 agent 自己的 appId（与 principalKey 语义一致）。
	return principalKey(openId, appId, cfg.defaultAppId || appId);
}

async function errorMessage(response, body, fallback) {
	if (body && typeof body === 'object') {
		const error = body.error;
		if (typeof error === 'string') return error;
		if (typeof error?.message === 'string') return error.message;
	}
	return `${fallback} HTTP ${response.status}`;
}

/** The sole request path for all ten market tools. */
async function marketTool(exec, cfg, toolName, args, timeoutOverrideMs) {
	// Resolve on every invocation: user configuration and token files can change.
	const userCfg = connectionForExecution(exec, cfg, 'market');
	const base = String(userCfg.dataCenterBaseUrl || userCfg.watchServiceBaseUrl || userCfg.fqgateBaseUrl || '').replace(/\/+$/, '');
	if (!base) throw new Error('数据中心地址未配置(dataCenterBaseUrl/watchServiceBaseUrl)');
	const headers = {
		'X-API-Key': marketToken(userCfg),
		'Content-Type': 'application/json',
		...identityHeaders(exec?.agent),
	};
	// 每用户凭据归属：飞书用户带 u_xxx，Web owner 留空走中心 owner 映射。
	const userId = resolveUserId(exec, cfg);
	if (userId) headers['X-THS-User-Id'] = userId;
	if (userCfg.fqgateInstanceId) headers['X-FQGate-Instance-Id'] = String(userCfg.fqgateInstanceId);
	const response = await fetch(`${base}/api/tools/market/${toolName}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ arguments: args }),
		signal: AbortSignal.timeout(
			timeoutOverrideMs ?? TOOL_TIMEOUT_OVERRIDE_MS[toolName] ?? userCfg.requestTimeoutMs ?? 15000,
		),
	});
	const data = await response.json().catch(() => null);
	if (!response.ok || data?.ok !== true || !Object.hasOwn(data ?? {}, 'data')) {
		throw new Error(await errorMessage(response, data, '数据中心'));
	}
	return data.data;
}

/** Watch management remains a thin client of the one central evaluator. */
function createWatchServiceClient(cfg) {
	const baseUrl = String(cfg.watchServiceBaseUrl ?? '').replace(/\/+$/, '');
	const token = watchToken(cfg);
	if (!baseUrl || !token) throw new Error('独立盯盘服务缺少 watchServiceBaseUrl 或 token');
	const call = async (method, path, { body, agent } = {}) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				...identityHeaders(agent),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(cfg.requestTimeoutMs ?? 15000),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(await errorMessage(response, data, '盯盘服务'));
		return data;
	};
	return {
		addRule: (args, agent) => call('POST', '/v1/rules', { body: args, agent }),
		status: (openId, appId, historyLimit) => call('GET', `/v1/status?openId=${encodeURIComponent(openId ?? '')}&appId=${encodeURIComponent(appId ?? '')}${historyLimit == null ? '' : `&history_limit=${encodeURIComponent(historyLimit)}`}`),
		removeRule: (id, agent) => call('DELETE', `/v1/rules/${encodeURIComponent(id)}`, { agent }),
		updateRule: (id, patch, agent) => call('PATCH', `/v1/rules/${encodeURIComponent(id)}`, { body: patch, agent }),
	};
}

/** big_order requires the unavailable LV2/WS standard subscription. */
function assertWatchSubscriptionSupported(args) {
	const types = [args?.type, ...(Array.isArray(args?.and) ? args.and.map((item) => item?.type) : [])];
	if (types.includes('big_order')) {
		throw new Error('big_order 大单盯盘依赖 LV2/WS 订阅，当前上游标准订阅未实现，已禁用；请改用普通价格/涨跌幅/回落反弹盯盘，或用 ths_level2 主动查询盘口与逐笔');
	}
}

function validateWatchRule(args) {
	if (!cfgTypeAllowed(args.type)) throw new Error(`未知盯盘类型: ${args.type}`);
	assertWatchSubscriptionSupported(args);
	if (!Number.isFinite(args.threshold) || args.threshold <= 0) throw new Error('threshold 必须是正数');
	for (const condition of args.and ?? []) {
		if (!['price_above', 'price_below', 'change_above', 'change_below'].includes(condition?.type)) {
			throw new Error('and 子条件仅支持 price_above/price_below/change_above/change_below');
		}
		if (!Number.isFinite(condition.threshold) || condition.threshold <= 0) throw new Error('and 子条件 threshold 必须是正数');
	}
	if (Object.hasOwn(args, 'action')) throw new Error('行情盯盘仅支持提醒，不接受 action 交易动作');
}

function cfgTypeAllowed(type) {
	return ['price_above', 'price_below', 'change_above', 'change_below', 'pullback_sell', 'rebound_buy', 'big_order'].includes(type);
}

function renderJson(value, budget = 6000) {
	const text = JSON.stringify(value, null, 1);
	return text.length > budget
		? { type: 'text', text: `${text.slice(0, budget)}\n…(已截断,共 ${text.length} 字符)` }
		: { type: 'text', text };
}

const anyJsonOutput = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => [renderJson(value)],
};

const MARKET_TOOLS = [
	{
		name: 'ths_quote',
		description: '查询单只或多只证券最新行情快照（统一行情中心，价格和涨跌等数值优先使用本工具）。快照是否实时以源时间与 freshness 为准；收到响应时间不是行情时间。支持 A 股/ETF/指数/可转债/港股/美股个股,返回价格、涨跌幅、成交量额等。securities 支持形如 "600519"、"SH600519" 的代码;可转债 "123241"、"USZB123241" 及 110/111/113/118(沪)、120/123/127/128(深) 号段;A 股指数用 "USHI1A0001"(上证)/"USZI399001"/"USZI399006";港股 "UHKMHK0700";**美股个股须加 UNQQ 前缀**,如 "UNQQAAPL"(苹果)/"UNQQNVDA"(英伟达)/"UNQQTSLA"(特斯拉)。本工具当前不覆盖纳指/标普/道指等美股指数；优先使用可用的专用行情源，明确缺少行情能力时才用问财补充并核对日期与来源。',
		parameters: { type: 'object', properties: {
			securities: { type: 'array', items: { type: 'string' }, description: '证券代码列表,如 ["600519","SZ000001","USHI1A0001","123241"];指数用 ths_search 返回的完整 ths_code;可转债可直接用六位代码' },
			fields: { type: 'array', items: { type: ['integer', 'string'] }, description: '可选 V2 标准字段名；旧数字编号会转换为标准字段。省略返回全部常用字段' },
		}, required: ['securities'] },
	},
	{
		name: 'ths_yield_curve',
		description: '查询美国财政部官方每日国债收益率曲线（名义 par yield，单位 %），含 2Y/10Y/30Y 及完整期限、相对上一发布日基点变化。不是同花顺证券行情，也不是国债 ETF 价格；适用于美债收益率与历史宏观复盘。date 可指定 YYYY-MM-DD，取该日或之前最近发布日；省略取最新发布值，不是实时盘中利率。',
		parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '可选，查询该日或之前最近发布日，格式 YYYY-MM-DD' } }, additionalProperties: false },
	},
	{
		name: 'ths_klines',
		description: '查询证券历史 K 线。分钟(1m/5m/15m/30m/60m/120m)使用数据中心且仅支持前复权，日线及以上使用 FQGate V2。count 与 start_date/end_date 二选一（不要同时传）。指数代码同 ths_quote,如 USHI1A0001;可转债如 123241/110092。当前数据中心分钟 K 仅返回沪深普通股票；ETF/可转债/指数分钟 K 和 FQGate 季/年 K 暂不支持，返回空数据或能力错误时勿重复重试。',
		parameters: { type: 'object', properties: {
			code: { type: 'string', description: '证券代码,如 600519;指数用完整代码 USHI1A0001 / USZI399001;可转债如 123241/110092' },
			interval: { type: 'string', description: 'K 线周期:1m/5m/15m/30m/60m/120m/day/week/month/quarter/year' },
			count: { type: 'integer', description: '返回最近 N 根(与 start_date/end_date 二选一,勿同时传)' },
			start_date: { type: 'string', description: 'YYYYMMDD(与 count 二选一,勿同时传)' },
			end_date: { type: 'string', description: 'YYYYMMDD' },
			adjust: { type: 'string', description: '复权:None 不复权 / forward 前复权 / backward 后复权' },
		}, required: ['code', 'interval'] },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, Math.max(12000, Math.min(60000, (value.klines?.count ?? 0) * 220 + 2000)))] },
	},
	{
		name: 'ths_search',
		description: '按名称、代码或拼音搜索证券，确认市场与代码。当前覆盖A股、ETF及港股，不支持美股搜索；已知有效代码可直接查询行情，无需重复搜索。',
		parameters: { type: 'object', properties: { pattern: { type: 'string', description: '搜索关键字:名称、代码或拼音缩写' } }, required: ['pattern'] },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, Math.max(12000, (value.symbols?.count ?? 0) * 180 + 1000))] },
	},
	{
		name: 'ths_level2',
		description: '查询 Level-2 深度数据(FQGate):十档盘口、逐笔成交、逐笔委托。kind: depth / transactions / orders。',
		parameters: { type: 'object', properties: {
			kind: { type: 'string', description: 'depth(十档盘口,多证券) / transactions(逐笔成交) / orders(逐笔委托)' },
			code: { type: 'string', description: '证券代码；逗号分隔多标的等价于 codes' },
			codes: { type: 'array', items: { type: 'string' }, description: '多标的代码；仅 depth 支持，如 ["600519","300870"]' },
			count: { type: 'integer', description: 'transactions/orders 返回条数' },
		}, required: ['kind'] },
	},
	{
		name: 'ths_market_pulse',
		description: 'A股大盘统计与热点摘要：涨跌家数、各独立来源涨跌停统计、昨日涨停/上涨股今日表现、热点最新日双向各10及综合前10、完整紧凑涨跌停名单。输出pulse.schema说明字段/单位/来源及截断；distribution.rawBuckets精确边界未校准，moneyEffect档位未校准且zxb为遗留字段，不能自行反推标签或混用不同口径计算炸板率。retrievedAt是取回时间，非行情源时间。',
		parameters: { type: 'object', properties: { withLimitStocks: { type: 'boolean', description: '附带今日涨停股名单(默认 true)' }, withHotPlates: { type: 'boolean', description: '附加热点板块(默认 true)' } } },
	},
	{
		name: 'ths_sec_kline',
		description: '查询沪深普通股票秒级K线，time_period可选1/5/10/15/30/45秒，market用SZ/SH且必须与证券匹配。当前ETF/指数等资产覆盖未确认，返回显式capability；空数组不能解释为无成交或零价格，不反复请求已说明的能力缺口。',
		parameters: { type: 'object', properties: {
			market: { type: 'string', description: 'SZ | SH' }, code: { type: 'string', description: '证券代码,如 003021' },
			time_period: { type: 'string', description: 'sec_1 | sec_5 | sec_10 | sec_15 | sec_30 | sec_45' }, count: { type: 'integer', description: '返回最近 N 根,默认 120' },
		}, required: ['market', 'code'] },
	},
	{
		name: 'ths_move_detail',
		description: '查询市场异动明细(数据中心):板块走强/走弱异动流,带成分股与资金。适合持仓股触发时归因(是个股问题还是板块带崩)。',
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'ths_margin_collateral',
		description: '查询华宝证券官网"可充抵保证金证券"列表(融资融券折算率)。支持按证券代码或简称搜索,或按页码浏览。字段:证券代码、简称、品种、折算率(%)、集中度分组。两融保证金计算必备。',
		parameters: { type: 'object', properties: { query: { type: 'string', description: '证券代码(如 000001 或 000001.sz)或简称(如 平安银行),支持模糊匹配;与 page 二选一' }, page: { type: 'number', description: '浏览模式页码,默认 1(每页 24 条)' } } },
	},
];

function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	const toolPattern = (pattern) => new RegExp('^' + String(pattern).split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
	const toolAllowed = (toolName) => {
		if ((cfg.toolDeny ?? []).some((pattern) => toolPattern(pattern).test(toolName))) return false;
		const allow = cfg.toolAllow ?? [];
		return allow.length === 0 || allow.some((pattern) => toolPattern(pattern).test(toolName));
	};
	const register = (def) => {
		if (toolAllowed(def.name)) ctx.tools.register(def);
		else ctx.logger.info?.(`[ths-market] ${def.name}: skipped (toolDeny/toolAllow)`);
	};
	for (const def of MARKET_TOOLS) register({
		...def, output: def.output ?? anyJsonOutput,
		execute: (args, exec) => marketTool(exec, cfg, def.name, args),
	});
	const watchClient = cfg.watchServiceBaseUrl ? createWatchServiceClient(cfg) : null;
	register({
		name: 'ths_watch_add',
		description: '创建当前用户的行情提醒规则：支持价格、涨跌幅、从高点回落及从低点反弹条件，and 子条件须全部命中。中心共享采样并在触发后提醒与唤醒 Agent，不提交交易委托；不传 action。big_order 大单订阅未实现，不支持创建；盘口和逐笔查询用 ths_level2。oneShot 默认 true，触发一次后停止。',
		parameters: { type: 'object', properties: {
			code: { type: 'string', description: '证券代码' },
			type: { type: 'string', description: 'price_above | price_below | change_above | change_below | pullback_sell | rebound_buy。pullback_sell/rebound_buy 的 threshold 是回落/反弹百分比；big_order 已禁用' },
			threshold: { type: 'number', description: '阈值：price_* 为价格，change_* 为相对前收涨跌百分比，pullback_sell/rebound_buy 为从极值回落/反弹百分比；百分比填3代表3%' },
			anchorPrice: { type: 'number', description: '拐点初始锚定价；缺省用启用后的首个报价，后续按新极值更新，不自动使用全天高低点' },
			expiresAt: { type: 'string', format: 'date-time', description: '可选到期时间RFC3339，必须在未来，例如2026-11-03T15:00:00+08:00；到期后停止评估和采样但保留可查。日内规则应填写' },
			confirmSeconds: { type: 'number', description: '拐点型连续确认秒数,默认 3;新极值出现会重置确认' },
			cooldownMinutes: { type: 'integer', description: '同规则冷却分钟数,默认 15' },
			oneShot: { type: 'boolean', description: '默认 true：触发提醒一次后停止；false：冷却后可再次提醒' },
			note: { type: 'string', description: '备注(触发消息里带上)' },
			and: { type: 'array', description: '复合条件(可选):子条件数组,全部命中才触发。子条件只支持瞬时阈值型(price_*/change_*),如 [{type:"change_below", threshold:3}]', items: { type: 'object' } },

		}, required: ['code', 'type', 'threshold'] },
		output: anyJsonOutput,
		async execute(args, exec) {
			if (!cfg.watchEnabled) throw new Error('盯盘引擎未开启:在 profile 配置里设 watchEnabled: true 并重载');
			validateWatchRule(args);
			if (!watchClient) throw new Error('独立盯盘服务未配置 watchServiceBaseUrl；不再创建进程内盯盘引擎');
			return watchClient.addRule(args, exec.agent);
		},
	});
	register({
		name: 'ths_watch_list',
		description: '查看共享行情提醒引擎的健康与采样状态、当前用户可见的提醒规则及最近触发记录。此工具不查询证券账户、交易条件单或下单限额；采样就绪与服务存活须分别判断。',
		parameters: { type: 'object', properties: { history_limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回最近可见触发历史条数，默认10，最大200；以triggerHistoryPage核对截断范围' } } }, output: anyJsonOutput,
		execute(args, exec) {
			if (!watchClient) throw new Error('独立盯盘服务未配置 watchServiceBaseUrl');
			return watchClient.status(exec.agent?.larkUser?.openId ?? identityOf(exec.agent)?.subjectId, exec.agent?.larkUser?.appId ?? identityOf(exec.agent)?.appId, args?.history_limit);
		},
	});
	register({
		name: 'ths_watch_update',
		description: '原位更新本人行情提醒的阈值、锚点、备注、到期时间或频率，保留规则ID、归属与触发历史；不支持改证券、规则类型、会话归属。threshold/anchorPrice实际变化会重置拐点观察进度，冷却和历史仍保留；只改备注/期限不会重置。优先原位更新，避免删建丢状态。',
		parameters: { type: 'object', additionalProperties: false, properties: {
			id: { type: 'string', description: '规则ID，ths_watch_list可查' },
			threshold: { type: 'number', description: '新阈值，与创建时口径一致' },
			anchorPrice: { type: ['number', 'null'], description: '新拐点初始锚点；null清空，后续按观察极值推进' },
			note: { type: 'string', description: '新备注，日内基准写绝对日期、来源及可用复核路径' },
			expiresAt: { type: ['string', 'null'], description: '未来RFC3339到期时间，null取消期限；到期后停止评估' },
			confirmSeconds: { type: 'integer', description: '拐点连续确认秒数' },
			cooldownMinutes: { type: 'integer', description: '重复提醒冷却分钟数' },
			oneShot: { type: 'boolean', description: 'true一次提醒后停止；false冷却后可重复' },
		}, required: ['id'] }, output: anyJsonOutput,
		execute(args, exec) {
			if (!watchClient) throw new Error('独立盯盘服务未配置 watchServiceBaseUrl');
			const { id, ...patch } = args;
			return watchClient.updateRule(id, patch, exec.agent);
		},
	});
	register({
		name: 'ths_watch_remove',
		description: '删除盯盘规则(按 add 返回的 id)。',
		parameters: { type: 'object', properties: { id: { type: 'string', description: '规则 id(ths_watch_list 可查)' } }, required: ['id'] }, output: anyJsonOutput,
		async execute(args, exec) {
			if (!watchClient) throw new Error('独立盯盘服务未配置 watchServiceBaseUrl');
			const result = await watchClient.removeRule(args.id, exec.agent);
			return { removed: result.removed };
		},
	});
	// Each assistant bridge hands notifications to its owning Feishu channel.
	// Success means durable acceptance; the channel delivers and retries the reply.
	if (cfg.watchWakeBridgeEnabled && cfg.watchServiceBaseUrl) {
		const token = watchToken(cfg);
		const port = Number(cfg.watchWakeBridgePort ?? 17921);
		const server = createServer(async (req, res) => {
			const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
			try {
				if (req.method !== 'POST' || !['/wake', '/session-alias'].includes(req.url)) return send(404, { error: 'not_found' });
				if (!token || req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
				let body = '';
				for await (const chunk of req) { body += chunk; if (body.length > 256 * 1024) throw new Error('wake body too large'); }
				const payload = JSON.parse(body || '{}');
				if (req.url === '/session-alias') {
					const notifications = ctx.get('feishuNotifications');
					if (typeof notifications?.rebindPreviousSession !== 'function') return send(503, { error: 'notification session binding service unavailable' });
					await notifications.rebindPreviousSession(payload);
					return send(200, { ok: true });
				}
				const { rule, text, sessionId, eventId } = payload;
				if (!rule?.id || typeof text !== 'string') return send(400, { error: 'rule and text required' });
				await deliverWatchWake(ctx, cfg, rule, text, sessionId, eventId);
				send(200, { ok: true });
			} catch (error) {
				ctx.logger.warn(`ths-watch wake bridge: ${error?.message ?? error}`);
				send(500, { error: String(error?.message ?? error) });
			}
		});
		new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); })
			.then(() => ctx.logger.info(`ths-watch wake bridge listening on 127.0.0.1:${port}`))
			.catch((error) => ctx.logger.warn(`ths-watch wake bridge listen failed: ${error?.message ?? error}`));
		ctx.effect(() => () => new Promise((resolve) => server.close(resolve)));
	}
}

export { apply, inject, name, assertWatchSubscriptionSupported, deliverWatchWake, createWatchServiceClient };
