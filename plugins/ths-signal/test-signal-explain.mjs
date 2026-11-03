import assert from 'node:assert/strict';
import { buildSignalExplanations } from './signal-explain.js';

const signals = [{
	processed_at: '2026-10-26T09:48:11+08:00', condition_id: 'local-buy', stock_code: '300870', stock_name: '欧陆通',
	signal_type: 'rebound_buy', outcome: 'created', source: 'ai_topbottom_stream', entrust_quantity: 100,
	decision: { source: 'smart', signal_origin: 'AI分时', score: 18.09, tier: 'very_weak', trigger_pct: 3, regime_reason: '初始证据',
		evidence: { score_coverage: 1, day_state: 'panic', short_term_state: '偏弱', stock_roc_10m: -2.04, relative_roc: -0.55 } },
}, {
	processed_at: '2026-10-26T10:18:09+08:00', condition_id: 'local-sell', stock_code: '300386', stock_name: '飞天诚信',
	signal_type: 'fall_sell', outcome: 'ignored', dedup_reason: 'local_window',
	decision: { source: 'smart', score: 50.27, tier: 'neutral' },
}];
const conditions = [{
	condition_id: 'local-buy', stock_code: '300870', direction: 'buy', execution_route: 'simulation', status: 'submitted',
	quantity: 100, dynamic_initial_target_pct: 3, dynamic_initial_confirm_seconds: 18,
	target_pct: 0.5, confirm_target_seconds: 3, current_price: 121.71, extreme_price: 119.82,
	move_pct: 1.577366, confirm_seconds: 3, message: '已成交(模拟)',
	dynamic_adjust_history: [{ ts: 1792979762.49, old_threshold_pct: 3, new_threshold_pct: 0.5, old_confirm_seconds: 18, new_confirm_seconds: 3, score: 81.59, tier: 'very_strong', reason: '3轮确认调快' }],
}, {
	condition_id: 'local-sell', stock_code: '300386', direction: 'sell', execution_route: 'ths_direct', status: 'armed', target_pct: 1.2, move_pct: 0.5,
}];

const [buy] = buildSignalExplanations(signals, conditions, { code: '300870' });
assert.equal(buy.conditionId, 'local-buy');
assert.equal(buy.initial.thresholdPct, 3);
assert.equal(buy.current.route, 'simulation');
assert.equal(buy.adjustments[0].reason, '3轮确认调快');
assert.ok(Math.abs(buy.current.remainingPct - 0) < 1e-9);
assert.match(buy.explanation.join('\n'), /不是上涨概率/);
assert.match(buy.explanation.join('\n'), /模拟/);
assert.match(buy.explanation.join('\n'), /尚差0.00%/);

const [ignored] = buildSignalExplanations(signals, conditions, { conditionId: 'local-sell' });
assert.match(ignored.explanation.join('\n'), /去重窗口/);
assert.equal(ignored.current.route, 'ths_direct');
assert.ok(Math.abs(ignored.current.remainingPct - 0.7) < 1e-9);

const [missing] = buildSignalExplanations([signals[0]], [], {});
assert.equal(missing.current, null);
assert.match(missing.explanation.join('\n'), /不据此推断已下单/);
assert.equal(buildSignalExplanations(signals, conditions, { code: '600519' }).length, 0);
assert.equal(buildSignalExplanations(signals, conditions, { limit: 1 }).length, 1);
console.log('ths-trade: signal explanation tests passed');
