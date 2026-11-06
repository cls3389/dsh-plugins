/**
 * @dsh-friends/market-data — DSH Cordis adapter.
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
import { limitUpTools, limitUpPoolOutput } from './limit-up-tools.js';

const name = 'market-data';
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
 *  mkt_yield_curve：美国财政部官网 CSV 实测 TTFB 18.6s（DNS/连接均正常，是服务端慢），
 *  且该数据为官方每日发布（日频），等待成本可接受。2026-11-03 实测 15s 默认值必然超时。 */
const TOOL_TIMEOUT_OVERRIDE_MS = {
	mkt_yield_curve: 45000,
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

/** Shared authenticated client for market tools and public hub APIs. */
async function marketRequest(exec, cfg, path, body, timeoutOverrideMs) {
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
	const response = await fetch(`${base}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutOverrideMs ?? userCfg.requestTimeoutMs ?? 15000),
	});
	const data = await response.json().catch(() => null);
	if (!response.ok || data?.ok !== true || !Object.hasOwn(data ?? {}, 'data')) {
		throw new Error(await errorMessage(response, data, '数据中心'));
	}
	return data.data;
}

async function marketTool(exec, cfg, toolName, args) {
	const result = await marketRequest(exec, cfg, `/api/tools/market/${toolName}`, { arguments: args },
		TOOL_TIMEOUT_OVERRIDE_MS[toolName]);
	if (toolName === 'mkt_klines') {
		return {
			...result,
			analysisTool: 'mkt_kline_analysis',
			analysisRule: '只能直接整理原始rows；若准备计算收益、涨跌幅、均价、量额合计、区间位置或任何指标，必须改用analysisTool，禁止将数字抄入bash（含Python元组/列表）。',
		};
	}
	return result;
}

async function klineAnalysis(exec, cfg, args) {
	const result = await marketRequest(exec, cfg, '/api/market/kline-analysis', args);
	if (!result?.klines || !result?.analysis) throw new Error('数据中心 K 线分析响应缺少 klines/analysis');
	// Keep the complete analysis and sample metadata, but do not flood the model
	// with a second copy of all rows. analysis.recent_bars covers the latest ten.
	const { rows, ...summary } = result.klines;
	return {
		...result,
		klines: {
			...summary,
			rowsOmitted: Array.isArray(rows) ? rows.length : 0,
			rowsLocation: 'analysis.recent_bars（最多最近10根）；完整原始行可用 mkt_klines 查询',
		},
	};
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
		throw new Error('big_order 大单盯盘依赖 LV2/WS 订阅，当前上游标准订阅未实现，已禁用；请改用普通价格/涨跌幅/回落反弹盯盘，或用 mkt_level2 主动查询盘口与逐笔');
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
		name: 'mkt_quote',
		description: '查询单只或多只证券最新行情快照（统一行情中心，价格和涨跌等数值优先使用本工具）。订阅标的(A股/ETF/指数,含盯盘/预热/常用集)直接返回数据中心共享快照(XTP tick 毫秒级主价格流,sampleAgeMs 标注采样年龄),未订阅标的走 FQGate V2 上游;快照是否实时以源时间与 freshness 为准，收到响应时间不是行情时间。支持 A 股/ETF/指数/可转债/港股/美股个股,返回价格、涨跌幅、成交量额等。securities 支持形如 "600519"、"SH600519" 的代码;可转债 "123241"、"USZB123241" 及 110/111/113/118(沪)、120/123/127/128(深) 号段;A 股指数用 "USHI1A0001"(上证)/"USZI399001"/"USZI399006";港股 "UHKMHK0700";**美股个股须加 UNQQ 前缀**,如 "UNQQAAPL"(苹果)/"UNQQNVDA"(英伟达)/"UNQQTSLA"(特斯拉)。**美股指数现货(2026-11-05 起)用 UFII 前缀**："UFIINDX"(纳指100)/"UFIISPX"(标普500)/"UFIIDJIA"(道指)/"UFIISOX"(费城半导体,行带 asOf 美股源时间),以上指数历史K线(日/周/月/分钟,mkt_klines)亦可查;纳指综合(IXIC)无现货源,用 NDX 或纳指期货替代;期货走势用 mkt_global_futures。',
		parameters: { type: 'object', properties: {
			securities: { type: 'array', items: { type: 'string' }, description: '证券代码列表,如 ["600519","SZ000001","USHI1A0001","123241"];指数用 mkt_search 返回的完整 ths_code;可转债可直接用六位代码' },
			fields: { type: 'array', items: { type: ['integer', 'string'] }, description: '可选 V2 标准字段名；旧数字编号会转换为标准字段。省略返回全部常用字段' },
		}, required: ['securities'] },
	},
	{
		name: 'mkt_global_futures',
		description: '查询全球期货与重要指数实时快照(新浪外盘,秒级):期货(外盘) ES标普/NQ纳指/YM道指/VX恐慌/CHA50CFD富时A50/HSI恒指/CL原油/GC黄金/SI白银/NG天然气/HG美铜;期货(内盘) LC碳酸锂/PS多晶硅/GSI工业硅/RB螺纹/CU沪铜/I铁矿/J焦炭/SA纯碱/FG玻璃/AU沪金/AG沪银/SC沪原油/EC集运欧线/LH生猪等;现货指数 N225日经/KOSPI韩国/SPX标普/NDX纳指/DJI道指(隔夜收盘)/FTSE伦敦/DAX德国/BOVESPA巴西(中金所股指期货不支持)。内盘涨跌幅基于昨结算价。A股开盘情绪与隔夜外围判断首选(证券行情工具不覆盖美股指数/期货,不要走问财或 UNQQ 重试)。返回现价/涨跌幅/高低与源时间(time/date);int_ 现货系列无源时间戳,time 为空;retrievedAt 只是取回时间。默认返回情绪信号集 ES,NQ,YM,VX,CHA50CFD,HSI,N225,KOSPI,CL,GC,LC(含日经韩国与碳酸锂)。',
		parameters: { type: 'object', additionalProperties: false, properties: {
			securities: { type: 'array', items: { type: 'string' }, description: '代码列表:外盘期货 ES/NQ/YM/VX/CHA50CFD/HSI/CL/GC/SI/NG/HG,内盘期货 LC/PS/GSI/RB/CU/I/J/SA/FG/AU/AG/SC/EC/LH/MA/TA/PP/V/EG/NR,指数 N225/KOSPI/SPX/NDX/DJI/FTSE/DAX/BOVESPA;缺省返回默认情绪信号集' },
		}, additionalProperties: true },
	},
	{
		name: 'mkt_market_overview',
		description: '盘面概览一把梭(数据中心预热快照,毫秒级返回):A股7只常用指数(上证/深成/创业板/上证50/沪深300/中证500/中证1000)+6只核心ETF(沪深300/中证500/红利/中证1000/科创50/创业板)+全球期货(美股三大/VIX/A50/恒指/日经/韩国/原油/黄金)+全市场涨跌分布(涨跌家数/涨跌停/炸板)。交易时段数据由数据中心每3-15秒主动刷新,问「今天盘面怎么样/外围如何/大盘情绪」首选本工具;需要热点板块/昨日涨停今日表现再补 mkt_market_pulse(默认不带名单)，精确到秒的单标的实时报价或指定品种明细再用 mkt_quote / mkt_global_futures。无参数。sampledAt 是采样时刻而非交易所行情时间，retrievedAt 只是期货取回时刻，均不得冒充源时间。breadth 已给上涨/下跌占比与涨跌比，直接用，不再用 bash 重复计算；用户只要简明盘面时只答所问维度，不自动展开所有外围品种。',
		parameters: { type: 'object', properties: {}, description: '无参数;误传的参数会被忽略' },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, 24000)] },
	},
	{
		name: 'mkt_etf_tracker',
		description: '汪汪队ETF跟踪器：判断「今日国家队(汇金)是否上班」的量价工具。盯 20 只汇金历史持仓宽基ETF(沪深300/上证50/中证500/中证1000/创业板/科创50等)+4只扩展观察(A500/科创50华夏)。核心指标:①同时点倍数=当前累计成交额÷(20日均额×历史日内进度),盘中半天与全天基准可比,判断放量是否异常(≥1.8×强信号/≥1.3×有迹象);②主动净买入=(外盘−内盘)÷(外盘+内盘)×成交额(逐笔方向推算,非资金净流入);③份额申赎估算与同市场「份额源未日更」自检;④收盘后累积份额趋势(加仓指数,首日=100)。直接给五级结论(hot大概率上班/mid护盘迹象或放量方向不对/cool没迹象)与完整理由。问「今天汪汪队/国家队上班了吗、汇金护盘了吗、ETF放量了吗」首选本工具。detail=summary(默认)返回判断+放量前列,full 返回全部24只明细与份额趋势。注意:名单为2025年报最后一次披露的历史标签(信披新规后不可验证),所有结论均为量价推测,不构成投资建议;summary.donePct/sumBaseAdjYi 已按日内进度对齐分母,直接用结论与倍数,不要再用 bash 重算。',
		parameters: { type: 'object', additionalProperties: false, properties: {
			detail: { type: 'string', enum: ['summary', 'full'], description: 'summary(默认)：判断+放量前列；full：全部24只明细与份额趋势' },
		} },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, 20000)] },
	},
	{
		name: 'mkt_yield_curve',
		description: '查询美国财政部官方每日国债收益率曲线（名义 par yield，单位 %），含 2Y/10Y/30Y 及完整期限、相对上一发布日基点变化。不是同花顺证券行情，也不是国债 ETF 价格；适用于美债收益率与历史宏观复盘。date 可指定 YYYY-MM-DD，取该日或之前最近发布日；省略取最新发布值，不是实时盘中利率。',
		parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '可选，查询该日或之前最近发布日，格式 YYYY-MM-DD' } }, additionalProperties: false },
	},
	{
		name: 'mkt_klines',
		description: '查询证券历史 K 线。分钟(1m/5m/15m/30m/60m/120m)使用数据中心且仅支持前复权，日线及以上使用 FQGate V2。count 与 start_date/end_date 二选一（不要同时传）。指数代码同 mkt_quote,如 USHI1A0001;可转债如 123241/110092。覆盖(2026-11-05 起)：指数全周期 K(日/周/月/分钟,东财公共源,含已映射美股指数 UFIINDX/UFIISPX/UFIIDJIA/UFIISOX)、ETF/可转债分钟 K、全标的季/年 K(由日 K 在数据中心聚合,行带 period_start/samples,当年/当季未走完属正常)、股票分钟 K 仅前复权。响应 source 字段标注取数路径(fqgate/eastmoney:kline/eastmoney:kline+aggregate)。120m 仅沪深普通股票。分钟 K 的 date/startDate/endDate 均为带 +08:00 偏移的北京时间，barBoundary=end 表示该时间是本根结束边界，不要再次换算或当成开始时刻；日/周/月 K 的 date 保持 YYYY-MM-DD。返回能力错误(unsupported)时勿重复重试。本工具只用于原始行展示，调用后不得再用 bash 复制数值计算收益、涨跌幅、均价、量额合计、区间位置或任何指标；**问每季/每年涨跌、区间收益这类"每根K的涨跌幅"时直接调 mkt_kline_analysis(同 interval,它的 recent_bars 每行已带 pct),不要抄本工具的行到 bash**；只要准备做任何派生计算，就必须改用独立工具 mkt_kline_analysis（含 MA/RSI/MACD/ATR/BOLL/收益/量排名）。',
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
		name: 'mkt_kline_analysis',
		description: '查询证券 K 线并由数据中心直接计算常用指标，一次返回 klines 元数据与 analysis：MA5/10/20/60、EMA/MACD(DIF/DEA/柱=2×(DIF−DEA))、Wilder RSI14/ATR14、BOLL、区间收益/振幅/VWAP、周度聚合、量额均值和量排名。参数与 mkt_klines 相同；指标及简单收益、涨跌幅、均价、量额合计、区间位置等派生分析都必须用本工具，不要把 K 线复制到 bash。count 请求会自动多取 150 根暖机历史再裁剪回展示窗（analysis.warmupBars 标注），EMA/MACD/RSI/ATR 已收敛，改变 count 不会明显改变最新指标值，短窗口也能取到 MA60。analysis.latest_bar_final/isFinal 表示最新一根（及周线聚合行）周期是否完结：false=周期未走完（如当周），null=上游未提供；day 请求的周线聚合行含 period_start 与 samples（该周已入账日K数），判断本周是否走完直接用它，不要抄日线到 bash 聚合核对。完整结果不做模型侧截断；完整原始 rows 被省略，最近10根见 analysis.recent_bars，确需全部原始行再调 mkt_klines。分钟 K 与前复权等覆盖限制同 mkt_klines；分钟 K 时间直接为 +08:00 北京时间且 barBoundary=end，分析结果保留同一时间，不再换算 UTC。',
		parameters: { type: 'object', additionalProperties: false, properties: {
			code: { type: 'string', description: '证券代码；搜索得到完整 ths_code 时必须原样传递' },
			interval: { type: 'string', description: 'K 线周期:1m/5m/15m/30m/60m/120m/day/week/month/quarter/year' },
			count: { type: 'integer', description: '分析最近 N 根(与 start_date/end_date 二选一,勿同时传)' },
			start_date: { type: 'string', description: 'YYYYMMDD(与 count 二选一,勿同时传)' },
			end_date: { type: 'string', description: 'YYYYMMDD' },
			adjust: { type: 'string', description: '复权:None 不复权 / forward 前复权 / backward 后复权' },
		}, required: ['code', 'interval'] },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, 40000)] },
	},
	{
		name: 'mkt_search',
		description: '按名称、代码或拼音搜索证券，确认市场与代码。当前覆盖A股、ETF及港股，不支持美股搜索；已知有效代码可直接查询行情，无需重复搜索。',
		parameters: { type: 'object', properties: { pattern: { type: 'string', description: '搜索关键字:名称、代码或拼音缩写' } }, required: ['pattern'] },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, Math.max(12000, (value.symbols?.count ?? 0) * 180 + 1000))] },
	},
	{
		name: 'mkt_level2',
		description: '查询 Level-2 深度数据(FQGate):十档盘口、逐笔成交、逐笔委托。kind: depth / transactions / orders。',
		parameters: { type: 'object', properties: {
			kind: { type: 'string', description: 'depth(十档盘口,多证券) / transactions(逐笔成交) / orders(逐笔委托)' },
			code: { type: 'string', description: '证券代码；逗号分隔多标的等价于 codes' },
			codes: { type: 'array', items: { type: 'string' }, description: '多标的代码；仅 depth 支持，如 ["600519","300870"]' },
			count: { type: 'integer', description: 'transactions/orders 返回条数' },
		}, required: ['kind'] },
	},
	{
		name: 'mkt_market_pulse',
		description: 'A股大盘统计与热点摘要：涨跌家数/占比/涨跌比、各独立来源涨跌停统计、昨日涨停/上涨股今日表现、热点最新日双向各10及综合前10。默认不带涨跌停名单，查名单/涨停复盘直接用 mkt_limit_up_pool，避免重复大输出；确需旧接口紧凑名单才显式 withLimitStocks=true。输出pulse.schema说明字段/单位/来源及截断；distribution.rawBuckets精确边界未校准，moneyEffect档位未校准且zxb为遗留字段，不能自行反推标签或混用不同口径计算炸板率。retrievedAt是取回时间，非行情源时间。',
		parameters: { type: 'object', properties: { withLimitStocks: { type: 'boolean', description: '附带旧接口今日涨跌停紧凑名单(默认 false；常规复盘用 mkt_limit_up_pool)' }, withHotPlates: { type: 'boolean', description: '附加热点板块(默认 true)' } } },
		output: { schema: anyJsonOutput.schema, render: (_args, value) => [renderJson(value, value.pulse?.limitStocks ? 60000 : 16000)] },
	},
	{
		name: 'mkt_sec_kline',
		description: '查询沪深普通股票秒级K线，time_period可选1/5/10/15/30/45秒，market用SZ/SH且必须与证券匹配。当前ETF/指数等资产覆盖未确认，返回显式capability；空数组不能解释为无成交或零价格，不反复请求已说明的能力缺口。',
		parameters: { type: 'object', properties: {
			market: { type: 'string', description: 'SZ | SH' }, code: { type: 'string', description: '证券代码,如 003021' },
			time_period: { type: 'string', description: 'sec_1 | sec_5 | sec_10 | sec_15 | sec_30 | sec_45' }, count: { type: 'integer', description: '返回最近 N 根,默认 120' },
		}, required: ['market', 'code'] },
	},
	{
		name: 'mkt_move_detail',
		description: '查询市场异动明细(数据中心):板块走强/走弱异动流,带成分股与资金。适合持仓股触发时归因(是个股问题还是板块带崩)。',
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'mkt_margin_collateral',
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
		else ctx.logger.info?.(`[market-data] ${def.name}: skipped (toolDeny/toolAllow)`);
	};
	for (const def of MARKET_TOOLS) register({
		...def, output: def.output ?? anyJsonOutput,
		execute: def.name === 'mkt_kline_analysis'
			? (args, exec) => klineAnalysis(exec, cfg, args)
			: (args, exec) => marketTool(exec, cfg, def.name, args),
	});
	for (const def of limitUpTools) {
		const path = '/api/market/limit-up-pool';
		register({ ...def, output: { schema: anyJsonOutput.schema, render: limitUpPoolOutput }, execute: (args, exec) => marketRequest(exec, cfg, path, args) });
	}
	const watchClient = cfg.watchServiceBaseUrl ? createWatchServiceClient(cfg) : null;
	register({
		name: 'watch_add',
		description: '创建当前用户的行情提醒规则：支持价格、涨跌幅、从高点回落及从低点反弹条件，and 子条件须全部命中。中心共享采样并在触发后提醒与唤醒 Agent，不提交交易委托；不传 action。big_order 大单订阅未实现，不支持创建；盘口和逐笔查询用 mkt_level2。oneShot 默认 true，触发一次后停止。',
		parameters: { type: 'object', properties: {
			code: { type: 'string', description: '证券代码;也支持全球期货/指数统一代码(ES/NQ/YM/VX/CHA50CFD/HSI/CL/GC/LC碳酸锂/PS/GSI/N225日经/KOSPI韩国等,即 mkt_global_futures 的代码),期货提醒全天评估' },
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
		name: 'watch_list',
		description: '查看共享行情提醒引擎的健康与采样状态、当前用户可见的提醒规则及最近触发记录。此工具不查询证券账户、交易条件单或下单限额；采样就绪与服务存活须分别判断。',
		parameters: { type: 'object', properties: { history_limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回最近可见触发历史条数，默认10，最大200；以triggerHistoryPage核对截断范围' } } }, output: anyJsonOutput,
		execute(args, exec) {
			if (!watchClient) throw new Error('独立盯盘服务未配置 watchServiceBaseUrl');
			return watchClient.status(exec.agent?.larkUser?.openId ?? identityOf(exec.agent)?.subjectId, exec.agent?.larkUser?.appId ?? identityOf(exec.agent)?.appId, args?.history_limit);
		},
	});
	register({
		name: 'watch_update',
		description: '原位更新本人行情提醒的阈值、锚点、备注、到期时间或频率，保留规则ID、归属与触发历史；不支持改证券、规则类型、会话归属。threshold/anchorPrice实际变化会重置拐点观察进度，冷却和历史仍保留；只改备注/期限不会重置。优先原位更新，避免删建丢状态。',
		parameters: { type: 'object', additionalProperties: false, properties: {
			id: { type: 'string', description: '规则ID，watch_list可查' },
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
		name: 'watch_remove',
		description: '删除盯盘规则(按 add 返回的 id)。',
		parameters: { type: 'object', properties: { id: { type: 'string', description: '规则 id(watch_list 可查)' } }, required: ['id'] }, output: anyJsonOutput,
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
				ctx.logger.warn(`watch wake bridge: ${error?.message ?? error}`);
				// Permanent rejections (missing owner/session/eventId) use 400 so
				// the data center drops the event; transient failures keep 500.
				send(error?.permanent ? 400 : 500, { error: String(error?.message ?? error) });
			}
		});
		new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); })
			.then(() => ctx.logger.info(`watch wake bridge listening on 127.0.0.1:${port}`))
			.catch((error) => ctx.logger.warn(`watch wake bridge listen failed: ${error?.message ?? error}`));
		ctx.effect(() => () => new Promise((resolve) => server.close(resolve)));
	}
}

export { apply, inject, name, assertWatchSubscriptionSupported, deliverWatchWake, createWatchServiceClient };
