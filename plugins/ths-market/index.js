/**
 * @dsh-friends/ths-market — 同花顺行情+盯盘(2026-10-29 自 @local/ths-trade 拆分)
 *
 * 纯只读行情 9 工具(quote/klines/search/wencai/level2/market_pulse/sec_kline/
 * move_detail/margin_collateral) + 盯盘引擎与 3 工具(watch_add/list/remove)。
 * 自动执行双门禁:同 profile 装有 ths-trade(ctx.tools 探测 ths_order_submit)
 * 且配置 xiadanApiKey 才启用;否则 action 规则自动降级为提醒型。
 * 工具面收窄:toolDeny/toolAllow(通配符,deny 优先)。
 */

import fsModule from 'node:fs';
import { connectionForExecution, connectionForOpenId } from '../../lib/user-connections.js';
import { identityOf } from '../feishu-principal/index.js';

const name = 'ths-market';
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	fqgateBaseUrl: process.env.THS_FQGATE_BASE_URL || 'http://127.0.0.1:18000',
	requestTimeoutMs: 15000,
	// ── ths-data-center(数据中心:L2 云端指标/秒K/异动/交易日历/问财)──
	dataCenterBaseUrl: 'http://127.0.0.1:17890',
	dataCenterApiKey: process.env.THS_DATACENTER_API_KEY || '',
	// ── 华宝证券可充抵保证金证券(官网公示页)──
	marginCollateralBaseUrl: 'https://www.cnhbstock.com/tt/308',
	// ── 盯盘引擎(原 ths-trade 同款)──
	watchEnabled: false,
	watchIntervalMs: 30000,
	watchExclusiveMaster: 'any',
	watchRulesFile: '/data/dsh/home/dsh-management/watch-rules.json',
	autoTradeMaxOrderValue: 80000,
	autoTradeDailyMaxValue: 200000,
	autoTradeMaxDeviationPercent: 2,
	autoTradeHaltGuardPercent: 0.5,
	// ── 自动执行后端(可选):须同时安装 ths-trade 才生效,否则纯提醒 ──
	xiadanBaseUrl: process.env.THS_XIADAN_BASE_URL || 'http://127.0.0.1:18710',
	xiadanApiKey: '',
	// ── 工具面收窄 ──
	toolDeny: [],
	toolAllow: [],
};


const MARKETS = {
	SH: 'USHA', SHA: 'USHA', 沪: 'USHA', 上海: 'USHA',
	SZ: 'USZA', SZA: 'USZA', 深: 'USZA', 深圳: 'USZA',
	BJ: 'USJB', 北: 'USJB', 北交: 'USJB',
	HK: 'UHKM', 港: 'UHKM', 香港: 'UHKM',
	SHJ: 'USHJ', 沪基: 'USHJ', SHF: 'USHJ',
	SZJ: 'USZJ', 深基: 'USZJ', SZF: 'USZJ',
	SHI: 'USHI', SZI: 'USZI',
	USHI: 'USHI', USZI: 'USZI',
};

/** 按代码前缀推断 FQGate 市场(实测校准:510300/588000/511990→USHJ,159915→USZJ) */
function inferMarket(code) {
	if (code.length === 6) {
		if (/^4[38]/.test(code)) return 'USJB';  // 43/48 北交
		if (/^8[38]/.test(code)) return 'USJB';  // 83/87 北交
		if (/^[45]/.test(code)) return 'USHJ';   // 50/51/56/58 沪市基金/ETF
		if (/^1[56]/.test(code)) return 'USZJ';  // 15/16/18 深市基金/ETF
		// 000xxx 是深圳股票与上证指数的重叠号段，不能一律当指数。
		// 已知指数白名单之外按深股处理；SH/SHI 显式前缀仍走指数映射。
		if (/^000(001|016|300|688|905|852|906|985|986|987)$/.test(code)) return 'USHI';
		if (/^399/.test(code)) return 'USZI';             // 399xxx 深市指数
		if (/^[69]/.test(code)) return 'USHA';   // 60/68 沪股、90 B股
		if (/^[023]/.test(code)) return 'USZA';  // 00/30 深股、20 B股
		return 'USHA';
	}
	// 五位数字按港股主板处理；北交所使用 BJ/USJB 显式市场前缀。
	if (code.length === 5) return 'UHKM';
	if (code.length === 4) return 'UHKM';        // 港股主板 4 位数字
	return 'USHA';
}

/** 数字指数代码转 FQGate 内部代码;完整 1A/1B 代码原样保留。 */
function normalizeCode(market, code) {
	if (market === 'USHI' && /^000\d{3}$/.test(code)) return code === '000001' ? '1A0001' : `1B0${code.slice(3)}`;
	if (market === 'USZI' && /^\d{6}$/.test(code)) return `399${code.slice(3)}`;
	return code;
}

/**
 * 规范化证券标识:支持股票代码、市场前缀和 ths_search 返回的完整 ths_code。
 * FQGate 的 SH/SZ 是交易所前缀,不等于个股市场;指数必须使用 USHI/USZI。
 */
function parseSecurity(input) {
	if (typeof input !== 'string' || !input.trim()) throw new Error('证券代码不能为空');
	const raw = input.trim().toUpperCase();
	if (/^1[AB][0-9A-F]{4}$/.test(raw)) return { market: 'USHI', code: raw };
	let m = raw.match(/^(U[A-Z]{3})([0-9A-Z]+)$/);
	if (m && m[1] === 'USHK') return { market: 'UHKM', code: `HK${m[2].padStart(4, '0')}` };
	if (m) return { market: m[1], code: normalizeCode(m[1], m[2]) };
	m = raw.match(/^(SHI|SZI)([0-9A-Z]+)$/);
	if (m) return { market: MARKETS[m[1]], code: normalizeCode(MARKETS[m[1]], m[2]) };
	m = raw.match(/^(SH|SHA|SZ|SZA|BJ|HK|沪|深|北|港|上海|深圳|北交|香港)?([0-9A-F]{4,6})$/);
	if (!m) throw new Error(`无法识别的证券代码: ${input};指数请使用 ths_search 返回的完整代码(如 USHI1A0001、USZI399001)`);
	const alias = m[1] ?? '';
	let code = m[2];
	// SH/SZ 在指数语境是交易所;完整 USHA/USZA 才显式指定个股市场。
	if (/^(SH|SHA|SHI|沪|上海)$/.test(alias) && code === '000001') return { market: 'USHI', code: '1A0001' };
	if (/^(SH|SHA|SHI|沪|上海)$/.test(alias) && /^000[0-9A-F]{3}$/.test(code)) return { market: 'USHI', code: `1B0${code.slice(3)}` };
	if (/^(SZ|SZA|SZI|深|深圳)$/.test(alias) && /^399/.test(code)) return { market: 'USZI', code };
	if (['USHI', 'USZI'].includes(MARKETS[alias] ?? inferMarket(code))) return { market: inferMarket(code), code: normalizeCode(inferMarket(code), code) };
	const market = MARKETS[alias] ?? inferMarket(code);
	// 港股主板完整代码为 UHKMHK0700，而不是 USHK700。
	if (market === 'UHKM') code = `HK${code.replace(/^0+(?=\d)/, '').padStart(4, '0')}`;
	return { market, code };
}


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
	const toolPattern = (p) => new RegExp('^' + String(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
	const toolAllowed = (n) => {
		if ((cfg.toolDeny ?? []).some((p) => toolPattern(p).test(n))) return false;
		const allow = cfg.toolAllow ?? [];
		if (allow.length > 0 && !allow.some((p) => toolPattern(p).test(n))) return false;
		return true;
	};
	const register = (def) => {
		if (toolAllowed(def.name)) ctx.tools.register(def);
		else ctx.logger.info?.(`[ths-market] ${def.name}: skipped (toolDeny/toolAllow)`);
	};
	const fqFor = (exec) => fqgateClient(ctx, connectionForExecution(exec, cfg, 'market'));
	// 自动执行双门禁:ths-trade 在场(ctx.tools 探测)+ xiadanApiKey 已配
	const tradeToolAvailable = () => ctx.tools.get?.('ths_order_submit') !== undefined;
	let xd = null;
	const getXd = () => {
		if (!xd && cfg.xiadanApiKey && tradeToolAvailable()) xd = xiadanClient(ctx, cfg);
		return xd;
	};
	if (cfg.watchEnabled && !getXd()) {
		ctx.logger.info('ths-market: 交易后端不可用(未安装 ths-trade 或未配 xiadanApiKey),盯盘为纯提醒模式');
	}
	const watch = createWatchEngine(ctx, cfg, { getXd });


	const dcFor = (exec) => {
		const userCfg = connectionForExecution(exec, cfg, 'market');
		return {
			get: (path) => request(ctx, userCfg.dataCenterBaseUrl, path, {
				headers: { 'X-API-Key': userCfg.dataCenterApiKey },
				timeoutMs: userCfg.requestTimeoutMs,
			}).then((envelope) => {
				if (!envelope || envelope.ok === false) throw new Error(`data-center: ${envelope?.error ?? 'unknown error'}`);
				return envelope.data ?? envelope;
			}),
			post: (path, body) => request(ctx, userCfg.dataCenterBaseUrl, path, {
				method: 'POST',
				headers: { 'X-API-Key': userCfg.dataCenterApiKey, 'Content-Type': 'application/json' },
				body: body ?? {},
				timeoutMs: Math.max(userCfg.requestTimeoutMs ?? 10000, 30000),
			}).then((envelope) => {
				if (!envelope || envelope.ok === false) throw new Error(`data-center: ${envelope?.error ?? 'unknown error'}`);
				return envelope.data ?? envelope;
			}),
		};
	};
	register({
		name: 'ths_quote',
		description: '查询单只或多只证券实时行情(FQGate)。支持股票/ETF/指数/债券,返回价格、涨跌幅、成交量额、换手率等。securities 支持形如 "600519"、"SH600519"、"SZ000001" 的代码;指数优先用 ths_search 返回的完整代码,如 "USHI1A0001"(上证)、"USZI399001"(深证成指)、"USZI399006"(创业板指),也支持 "SH000001"、"SZ399001"。',
		parameters: {
			type: 'object',
			properties: {
				securities: { type: 'array', items: { type: 'string' }, description: '证券代码列表,如 ["600519","SZ000001","USHI1A0001"];指数用 ths_search 返回的完整 ths_code' },
				fields: { type: 'array', items: { type: 'integer' }, description: `可选,自选字段编号。常用:${Object.entries(FQ_FIELDS).map(([k, v]) => `${k}=${v}`).join(', ')}。省略返回全部常用字段` },
			},
			required: ['securities'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const secs = args.securities.map(parseSecurity);
			// FQGate 自选字段接口要求同市场分组;fields 必填(实测)
			const groups = new Map();
			for (const s of secs) {
				const list = groups.get(s.market) ?? [];
				list.push(s.code);
				groups.set(s.market, list);
			}
			const results = {};
			const errors = [];
			for (const [market, codes] of groups) {
				try {
					const body = {
						securities: codes.map((code) => ({ market, code })),
						fields: args.fields?.length ? args.fields : DEFAULT_QUOTE_FIELDS,
					};
					const raw = await fqFor(exec).post('/v1/market/realtime/quote', body);
					const rows = decodeRows(raw?.data);
					for (const row of rows) {
						// 本地衍生指标:涨跌幅、振幅(FQ 无直接字段)
						if (Number.isFinite(row.price) && Number.isFinite(row.preClose) && row.preClose > 0) {
							row.changePercent = round4(((row.price - row.preClose) / row.preClose) * 100);
							// fields 子集可能不含 high/low;缺字段时省略振幅,避免非有限数破坏 lossless JSON 输出。
							if (Number.isFinite(row.high) && Number.isFinite(row.low)) {
								row.amplitude = round4(((row.high - row.low) / row.preClose) * 100);
							}
						}
						const symbol = String(row.code ?? '');
						// 完整 ths_code 是跨市场唯一键；四位市场前缀后的代码仅作兼容别名。
						results[symbol] = row;
						results[symbol.slice(4)] = row;
					}
				} catch (error) {
					if (groups.size === 1) throw error;
					errors.push({ market, codes, reason: String(error?.message ?? error) });
				}
			}
			const unavailable = secs
				.filter(({ market, code }) => !results[`${market}${code}`])
				.map(({ market, code }) => ({ symbol: `${market}${code}`, reason: '上游未返回行情,请用 ths_search 核对完整代码' }));
			return { quotes: results, unavailable, ...(errors.length ? { errors } : {}) };
		},
	});

	register({
		name: 'ths_klines',
		description: '查询证券历史 K 线(FQGate)。interval 枚举:1m/5m/15m/30m/60m/120m/day/week/month/quarter/year;adjust 枚举:None/forward(前复权)/backward(后复权)。count 与 start_date/end_date 二选一。指数代码同 ths_quote,如 USHI1A0001。',
		parameters: {
			type: 'object',
			properties: {
				code: { type: 'string', description: '证券代码,如 600519;指数用完整代码 USHI1A0001 / USZI399001' },
				interval: { type: 'string', description: 'K 线周期:1m/5m/15m/30m/60m/120m/day/week/month/quarter/year' },
				count: { type: 'integer', description: '返回最近 N 根(与日期范围二选一)' },
				start_date: { type: 'string', description: 'YYYYMMDD(与 count 二选一)' },
				end_date: { type: 'string', description: 'YYYYMMDD' },
				adjust: { type: 'string', description: '复权:None 不复权 / forward 前复权 / backward 后复权' },
			},
			required: ['code', 'interval'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const { market, code } = parseSecurity(args.code);
			const body = { market, code, interval: args.interval };
			if (args.count != null) body.count = args.count;
			if (args.start_date) body.start_date = args.start_date;
			if (args.end_date) body.end_date = args.end_date;
			if (args.adjust) body.adjust = args.adjust;
			const raw = await fqFor(exec).post('/v1/market/history/klines', body);
			return { klines: raw?.data ?? raw };
		},
	});

	register({
		name: 'ths_search',
		description: '按名称/代码/拼音模糊搜索证券(FQGate),确认市场与代码后再用行情工具。',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: '搜索关键字:名称、代码或拼音缩写' },
			},
			required: ['pattern'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const raw = await fqFor(exec).post('/v1/market/catalog/search-symbols', { pattern: args.pattern });
			return { symbols: raw?.data ?? raw };
		},
	});

	register({
		name: 'ths_wencai',
		description: '问财自然语言选股(数据中心 cookie 版,带 AI 摘要 + 规整结果表,列含涨停原因/几天几板/封单额等),如 "今日涨停且量比大于2的股票";数据中心不可用时自动回退 FQGate 版(列较少)。',
		parameters: {
			type: 'object',
			properties: {
				condition: { type: 'string', description: '自然语言选股条件' },
				limit: { type: 'integer', description: '返回行数上限(数据中心版,默认 20)' },
			},
			required: ['condition'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			// 优先数据中心 cookie 版:AI 摘要 + 富列(涨停原因/几天几板/封单额/首板时间…)
			try {
				const data = await dcFor(exec).post('/api/wencai/query2data', {
					query: args.condition,
					limit: args.limit ?? 20,
				});
				return { source: 'data-center', answer: data?.answer ?? '', tables: data?.tables ?? [] };
			} catch (err) {
				// 回退 FQGate wencai-nlp(列较少,无 AI 摘要)
				const raw = await fqFor(exec).post('/v1/market/selection/wencai-nlp', { condition: args.condition });
				return { source: 'fqgate-fallback', result: raw?.data ?? raw, fallbackReason: String(err?.message ?? err) };
			}
		},
	});

	register({
		name: 'ths_level2',
		description: '查询 Level-2 深度数据(FQGate):十档盘口、逐笔成交、逐笔委托。kind: depth / transactions / orders。',
		parameters: {
			type: 'object',
			properties: {
				kind: { type: 'string', description: 'depth(十档盘口,多证券) / transactions(逐笔成交) / orders(逐笔委托)' },
				code: { type: 'string', description: '证券代码' },
				count: { type: 'integer', description: 'transactions/orders 返回条数' },
			},
			required: ['kind', 'code'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const { market, code } = parseSecurity(args.code);
			if (args.kind === 'depth') {
				const raw = await fqFor(exec).post('/v1/market/level2/depth', { securities: [{ market, code }] });
				return { depth: raw?.data ?? raw };
			}
			if (args.kind === 'transactions') {
				const body = {
					market, code,
					fields: ['price', 'volume', 'side', 'trade_time', 'volclass', 'transaction_count'],
					count: args.count ?? 50,
					end_time: 0,
				};
				const raw = await fqFor(exec).post('/v1/market/level2/transactions', body);
				return { transactions: raw?.data ?? raw };
			}
			if (args.kind === 'orders') {
				const body = {
					market, code,
					fields: ['order_no', 'price', 'side', 'volume', 'amount', 'order_time'],
					range: { count: args.count ?? 50, end: 0, mode: 'recent' },
					require_data: true,
					semantic: true,
				};
				const raw = await fqFor(exec).post('/v1/market/level2/orders', body);
				return { orders: raw?.data ?? raw };
			}
			throw new Error(`未知的 level2 kind: ${args.kind}`);
		},
	});

	/* ── 账户与交易(xiadan)────────────────────────── */

	register({
		name: 'ths_market_pulse',
		description: 'A 股大盘体检(数据中心 L2 云端指标聚合):涨跌家数分布、涨停/跌停数、炸板率、赚钱效应分档、热点板块(强弱双向)、涨停股名单(含首板时间)。一次调用返回全景,适合开盘前评估与触发复核时判断市场环境。',
		parameters: {
			type: 'object',
			properties: {
				withLimitStocks: { type: 'boolean', description: '附带今日涨停股名单(默认 true)' },
				withHotPlates: { type: 'boolean', description: '附加热点板块(默认 true)' },
			},
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const want = {
				limits: args?.withLimitStocks !== false,
				plates: args?.withHotPlates !== false,
			};
			const [dist, effect, avg] = await Promise.all([
				dcFor(exec).get('/api/market/change-distribution').catch((e) => ({ error: String(e?.message ?? e) })),
				dcFor(exec).get('/api/market/money-effect').catch((e) => ({ error: String(e?.message ?? e) })),
				dcFor(exec).get('/api/market/average-increase').catch((e) => ({ error: String(e?.message ?? e) })),
			]);
			const pulse = {
				timestamp: new Date().toISOString(),
				distribution: dist,   // up_num/down_num/limit_up_cnt/limit_down_cnt/炸板/分布
				moneyEffect: effect,  // 赚钱效应分档(涨停梯队)
				// 空数组(盘前)时 latest 为 undefined 会炸工具输出校验,兜底 null
			averageIncrease: Array.isArray(avg)
				? { latest: avg.length ? avg[avg.length - 1] : null, series: avg.length }
				: avg,
			};
			if (want.limits) {
				const today = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
				const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
				pulse.limitStocks = await dcFor(exec).get(`/api/market/limit-stocks?date=${dateStr}`)
					.catch((e) => ({ error: String(e?.message ?? e) }));
			}
			if (want.plates) {
				pulse.hotPlates = await dcFor(exec).get('/api/market/hot-plates?days=10&filter=no_filter')
					.catch((e) => ({ error: String(e?.message ?? e) }));
			}
			return { pulse };
		},
	});

	register({
		name: 'ths_sec_kline',
		description: '查询秒级 K 线(数据中心,10/15/30/45/1/5 秒):比逐笔轻、比分钟线细,适合拐点触发后的精细复核(回落深度、量能配合)。market 用 SZ/SH。',
		parameters: {
			type: 'object',
			properties: {
				market: { type: 'string', description: 'SZ | SH' },
				code: { type: 'string', description: '证券代码,如 003021' },
				time_period: { type: 'string', description: 'sec_1 | sec_5 | sec_10 | sec_15 | sec_30 | sec_45' },
				count: { type: 'integer', description: '返回最近 N 根,默认 120' },
			},
			required: ['market', 'code'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const period = args.time_period ?? 'sec_10';
			const count = args.count ?? 120;
			const data = await dcFor(exec).get(`/api/market/sec-kline?market=${args.market}&code=${args.code}&time_period=${period}&count=${count}&end_time=0`);
			return { secKline: data, fields: '1=时间, 7/8/9/11=开高低收, 13=量, 19=额' };
		},
	});

	register({
		name: 'ths_move_detail',
		description: '查询市场异动明细(数据中心):板块走强/走弱异动流,带成分股与资金。适合持仓股触发时归因(是个股问题还是板块带崩)。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(args, exec) {
			const data = await dcFor(exec).get('/api/market/move-detail');
			return { moves: data };
		},
	});

	/* 自选不属于公共行情：由 ths-favorites 提供每用户独立扫码登录与登录态。 */

	/* ── 华宝证券可充抵保证金证券查询(2026-10-29 自 OpenClaw cnhb-margin-collateral 移植) ── */

	const MARGIN_PAGE_SIZE = 24;
	const MARGIN_MAX_BODY_BYTES = 5 * 1024 * 1024;

	function stripCellHtml(raw) {
		return raw
			.replace(/<[^>]+>/g, '')
			.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.trim();
	}

	function parseMarginTable(html) {
		const rows = [];
		const rowRegex = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
		let m;
		while ((m = rowRegex.exec(html)) !== null) {
			rows.push({
				code: stripCellHtml(m[1]),
				name: stripCellHtml(m[2]),
				variety: stripCellHtml(m[3]),
				collateralRate: stripCellHtml(m[4]),
				concentrationGroup: stripCellHtml(m[5]),
			});
		}
		return rows;
	}

	async function fetchMarginPage(page, ddss) {
		const base = cfg.marginCollateralBaseUrl.replace(/\/+$/, '');
		let url = page > 1 ? `${base}/${page}` : base;
		if (ddss) url += (url.includes('?') ? '&' : '?') + 'ddss=' + encodeURIComponent(JSON.stringify(ddss));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
		try {
			const resp = await fetch(url, {
				method: 'GET',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
				signal: controller.signal,
			});
			const text = await resp.text();
			if (Buffer.byteLength(text, 'utf8') > MARGIN_MAX_BODY_BYTES) throw new Error('response body exceeds size limit');
			if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
			return text;
		} finally {
			clearTimeout(timer);
		}
	}

	function marginPageInfo(html, fallbackPage) {
		const m = html.match(/<input type="number" min="1" max="(\d+)" value="(\d+)"/);
		return {
			page: m ? Number.parseInt(m[2], 10) : fallbackPage,
			totalPages: m ? Number.parseInt(m[1], 10) : null,
		};
	}

	register({
		name: 'ths_margin_collateral',
		description: '查询华宝证券官网"可充抵保证金证券"列表(融资融券折算率)。支持按证券代码或简称搜索,或按页码浏览。字段:证券代码、简称、品种、折算率(%)、集中度分组。两融保证金计算必备。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '证券代码(如 000001 或 000001.sz)或简称(如 平安银行),支持模糊匹配;与 page 二选一' },
				page: { type: 'number', description: '浏览模式页码,默认 1(每页 24 条)' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			const query = args.query ? String(args.query).trim() : '';
			const page = Math.max(1, Number(args.page) || 1);
			if (query) {
				const isCode = /^\d{6}(\.(sh|sz|bj))?$/i.test(query);
				const html = await fetchMarginPage(1, isCode ? { zqdm: query.replace(/\.[^.]+$/, '') } : { zqjc: query });
				const { totalPages } = marginPageInfo(html, 1);
				const data = parseMarginTable(html);
				return {
					status: 'ok',
					mode: 'search',
					query,
					searchField: isCode ? 'zqdm' : 'zqjc',
					count: data.length,
					totalPages,
					data,
				};
			}
			const html = await fetchMarginPage(page, null);
			const info = marginPageInfo(html, page);
			const data = parseMarginTable(html);
			return {
				status: 'ok',
				mode: 'list',
				page: info.page,
				totalPages: info.totalPages,
				totalRows: info.totalPages ? info.totalPages * MARGIN_PAGE_SIZE : null,
				count: data.length,
				data,
			};
		},
	});

	register({
		name: 'ths_watch_add',
		description: '添加行情监控规则(FQGate WS 实时推送)：price_above/price_below/change_above/change_below 阈值、pullback_sell/rebound_buy 拐点、big_order 大单；and 为全部命中的复合条件。默认不填 action，仅触发行情提醒与 Agent 复核，不是买入/卖出建议，不要主动引导交易。仅当前用户已明确配置交易且明确要求条件单时才可填 action，触发将实盘执行。oneShot 默认 true。',
		parameters: {
			type: 'object',
			properties: {
				code: { type: 'string', description: '证券代码' },
				type: { type: 'string', description: 'price_above | price_below | change_above | change_below | pullback_sell | rebound_buy | big_order。pullback_sell/rebound_buy 的 threshold 是回落/反弹百分比' },
				threshold: { type: 'number', description: '阈值:价格(元)/涨跌百分比/回落反弹百分比/大单金额(元)' },
				anchorPrice: { type: 'number', description: '拐点型可选锚定价(如信号价);缺省用首个报价' },
				confirmSeconds: { type: 'number', description: '拐点型连续确认秒数,默认 3;新极值出现会重置确认' },
				cooldownMinutes: { type: 'integer', description: '同规则冷却分钟数,默认 15' },
				oneShot: { type: 'boolean', description: '默认 true:成功委托后停止;false 允许冷却后再次触发,每次独立幂等键' },
				note: { type: 'string', description: '备注(触发消息里带上)' },
				and: {
					type: 'array',
					description: '复合条件(可选):子条件数组,全部命中才触发。子条件只支持瞬时阈值型(price_*/change_*),如 [{type:"change_below", threshold:3}]',
					items: { type: 'object' },
				},
				action: {
					type: 'object',
					description: '条件单动作(可选;提供即自动实盘执行)。执行价:固定价格规则默认=阈值;百分比/大单/拐点默认=现价±0.5%滑点;limitPrice 覆盖。提供前须校验 side 和数量/金额合法。',
					properties: {
						side: { type: 'string', description: 'buy | sell' },
						quantity: { type: 'integer', description: '数量(股),四选一' },
						amount: { type: 'number', description: '金额(元,买入),四选一' },
						quantityPercent: { type: 'integer', description: '可用持仓百分比(卖出常用,如 50=卖一半,整百取整),四选一' },
						all: { type: 'boolean', description: 'true=全部可用持仓清仓,四选一' },
						limitPrice: { type: 'number', description: '限价(默认按类型)' },
						reduceOnly: { type: 'boolean', description: '卖出超量按可用持仓清仓' },
					},
					required: ['side'],
				},
			},
			required: ['code', 'type', 'threshold'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			if (!cfg.watchEnabled) throw new Error('盯盘引擎未开启:在 profile 配置里设 watchEnabled: true 并重载');
			if (!['price_above', 'price_below', 'change_above', 'change_below', 'pullback_sell', 'rebound_buy', 'big_order'].includes(args.type)) {
				throw new Error(`未知盯盘类型: ${args.type}`);
			}
			if (!Number.isFinite(args.threshold) || args.threshold <= 0) throw new Error('threshold 必须是正数');
			if (args.action) {
				if (!['buy', 'sell'].includes(args.action.side)) throw new Error('action.side 必须是 buy 或 sell');
				const forms = ['quantity', 'amount', 'quantityPercent', 'all'].filter((key) => args.action[key] != null && args.action[key] !== false);
				if (forms.length !== 1) throw new Error('action 必须且只能指定 quantity/amount/quantityPercent/all 之一');
				if (args.action.all === true && args.action.side !== 'sell') throw new Error('all=true 仅允许卖出');
				if (args.action.quantityPercent != null && (args.action.quantityPercent <= 0 || args.action.quantityPercent > 100)) throw new Error('quantityPercent 必须在 1-100');
				for (const key of ['quantity', 'amount', 'limitPrice']) {
					if (args.action[key] != null && (!Number.isFinite(args.action[key]) || args.action[key] <= 0)) throw new Error(`${key} 必须是正数`);
				}
			}
			// 身份读取双轨(基座化过渡):larkUser 直读优先,回退 identityOf 合成 agent.identity。
			// 仅用于本工具面展示;fqFor/dcFor 已走 lib 壳 identityOf 双读。
			const ownerOpenId = exec.agent?.larkUser?.openId ?? identityOf(exec.agent)?.subjectId;
			if (args.action && !getXd() && !ownerOpenId) {
				ctx.logger.warn('ths-market: action 规则已降级为提醒型(交易后端不可用:未安装 ths-trade 或未配 xiadanApiKey)');
				args = { ...args, action: undefined };
			}
			if (args.action && ownerOpenId) {
				connectionForOpenId(ownerOpenId, cfg, 'trading', exec.agent?.larkUser?.appId ?? identityOf(exec.agent)?.appId);
			}
			const rule = watch.addRule(args, exec.agent);
			const active = watch.status(ownerOpenId, exec.agent?.larkUser?.appId ?? identityOf(exec.agent)?.appId);
			return {
				rule,
				active,
				monitoring: active.enabled && active.connected,
				...(!(active.enabled && active.connected) ? {
					warning: '规则已保存，但当前监控引擎未连接，暂不会触发；不要表述为已开始盯盘。',
				} : {}),
			};
		},
	});

	register({
		name: 'ths_watch_list',
		description: '查看当前用户的行情监控引擎状态与本人规则(连接、行情、最近触发)。未配置交易的用户仅使用监控提醒，不展示下单能力或交易限额；只有明确配置交易的用户才显示条件单台账与限额。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute(args, exec) {
			return watch.status(
				exec.agent?.larkUser?.openId ?? identityOf(exec.agent)?.subjectId,
				exec.agent?.larkUser?.appId ?? identityOf(exec.agent)?.appId,
			);
		},
	});

	register({
		name: 'ths_watch_remove',
		description: '删除盯盘规则(按 add 返回的 id)。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '规则 id(ths_watch_list 可查)' },
			},
			required: ['id'],
		},
		output: anyJsonOutput,
		async execute(args, exec) {
			const removed = watch.removeRule(args.id, exec.agent?.larkUser?.openId ?? identityOf(exec.agent)?.subjectId);
			if (!removed) throw new Error(`规则不存在或不属于当前用户: ${args.id}`);
			return { removed };
		},
	});

	// 一键撤单:撤全部可撤委托(护栏场景/收盘前清场)
}

/* ─────────────────── 盯盘引擎实现 ─────────────────── */

/** 台账与幂等键统一使用上海自然日,避免 UTC 与上海日期错位。 */
function shanghaiDateKey(timestamp = Date.now()) {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
	}).format(new Date(timestamp));
}

/** A 股交易时段(Asia/Shanghai);节假日经 ths-data-center trade-dates 校准 */
const tradeDateCache = { dates: null, fetchedAt: 0 };

/** 查询今天是否交易日:优先数据中心交易日历(5 分钟缓存),失败回退周几判断 */
async function isTradingDay(ctx, cfg) {
	// 上海时区的今天(YYYYMMDD)
	const t = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
	const today = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
	if (Date.now() - tradeDateCache.fetchedAt < 300000 && tradeDateCache.dates) {
		return tradeDateCache.dates.includes(today);
	}
	try {
		const raw = await request(ctx, cfg.dataCenterBaseUrl, '/api/market/trade-dates', {
			headers: { 'X-API-Key': cfg.dataCenterApiKey }, timeoutMs: 5000,
		});
		const dates = raw?.data;
		if (Array.isArray(dates) && dates.length > 0) {
			tradeDateCache.dates = dates;
			tradeDateCache.fetchedAt = Date.now();
			return dates.includes(today);
		}
	} catch { /* 回退 */ }
	const day = new Date().getDay();
	return day !== 0 && day !== 6;
}

/** A 股交易时段(Asia/Shanghai;简化版,不含节假日) */
function isTradingHours(now = new Date()) {
	// 用上海时区判断:宿主机 TZ 已是 Asia/Shanghai;防呆起见按 UTC+8 换算
	const t = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
	const day = t.getDay();
	if (day === 0 || day === 6) return false;
	const hm = t.getHours() * 100 + t.getMinutes();
	return (hm >= 925 && hm <= 1131) || (hm >= 1258 && hm <= 1501);
}

/** 集合竞价窗口(9:25-9:30):价格未定型,自动执行只记录不执行 */
function isAuctionWindow(now = new Date()) {
	const t = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
	if (t.getDay() === 0 || t.getDay() === 6) return false;
	const hm = t.getHours() * 100 + t.getMinutes();
	return hm >= 925 && hm < 930;
}

/** 规则匹配:quote 行 vs 规则。
 *  pullback_sell / rebound_buy 是拐点条件(算法移植自 ths-ai-signal-trader
 *  的 LocalCondition):extreme_price 跟踪极值,move≥threshold 且连续确认
 *  confirmSeconds 才触发;新极值出现重置确认(防噪声)。状态在 conditionStates。 */
function matchRule(rule, quote, state) {
	const price = quote.price;
	const preClose = quote.preClose;
	if (typeof price !== 'number') return null;
	switch (rule.type) {
		case 'price_above':
			return price >= rule.threshold ? `价格 ${price} ≥ ${rule.threshold}` : null;
		case 'price_below':
			return price <= rule.threshold ? `价格 ${price} ≤ ${rule.threshold}` : null;
		case 'change_above':
			if (typeof preClose !== 'number' || preClose <= 0) return null;
			return ((price - preClose) / preClose) * 100 >= rule.threshold
				? `涨幅 ${round4(((price - preClose) / preClose) * 100)}% ≥ ${rule.threshold}%` : null;
		case 'change_below':
			if (typeof preClose !== 'number' || preClose <= 0) return null;
			return ((preClose - price) / preClose) * 100 >= rule.threshold
				? `跌幅 ${round4(((preClose - price) / preClose) * 100)}% ≥ ${rule.threshold}%` : null;
		case 'pullback_sell':
		case 'rebound_buy': {
			// 拐点状态机(回落卖出/反弹买入)。提醒型(无 action)与条件单型都支持:
			// 2026-10-27 修复:此前 `if (!rule.action) return null;` 使无 action 的
			// 拐点规则永远不参与匹配,纯提醒的 pullback_sell 挂上后从不触发。
			// 状态(state.extremePrice/candidateAt)由 evaluateRules 按 rule.id 维护,
			// 与是否带 action 无关。
			const thresholdPct = rule.threshold; // 回落/反弹百分比
			const confirmSeconds = rule.confirmSeconds ?? 3;
			const now = Date.now() / 1000;
			if (state.extremePrice == null) {
				// 首个报价:极值=锚定价(信号价)或当前价
				state.extremePrice = rule.anchorPrice ?? price;
				state.candidateAt = null;
				return null;
			}
			const isSell = rule.type === 'pullback_sell';
			const prevExtreme = state.extremePrice;
			state.extremePrice = isSell
				? Math.max(state.extremePrice, price)
				: Math.min(state.extremePrice, price);
			const move = isSell
				? (state.extremePrice - price) / state.extremePrice * 100
				: (price - state.extremePrice) / state.extremePrice * 100;
			// 新极值 → 重置确认(更高高点/更低低点重算回落/反弹)
			if (prevExtreme !== state.extremePrice) {
				state.candidateAt = null;
				return null;
			}
			if (move + 1e-12 < thresholdPct) {
				state.candidateAt = null;
				return null;
			}
			// 达到阈值:连续确认计时
			if (state.candidateAt == null) {
				state.candidateAt = now;
				if (confirmSeconds <= 0) return `${isSell ? '回落' : '反弹'} ${round4(move)}% ≥ ${thresholdPct}%(即刻确认)`;
				return null;
			}
			if (now - state.candidateAt >= confirmSeconds) {
				return `${isSell ? '回落' : '反弹'} ${round4(move)}% ≥ ${thresholdPct}%,连续确认 ${confirmSeconds}s`;
			}
			return null;
		}
		case 'big_order': {
			// 大单在 WS big_order_flow 订阅里处理,quote 匹配不到
			return null;
		}
		default:
			return null;
	}
}

/** 自动规则限价:固定价格用阈值;百分比/大单/拐点按现价加受控滑点。 */
function resolveAutoOrderPrice(rule, quote) {
	const price = Number(quote.price);
	if (!Number.isFinite(price) || price <= 0) throw new Error(`触发行情缺少有效现价: ${quote.price}`);
	if (rule.action.limitPrice != null) return Number(rule.action.limitPrice);
	if (rule.type === 'price_above' || rule.type === 'price_below') return Number(rule.threshold);
	const slip = price * 0.005;
	return round4(rule.action.side === 'buy' ? price + slip : price - slip);
}

/** 每次触发独立幂等键;同一触发请求重试必须复用。 */
function createAutoIdempotencyKey(ruleId, suffix = nowKey()) {
	return `auto-${ruleId}-${suffix}`;
}

/** 规则与自动交易台账持久化:workspace JSON 读写(原子写,失败不致命) */
function createRuleStore(ctx, filePath) {
	function resolvePath() {
		// 绝对路径直接用;相对路径相对 cwd(workspace)
		if (filePath.startsWith('/')) return filePath;
		return `${process.cwd?.() ?? '/tmp'}/${filePath}`;
	}
	return {
		load() {
			try {
				const text = fsModule.readFileSync(resolvePath(), 'utf8');
				const parsed = JSON.parse(text);
				return {
					rules: Array.isArray(parsed.rules) ? parsed.rules : [],
					ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
					// version 2 新增:规则归属会话(触发唤醒路由用)
					owners: Array.isArray(parsed.owners) ? parsed.owners : [],
					// version 3 新增:已触发的一次性提醒规则 [{ruleId, at}]
					firedOnce: Array.isArray(parsed.firedOnce) ? parsed.firedOnce : [],
				};
			} catch { return { rules: [], ledger: [], owners: [], firedOnce: [] }; }
		},
		save(rules, ledger, owners, firedOnce) {
			try {
				const doc = {
					version: 3,
					savedAt: new Date().toISOString(),
					rules: [...rules.values()],
					ledger: ledger.slice(-200),
					// [{ruleId, sessionId}]:重启后触发唤醒能路由回原会话
					owners: owners ? [...owners.entries()].map(([ruleId, sessionId]) => ({ ruleId, sessionId })) : [],
					// 一次性提醒的已触发标记:重启后不应重放已响过的提醒
					firedOnce: firedOnce ? [...firedOnce.entries()].map(([ruleId, at]) => ({ ruleId, at })) : [],
				};
				const text = JSON.stringify(doc, null, 1);
				const p = resolvePath();
				fsModule.writeFileSync(`${p}.tmp`, text);
				fsModule.renameSync(`${p}.tmp`, p);
				return true;
			} catch (error) {
				ctx.logger?.warn?.(`ths-watch store: save failed ${error?.message ?? error}`);
				return false;
			}
		},
	};
}

/** 构建盯盘引擎:WS 连 FQGate、按规则匹配、条件单自动执行、触发唤醒 */
function isWatchMaster(argv, wantedMaster) {
	const argvText = (argv ?? []).join(' ');
	const profileName = argvText.match(/--profile\s+([^\s]+)/)?.[1] ?? '';
	const isFeishuProc = Boolean(profileName) && !argvText.includes('--port');
	const isWebProc = argvText.includes('--port') || profileName === 'web';
	const myMarker = isWebProc ? 'web' : (isFeishuProc ? 'feishu' : 'unknown');
	return { profileName, myMarker, isMaster: wantedMaster === 'any' || wantedMaster === myMarker || wantedMaster === profileName };
}

function createWatchEngine(ctx, cfg, options) {
	const getXd = options?.getXd ?? (() => options?.xd ?? null);
	/** @type {Map<string, object>} 规则表 */
	const rules = new Map();
	/** @type {Map<string, number>} 规则上次触发时间(ms) */
	const lastFired = new Map();
	/** @type {Map<string, object>} 最近快照(code -> quote) */
	const lastQuotes = new Map();
	/** 证券名缓存(code -> name):WS 推送的 55 字段是 GBK 乱码,REST 正常;
	 * 订阅时补拉一次,触发文本用缓存名 */
	const nameCache = new Map();
	/** 触发历史(环形,最多 100 条) */
	const firedHistory = [];
	/**
	 * 已触发过的一次性提醒规则 id(ruleId -> 首次触发时间 ms)。
	 * 与 firedHistory 分开保存:firedHistory 是长度 100 的环形缓冲,滚动淘汰后
	 * 若用它判定 oneShot 会让老规则"复活"重复提醒。此 Set 随规则一起持久化,
	 * 规则被删除时同步清理。
	 */
	const firedOnce = new Map();
	/** 拐点条件运行状态(ruleId -> {extremePrice, candidateAt}) */
	const conditionStates = new Map();
	/** 自动交易台账(持久化尾部 200 条) */
	const ledger = [];
	/** 当日自动交易累计金额(元) */
	let dailyAutoValue = 0;
	let dailyAutoDate = shanghaiDateKey();
	/** 会话 -> 规则归属:规则唤醒加规则的那个会话(会话删了就回退最新会话) */
	const ruleOwners = new Map();
	/** 规则执行中标记(防同 tick 重入) */
	const executing = new Set();
	/** 成交回报跟踪:ruleId -> {htbh, checks: [30s, 120s, 300s], done} */
	const fillWatchers = new Map();
	let fillTimer = null;
	let ws = null;
	let reconnectTimer = null;
	let saveTimer = null;
	/** 交易日标志:后台异步刷新(isTradingDay 有 5 分钟缓存),交易日历失效(节假日)时不自动执行/不唤醒 */
	let tradingDay = true;
	let tradeDayTimer = null;
	let stats = { connectedAt: null, reconnects: 0, pushes: 0, fired: 0, autoTrades: 0, autoBlocked: 0, lastError: null };

	/** 持久化存储 */
	const store = createRuleStore(ctx, cfg.watchRulesFile ?? '/data/dsh/home/dsh-management/watch-rules.json');

	function nowMs() { return Date.now(); }

	/** 防抖保存 */
	function scheduleSave() {
		if (saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			store.save(rules, ledger, ruleOwners, firedOnce);
		}, 1000);
	}

	/** 当日重置 */
	function ensureDailyWindow() {
		const today = shanghaiDateKey();
		if (today !== dailyAutoDate) {
			dailyAutoDate = today;
			dailyAutoValue = 0;
		}
	}

	/** 订阅指令 id 计数 */
	let subSeq = 0;
	/** 已订阅集合(kind:code) */
	const subscribed = new Set();

	/**
	 * 已完成的 oneShot 规则不再触发;可由 Agent 显式重建。
	 * 2026-10-27 修复:原实现只查 ledger 里 status==='submitted'(成功下单),
	 * 而提醒型规则从不下单、ledger 永远为空,导致 oneShot 对提醒规则完全失效
	 * (实测 w10 price_above 96.3 在 oneShot:true 下 09:30/09:56/10:34 连响 3 次)。
	 * 改为:条件单仍以"成功下单"为准(下单被护栏拦截时应允许重试);
	 * 提醒型则以"已触发过"为准,一次性提醒即止。
	 */
	function ruleCompleted(rule) {
		if (rule.oneShot !== true) return false;
		if (rule.action) {
			return ledger.some((entry) => entry.ruleId === rule.id && entry.status === 'submitted');
		}
		return firedOnce.has(rule.id);
	}

	/** 规则触发的冷却检查 */
	function cooled(id) {
		const rule = rules.get(id);
		const cd = (rule?.cooldownMinutes ?? 15) * 60000;
		const last = lastFired.get(id) ?? 0;
		return nowMs() - last >= cd;
	}

	/** 条件单自动执行(带护栏);返回执行结果(never throws) */
	async function executeAutoTrade(rule, quote, hitText) {
		let tradeCfg = cfg;
		let tradeXd = getXd?.() ?? null;
		if (rule.ownerOpenId) {
			try {
				tradeCfg = connectionForOpenId(rule.ownerOpenId, cfg, 'trading', rule.ownerAppId);
				tradeXd = xiadanClient(ctx, tradeCfg);
			} catch (error) {
				const blocked = { at: nowMs(), ruleId: rule.id, code: rule.code, status: 'blocked', reason: String(error?.message ?? error) };
				ledger.push(blocked);
				scheduleSave();
				return blocked;
			}
		}
		if (!tradeXd) return { blocked: true, reason: '交易后端不可用(未安装 ths-trade 或未配 xiadanApiKey),本条不执行' };
		const entry = {
			at: nowMs(), ruleId: rule.id, code: rule.code, side: rule.action.side,
			status: 'blocked', reason: '', hit: hitText, price: quote.price,
		};
		try {
			ensureDailyWindow();
			let qty = rule.action.quantity ?? null;
			const amount = rule.action.amount ?? null;
			// 数量语义解析:数量 / 金额 / 持仓百分比 / 清仓
			if (qty == null && amount == null) {
				if (rule.action.quantityPercent != null || rule.action.all) {
					// 实时查持仓算股数
					const posData = await tradeXd.get('/api/v1/account/positions');
					const positions = posData?.result?.data?.position ?? {};
					const pos = positions[rule.code];
					const available = Number(pos?.kyye ?? 0);
					if (available <= 0) throw new Error(`无可用持仓(${rule.code}),无法按百分比/清仓卖出`);
					if (rule.action.all) qty = available;
					else {
						qty = Math.floor(available * rule.action.quantityPercent / 100 / 100) * 100; // 整百
						if (qty < 100) qty = 100;
						if (qty > available) qty = available;
					}
				} else {
					throw new Error('action 缺少 quantity/amount/quantityPercent/all');
				}
			}
			// 固定价格规则默认阈值价;百分比/大单/拐点用现价±0.5%;limitPrice 永远优先。
			const orderPrice = resolveAutoOrderPrice(rule, quote);
			// 1) 单笔限额
			const estValue = qty != null ? qty * orderPrice : amount;
			if (estValue > tradeCfg.autoTradeMaxOrderValue) {
				throw new Error(`单笔金额 ${estValue} 超限额 ${tradeCfg.autoTradeMaxOrderValue}`);
			}
			// 2) 当日累计限额（用户规则只累计本人台账，不挤占也不共享别人的额度）
			const usedToday = rule.ownerOpenId
				? ledger.filter((item) => item.ownerOpenId === rule.ownerOpenId && item.status === 'submitted' && shanghaiDateKey(item.at) === dailyAutoDate).reduce((sum, item) => sum + (Number.isFinite(item.value) ? item.value : 0), 0)
				: dailyAutoValue;
			if (usedToday + estValue > tradeCfg.autoTradeDailyMaxValue) {
				throw new Error(`当日累计 ${usedToday + estValue} 将超限额 ${tradeCfg.autoTradeDailyMaxValue}`);
			}
			// 3) 价格偏离保护(限 price 类规则):现价相对阈值偏离过大 → 转人工
			if (rule.type === 'price_above' || rule.type === 'price_below') {
				const deviation = Math.abs((quote.price - rule.threshold) / rule.threshold) * 100;
				if (deviation > tradeCfg.autoTradeMaxDeviationPercent) {
					throw new Error(`现价 ${quote.price} 偏离阈值 ${rule.threshold} 达 ${round4(deviation)}%(> ${tradeCfg.autoTradeMaxDeviationPercent}%),跳空过大转人工`);
				}
			}
			// 4) 涨跌停保护:委托价接近当日涨跌停(按昨收 ±10% 估算)不追
			if (typeof quote.preClose === 'number' && quote.preClose > 0) {
				const limitUp = quote.preClose * 1.1;
				const limitDown = quote.preClose * 0.9;
				const band = quote.preClose * (cfg.autoTradeHaltGuardPercent / 100);
				if ((rule.action.side === 'buy' && orderPrice >= limitUp - band) ||
					(rule.action.side === 'sell' && orderPrice <= limitDown + band)) {
					throw new Error(`委托价 ${orderPrice} 接近涨跌停(涨停≈${round4(limitUp)}/跌停≈${round4(limitDown)}),不追`);
				}
			}
			// 每次实际触发使用独立幂等键;网络重试沿用触发序号,不能把当天后续触发压成同一委托。
			const idem = createAutoIdempotencyKey(rule.id);
			entry.idempotencyKey = idem;
			const body = { code: rule.code, side: rule.action.side, price: orderPrice };
			if (qty != null) body.quantity = qty;
			if (amount != null) body.amount = amount;
			if (rule.action.reduceOnly) body.reduce_only = true;
			const result = await request(ctx, tradeCfg.xiadanBaseUrl, '/api/v1/trading/orders', {
				method: 'POST', body,
				headers: {
					Authorization: `Bearer ${tradeCfg.xiadanApiKey}`,
					'X-Xiadan-Intent': 'real-trade',
					'X-Xiadan-Idempotency-Key': idem,
				},
				timeoutMs: tradeCfg.requestTimeoutMs,
			}).then((env) => unwrapXiadan(env, 'auto/orders'));
			entry.status = 'submitted';
			entry.orderId = result?.orderId ?? null;
			entry.htbh = result?.htbh ?? null;
			entry.pending = result?.pending ?? false;
			entry.accepted = result?.accepted ?? null;
			entry.errorCode = result?.errorCode ?? null;
			entry.orderPrice = orderPrice;
			entry.quantity = qty ?? null;
			if (!rule.ownerOpenId) dailyAutoValue += estValue;
			stats.autoTrades += 1;
			entry.value = estValue;
			if (rule.ownerOpenId) entry.ownerOpenId = rule.ownerOpenId;
			// 成交回报跟踪:30s/2m/5m 三次查当日成交更新台账
			if (entry.htbh) trackFill(rule.id, String(entry.htbh));
		} catch (error) {
			entry.reason = String(error?.message ?? error);
			stats.autoBlocked += 1;
		}
		ledger.push(entry);
		if (ledger.length > 500) ledger.splice(0, ledger.length - 500);
		scheduleSave();
		return entry;
	}

	/** 成交回报:委托后 30s/2m/5m 查当日成交,把成交价量写回台账 */
	function trackFill(ruleId, htbh) {
		fillWatchers.set(ruleId, { htbh, checks: [30000, 120000, 300000], startedAt: nowMs() });
		if (!fillTimer) fillTimer = setInterval(pollFills, 15000);
	}

	async function pollFills() {
		if (fillWatchers.size === 0) {
			if (fillTimer) { clearInterval(fillTimer); fillTimer = null; }
			return;
		}
		for (const [ruleId, watcher] of [...fillWatchers]) {
			const elapsed = nowMs() - watcher.startedAt;
			if (elapsed > 310000) { fillWatchers.delete(ruleId); continue; } // 超时停止跟踪
			if (elapsed < watcher.checks[0]) continue;
			const rule = rules.get(ruleId);
			let dealsByHtbh;
			try {
				const fillXd = rule?.ownerOpenId ? xiadanClient(ctx, connectionForOpenId(rule.ownerOpenId, cfg, 'trading', rule.ownerAppId)) : getXd?.();
				if (!fillXd) continue;
				const dealsData = await fillXd.get('/api/v1/account/deals');
				dealsByHtbh = dealsData?.result?.data?.deal ?? dealsData?.result?.data?.deals ?? {};
			} catch { continue; } // 查询失败下次再试；绝不切换到其他用户账户
			// 找该合同号的成交
			let found = null;
			for (const [code, list] of Object.entries(dealsByHtbh ?? {})) {
				for (const d of list ?? []) {
					if (String(d.htbh) === watcher.htbh) { found = d; break; }
				}
				if (found) break;
			}
			const entry = [...ledger].reverse().find((e) => e.ruleId === ruleId && String(e.htbh) === watcher.htbh);
			if (found) {
				// 有成交(全部/部分)
				entry.fill = {
					cjsl: found.cjsl, cjjj: found.cjjj, cjje: found.cjje,
					status: found.cjsl && found.wtsl && Number(found.cjsl) >= Number(found.wtsl) ? 'filled' : 'partial',
					checkedAt: nowMs(),
				};
				scheduleSave();
				if (entry.fill.status === 'filled') { fillWatchers.delete(ruleId); continue; }
			}
			watcher.checks.shift();
			if (watcher.checks.length === 0) {
				if (entry && !entry.fill) entry.fill = { status: 'no-fill-yet', checkedAt: nowMs(), note: '5 分钟内未见成交,委托可能仍在挂单' };
				fillWatchers.delete(ruleId);
			}
		}
	}

	/** 唤醒规则原会话；用户规则绝不回退到其他用户的最新会话。 */
	async function wakeAgent(rule, text) {
		try {
			// 2026-10-30 修复:ctx.sessionQuery 未注入(agent 宿主重构后),旧实现
			// 每次触发都抛 "cannot get property sessionQuery without inject" 进
			// catch 丢弃。改为:归属会话直接经 agents registry resume(owners 表
			// 里的 sessionId resume 不存在即回退);无归属旧规则回退 registry 最近
			// 常驻 agent。两者都不依赖未注入服务。
			let sessionId = ruleOwners.get(rule.id);
			if (!sessionId && rule.ownerOpenId) {
				ctx.logger.warn(`ths-watch: 用户规则的归属会话不可用,触发丢弃 rule=${rule.id}`);
				return;
			}
			if (!sessionId) {
				const agents = ctx.get('agents');
				const fallback = typeof agents?.live === 'function' ? agents.live() : (typeof agents?.list === 'function' ? agents.list() : []);
				const live = Array.isArray(fallback) ? fallback : [];
				if (live.length === 0) { ctx.logger.warn('ths-watch: 无活跃会话,触发丢弃'); return; }
				sessionId = live[live.length - 1].session?.id ?? live[live.length - 1].sessionId ?? live[live.length - 1].id;
			}
			// 注意:不要访问 ctx.sessionController——它不在 inject 声明里,Cordis 对
			// 未注入属性的访问直接抛 "cannot get property ... without inject",
			// 旧三元条件在 feishu profile 下求值即炸,fallback 永远到不了。统一走
			// registry 显式查找(ctx.get('agents')),web/feishu 双 profile 通用。
			const resolved = await resolveAgentFromRegistry(ctx, sessionId);
			if ('error' in resolved) throw new Error(`resolveAgent: ${JSON.stringify(resolved.error)}`);
			if (rule.ownerOpenId) {
				resolved.agent.larkUser = { openId: rule.ownerOpenId, ...(rule.ownerAppId ? { appId: rule.ownerAppId } : {}) };
				// 基座化双载体:触发链唤醒时同步回注 identity(合成形态,channel 绑定补全 context)。
				resolved.agent.identity = { channel: 'feishu', subjectId: rule.ownerOpenId, ...(rule.ownerAppId ? { appId: rule.ownerAppId } : {}) };
			}
			const message = {
				id: `ths-watch-${rule.id}-${nowMs()}`,
				role: 'user',
				content: [{ type: 'text', text }],
				source: { kind: 'schedule' },
			};
			resolved.agent.followup(message);
			// ctx.sessions 同样未注入(2026-10-30 二次修复):flush 走 agent 自身的
			// scoped ctx 拿 sessions 服务,宿主无关。
			try {
				const agentSessions = resolved.agent.ctx?.get?.('sessions');
				if (agentSessions?.flush) await agentSessions.flush(resolved.agent.session);
			} catch { /* flush 失败不影响唤醒本身;followup 已入队 */ }
			stats.fired += 1;
		} catch (error) {
			ctx.logger.warn(`ths-watch wake: ${error?.message ?? error}`);
		}
	}

	/** WS 推送数据处理 */
	function handlePush(data) {
		stats.pushes += 1;
		if (data?.event !== 'data' || !data.data) return;
		const inner = data.data;
		// quote 推送:records 字段结构
		if (inner.business_type === 10001 && Array.isArray(inner.records)) {
			for (const segment of inner.records) {
				if (!Array.isArray(segment)) continue;
				for (const record of segment) {
					const row = {};
					for (const [key, cell] of Object.entries(record ?? {})) {
						if (cell?.value === undefined) continue;
						row[FQ_FIELDS[key] ?? `f${key}`] = cell.value;
					}
					const code = String(row.code ?? '').replace(/^[A-Z]+/, '');
					if (!code || typeof row.price !== 'number') continue;
					lastQuotes.set(code, { ...row, at: nowMs() });
					evaluateRules(code, row);
				}
			}
			return;
		}
		// 大单资金流(business_type 见文档;records 为大单数组)
		if (Array.isArray(inner.records) && (inner.business_type === 10200 || inner.business_type === 10207)) {
			for (const segment of inner.records) {
				const arr = Array.isArray(segment) ? segment : [segment];
				for (const rec of arr) {
					const row = rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
					if (!row) continue;
					evaluateBigOrder(row);
				}
			}
		}
	}

	/** 规则评估(quote);交易时段:条件单自动执行(竞价窗口只记录),提醒型唤醒;休市只记录 */
	function evaluateRules(code, row, { replay = false, forceTrading = false } = {}) {
		const trading = forceTrading || (isTradingHours() && tradingDay);
		const auction = isAuctionWindow();
		for (const rule of rules.values()) {
			if (rule.code !== code || rule.type === 'big_order' || ruleCompleted(rule)) continue;
			if (!cooled(rule.id)) continue;
			if (rule.action && executing.has(rule.id)) continue; // 防重入
			// 拐点条件运行状态(每规则每代码一份)
			if (!conditionStates.has(rule.id)) conditionStates.set(rule.id, {});
			const state = conditionStates.get(rule.id);
			let hit = matchRule(rule, row, state);
			// 复合条件 and[]:全部命中才触发(子条件只支持瞬时类,不支持拐点嵌套)
			if (hit && Array.isArray(rule.and) && rule.and.length > 0) {
				for (const sub of rule.and) {
					const subHit = matchRule({ ...sub, action: sub }, row, {});
					if (!subHit) { hit = null; break; }
				}
			}
			if (hit) {
				lastFired.set(rule.id, nowMs());
				// 一次性提醒规则:立即记为已触发,后续轮询不再命中
				// (条件单不在此记录,以 ledger 的 submitted 为准,被护栏拦截时可重试)
				if (rule.oneShot === true && !rule.action && !replay) {
					firedOnce.set(rule.id, nowMs());
				}
				// 拐点条件触发后清状态(下个冷却期重新跟踪极值)
				if (rule.type === 'pullback_sell' || rule.type === 'rebound_buy') {
					conditionStates.delete(rule.id);
				}
				if (rule.action && trading && !auction) {
					// 条件单:自动执行(带护栏),完成后唤醒 agent 汇报结果
					executing.add(rule.id);
					executeAutoTrade(rule, row, hit)
						.then(async (entry) => {
							const outcome = entry.status === 'submitted'
								? `✅ 已自动${entry.side === 'buy' ? '买入' : '卖出'}委托 ${entry.code} @${entry.orderPrice ?? entry.price}${entry.htbh ? `(合同 ${entry.htbh})` : ''}${entry.pending ? '[回执待确认,需对账]' : ''}`
								: `⛔ 自动执行被护栏拦截: ${entry.reason}`;
							const text = `⏰ 条件单触发 [${rule.type}] ${nameCache.get(code) ?? safeName(row.name)}(${code}): ${hit}` +
								(rule.note ? `\n备注: ${rule.note}` : '') +
								`\n现价 ${row.price}(昨收 ${row.preClose ?? '?'})\n${outcome}` +
								(entry.status === 'submitted'
									? `\n成交回报将自动跟踪(30s/2m/5m 查 deals 写台账);如需撤销用 ths_cancel_submit。`
									: `\n请 Agent 自动复核行情、持仓与规则参数;修正规则后可重试,不等待用户审批。`);
							firedHistory.push({ at: nowMs(), ruleId: rule.id, code, hit, auto: entry, text: text.slice(0, 260) });
							if (!replay) await wakeAgent(rule, text);
						})
						.finally(() => executing.delete(rule.id));
				} else if (rule.action && (auction || !trading)) {
					// 竞价窗口或休市:只记录
					const why = auction ? '竞价窗口(9:25-9:30 价格未定型)' : '非交易时段';
					firedHistory.push({ at: nowMs(), ruleId: rule.id, code, hit, deferred: why, text: `${hit} — ${why}仅记录` });
					if (!replay) ctx.logger.info(`ths-watch(${why}): ${code} ${hit}`);
				} else {
					// 提醒型:唤醒复核
					const text = `⏰ 盯盘触发 [${rule.type}] ${nameCache.get(code) ?? safeName(row.name)}(${code}): ${hit}` +
						(rule.note ? `\n备注: ${rule.note}` : '') +
						`\n现价 ${row.price}(昨收 ${row.preClose ?? '?'}),时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` +
						`\n请复核行情(ths_quote/ths_level2)与持仓(ths_account)后决定;请 Agent 自动复核并直接执行合适的交易/撤单,无需再向用户请求审批;按用户既定交易计划执行。`;
					firedHistory.push({ at: nowMs(), ruleId: rule.id, code, hit, tradingHours: trading, text: text.slice(0, 200) });
					if (trading && !replay) wakeAgent(rule, text);
					else if (!replay) ctx.logger.info(`ths-watch(休市不唤醒): ${code} ${hit}`);
				}
				if (firedHistory.length > 100) firedHistory.shift();
			}
		}
	}

	/** 大单评估;非交易时段只记录不唤醒 */
	function evaluateBigOrder(row) {
		const trading = isTradingHours() && tradingDay;
		const code = String(row.code ?? row.full_code ?? row['5'] ?? '').replace(/^[A-Z]+/, '');
		const amount = Number(row.amount ?? row['19'] ?? 0);
		for (const rule of rules.values()) {
			if (rule.type !== 'big_order' || rule.code !== code || ruleCompleted(rule)) continue;
			if (!cooled(rule.id) || !(amount >= rule.threshold)) continue;
			lastFired.set(rule.id, nowMs());
			const side = row.side ?? row.buyorsell ?? '';
			const text = `⏰ 大单触发 [big_order] ${code}: ${side} ${amount} 元 ≥ ${rule.threshold}` +
				(rule.note ? `\n备注: ${rule.note}` : '') +
				`\n请复核盘口(ths_level2)后决定;请 Agent 自动复核并直接执行合适的交易/撤单,无需再向用户请求审批;按用户既定交易计划执行。`;
			firedHistory.push({ at: nowMs(), ruleId: rule.id, code, hit: `大单 ${amount}`, tradingHours: trading, text: text.slice(0, 200) });
			if (firedHistory.length > 100) firedHistory.shift();
			if (trading) wakeAgent(rule, text);
			else ctx.logger.info(`ths-watch(休市不唤醒): ${code} 大单 ${amount}`);
		}
	}

	/** 确保 WS 里的订阅覆盖规则集合 */
	function syncSubscriptions() {
		if (!ws || ws.readyState !== 1 /* OPEN */) return;
		for (const rule of rules.values()) {
			const { market, code } = parseSecurity(rule.code);
			if (rule.type === 'big_order') {
				const key = `big:${market}:${code}`;
				if (!subscribed.has(key)) {
					subscribed.add(key);
					ws.send(JSON.stringify({
						action: 'subscribe', kind: 'big_order_flow', market, code,
						money: rule.threshold,
					}));
				}
			} else {
				const key = `q:${market}:${code}`;
				if (!subscribed.has(key)) {
					subscribed.add(key);
					// fields 显式指定:55=名称(触发文本用);其余常用行情字段
					ws.send(JSON.stringify({
						action: 'subscribe', kind: 'quote', market, code,
						fields: [5, 6, 7, 8, 9, 10, 13, 19, 55],
					}));
					// 名称走 REST 补缓存(WS 的 55 字段是 GBK 乱码,见 safeName)
					if (!nameCache.has(code)) fetchNameIntoCache(market, code);
				}
			}
		}
	}

	/** REST 拉一次名称进缓存(失败静默,触发文本回退代码) */
	async function fetchNameIntoCache(market, code) {
		try {
			const raw = await request(ctx, cfg.fqgateBaseUrl, '/v1/market/realtime/quote', {
				method: 'POST',
				body: { securities: [{ market, code }], fields: [5, 55] },
				timeoutMs: cfg.requestTimeoutMs,
			});
			for (const row of decodeRows(raw?.data)) {
				const c = String(row.code ?? '').replace(/^[A-Z]+/, '');
				if (c && typeof row.name === 'string' && row.name && !row.name.includes('�')) {
					nameCache.set(c, row.name);
				}
			}
		} catch { /* 静默:名称是锦上添花 */ }
	}

	/** 建立 WS(带重连) */
	function connect() {
		if (!cfg.watchEnabled) return;
		const url = cfg.fqgateBaseUrl.replace(/^http/, 'ws') + '/v1/market/stream';
		try {
			ws = new WebSocket(url);
		} catch (error) {
			stats.lastError = String(error?.message ?? error);
			ctx.logger.warn(`ths-watch: WS 构造失败 ${stats.lastError}`);
			scheduleReconnect();
			return;
		}
		ws.onopen = () => {
			stats.connectedAt = nowMs();
			subscribed.clear();
			syncSubscriptions();
			ctx.logger.info('ths-watch: FQGate WS 已连接');
			// 断线补偿:重连后先 REST 拉一次快照,对每个规则补评估
			// (断线期间可能已越过阈值;replay 模式只记录+执行条件单,不重复唤醒提醒)
			catchUpAfterReconnect();
		};
		ws.onmessage = (ev) => {
			try {
				const data = JSON.parse(String(ev.data));
				if (data?.event === 'notice') { stats.lastError = data.message ?? 'notice'; return; }
				handlePush(data);
				// 订阅确认可能需要补同步(规则动态新增时)
				if (data?.event === 'subscribed') syncSubscriptions();
			} catch { /* 忽略非 JSON */ }
		};
		ws.onclose = () => {
			stats.connectedAt = null;
			scheduleReconnect();
		};
		ws.onerror = () => { stats.lastError = 'ws error'; };
	}

	function scheduleReconnect() {
		if (reconnectTimer || !cfg.watchEnabled) return;
		stats.reconnects += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, Math.min(30000, 3000 * stats.reconnects));
	}

	/** 断线补偿:重连后 REST 快照对全部规则补评估(不重复唤醒提醒,条件单照常执行) */
	async function catchUpAfterReconnect() {
		try {
			const codes = [...new Set([...rules.values()].map((r) => r.code))];
			if (codes.length === 0) return;
			const secs = codes.map(parseSecurity);
			const groups = new Map();
			for (const s of secs) {
				const list = groups.get(s.market) ?? [];
				list.push(s.code);
				groups.set(s.market, list);
			}
			for (const [market, list] of groups) {
				const raw = await request(ctx, cfg.fqgateBaseUrl, '/v1/market/realtime/quote', {
					method: 'POST',
					body: { securities: list.map((code) => ({ market, code })), fields: DEFAULT_QUOTE_FIELDS },
					timeoutMs: cfg.requestTimeoutMs,
				});
				const rows = decodeRows(raw?.data);
				for (const row of rows) {
					const code = String(row.code ?? '').replace(/^[A-Z]+/, '');
					if (!code) continue;
					lastQuotes.set(code, { ...row, at: nowMs() });
					evaluateRules(code, row, { replay: true });
				}
			}
			ctx.logger.info('ths-watch: 断线补偿评估完成');
		} catch (error) {
			ctx.logger.warn(`ths-watch: 补偿评估失败 ${error?.message ?? error}`);
		}
	}

	/** 停市时暂停触发评估(WS 保持,数据照收,只是不执行/不唤醒) */
	const engine = {
		addRule(args, agent) {
			const id = `w${++subSeq}-${nowMs().toString(36)}`;
			const rule = {
				id, code: args.code, type: args.type, threshold: args.threshold,
				cooldownMinutes: args.cooldownMinutes ?? 15, note: args.note ?? '',
				...(args.anchorPrice != null ? { anchorPrice: args.anchorPrice } : {}),
				...(args.confirmSeconds != null ? { confirmSeconds: args.confirmSeconds } : {}),
				...(Array.isArray(args.and) && args.and.length ? { and: args.and } : {}),
				...(args.action ? { action: args.action } : {}),
				oneShot: args.oneShot !== false,
				// 身份读取双轨(基座化过渡):larkUser 直读优先,回退 identityOf 合成 agent.identity。
				...(() => {
					const ownerOpenId = agent?.larkUser?.openId ?? identityOf(agent)?.subjectId;
					return ownerOpenId ? {
						ownerOpenId,
						// 触发链身份快照:带 appId 域,防止非默认 app 规则触发时错误解析到默认应用的交易连接(P0-2)。
						ownerAppId: agent?.larkUser?.appId ?? identityOf(agent)?.appId,
					} : {};
				})(),
				createdAt: nowMs(),
			};
			rules.set(id, rule);
			if (agent?.session?.header?.id) ruleOwners.set(id, agent.session.header.id);
			syncSubscriptions();
			scheduleSave();
			return rule;
		},
		/** 离线回归专用:注入行情,仍经过同一匹配/护栏/委托执行链。 */
		testEvaluate(code, row) {
			evaluateRules(code, row, { forceTrading: true });
		},
		removeRule(id, openId) {
			const rule = rules.get(id);
			if (!rule || (openId && rule.ownerOpenId !== openId)) return null;
			rules.delete(id);
			ruleOwners.delete(id);
			conditionStates.delete(id);
			firedOnce.delete(id);
			lastFired.delete(id);
			fillWatchers.delete(id);
			scheduleSave();
			return rule;
		},
		status(openId, appId) {
			ensureDailyWindow();
			let canTrade = Boolean(getXd?.());
			if (openId) {
				try { connectionForOpenId(openId, cfg, 'trading', appId); canTrade = true; }
				catch { canTrade = false; }
			}
			const ownedRuleIds = new Set([...rules.values()].filter((rule) => !openId || rule.ownerOpenId === openId).map((rule) => rule.id));
			return {
				engine: '行情监控引擎',
				mode: canTrade ? 'monitor_and_conditional_orders' : 'market_monitor',
				description: canTrade ? '行情监控与条件单引擎；仅在规则明确带 action 时执行交易' : '行情监控与提醒；当前用户未配置交易连接，不执行下单',
				canTrade,
				enabled: cfg.watchEnabled && watchIsMaster,
				connected: stats.connectedAt !== null,
				connectedAt: stats.connectedAt,
				reconnects: stats.reconnects,
				pushes: stats.pushes,
				fired: stats.fired,
				...(canTrade ? { autoTrades: stats.autoTrades, autoBlocked: stats.autoBlocked } : {}),
				lastError: stats.lastError,
				tradingHours: isTradingHours(),
				tradingDay,
				rules: [...rules.values()].filter((rule) => ownedRuleIds.has(rule.id)),
				recentFires: firedHistory.filter((fire) => ownedRuleIds.has(fire.ruleId)).slice(-10),
				ledger: ledger.filter((entry) => ownedRuleIds.has(entry.ruleId)).slice(-20),
				...(canTrade ? { autoTradeGuardrails: {
					maxOrderValue: cfg.autoTradeMaxOrderValue,
					dailyMaxValue: cfg.autoTradeDailyMaxValue,
					dailyUsedValue: dailyAutoValue,
					maxDeviationPercent: cfg.autoTradeMaxDeviationPercent,
					haltGuardPercent: cfg.autoTradeHaltGuardPercent,
				} } : {}),
				// price 兜底:WS 初始快照可能缺 price(undefined 会让工具输出 lossless 校验失败)
				lastQuotes: [...lastQuotes.entries()].map(([code, q]) => ({ code, price: q.price ?? null, at: q.at })),
			};
		},
	};

	/** 本实例是否为盯盘监控 master(见下方恢复处的双 profile 说明) */
	let watchIsMaster = true;

	// 恢复持久化规则与当日台账(只恢复状态,不重放历史触发)。
	// 重启后累计限额与一次性规则的完成状态仍然有效。
	{
		// 双 profile 架构下(web 与 feishu 各跑一个引擎实例)对同一份规则文件是
		// "读时快照":两边各自内存匹配,会重复唤醒/重复消耗 oneShot。约定单一
		// 监控源:watchExclusiveMaster 取值 'feishu'|'web'|'any'(默认 any=本实例
		// 即 master);用进程命令行识别身份(环境变量不可靠:keeper 拉起的 feishu
		// 子进程与 web 主进程的 env 完全相同,但 argv 不同:feishu 带 "--profile
		// feishu",web 带 "--port 3080")。非 master 实例仅作规则管理面(增删查),
		// 不建 WS 连接、不匹配、不唤醒。
		// master 可用 'feishu'(所有飞书渠道身份)、'web' 或具体 profile 名。
		// 新身份 personal-investment/guests 不能按旧 '--profile feishu' 字面匹配，
		// 否则会被误判 unknown 而关闭监控。
		const wantedMaster = String(cfg.watchExclusiveMaster ?? 'any').trim();
		const { profileName, myMarker, isMaster } = isWatchMaster(process.argv, wantedMaster);
		watchIsMaster = isMaster;
		if (!watchIsMaster) {
			ctx.logger.info(`ths-watch: 本实例非监控 master(profile='${profileName || myMarker}', master='${wantedMaster}'),仅作规则管理面,不进行行情匹配与唤醒`);
		}
		const saved = store.load();
		ledger.push(...saved.ledger.slice(-500));
		dailyAutoValue = saved.ledger.reduce((sum, entry) =>
			sum + (entry?.status === 'submitted' && shanghaiDateKey(entry.at) === dailyAutoDate && Number.isFinite(entry.value)
				? entry.value : 0), 0);
		for (const savedRule of saved.rules) {
			if (!savedRule?.id || !savedRule.code || !savedRule.type) continue;
			rules.set(savedRule.id, savedRule);
			subSeq = Math.max(subSeq, Number(savedRule.id?.match(/^w(\d+)/)?.[1] ?? 0));
		}
		// version 2:恢复规则归属会话(触发唤醒路由回原会话;会话已删时 wakeAgent 会回退最新)
		for (const { ruleId, sessionId } of saved.owners ?? []) {
			if (ruleId && sessionId && rules.has(ruleId)) ruleOwners.set(ruleId, sessionId);
		}
		// version 3:恢复一次性提醒的已触发标记(重启后不重放已响过的提醒)
		for (const { ruleId, at } of saved.firedOnce ?? []) {
			if (ruleId && rules.has(ruleId)) firedOnce.set(ruleId, Number(at) || nowMs());
		}
		const ownerCount = [...ruleOwners.keys()].filter((id) => rules.has(id)).length;
		if (saved.rules.length) ctx.logger.info(`ths-watch: 恢复 ${saved.rules.length} 条持久化规则 (${ownerCount} 条带会话归属)`);
	}

	if (cfg.watchEnabled && watchIsMaster) {
		ctx.effect(() => {
			connect();
			// 交易日历后台刷新:启动 + 每 5 分钟(isTradingDay 内部 5 分钟缓存,这里兜底)
			const refreshTradeDay = async () => {
				try { tradingDay = await isTradingDay(ctx, cfg); } catch { tradingDay = true; }
			};
			refreshTradeDay();
			tradeDayTimer = setInterval(refreshTradeDay, 300000);
			return () => {
				if (reconnectTimer) clearTimeout(reconnectTimer);
				if (saveTimer) { clearTimeout(saveTimer); store.save(rules, ledger, ruleOwners, firedOnce); }
				if (tradeDayTimer) clearInterval(tradeDayTimer);
				reconnectTimer = null;
				tradeDayTimer = null;
				try { ws?.close(); } catch { /* noop */ }
			};
		});
	}
	return engine;
}


export { apply, inject, name, createWatchEngine, isWatchMaster, isTradingHours, matchRule, parseSecurity };
