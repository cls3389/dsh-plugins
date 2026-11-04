// 回归测试: time-context 采样消息不再卡死轮龄折叠 (2026-11-04)
// 场景复现自 personal-investment lark-1793789451570-ea64208c T5→T6 边界。
import { StaleProcessPruner } from './index.js';

function mkSession(events) {
	// events: [{seq,type,kind,turn,content}]
	const bySeq = new Map(events.map((e) => [e.seq, e]));
	return {
		id: 'test-session',
		seq: Math.max(...events.map((e) => e.seq)),
		surface: { nodes: events.map((e) => e.seq), replaceGeneration: 1 },
		eventAt: (seq) => bySeq.get(seq),
		deriveEventMessage: (event) =>
			event ? (event.data?.message ?? { role: 'user', content: event.data?.content || [] }) : null,
		appended: [],
		append(type, data, opts) {
			this.seq += 1;
			this.appended.push({ type, data, opts, seq: this.seq });
			return { seq: this.seq };
		},
	};
}

// 真实事件形态: type/seq 顶层, turn/content/source.kind 都在 data 内
const U = (seq, kind, text, turn) => ({ seq, type: 'user/message', data: { turn, content: [{ type: 'text', text }], source: { kind } } });
const A = (seq, turn, text, withToolCall = false) => ({ seq, type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [
	{ type: 'text', text },
	{ type: 'reasoning', text: '思考' },
	...(withToolCall ? [{ type: 'tool-call', id: `call_${seq}`, name: 'ths_quote' }] : []),
] } } });
const TC = (seq, turn, when = '19:01') => U(seq, 'time-context', `Time sampled while preparing turn ${turn}, step 1: ${when}`, null);
const TC_RESULT = (seq) => ({ seq, type: 'tool/result', data: { turn: 5, content: [{ type: 'text', text: 'x'.repeat(100) }] } });
const TC_CALL = (seq) => ({ seq, type: 'tool/call', data: { turn: 5, name: 'ths_quote', content: [{ type: 'text', text: '{}' }] } });

const ctx = {
	on: () => {},
	reflect: { provide: () => {} },
	logger: { info: () => {}, warn: (m) => process.stderr.write('WARN ' + m + '\n') },
	tokenMeter: { estimateMessage: () => 10 },
};

let failed = 0;
const check = (name, cond) => {
	console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
	if (!cond) failed += 1;
};

// ── 用例1(核心回归): 上一轮头部有 time-context 采样, 折叠不再整段跳过 ──
{
	const session = mkSession([
		U(1, 'user', '相关的标的同步到多维表', null), // T5 用户消息(pinned)
		TC(2, 5), // ← 10分钟采样落点: 无 turn 号, 旧逻辑在此卡死整段
		A(3, 5, '已同步四个群的标的。', true), // 工具调用块在 assistant 消息内(tool/call 事件本身 delta=0)
		TC_CALL(4),
		TC_RESULT(5),
		U(6, 'user', '好的', null), // T6 用户消息(pinned)
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0 });
	const r = pruner.pruneStaleProcess(session, 6); // T6 开轮, cutoff=5
	check('case1 折掉了过程段(pruned>0)', r.pruned > 0);
	const replace = session.appended.find((x) => x.opts?.surfaceOp?.op === 'replace');
	check('case1 走了 checkpoint replace 事务', Boolean(replace));
	const range = replace?.opts?.surfaceOp;
	check('case1 折叠范围从 time-context(seq2) 开始', range?.startSeq === 2);
	const ckpt = session.appended.find((x) => x.type === 'user/message');
	check('case1 checkpoint 保留助手正文', ckpt?.data?.content?.[0]?.text.includes('已同步四个群的标的。'));
	const body = (ckpt?.data?.content?.[0]?.text || '').split(']\n\n')[1] || '';
	check('case1 checkpoint 正文不含时间戳/思考(样板头除外)', !body.includes('Time sampled') && !body.includes('思考'));
}

// ── 用例2(回归保护): 段内有更新轮(turn>cutoff)仍然整段不折 ──
{
	const session = mkSession([
		U(1, 'user', 'q1', null),
		TC(2, 5),
		A(3, 5, '正文1'),
		A(4, 6, '新轮正文'), // turn=6 > cutoff=5
		U(5, 'user', 'q2', null),
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0 });
	const r = pruner.pruneStaleProcess(session, 6);
	check('case2 段内有新轮内容 → 不折', r.pruned === 0);
}

// ── 用例3: 无 time-context 的正常路径不受影响 ──
{
	const session = mkSession([
		U(1, 'user', 'q1', null),
		A(2, 5, '正文', true),
		TC_CALL(3),
		TC_RESULT(4),
		U(5, 'user', 'q2', null),
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0 });
	const r = pruner.pruneStaleProcess(session, 6);
	check('case3 纯过程段照常折叠', r.pruned >= 3);
}

// ── 用例4: staleTurns=-1 完全禁用 ──
{
	const session = mkSession([
		U(1, 'user', 'q1', null),
		TC(2, 5),
		A(3, 5, '正文'),
		U(4, 'user', 'q2', null),
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: -1 });
	const r = pruner.pruneStaleProcess(session, 6);
	check('case4 -1 禁用', r.pruned === 0);
}

const CK = (seq, text, turn = null) => ({ seq, type: 'user/message', data: { turn, content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint' } } });
const ckBodyLike = (n) => `<checkpoint>\n[历史对话精编：第${n}轮]\n\n第${n}轮结论：${'详'.repeat(400)}。\n</checkpoint>`;

// ── 用例7(v1.4.0 定版): checkpoint 永久保留 — 多条旧 checkpoint 在后续折叠/新轮到来时零改写 ──
{
	const session = mkSession([
		U(1, 'user', 'q', null),
		CK(2, ckBodyLike(1)),
		CK(3, ckBodyLike(2)),
		CK(4, ckBodyLike(3)),
		U(5, 'user', 'new turn', null),
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0 });
	const r = pruner.pruneStaleProcess(session, 5);
	const replaces = session.appended.filter((a) => a.op === 'replace');
	check('case7 无任何 checkpoint 改写(永不改写)', replaces.length === 0 && r.pruned === 0);
}

// ── 用例8(2026-11-05 定版): checkpoint 携带机械过程记录(▸调用/↳输出头/提示词锚) ──
{
	const session = mkSession([
		U(1, 'user', '查一下 600519 现价', null),
		A(2, 1, '600519 现价 1512.3 元。', true), // assistant 正文 + tool-call 块
		{ seq: 3, type: 'tool/call', data: { turn: 1, name: 'ths_quote', content: [{ type: 'text', text: '{"code":"600519"}' }] } },
		{ seq: 4, type: 'tool/result', data: { turn: 1, content: [{ type: 'text', text: 'price=1512.30 ' + 'x'.repeat(100) }] } },
		U(5, 'user', '好，再看 000001', null),
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0 });
	const r = pruner.pruneStaleProcess(session, 5);
	const ck = session.appended.filter((a) => a.type === 'user/message')
		.map((a) => (a.data?.content?.[0]?.text) || '').find((t) => t.startsWith('<checkpoint>')) || '';
	check('proc8 折叠发生', r.pruned > 0);
	check('proc8 含调用行(▸ ths_quote)', ck.includes('▸ ths_quote'));
	check('proc8 含输出头(↳ price=1512.30)', ck.includes('↳ price=1512.30'));
	check('proc8 含提示词锚(勿重述为未执行)', ck.includes('勿重述为未执行'));
	check('proc8 正文仍保留', ck.includes('1512.3'));
	check('proc8 头部标记兼容旧剥离正则', /^\[历史对话精编[^\n]*\]/.test(ck.replace(/^<checkpoint>\n?/, '')));
}
process.exit(failed ? 1 : 0);
