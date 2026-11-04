// stale-process-pruner(2026-11-04): 面向对话型身份的 compaction 扩展。
// 用户定调: 投资助手非 coding 场景, 旧轮的「工具调用记录 + 思考过程」过期即废,
// 只需保留 assistant 正文与用户消息维持对话记忆。
//
// 策略(两层):
//   1) 继承官方 ToolResultPruner: 大工具结果头尾截断(8192/4096/1024) — 不变
//   2) staleTurns 轮龄裁剪(及时触发, 2026-11-04 从水位钩子改为轮次边界):
//      每轮首次模型请求前裁 N 轮外的 tool/result、tool/call、reasoning, 留正文 checkpoint。
//      仅 agent/pre-step(step=1) 触发；同轮工具步骤不裁，工具链始终完整。
//      time-context 等每轮采样快照视为临时节点随段折叠(2026-11-04 修: 之前卡死整段)。
//
// 保留: assistant 正文(text 段)、user 消息、最近 N 轮内的一切。
// 触发: 仅 agent/pre-step(step=1)，同轮工具调用过程完整；step>1 不裁。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 可移植导入(2026-11-04 v1.1.2): dsh 内部件优先走裸说明符(dsh-app-boot 的插件解析器支持),
// 兜底按已知安装根逐一尝试 — 修掉硬编码 /usr/lib 路径(Windows 上曾解析成 C:\usr\lib 导致启动失败)。
async function importDshInternal(sub) {
	const spec = `@deepseek-ai/${sub}`;
	try { return await import(spec); } catch { /* fall through */ }
	const roots = [
		'/usr/lib/node_modules/@deepseek-ai/dsh/node_modules', // baiying(Linux 全局安装)
		`${process.env.APPDATA ?? ''}\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules`, // Windows npm 全局
		'/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules', // macOS/Linux 常规全局
	];
	for (const root of roots) {
		if (!root) continue;
		try {
			return await import(pathToFileURL(join(root, '@deepseek-ai', sub, 'lib', 'index.js')).href);
		} catch { /* try next */ }
	}
	throw new Error(`stale-process-pruner: cannot import ${spec} (bare specifier and all fallback roots failed)`);
}

const [
	{ ToolResultPruner },
	{ createUserMessage },
	{ compactCheckpointSource, toolPairingBalancedBefore },
] = await Promise.all([
	importDshInternal('dsh-compaction-tool-result-pruner'),
	importDshInternal('dsh-llm'),
	importDshInternal('dsh-compaction'),
]);

export const name = 'stale-process-pruner';

// 事件驱动(2026-11-04 定稿「及时裁」语义): 每次模型请求前裁剪。
// agent/pre-step 是有序 agent 事件; 不能从同步的 session/event 回调里 append,
// Session 会拒绝 "session append cannot reenter while another append is being published"。
export const inject = ['sessions', 'tokenMeter', 'agents'];

const DEFAULT_STALE_TURNS = 1;

export class StaleProcessPruner extends ToolResultPruner {
	constructor(ctx, config = {}) {
		// 父类拿 thresholdChars/headChars/tailChars; 多余键 staleTurns 自己取。
		const { staleTurns, ...parent } = config;
		super(ctx, parent);
		this.staleTurns = Number.isInteger(staleTurns) ? staleTurns : DEFAULT_STALE_TURNS; // 0/-1 是合法显式值,校验在 pruneStaleProcess
		// 用引擎 checkpoint 协议替换整段历史，避免 assistant tool-call/result 失配，
		// 也不触发 session/event 的同步观察者看到半提交状态。
		ctx.on?.('agent/pre-step', async ({ agent, step, turn, signal }, next) => {
			if (!signal?.aborted && step === 1) {
				try {
					const stale = this.pruneStaleProcess(agent.session, turn);
					if (stale.pruned > 0) {
						ctx.logger?.info?.(`[stale-process-pruner] 请求前裁剪: ${stale.pruned} 事件, ${stale.charsRemoved} 字符 (${agent.session.id})`);
					}
				} catch (error) {
					ctx.logger?.warn?.(`[stale-process-pruner] 请求前裁剪失败: ${String(error)}`);
				}
			}
			return next();
		});
		const originalPrune = this.pruneSession.bind(this);
		this.pruneSession = (session) => originalPrune(session);
	}

	/** 最近会话轮次: surface 上最后一条事件的 turn。 */
	currentTurn(session) {
		for (let i = session.surface.nodes.length - 1; i >= 0; i -= 1) {
			const event = session.eventAt(session.surface.nodes[i]);
			const turn = event?.data?.turn;
			if (Number.isInteger(turn)) return turn;
		}
		return 0;
	}

	/**
	 * 钉住节点(pinned): 真实用户消息 / AGENTS 指令注入(基线+更新) / 运行时快照 / 系统消息。
	 * 这些节点字节永远稳定: 用户消息承载对话记忆; 指令注入一旦被 shadow,
	 * agent-instructions 会因可见摘要丢失而整份重发(实测 9k token/轮的缓存惩罚)。
	 * 裁剪只发生在两个钉住节点之间的纯过程段(assistant/tool/旧checkpoint)。
	 */
	isPinned(event) {
		if (event?.type === 'system/message') return true;
		if (event?.type !== 'user/message') return false;
		const kind = event.data?.source?.kind;
		return kind === 'user' || kind === 'agent-instructions' || kind === 'runtime-context';
	}

	/** checkpoint 消息(本插件产物): 折叠态, 作为过程段一员, 再次折叠时文本去头防嵌套。 */
	isCheckpoint(event) {
		return event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint';
	}

	/**
	 * 每轮运行时采样快照(time-context): 无轮号但必然过期, 不值得钉住。
	 * 2026-11-04 实测(personal-investment lark-1793789451570 T5→T6): 它落在过程段头部时,
	 * 旧逻辑因「无整数 turn」整段放弃折叠 —— 恰逢 10 分钟采样点的轮(52k 过程)一条都折不掉。
	 * 修法: 视为可折叠的临时节点, 正文(时间戳)折叠时直接丢弃。
	 */
	isEphemeral(event) {
		return event?.type === 'user/message' && event.data?.source?.kind === 'time-context';
	}

	/**
	 * 轮龄裁剪: 把「完全过期」的过程段各折叠成一条确定性 checkpoint; 原始事件仍完整保留在日志。
	 * 段边界 = 钉住节点; 指令注入永不 shadow → 不会触发整份重发。
	 * 每段独立走官方 compaction/start|summary|replace|end 事务。
	 */
	pruneStaleProcess(session, openTurn) {
		// compaction 生命周期事件的 turn 必须等于当前已开启轮号(v3→v4 加载校验),
		// 不能用 currentTurn()(它读到的是上一轮)。拿不到开启轮号就跳过本轮裁剪。
		if (!Number.isInteger(openTurn)) return { pruned: 0, charsRemoved: 0 };
		// staleTurns 语义(2026-11-04 用户定调): 值 = 原始保留的既往轮数。
		//   0  = 保留 0 轮: 上一轮在下一轮开始即折(对话/紧凑模式)
		//   1  = 保留上一轮原始, 折 ≤T-2(coding 兼容模式)
		//  -1  = 完全禁用轮龄裁剪(仅保留大结果截断)
		// cutoff = openTurn - 1 - N (N≥0); N<0 禁用。
		if (!Number.isInteger(this.staleTurns) || this.staleTurns < 0) {
			if (this.staleTurns !== -1) {
				this.ctx?.logger?.warn?.(`stale-process-pruner: 非法 staleTurns=${this.staleTurns}, 轮龄裁剪禁用(仅 -1 显式禁用, 0+ 合法)`);
			}
			return { pruned: 0, charsRemoved: 0 };
		}
		const cutoff = openTurn - 1 - this.staleTurns;
		if (cutoff <= 0) return { pruned: 0, charsRemoved: 0 };
		const nodes = [...session.surface.nodes];
		let pruned = 0;
		let charsRemoved = 0;
		let gapStart = -1;
		for (let index = 0; index <= nodes.length; index += 1) {
			const event = index < nodes.length ? session.eventAt(nodes[index]) : undefined;
			if (index < nodes.length && !this.isPinned(event)) {
				if (gapStart === -1) gapStart = index;
				continue;
			}
			// index 是段尾边界(钉住节点或 surface 末端), 折叠 [gapStart, index)
			if (gapStart !== -1) {
				const folded = this.foldGap(session, nodes, gapStart, index - 1, cutoff, openTurn);
				pruned += folded.pruned;
				charsRemoved += folded.charsRemoved;
				gapStart = -1;
			}
		}
		return { pruned, charsRemoved };
	}

	/** 折叠一个过程段; 段内必须全部过期且含未折叠的原始内容, 否则跳过。 */
	foldGap(session, nodes, from, to, cutoff, openTurn) {
		let hasRawStale = false;
		for (let index = from; index <= to; index += 1) {
			const event = session.eventAt(nodes[index]);
			if (this.isCheckpoint(event)) continue; // 折叠态透明: 不算新内容也不阻碍
			if (this.isEphemeral(event)) continue; // time-context 采样: 无轮号但必然过期, 随段折叠
			const turn = event?.data?.turn;
			if (!Number.isInteger(turn) || turn > cutoff) return { pruned: 0, charsRemoved: 0 };
			if (event?.type === 'assistant/message' || event?.type === 'tool/result') hasRawStale = true;
		}
		if (!hasRawStale) return { pruned: 0, charsRemoved: 0 }; // 纯旧checkpoint段: 已冻结, 不再重折
		// 边界工具配对: 段首前移/段尾回缩到 balanced 切口(钉住节点旁通常天然平衡)。
		let start = from;
		while (start <= to && !toolPairingBalancedBefore(session, nodes[start])) start += 1;
		let end = to;
		while (end >= start && !toolPairingBalancedBefore(session, nodes[end + 1] ?? nodes[end])) end -= 1;
		if (end < start) return { pruned: 0, charsRemoved: 0 };
		const shadowedSeqs = nodes.slice(start, end + 1);
		const retained = [];
		let charsRemoved = 0;
		for (const seq of shadowedSeqs) {
			const event = session.eventAt(seq);
			const original = session.deriveEventMessage(event);
			if (!original) continue;
			if (this.isCheckpoint(event)) {
				// 旧checkpoint并入新段: 去掉首行标记, 正文延续, 防嵌套增长。
				const text = (original.content || []).map((part) => part?.text || '').join('\n');
				const body = text.replace(/^\[历史对话精编[^\n]*\]\n?/, '').trim();
				if (body) retained.push(body);
				continue;
			}
			const texts = event.type === 'assistant/message'
				? (original.content || []).filter((part) => part?.type === 'text' && part.text?.trim()).map((part) => part.text)
				: [];
			retained.push(...texts);
			charsRemoved += this.measureContent(original.content) - texts.reduce((sum, text) => sum + text.length, 0);
		}
		const originalTokens = shadowedSeqs.reduce((sum, seq) => {
			const message = session.deriveEventMessage(session.eventAt(seq));
			return sum + (message ? this.ctx.tokenMeter.estimateMessage(message) : 0);
		}, 0);
		const text = retained.filter((part) => part.trim()).join('\n\n');
		const summary = [{ type: 'text', text: `[历史对话精编：仅保留用户与助手正文，工具调用参数、工具输出与思考过程已裁剪。]\n\n${text || '（此前只有工具调用过程，无正文。）'}` }];
		const checkpointId = `stale-${session.id}-${session.seq}-${shadowedSeqs[0]}`;
		const startEvent = session.append('compaction/start', { compactionId: checkpointId, turn: openTurn });
		const summaryEvent = session.append('compaction/summary', {
			compactionId: checkpointId,
			summary,
			shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
			shadowedSeqs,
			shadowedTokenCount: originalTokens,
			provider: 'local',
			model: 'deterministic-stale-process-pruner',
			deterministic: true,
		});
		const checkpointMessage = createUserMessage({
			content: [{ type: 'text', text: `<checkpoint>\n${summary[0].text}\n</checkpoint>` }],
			source: compactCheckpointSource(checkpointId),
		});
		session.append('user/message', checkpointMessage, {
			surfaceOp: { op: 'replace', startSeq: shadowedSeqs[0], endSeq: shadowedSeqs[shadowedSeqs.length - 1] },
			sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
		});
		session.append('compaction/end', { compactionId: checkpointId, turn: openTurn });
		return { pruned: shadowedSeqs.length, charsRemoved };
	}
}

// cordis 插件协议(default 导出 class, 加载器 new 它):
// 构造内完成官方语义(super: 截断参数), 再把轮龄裁剪织入 pruneSession 钩子。
export default StaleProcessPruner;

// 已在构造器织入钩子(见下), apply 保留给函数式加载兼容。
export function apply(ctx, config) {
	return new StaleProcessPruner(ctx, config);
}
