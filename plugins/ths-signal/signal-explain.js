/** AI 分时交易决策审计:只读整理引擎已有记录,不重新评分、不改变交易行为。 */

const TIER_LABELS = {
	very_strong: '很强', strong: '较强', neutral: '中性', weak: '较弱', very_weak: '很弱',
};
const OUTCOME_REASONS = {
	local_window: '同方向信号仍在去重窗口内,未重复建条件',
	local_active: '同方向已有在途条件,未重复建条件',
	broker_active: '券商侧已有同向活动委托,未重复建条件',
};

function present(value) {
	return value !== undefined && value !== null && value !== '';
}

function percent(value) {
	return present(value) && Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : '缺失';
}

function epochToIso(value) {
	return present(value) && Number.isFinite(Number(value))
		? new Date(Number(value) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : undefined;
}

function direction(signal) {
	return signal.signal_type === 'fall_sell' ? 'sell' : signal.signal_type === 'rebound_buy' ? 'buy' : '';
}

function evidenceSummary(evidence = {}) {
	const rows = [
		`日内状态=${evidence.day_state || '未知'}`,
		`板块短线=${evidence.short_term_state || '未知'}`,
		`板块背景=${evidence.background_state || '未知'}`,
		`个股10分钟涨速=${percent(evidence.stock_roc_10m)}`,
		`个股相对板块涨速=${percent(evidence.relative_roc)}`,
		`市场广度=${percent(evidence.breadth_ratio)}`,
	];
	if (present(evidence.position_score_adjustment)) {
		rows.push(`位置评分修正=${Number(evidence.position_score_adjustment) >= 0 ? '+' : ''}${evidence.position_score_adjustment}`);
	}
	if (present(evidence.remaining_adverse_pct)) rows.push(`剩余反向空间=${percent(evidence.remaining_adverse_pct)}`);
	return rows;
}

function structureSummary(gate) {
	if (!gate || typeof gate !== 'object') return [];
	const rows = [`结构门禁=${gate.applied ? '已改变参数' : '已评估,未改变参数'}`];
	for (const scope of ['stock', 'index', 'sector']) {
		const frames = gate.layers?.[scope];
		if (!frames) continue;
		for (const [frame, value] of Object.entries(frames)) {
			if (value?.divergence && value.divergence !== 'none') {
				rows.push(`${scope}/${frame} 背离=${value.divergence}`);
			}
			if (value?.cross && value.cross !== 'none') rows.push(`${scope}/${frame} 交叉=${value.cross}`);
		}
	}
	return rows;
}

function selectCondition(signal, conditions) {
	const conditionId = String(signal.condition_id || '');
	if (conditionId) return conditions.find((item) => String(item.condition_id || '') === conditionId) ?? null;
	// 老记录没有 condition_id 时,只回退同代码同方向、创建时间不早于信号的一条。
	// 不拿其他方向或其他股票的记录补充,避免串单。
	const signalTime = Date.parse(signal.processed_at || '');
	const side = direction(signal);
	return conditions.filter((item) =>
		item.stock_code === signal.stock_code && item.direction === side &&
		(!Number.isFinite(signalTime) || !present(item.created_at) || Number(item.created_at) * 1000 >= signalTime - 1000)
	).sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))[0] ?? null;
}

function explainOne(signal, condition) {
	const decision = signal.decision ?? {};
	const evidence = decision.evidence ?? {};
	const reason = signal.dedup_reason || '';
	const score = decision.score ?? signal.score;
	const tier = decision.tier ?? signal.tier;
	const adjustments = (condition?.dynamic_adjust_history ?? []).map((item) => ({
		at: epochToIso(item.ts),
		score: item.score,
		tier: item.tier,
		tierLabel: TIER_LABELS[item.tier] ?? item.tier,
		threshold: `${item.old_threshold_pct}% → ${item.new_threshold_pct}%`,
		confirmationSeconds: `${item.old_confirm_seconds}s → ${item.new_confirm_seconds}s`,
		reason: item.reason || '引擎未记录原因',
	}));
	const initialThreshold = condition?.dynamic_initial_target_pct ?? signal.turn_back_percent ?? decision.trigger_pct;
	const initialConfirmSeconds = condition?.dynamic_initial_confirm_seconds;
	const currentThreshold = condition?.target_pct ?? initialThreshold;
	const currentConfirmSeconds = condition?.confirm_target_seconds;
	const move = condition?.move_pct;
	const remaining = present(move) && present(currentThreshold) ? Math.max(0, Number(currentThreshold) - Number(move)) : undefined;
	const explanation = [
		`信号: ${signal.signal_type === 'fall_sell' ? '高点→回落卖出' : signal.signal_type === 'rebound_buy' ? '低点→反弹买入' : signal.signal_type};来源=${decision.signal_origin || signal.source || '未知'}。`,
		present(score)
			? `初始评分=${score},档位=${TIER_LABELS[tier] ?? tier ?? '未知'},证据覆盖=${present(evidence.score_coverage) ? `${Math.round(Number(evidence.score_coverage) * 100)}%` : '未知'}。该分数衡量动能强弱,不是上涨概率。`
			: `未记录智能评分;参数来源=${decision.source === 'static' ? '静态规则' : decision.source || '未知'}。`,
		`初始条件=${present(initialThreshold) ? `${initialThreshold}%` : '未记录'},确认=${present(initialConfirmSeconds) ? `${initialConfirmSeconds}s` : present(signal.confirm_times) ? `${signal.confirm_times}次` : '未记录'};数量=${condition?.quantity ?? signal.entrust_quantity ?? '未记录'}。`,
		reason ? `未新建原因=${OUTCOME_REASONS[reason] ?? reason}。` : `处理结果=${signal.outcome || '未知'};创建条件不代表已经委托或成交。`,
	];
	if (decision.regime_reason) explanation.push(`策略记录: ${decision.regime_reason}`);
	const facts = [...evidenceSummary(evidence), ...structureSummary(evidence.structure_gate)];
	if (condition) {
		explanation.push(`当前条件=${currentThreshold}% / ${currentConfirmSeconds ?? '?'}s,状态=${condition.status || '未知'},该笔执行路由=${condition.execution_route || '未知'}。`);
		if (present(move)) {
			explanation.push(`触发进度: 现价=${condition.current_price ?? '未知'},跟踪极值=${condition.extreme_price ?? '未知'},已${condition.direction === 'sell' ? '回落' : '反弹'}${percent(move)},目标=${currentThreshold}%,尚差${percent(remaining)}。`);
		}
		if (present(condition.confirm_seconds)) {
			explanation.push(`确认进度=${Number(condition.confirm_seconds).toFixed(1)}s / ${currentConfirmSeconds ?? '?'}s。`);
		}
		if (condition.message) explanation.push(`执行回报: ${condition.message}`);
	} else {
		explanation.push('未找到对应的本地条件记录;可能是历史记录、未建条件、去重拦截或引擎已清理,不据此推断已下单。');
	}
	return {
		at: signal.processed_at,
		conditionId: signal.condition_id || condition?.condition_id || undefined,
		code: signal.stock_code,
		name: signal.stock_name,
		type: signal.signal_type,
		outcome: signal.outcome,
		dedupReason: reason || undefined,
		decisionSource: decision.source,
		score,
		tier,
		tierLabel: TIER_LABELS[tier] ?? tier,
		scoreMeaning: '动能强弱评分,不是上涨概率',
		initial: { thresholdPct: initialThreshold, confirmSeconds: initialConfirmSeconds, confirmTimes: signal.confirm_times },
		evidence: facts,
		adjustments,
		current: condition ? {
			status: condition.status,
			route: condition.execution_route,
			thresholdPct: currentThreshold,
			confirmSeconds: currentConfirmSeconds,
			currentPrice: condition.current_price,
			extremePrice: condition.extreme_price,
			movePct: move,
			remainingPct: remaining,
			confirmedSeconds: condition.confirm_seconds,
			message: condition.message,
		} : null,
		explanation,
	};
}

/** 构建可 JSON 序列化的审计视图;undefined 字段在工具输出前统一清理。 */
export function buildSignalExplanations(signals, conditions, { code, conditionId, limit = 5 } = {}) {
	return signals.filter((signal) =>
		(!code || signal.stock_code === code) &&
		(!conditionId || signal.condition_id === conditionId)
	).slice(-limit).reverse().map((signal) => explainOne(signal, selectCondition(signal, conditions)));
}
