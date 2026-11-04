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

// ── checkpoint 滚动压缩(2026-11-05): 马拉松会话止血 ──
const CK = (seq, text, turn = null) => ({ seq, type: 'user/message', data: { turn, content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint' } } });
const ckBody = (n, size) => `<checkpoint>\n[历史对话精编：仅保留用户与助手正文，工具调用参数、工具输出与思考过程已裁剪。]\n\n第${n}轮结论：${'详'.repeat(size)}。完。\n</checkpoint>`;

// ── 用例5: 默认 drop 模式 — 6 条 checkpoint, keep=2 → 前 4 条占位化, 后 2 条原样 ──
{
	const events = [U(1, 'user', 'q', null)];
	for (let i = 0; i < 6; i += 1) {
		events.push(CK(2 + i, ckBody(i + 1, 800)));
		events.push(U(8 + i, 'user', `q${i}`, null));
	}
	const session = mkSession(events);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0, checkpointKeep: 2 });
	pruner.compressStaleCheckpoints(session, 9);
	const replaces = session.appended.filter((x) => x.opts?.surfaceOp?.op === 'replace');
	check('case5 drop 占位化 4 条(6-2)', replaces.length === 4);
	const texts = replaces.map((x) => x.data?.content?.[0]?.text || '');
	check('case5 占位=DROP_MARK 包 checkpoint 壳', texts.every((t) => t === `<checkpoint>\n[已并档]\n</checkpoint>`));
	check('case5 单条 span 替换(startSeq===endSeq)', replaces.every((x) => x.opts.surfaceOp.startSeq === x.opts.surfaceOp.endSeq));
}

// ── 用例5b: 显式 archive 模式保留采样残影 ──
{
	const events = [U(1, 'user', 'q', null)];
	for (let i = 0; i < 6; i += 1) {
		events.push(CK(2 + i, ckBody(i + 1, 800)));
		events.push(U(8 + i, 'user', `q${i}`, null));
	}
	const session = mkSession(events);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0, checkpointKeep: 2, checkpointMode: 'archive' });
	pruner.compressStaleCheckpoints(session, 9);
	const replaces = session.appended.filter((x) => x.opts?.surfaceOp?.op === 'replace');
	check('case5b archive 压缩 4 条', replaces.length === 4);
	const texts = replaces.map((x) => x.data?.content?.[0]?.text || '');
	check('case5b 带归档标记+头尾采样', texts.every((t) => t.includes('[归档|原') && t.includes('[归档尾]')));
}

// ── 用例6: drop 幂等(占位冻结) + 无收益短正文不动 + 旧 archive 残影迁移为占位 ──
{
	const session = mkSession([
		U(1, 'user', 'q', null),
		CK(2, `<checkpoint>\n[已并档]\n</checkpoint>`),
		U(3, 'user', 'q', null),
		CK(4, `<checkpoint>\n[历史对话精编：裁剪。]\n\n短\n</checkpoint>`),
		U(5, 'user', 'q', null),
		CK(6, `<checkpoint>\n[归档|原42字符] 旧模式残影\n</checkpoint>`),
		U(7, 'user', 'q', null),
	]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0, checkpointKeep: 0 });
	pruner.compressStaleCheckpoints(session, 9);
	const replaces = session.appended.filter((x) => x.opts?.surfaceOp?.op === 'replace');
	check('case6 占位冻结+短正文不动, 仅旧残影迁移 → 1 次替换', replaces.length === 1);
	check('case6 迁移产物=占位', (replaces[0]?.data?.content?.[0]?.text || '').includes('[已并档]'));
}

// ── 用例7: checkpointKeep=-1 禁用压缩 ──
{
	const session = mkSession([U(1, 'user', 'q', null), CK(2, ckBody(1, 800)), U(3, 'user', 'q', null)]);
	const pruner = new StaleProcessPruner(ctx, { staleTurns: 0, checkpointKeep: -1 });
	pruner.compressStaleCheckpoints(session, 9);
	check('case7 -1 禁用', session.appended.length === 0);
}

// ── digest 模式(v1.3.0): 滚动摘要 ──
// 事件形态: 出窗 checkpoint(keep 窗口外) + keep 窗口内 checkpoint
const CKPT = (seq, turn, text) => ({ seq, type: 'user/message', data: { turn: null, content: [{ type: 'text', text: `<checkpoint>\n${text}\n</checkpoint>` }], source: { kind: 'compact-checkpoint' } } });
const digestScenario = (extra = []) => [
	U(1, 'user', '问题A', null),
	...extra,
	CKPT(90, 8, '第8轮记录: 用户要求X, 已完成, 关键文件 /tmp/a.py'),
	CKPT(91, 9, '第9轮记录: 修复了Y错误, 参数 k=3'),
	U(92, 'user', '最新问题', null),
];
async function digestTests() {
	// T1: 无旧摘要, 1候选 → 新摘要落候选位
	{
		const session = mkSession(digestScenario());
		const pruner = new StaleProcessPruner(ctx, { staleTurns: -1, checkpointKeep: 1, checkpointMode: 'digest' });
		let seen = null;
		pruner.mergeDigestText = async (_s, prev, inc) => { seen = { prev, inc }; return '合并后的摘要内容'; };
		pruner.compressStaleCheckpoints(session, 10);
		await pruner.digestInflight.get(session.id);
		const replaced = session.appended.filter((a) => a.opts?.surfaceOp?.op === 'replace');
		const newText = replaced.map((a) => a.data?.content?.[0]?.text || '').join('|');
		check('digest T1 候选被替换为滚动摘要', replaced.length === 1 && newText.includes('[会话滚动摘要') && newText.includes('合并后的摘要内容'));
		check('digest T1 合并输入含候选原文', seen?.inc?.includes('第8轮记录'));
	}
	// T2: 有旧摘要 → 旧摘要转占位, 新候选转摘要
	{
		const session = mkSession(digestScenario([CKPT(89, 7, '[会话滚动摘要|更新于turn 7]旧摘要: 此前做了W')]));
		const pruner = new StaleProcessPruner(ctx, { staleTurns: -1, checkpointKeep: 1, checkpointMode: 'digest' });
		let prevSeen = null;
		pruner.mergeDigestText = async (_s, prev, inc) => { prevSeen = prev; return '新摘要v2'; };
		pruner.compressStaleCheckpoints(session, 10);
		await pruner.digestInflight.get(session.id);
		const replaces = session.appended.filter((a) => a.opts?.surfaceOp?.op === 'replace');
		const texts = replaces.map((a) => (a.data?.content?.[0]?.text || '').replace(/<[^>]+>/g, '').trim());
		check('digest T2 旧摘要正文进入合并且头部标记被剥离', prevSeen?.includes('此前做了W') && !prevSeen?.includes('更新于turn 7'));
		check('digest T2 恰好两次替换(新摘要+旧占位)', replaces.length === 2);
		check('digest T2 含新摘要与占位', texts.some((t) => t.includes('新摘要v2')) && texts.some((t) => t.includes(DROP_MARK_S)));
	}
	// T3: LLM 失败 → 候选原文保留, 零替换
	{
		const session = mkSession(digestScenario());
		const pruner = new StaleProcessPruner(ctx, { staleTurns: -1, checkpointKeep: 1, checkpointMode: 'digest' });
		pruner.mergeDigestText = async () => null;
		pruner.compressStaleCheckpoints(session, 10);
		await pruner.digestInflight.get(session.id);
		const replaced = session.appended.filter((a) => a.opts?.surfaceOp?.op === 'replace');
		check('digest T3 失败不动(零替换)', replaced.length === 0);
		check('digest T3 锁已释放可重试', !pruner.digestInflight.has(session.id));
	}
	// T4: 多候选一批 → 首个转摘要, 其余转占位
	{
		const session = mkSession(digestScenario([CKPT(88, 6, '第6轮记录: 早期工作Z')]));
		const pruner = new StaleProcessPruner(ctx, { staleTurns: -1, checkpointKeep: 1, checkpointMode: 'digest' });
		pruner.mergeDigestText = async () => '批次摘要';
		pruner.compressStaleCheckpoints(session, 10);
		await pruner.digestInflight.get(session.id);
		const replaces = session.appended.filter((a) => a.opts?.surfaceOp?.op === 'replace');
		const texts = replaces.map((a) => (a.data?.content?.[0]?.text || '').replace(/<[^>]+>/g, '').trim());
		check('digest T4 两次替换(摘要+一占位,keep=1 留 91)', replaces.length === 2);
		check('digest T4 恰一份摘要其余占位', texts.filter((t) => t.includes('批次摘要')).length === 1 && texts.filter((t) => t.includes(DROP_MARK_S)).length === 1);
	}
}
const DROP_MARK_S = '[已并档]';
await digestTests();

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
