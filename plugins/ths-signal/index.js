/** @dsh-friends/ths-signal — AI 分时交易(智能交易系统)独立插件。 */
import { buildSignalExplanations } from './signal-explain.js';
import { connectionForExecution } from '../../lib/user-connections.js';

const name = 'ths-signal';
const inject = ['tools'];
const CONFIG_DEFAULTS = {
  requestTimeoutMs: 15000,
  signalTraderBaseUrl: process.env.THS_SIGNAL_TRADER_BASE_URL || 'http://127.0.0.1:8011',
  signalTraderWebuiToken: process.env.THS_SIGNAL_WEBUI_TOKEN || '',
  signalTraderWebhookToken: process.env.THS_SIGNAL_WEBHOOK_TOKEN || '',
  toolDeny: [], toolAllow: [],
};
async function request(ctx, baseUrl, path, { method = 'GET', body, headers = {}, timeoutMs = 15000, signal } = {}) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时(${timeoutMs}ms): ${url}`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    if (!response.ok) { const detail = json?.error?.message ?? json?.error ?? text.slice(0, 200); throw new Error(`${baseUrl} HTTP ${response.status}: ${String(detail)}`); }
    return json;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
const anyJsonOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
function apply(ctx, config) {
  const cfg = { ...CONFIG_DEFAULTS, ...config };
  const toolPattern = (p) => new RegExp('^' + String(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  const toolAllowed = (n) => !(cfg.toolDeny ?? []).some((p) => toolPattern(p).test(n)) && (!(cfg.toolAllow ?? []).length || (cfg.toolAllow ?? []).some((p) => toolPattern(p).test(n)));
  const register = (def) => { if (toolAllowed(def.name)) ctx.tools.register(def); };
	/* ── AI 信号引擎(ths-ai-signal-trader:接收信号,评分动态定参,自动建条件单)── */

	/** 查询用管理 token;投递必须用独立 webhook token,不走同步 /api/signal。 */
	const st = (exec) => {
		const userCfg = connectionForExecution(exec, cfg, 'aiSignal');
		return {
			get: (path) => request(ctx, userCfg.signalTraderBaseUrl, path, {
				headers: userCfg.signalTraderWebuiToken ? { 'X-Access-Token': userCfg.signalTraderWebuiToken } : {},
				timeoutMs: userCfg.requestTimeoutMs,
			}),
			post: (path, body) => request(ctx, userCfg.signalTraderBaseUrl, path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(userCfg.signalTraderWebuiToken ? { 'X-Access-Token': userCfg.signalTraderWebuiToken } : {}),
				},
				body,
				timeoutMs: userCfg.requestTimeoutMs,
			}),
			postWebhook: (path, body, raw = false) => request(ctx, userCfg.signalTraderBaseUrl, path, {
				method: 'POST',
				headers: {
					'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json',
					'X-Webhook-Token': userCfg.signalTraderWebhookToken,
				},
				body,
				timeoutMs: userCfg.requestTimeoutMs,
			}),
		};
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
			const userCfg = connectionForExecution(exec, cfg, 'aiSignal');
			const limit = args.limit ?? 10;
			const [health, signals, local, reeval] = await Promise.all([
				st(exec).get('/health').catch((e) => ({ error: String(e?.message ?? e) })),
				st(exec).get('/api/signals/today').catch((e) => ({ error: String(e?.message ?? e) })),
				st(exec).get('/api/local-execution/today').catch((e) => ({ error: String(e?.message ?? e) })),
				st(exec).get('/api/dynamic-reeval/status').catch((e) => ({ error: String(e?.message ?? e) })),
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
			const out = { baseUrl: userCfg.signalTraderBaseUrl };
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
		description: '只读解释 AI 分时交易决策:初始评分/盘面证据、回落反弹阈值与确认、动态调参原因、当前触发进度、去重拦截和执行回报。按 code/condition_id 查询今日记录;不重新评分、不修改条件、不交易。区分信号接收/条件创建/委托成交,展示每笔实际 execution_route。',
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
				st(exec).get('/api/signals/today'),
				st(exec).get('/api/local-execution/today'),
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
		description: '向 AI 信号引擎(ths-ai-signal-trader)发送一条交易信号:引擎按 strategy_v2.0 评分(强弱+位置+MACD结构门禁)动态定参,根据评分及用户配置决定是否创建拐点条件单（回落卖出/反弹买入），启用实盘执行时可能产生真实委托。用法:stock_name+signal_type 直达,quantity 覆盖单次委托数量(缺省用引擎预设);或传 text 让引擎自己解析。触发参数由引擎动态决定。统一经持久化 webhook 入队(结构化走 /webhook/structured,原始文本走 /webhook),由后台 worker 评分和建条件。插件不预检运行路由/账户/网关;执行路由与实盘开关由用户手动配置。返回 queued 仅表示信号已接收/去重结果,不代表已建条件、已下单或成交;用 ths_signal_status/ths_signal_explain 跟踪。',
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
			const userCfg = connectionForExecution(exec, cfg, 'aiSignal');
			if (!userCfg.signalTraderWebhookToken) throw new Error('当前用户未配置 AI 分时交易 webhook token,无法投递');
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
			const result = await st(exec).postWebhook(path, rawText ? body.text : body, rawText);
			return { queued: true, transport: 'persistent_webhook', path, sent: body, result };
		},
	});

}

export { apply, inject, name };
