/**
 * @dsh-friends/model-config — DSH 模型配置审计与提案(多端点,只读)
 *
 * 定位:模型路由单一事实源是 home 层 cordis.patch.yml 的 llm-pi-ai 段。
 * 本插件对每个 provider 按其真值源审计:
 *   - source=openrouter(cpa):拉 OpenRouter 目录,按 policy 映射比对
 *     contextWindow/maxTokens/input/reasoningEfforts;无 supported_efforts 的
 *     模型标记 MANUAL(保留网关实测值,不猜)。
 *   - source=manual(kimi-coding 等):无机器可读目录,policy 记录期望值,
 *     直接比对结构字段。
 * 附加不变量:路由级 reasoning 档位必须是全部模型 efforts 键的交集成员;
 *   compat 逐字段核对;maxTokens+headroom<=contextWindow 由 propose 护栏强制。
 *
 * 工具(全部只读,永不写 YAML):
 *   model_config_audit   审计一致性,输出 MISMATCH / MANUAL / 集合差异
 *   model_config_propose 生成变更提案:current/proposed + 经唯一性校验的
 *                        edit 锚点(oldString/newString),供 agent 展示给
 *                        用户确认后用 edit 工具落盘,再复跑 audit+dump 验证
 *   model_config_policy  查看当前策略、约束与生效路径
 *   model_config_discover 新端点接入:拉端点模型列表,匹配 OpenRouter 目录
 *                        预填建议参数,供用户挑选(仅此一步读外部端点)
 *
 * 护栏:只对模型块的 contextWindow/maxTokens/input/reasoningEfforts 生成提案;
 *   provider 级受保护键(api/baseURL/apiKeyEnv/...)与模型集合增删只报告不提案;
 *   违反 maxTokens+headroom<=contextWindow 的提案直接拒绝。
 *   集合增删与 MANUAL 项涉及人工决策,必须由用户逐项拍板。
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'model-config';
const inject = ['tools'];

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

const CONFIG_DEFAULTS = {
	// home 层 patch:模型路由单一事实源(所有 profile 之上)
	profilePath: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cordis.patch.yml'),
	catalogUrl: 'https://openrouter.ai/api/v1/models',
	policyFile: '', // 空=依次找 $DSH_HOME/model-config/policy.json → 包内 policy.json
	requestTimeoutMs: 45000,
	userAgent: '@dsh-friends/model-config/0.4.0',
	// OpenRouter 目录缓存:默认永久(参数基本不变);缺失模型增量补拉单模型端点并写回缓存;
	// 拉取失败回退旧缓存;forceRefresh 全量强刷。
	catalogCachePath: '', // 空=$DSH_HOME/model-config/catalog-cache.json
	catalogCacheTtlMs: Number.POSITIVE_INFINITY,
	catalogFillMissing: true,
};

const DSH_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// 路由默认档推荐优先级:交集内先取次顶,再取更高级/更低档
const ROUTE_EFFORT_PRIORITY = ['high', 'medium', 'xhigh', 'low', 'max', 'minimal', 'off'];
const FIXABLE_FIELDS = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'];
// YAML 1.1 里会被解析成 null/布尔的裸词,作为值输出时必须加引号
const YAML_AMBIGUOUS = new Set(['null', '~', 'true', 'false', 'yes', 'no', 'on', 'off']);

/* ── YAML 子集解析(位置感知):只解析本插件需要的形状 ─────── */

function splitTrailingComment(line) {
	let sq = false;
	let dq = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !dq) sq = !sq;
		else if (ch === '"' && !sq) dq = !dq;
		else if (ch === '#' && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]))) {
			return [line.slice(0, i), line.slice(i)];
		}
	}
	return [line, ''];
}

function unquoteKey(k) {
	if (!k) return k;
	if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1);
	return k;
}

function parseScalarValue(raw) {
	const s = String(raw).trim();
	if (s.startsWith('!')) return `__tag__${s}`; // !!js/!expr 等标签:按不透明字符串
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	if (s === '' || s === '~' || s === 'null') return null;
	if (s === 'true') return true;
	if (s === 'false') return false;
	if (/^-?\d+$/.test(s)) return Number(s);
	if (/^-?\d+\.\d+$/.test(s)) return Number(s);
	if (s.startsWith('[') && s.endsWith(']')) {
		// 流式数组 [a, b]
		const items = s
			.slice(1, -1)
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean)
			.map((x) => unquoteKey(x));
		return items;
	}
	return s;
}

function formatScalar(v) {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	const s = String(v);
	if (YAML_AMBIGUOUS.has(s.toLowerCase())) return JSON.stringify(s);
	if (/^[\w./@~-][\w./@~ -]*$/.test(s)) return s; // 常规裸词(URL、模型名等)
	return JSON.stringify(s);
}

/**
 * 把 YAML 文本解析成带行号/跨度的树。
 * 节点: { indent, lineIdx, endIdx, isItem, key, value, children }
 * 覆盖:注释、缩进块、`- key: value` 项、`- value` 项、标量/引号串/数字/布尔。
 * 未识别行跳过(树外原始文本仍在,块切片保留注释)。
 */
function buildTree(text) {
	const lines = text.split('\n');
	const root = { indent: -1, lineIdx: -1, endIdx: lines.length - 1, isItem: false, key: null, value: null, children: [] };
	const stack = [root];
	for (let i = 0; i < lines.length; i++) {
		const [body] = splitTrailingComment(lines[i]);
		if (!body.trim()) continue;
		const content = body.trimStart();
		if (content === '---' || content === '...') continue;
		const indent = body.length - content.length;
		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
		const parent = stack[stack.length - 1];
		let node = null;
		const m = content.match(/^- ("[^"]*"|'[^']*'|[^:\s]+): ?(.*)$/);
		if (m) {
			node = { indent, isItem: true, key: unquoteKey(m[1]), value: parseScalarValue(m[2]), children: [], lineIdx: i };
		} else if (content.startsWith('- ')) {
			node = { indent, isItem: true, key: null, value: parseScalarValue(content.slice(2)), children: [], lineIdx: i };
		} else {
			const k = content.match(/^("[^"]*"|'[^']*'|[^:\s]+): ?(.*)$/);
			if (k && k[2] !== undefined) {
				node = { indent, isItem: false, key: unquoteKey(k[1]), value: parseScalarValue(k[2]), children: [], lineIdx: i };
			}
		}
		if (!node) continue;
		parent.children.push(node);
		stack.push(node);
	}
	const assignEnd = (node) => {
		let end = node.lineIdx;
		for (const c of node.children) end = Math.max(end, assignEnd(c));
		node.endIdx = end;
		return end;
	};
	for (const c of root.children) assignEnd(c);
	return { root, lines };
}

function childByKey(node, key) {
	return node.children.find((c) => c.key === key && !c.isItem) ?? null;
}

function getField(node, key) {
	if (node.key === key) return node.value; // `- id: x` 形式:键在项首行
	return childByKey(node, key)?.value ?? null;
}

function modelView(node) {
	const inputNode = childByKey(node, 'input');
	let input = null;
	if (inputNode) {
		if (Array.isArray(inputNode.value)) input = inputNode.value;
		else if (inputNode.children.length) input = inputNode.children.map((c) => c.value);
		else if (inputNode.value !== null && inputNode.value !== undefined) input = [inputNode.value];
	}
	const effortsNode = childByKey(node, 'reasoningEfforts');
	let efforts = undefined; // undefined=未配置;false=显式不支持;object=档位表
	if (effortsNode) {
		if (effortsNode.value === false) efforts = false;
		else if (effortsNode.children.length) {
			efforts = {};
			for (const c of effortsNode.children) if (c.key) efforts[c.key] = c.value;
		} else efforts = effortsNode.value === null ? {} : effortsNode.value;
	}
	return {
		id: getField(node, 'id'),
		name: getField(node, 'name'),
		contextWindow: getField(node, 'contextWindow'),
		maxTokens: getField(node, 'maxTokens'),
		input,
		reasoningEfforts: efforts,
	};
}

/** 从 profile 树提取 llm-pi-ai → config.providers.<name> */
function extractProviders(tree) {
	const entry = tree.root.children.find((n) => n.isItem && getField(n, 'id') === 'llm-pi-ai');
	if (!entry) return null;
	const config = childByKey(entry, 'config');
	const providersNode = config && childByKey(config, 'providers');
	if (!providersNode) return null;
	const providers = {};
	for (const p of providersNode.children) {
		if (p.isItem || !p.key) continue;
		const modelsNode = childByKey(p, 'models');
		const compatNode = childByKey(p, 'compat');
		const compat = {};
		if (compatNode) for (const c of compatNode.children) if (c.key && !c.isItem) compat[c.key] = c.value;
		providers[p.key] = {
			node: p,
			reasoning: childByKey(p, 'reasoning')?.value ?? null,
			compat,
			models: modelsNode ? modelsNode.children.filter((c) => c.isItem) : [],
		};
	}
	return providers;
}

/* ── 目录与策略 ─────────────────────────────────────── */

function expectedEffortsFromCatalog(reasoning) {
	if (!reasoning || typeof reasoning !== 'object') return { efforts: false };
	const supported = reasoning.supported_efforts;
	if (!Array.isArray(supported) || supported.length === 0) return { manual: true };
	const unknown = supported.filter((l) => !DSH_LEVELS.includes(l) && l !== 'none');
	if (unknown.length) return { error: `OpenRouter 返回 DSH 不认识的 effort: ${unknown.join(',')}` };
	const efforts = {};
	if (supported.includes('none')) efforts.off = 'none';
	for (const l of DSH_LEVELS) if (supported.includes(l)) efforts[l] = l;
	return { efforts };
}

function stableJson(v) {
	if (v === null || v === undefined) return 'null';
	if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
	if (typeof v === 'object') {
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(v);
}

function orderEfforts(obj) {
	return DSH_LEVELS.filter((k) => k in obj).map((k) => [k, obj[k]]);
}

/* ── 审计 ───────────────────────────────────────────── */

function auditProvider(providerName, policyProvider, providerInfo, catalogById, headroom) {
	const findings = [];
	const source = policyProvider.source;
	if (source !== 'openrouter' && source !== 'manual') {
		return { provider: providerName, source, error: `未知 source: ${source}`, findings, ok: false };
	}
	if (!providerInfo) {
		return {
			provider: providerName,
			source,
			mapped: policyProvider.models?.length ?? 0,
			configured: 0,
			fullyChecked: 0,
			findings: [{ severity: 'mismatch', field: 'provider', expected: '存在于 profile', actual: null, note: `profile 中没有 provider ${providerName}` }],
			ok: false,
		};
	}
	// provider 级:compat 逐字段
	for (const [k, expected] of Object.entries(policyProvider.compat ?? {})) {
		const actual = providerInfo.compat[k] ?? null;
		if (actual !== expected) findings.push({ severity: 'mismatch', field: `compat.${k}`, expected, actual });
	}
	// provider 级:路由默认档
	const routeExpected = policyProvider.routeReasoning ?? null;
	if (routeExpected !== null && providerInfo.reasoning !== routeExpected) {
		findings.push({
			severity: 'mismatch',
			field: 'reasoning',
			expected: routeExpected,
			actual: providerInfo.reasoning,
			note: '路由级默认档(未选档实际发送;须为全模型 efforts 交集)',
		});
	}
	const configured = providerInfo.models.map(modelView);
	const configuredById = new Map(configured.map((m) => [m.id, m]));
	const mappedEntries = policyProvider.models ?? [];
	const mappedById = new Map(mappedEntries.map((m) => [m.id, m]));
	if (configuredById.size !== configured.length || mappedById.size !== mappedEntries.length) {
		findings.push({ severity: 'mismatch', field: 'models', note: 'profile 或 policy 中存在重复模型 id' });
	}
	for (const id of [...configuredById.keys()].sort()) {
		if (!mappedById.has(id)) findings.push({ severity: 'mismatch', id, field: 'models', note: 'profile 配置了 policy 未登记的模型(先登记映射再保留)' });
	}
	for (const id of [...mappedById.keys()].sort()) {
		if (!configuredById.has(id)) findings.push({ severity: 'mismatch', id, field: 'models', note: 'policy 登记了 profile 未配置的模型(集合增删需用户拍板,不自动提案)' });
	}
	// 逐模型
	for (const entry of mappedEntries) {
		const actual = configuredById.get(entry.id);
		if (source === 'openrouter') {
			const upstream = catalogById?.get?.(entry.openrouter);
			if (!upstream) {
				findings.push({ severity: 'mismatch', id: entry.id, field: 'openrouter', expected: entry.openrouter, actual: null, note: 'OpenRouter 目录找不到该模型(先确认后端映射,不得静默删/换近似)' });
				continue;
			}
			if (!actual) continue;
			const top = upstream.top_provider ?? {};
			const expectations = {
				contextWindow: entry.contextWindow ?? null,
				maxTokens: entry.maxTokens ?? top.max_completion_tokens ?? null,
				// 规范序 text→image(目录返回字母序,配置固定 text 在前)
				input: entry.input ?? ['text', 'image'].filter((x) => (upstream.architecture?.input_modalities ?? []).includes(x)),
			};
			for (const [field, expected] of Object.entries(expectations)) {
				if (expected === null) continue;
				if (stableJson(actual[field]) !== stableJson(expected)) {
					findings.push({ severity: 'mismatch', id: entry.id, field, expected, actual: actual[field] ?? null });
				}
			}
			const r = expectedEffortsFromCatalog(upstream.reasoning);
			if (r.error) findings.push({ severity: 'mismatch', id: entry.id, field: 'reasoningEfforts', note: r.error });
			else if (r.manual) {
				findings.push({
					severity: 'manual',
					id: entry.id,
					field: 'reasoningEfforts',
					actual: actual.reasoningEfforts ?? null,
					note: '目录 reasoning 无 supported_efforts;只保留有网关实测依据的档位(不得猜,也不得为消警告设 false)',
				});
			} else if (stableJson(actual.reasoningEfforts ?? null) !== stableJson(r.efforts)) {
				findings.push({ severity: 'mismatch', id: entry.id, field: 'reasoningEfforts', expected: r.efforts, actual: actual.reasoningEfforts ?? null });
			}
		} else {
			// manual:policy 即期望值(官方文档+网关实测记录)
			if (!actual) continue;
			for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
				const expected = entry[field];
				if (expected === undefined) continue;
				if (stableJson(actual[field] ?? null) !== stableJson(expected)) {
					findings.push({ severity: 'mismatch', id: entry.id, field, expected, actual: actual[field] ?? null });
				}
			}
		}
		// 交集不变量:路由默认档必须在每个模型 efforts 键里
		if (routeExpected !== null && actual) {
			const efforts = actual.reasoningEfforts;
			if (efforts === undefined || efforts === false || !(routeExpected in efforts)) {
				findings.push({ severity: 'mismatch', id: entry.id, field: 'reasoningEfforts', note: `路由默认档 ${routeExpected} 不在该模型支持列表(交集被破坏,未选档请求会直接报错)` });
			}
		}
		// 压缩不变量:maxTokens+headroom<=contextWindow
		if (actual && Number.isFinite(actual.maxTokens) && Number.isFinite(actual.contextWindow) && actual.maxTokens + headroom > actual.contextWindow) {
			findings.push({
				severity: 'mismatch',
				id: entry.id,
				field: 'maxTokens',
				note: `违反不变量 maxTokens+${headroom}<=contextWindow(压力压缩静默失效;调 maxTokens 或窗口)`,
			});
		}
	}
	const flagged = new Set(findings.filter((f) => f.id).map((f) => f.id));
	return {
		provider: providerName,
		source,
		mapped: mappedEntries.length,
		configured: configured.length,
		fullyChecked: [...mappedById.keys()].filter((id) => configuredById.has(id) && !flagged.has(id)).length,
		findings,
		ok: !findings.some((f) => f.severity === 'mismatch'),
	};
}

/* ── 提案(只生成锚点,永不写文件) ─────────────────────── */

function idLineIndexOf(node, lines) {
	if (node.key === 'id') return node.lineIdx;
	const child = node.children.find((c) => c.key === 'id');
	if (child) return child.lineIdx;
	return node.lineIdx;
}

function buildScalarRegion(lines, node, field, expected) {
	for (let i = node.lineIdx; i <= node.endIdx; i++) {
		const line = lines[i];
		const [body, comment] = splitTrailingComment(line);
		const m = body.match(new RegExp(`^(\\s*)${field}:(.+)$`));
		if (!m || !m[2].trim()) continue; // 空值是块字段,不是标量行
		const newLine = `${m[1]}${field}: ${formatScalar(expected)}${comment}`;
		if (newLine === line) return null; // 值已一致(并行修订)
		return { type: 'line', idx: i, newLine };
	}
	return { type: 'insert', after: idLineIndexOf(node, lines), newLines: [`${' '.repeat(node.indent + 2)}${field}: ${formatScalar(expected)}`] };
}

function buildBlockRegion(lines, node, field, expected) {
	for (let i = node.lineIdx; i <= node.endIdx; i++) {
		const line = lines[i];
		const [body, comment] = splitTrailingComment(line);
		const m = body.match(new RegExp(`^(\\s*)${field}:\\s*$`));
		if (!m) continue;
		const indent = m[1].length;
		let end = i;
		for (let j = i + 1; j < lines.length; j++) {
			const [b2] = splitTrailingComment(lines[j]);
			if (!b2.trim()) break;
			if (b2.match(/^ */)[0].length > indent) end = j;
			else break;
		}
		const newLines = [`${m[1]}${field}:${comment}`, ...renderBlockEntries(field, expected, ' '.repeat(indent + 2))];
		if (newLines.join('\n') === lines.slice(i, end + 1).join('\n')) return null;
		return { type: 'range', from: i, to: end, newLines };
	}
	// 块字段整块缺失:插在 id 行后
	const at = idLineIndexOf(node, lines);
	const fieldIndent = ' '.repeat(node.indent + 2);
	return { type: 'insert', after: at, newLines: [`${fieldIndent}${field}:`, ...renderBlockEntries(field, expected, `${fieldIndent}  `)] };
}

/** 把一个模型的全部字段修订合并成单条锚点(id 行起圈,天然唯一、互不重叠) */
function buildModelEdit(lines, node, regions) {
	const start = idLineIndexOf(node, lines);
	let maxEnd = start;
	for (const r of regions) {
		if (r.type === 'line') maxEnd = Math.max(maxEnd, r.idx);
		else if (r.type === 'range') maxEnd = Math.max(maxEnd, r.to);
		else maxEnd = Math.max(maxEnd, r.after);
	}
	const covered = new Set();
	const rangeAtFrom = new Map();
	for (const r of regions) {
		if (r.type !== 'range') continue;
		for (let i = r.from; i <= r.to; i++) covered.add(i);
		rangeAtFrom.set(r.from, r);
	}
	const lineRepl = new Map();
	for (const r of regions) if (r.type === 'line') lineRepl.set(r.idx, r.newLine);
	const inserts = new Map();
	for (const r of regions) {
		if (r.type === 'insert') {
			if (!inserts.has(r.after)) inserts.set(r.after, []);
			inserts.get(r.after).push(...r.newLines);
		}
	}
	const out = [];
	for (let i = start; i <= maxEnd; i++) {
		const range = rangeAtFrom.get(i);
		if (range) {
			out.push(...range.newLines);
			continue;
		}
		if (covered.has(i)) continue;
		out.push(lineRepl.get(i) ?? lines[i]);
		if (inserts.has(i)) out.push(...inserts.get(i));
	}
	return {
		oldString: lines.slice(start, maxEnd + 1).join('\n'),
		newString: out.join('\n'),
		kind: 'model-block',
		line: start + 1,
	};
}

function renderBlockEntries(field, expected, indent) {
	if (field === 'input') return expected.map((v) => `${indent}- ${formatScalar(v)}`);
	return orderEfforts(expected).map(([k, v]) => `${indent}${k}: ${formatScalar(v)}`);
}

function buildProposals(text, providersInfo, auditResults, policy, opts = {}) {
	const lines = text.split('\n');
	const onlyModels = opts.models ? new Set(opts.models) : null;
	const proposals = []; // 每模型一条:changes[] + 单条合并锚点(互不重叠)
	const unproposable = [];
	const headroom = policy.constraints?.headroomTokens ?? 65536;
	for (const [providerName, result] of Object.entries(auditResults)) {
		const info = providersInfo?.[providerName];
		if (!info) continue;
		const byId = new Map(info.models.map((n) => [getField(n, 'id'), n]));
		const modelFindings = new Map(); // id -> {field: finding}
		for (const f of result.findings ?? []) {
			if (f.id && FIXABLE_FIELDS.includes(f.field) && f.expected !== undefined && f.expected !== null) {
				if (!modelFindings.has(f.id)) modelFindings.set(f.id, {});
				modelFindings.get(f.id)[f.field] = f;
			}
		}
		const handledPairs = new Set(); // `id|field` 已进提案(含护栏拒绝),防 unproposable 重复报
		for (const [id, fields] of modelFindings) {
			if (onlyModels && !onlyModels.has(id)) continue;
			const node = byId.get(id);
			if (!node) continue;
			const regions = [];
			const changes = [];
			for (const field of FIXABLE_FIELDS) {
				const finding = fields[field];
				if (!finding) continue;
				const region = field === 'input' || field === 'reasoningEfforts'
					? buildBlockRegion(lines, node, field, finding.expected)
					: buildScalarRegion(lines, node, field, finding.expected);
				if (!region) continue;
				regions.push(region);
				changes.push({ field, current: finding.actual ?? null, proposed: finding.expected, rationale: rationaleFor(field) });
				handledPairs.add(`${id}|${field}`);
			}
			if (!regions.length) continue;
			// 护栏:提案后 maxTokens+headroom<=contextWindow
			const view = modelView(node);
			const effCtx = effectiveValue(changes, view, 'contextWindow');
			const effMax = effectiveValue(changes, view, 'maxTokens');
			if (Number.isFinite(effCtx) && Number.isFinite(effMax) && effMax + headroom > effCtx) {
				unproposable.push({
					provider: providerName,
					id,
					changes,
					reason: `护栏拒绝:提案后 maxTokens(${effMax})+headroom(${headroom})>contextWindow(${effCtx});需先调窗口或单独拍板`,
				});
				continue;
			}
			proposals.push({ provider: providerName, id, changes, edit: buildModelEdit(lines, node, regions) });
		}
		// 其余发现(manual/集合/provider 级/约束)归入 unproposable 报告
		for (const f of result.findings ?? []) {
			if (f.severity === 'manual') {
				unproposable.push({ provider: providerName, id: f.id, field: f.field, severity: 'manual', reason: f.note });
				continue;
			}
			if (f.severity !== 'mismatch') continue;
			if (f.id && FIXABLE_FIELDS.includes(f.field) && f.expected !== undefined && f.expected !== null) {
				continue; // 已作为提案处理(或护栏已报/范围外)
			}
			if (f.id && handledPairs.has(`${f.id}|${f.field}`)) continue; // 已被同字段的提案覆盖(如约束备注)
			unproposable.push({ provider: providerName, id: f.id, field: f.field, current: f.actual ?? null, expected: f.expected ?? null, reason: f.note ?? 'provider 级/集合级/约束级发现:涉及结构或人工决策,不自动提案' });
		}
	}
	// 唯一性校验
	for (const p of proposals) {
		const count = text.split(p.edit.oldString).length - 1;
		p.edit.unique = count === 1;
		if (!p.edit.unique) p.edit.warning = `锚点在文件中出现 ${count} 次,直接 edit 会歧义;需人工扩大上下文`;
	}
	return { proposals, unproposable };
}

function rationaleFor(field) {
	switch (field) {
		case 'contextWindow': return '策略本地窗口(钳制值,不照抄目录)';
		case 'maxTokens': return '策略预留输出(防目录值吃光窗口、压力压缩静默失效)';
		case 'input': return '目录输入模态∩DSH 支持,或策略覆盖(视觉桥接)';
		case 'reasoningEfforts': return '目录 supported_efforts 精确映射(只声明目录明确返回的档位)';
		default: return '';
	}
}

function effectiveValue(patches, view, field) {
	const p = patches.find((x) => x.field === field);
	if (p) return p.proposed;
	return view[field];
}

/* ── 端点发现(model_config_discover,只读) ─────────────── */

function normalizeBaseUrl(raw) {
	return String(raw).trim().replace(/\/+$/, '');
}

/** 端点 /models 载荷 → 模型 id 列表(兼容 {data:[...]}/{models:[...]}/[...] 与字符串项) */
function extractModelIds(payload) {
	const arr = Array.isArray(payload) ? payload : payload?.data ?? payload?.models ?? [];
	const ids = [];
	for (const item of arr) {
		const id = typeof item === 'string' ? item : item?.id;
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** 端点模型 id → OpenRouter 目录条目(精确 → vendor/后缀 → 归一化后缀) */
function matchCatalogEntry(modelId, catalogById) {
	const raw = String(modelId);
	const lower = raw.toLowerCase();
	const norm = (s) => s.toLowerCase().replace(/[._]/g, '-');
	if (catalogById.has(raw)) return { match: raw, tier: 'exact' };
	const suffixHits = [...catalogById.keys()].filter((id) => id.toLowerCase().endsWith(`/${lower}`));
	if (suffixHits.length === 1) return { match: suffixHits[0], tier: 'suffix' };
	if (suffixHits.length > 1) return { match: suffixHits.sort()[0], tier: 'suffix-ambiguous', alternatives: suffixHits };
	const n = norm(raw);
	const normHits = [...catalogById.keys()].filter((id) => norm(id).endsWith(`/${n}`));
	if (normHits.length === 1) return { match: normHits[0], tier: 'normalized-suffix' };
	if (normHits.length > 1) return { match: normHits.sort()[0], tier: 'normalized-ambiguous', alternatives: normHits };
	return { match: null, tier: 'none' };
}

/** 按策略把目录条目转成本地建议参数(窗口钳制/maxTokens 预留+不变量/模态/档位) */
function suggestModelParams(entry, { cap, headroom, defaultMaxTokens }) {
	let contextWindow = entry.context_length ?? cap;
	if (cap && contextWindow > cap) contextWindow = cap;
	const topMax = entry.top_provider?.max_completion_tokens ?? null;
	let maxTokens = Math.min(defaultMaxTokens, topMax ?? defaultMaxTokens);
	if (Number.isFinite(contextWindow) && maxTokens + headroom > contextWindow) maxTokens = contextWindow - headroom;
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = null;
	const input = ['text', 'image'].filter((x) => (entry.architecture?.input_modalities ?? []).includes(x));
	const r = expectedEffortsFromCatalog(entry.reasoning);
	let reasoningEfforts = null;
	let reasoningNote = null;
	if (r.error) reasoningNote = r.error;
	else if (r.manual) reasoningNote = '目录无 supported_efforts:档位需网关实测(MANUAL),配置时留空或用人工实测值';
	else reasoningEfforts = r.efforts; // false 或档位表
	return {
		contextWindow,
		maxTokens,
		input,
		reasoningEfforts,
		reasoningNote,
		upstreamDefaultEffort: entry.reasoning?.default_effort ?? null,
	};
}

/** 全部模型 efforts 键的交集;任一模型非对象(false/未定)则无交集 */
function intersectEfforts(effortsList) {
	if (!effortsList.length) return null;
	let common = null;
	for (const e of effortsList) {
		if (!e || typeof e !== 'object') return null;
		const keys = new Set(Object.keys(e));
		common = common ? new Set([...common].filter((k) => keys.has(k))) : keys;
	}
	return [...common];
}



/* ── 装载 ───────────────────────────────────────────── */

function policyCandidates(cfg) {
	if (cfg.policyFile) return [cfg.policyFile];
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return [join(home, 'model-config', 'policy.json'), join(PLUGIN_DIR, 'policy.json')];
}

function loadPolicy(cfg) {
	for (const p of policyCandidates(cfg)) {
		if (fs.existsSync(p)) return { policy: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
	}
	throw new Error(`policy.json 未找到(候选: ${policyCandidates(cfg).join(' ; ')})`);
}

function loadProfile(cfg) {
	if (!fs.existsSync(cfg.profilePath)) throw new Error(`profile 不存在: ${cfg.profilePath}`);
	const text = fs.readFileSync(cfg.profilePath, 'utf8');
	const tree = buildTree(text);
	const providers = extractProviders(tree);
	if (!providers) throw new Error(`未在 ${cfg.profilePath} 找到 llm-pi-ai → config.providers 结构`);
	return { text, lines: tree.lines, tree, providers };
}

function formatAge(ms) {
	if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
	if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)}min`;
	if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)}h`;
	return `${Math.round(ms / 86400000)}d`;
}

/** 读取缓存文件内容(损坏返回 null) */
function readCatalogCache(cachePath) {
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
		if (raw && Array.isArray(raw.data)) return raw;
	} catch {
		/* 无缓存或损坏 */
	}
	return null;
}

function writeCatalogCache(cachePath, payload) {
	fs.mkdirSync(dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(payload));
	fs.renameSync(tmp, cachePath);
}

/**
 * 缺失补拉:OpenRouter 无单模型端点(/models/{id} 实测 404),故策略为
 * "缓存缺谁→全量拉一次→只合并缺失条目进永久缓存(更新+追加,不删旧条目)"。
 * 平时零网络;仅当 policy/discover 需要缓存里没有的模型时打一次网。
 */
async function fillMissingModels(cfg, missingIds, cachePath) {
	const want = [...new Set(missingIds)].filter(Boolean);
	if (!want.length) return { filled: [], stillMissing: [], byId: null };
	let fresh = null;
	try {
		const res = await fetch(cfg.catalogUrl, {
			headers: { 'User-Agent': cfg.userAgent },
			signal: AbortSignal.timeout(cfg.requestTimeoutMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		fresh = (await res.json()).data ?? [];
	} catch (e) {
		return { filled: [], stillMissing: want, byId: null, error: e.message };
	}
	const byId = new Map(fresh.map((m) => [m.id, m]));
	const filled = [];
	const stillMissing = [];
	for (const id of want) (byId.has(id) ? filled : stillMissing).push(id);
	const cache = readCatalogCache(cachePath);
	if (cache && filled.length) {
		const map = new Map(cache.data.map((m) => [m.id, m]));
		for (const id of filled) map.set(id, byId.get(id));
		cache.data = [...map.values()];
		cache.fetchedAt = new Date().toISOString();
		try {
			writeCatalogCache(cachePath, cache);
		} catch {
			/* 写失败不影响本次结果 */
		}
	}
	return { filled, stillMissing, byId };
}

/** 目录缓存文件路径(config 可覆盖,默认 $DSH_HOME/model-config/catalog-cache.json) */
function catalogCachePath(cfg) {
	if (cfg.catalogCachePath) return cfg.catalogCachePath;
	return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'model-config', 'catalog-cache.json');
}

/**
 * 目录装载:catalogFile 离线路径 → 直接读;
 * 在线 → ①TTL 内缓存命中 ②拉网并写缓存(原子替换) ③拉网失败回退旧缓存(stale 标注)。
 */
async function loadCatalog(cfg, catalogFile, opts = {}) {
	if (catalogFile) {
		const raw = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
		const data = raw.data ?? raw;
		return { byId: new Map(data.map((m) => [m.id, m])), source: catalogFile };
	}
	const cachePath = catalogCachePath(cfg);
	const ttl = Number.isFinite(cfg.catalogCacheTtlMs) ? cfg.catalogCacheTtlMs : Number.POSITIVE_INFINITY;
	let cache = null;
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
		if (raw && raw.url === cfg.catalogUrl && Array.isArray(raw.data)) cache = raw;
	} catch {
		/* 无缓存或缓存损坏,忽略 */
	}
	const ageMs = cache ? Date.now() - Date.parse(cache.fetchedAt) : Number.POSITIVE_INFINITY;
	const ageLabel = Number.isFinite(ageMs) ? formatAge(Math.max(0, ageMs)) : null;
	const ttlLabel = Number.isFinite(ttl) ? `${Math.round(ttl / 60000)}min` : '永久';
	if (!opts.forceRefresh && cache && ageMs >= 0 && ageMs < ttl) {
		return {
			byId: new Map(cache.data.map((m) => [m.id, m])),
			source: `cache(${ageLabel}前拉取,ttl ${ttlLabel}):${cachePath}`,
			cachePath,
		};
	}
	try {
		const res = await fetch(cfg.catalogUrl, {
			headers: { 'User-Agent': cfg.userAgent },
			signal: AbortSignal.timeout(cfg.requestTimeoutMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const raw = await res.json();
		const data = raw.data ?? [];
		const payload = { url: cfg.catalogUrl, fetchedAt: new Date().toISOString(), data };
		try {
			fs.mkdirSync(dirname(cachePath), { recursive: true });
			const tmp = `${cachePath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(payload));
			fs.renameSync(tmp, cachePath);
		} catch {
			/* 缓存写失败不影响本次结果 */
		}
		return { byId: new Map(data.map((m) => [m.id, m])), source: cfg.catalogUrl, cachedAt: payload.fetchedAt, cachePath };
	} catch (e) {
		if (cache) {
			return {
				byId: new Map(cache.data.map((m) => [m.id, m])),
				source: `stale-cache(${ageLabel}前,拉取失败:${e.message},已回退):${cachePath}`,
			};
		}
		throw new Error(`OpenRouter 目录请求失败:${e.message}(且无可用缓存;可用 catalogFile 指向本地 JSON)`);
	}
}

/* ── 工具注册 ───────────────────────────────────────── */

function renderJson(value, budget = 12000) {
	let text;
	try {
		text = JSON.stringify(value, null, 1);
	} catch {
		text = String(value);
	}
	if (text.length > budget) text = `${text.slice(0, budget)}\n…(截断,共 ${text.length} 字符)`;
	return { type: 'text', text };
}

const anyJsonOutput = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => [renderJson(value)],
};

function providerParam() {
	return { type: 'string', description: '目标 provider 名,缺省=全部(policy 中登记的端点,如 cpa/kimi-coding)' };
}

function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	const logger = ctx.logger;

	async function runAudit(args) {
		const { policy, path: policyPath } = loadPolicy(cfg);
		const profile = loadProfile(cfg);
		const wanted = args.provider ? [args.provider] : Object.keys(policy.providers);
		const unknown = wanted.filter((p) => !policy.providers[p]);
		if (unknown.length) return { error: `policy 中没有 provider: ${unknown.join(',')}(可用: ${Object.keys(policy.providers).join('/')})` };
		let catalog = null;
		let filledModels = [];
		if (wanted.some((p) => policy.providers[p].source === 'openrouter')) {
			catalog = await loadCatalog(cfg, args.catalogFile, { forceRefresh: args.forceRefresh });
			// 缺失补拉:policy 登记了但缓存缺的模型 → 一次全量拉取合并缺失条目(默认开启,catalogFile 离线时跳过)
			if (!args.catalogFile && cfg.catalogFillMissing !== false) {
				const missing = [];
				for (const p of wanted) {
					const pol = policy.providers[p];
					if (pol.source !== 'openrouter') continue;
					for (const m of pol.models ?? []) if (!catalog.byId.has(m.openrouter) && !missing.includes(m.openrouter)) missing.push(m.openrouter);
				}
				if (missing.length) {
					const fill = await fillMissingModels(cfg, missing, catalog.cachePath ?? catalogCachePath(cfg));
					if (fill.byId) for (const id of fill.filled) catalog.byId.set(id, fill.byId.get(id));
					filledModels = fill.filled;
				}
			}
		}
		const headroom = policy.constraints?.headroomTokens ?? 65536;
		const providers = {};
		let ok = true;
		for (const p of wanted) {
			const result = auditProvider(p, policy.providers[p], profile.providers[p] ?? null, catalog?.byId ?? null, headroom);
			providers[p] = result;
			if (!result.ok) ok = false;
		}
		const parts = wanted.map((p) => {
			const r = providers[p];
			const mm = r.findings.filter((f) => f.severity === 'mismatch').length;
			const man = r.findings.filter((f) => f.severity === 'manual').length;
			return `${p}: mapped=${r.mapped} configured=${r.configured} ok=${r.ok} mismatch=${mm} manual=${man}`;
		});
		return {
			ok,
			profilePath: cfg.profilePath,
			policyPath,
			catalogSource: catalog?.source ?? null,
			...(filledModels.length ? { filledModels } : {}),
			providers,
			summary: parts.join('; '),
			hint: ok
				? '全部可自动校验字段一致;manual 项保持网关实测值即可'
				: '存在 mismatch:可先跑 model_config_propose 生成提案,展示给用户确认后由 agent 用 edit 落盘,再复跑本工具 + dsh web --dump-config 验证',
		};
	}

	ctx.tools.register({
		name: 'model_config_audit',
		description:
			'审计 DSH 模型配置(home 层 cordis.patch.yml 的 llm-pi-ai)与真值源的一致性:cpa 按 OpenRouter 目录+策略映射比对,kimi-coding 等手工源按策略比对;含 compat、路由默认档交集、压缩预算不变量。只读不改文件。',
		parameters: {
			type: 'object',
			properties: {
				provider: providerParam(),
				catalogFile: { type: 'string', description: '本地已保存的 OpenRouter models JSON 路径(离线调试;缺省在线拉取,命中 30 分钟内缓存)' },
				forceRefresh: { type: 'boolean', description: '跳过目录缓存强制拉最新(默认 TTL 内直接用缓存)' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			try {
				return await runAudit(args || {});
			} catch (e) {
				return { error: e.message };
			}
		},
	});

	ctx.tools.register({
		name: 'model_config_propose',
		description:
			'对审计发现的可修复项生成变更提案:每条含 current/proposed/理由和经唯一性校验的 edit 锚点(oldString/newString)。流程:展示给用户确认 → agent 用 edit 工具逐条落盘 → 复跑 model_config_audit + dsh web --dump-config 验证。本工具永不写文件;集合增删、provider 级字段、MANUAL 档位不自动提案;拒绝违反 maxTokens+headroom<=contextWindow 的提案。',
		parameters: {
			type: 'object',
			properties: {
				provider: providerParam(),
				models: { type: 'array', items: { type: 'string' }, description: '只处理这些模型 id(缺省全部)' },
				catalogFile: { type: 'string', description: '本地已保存的 OpenRouter models JSON 路径(离线调试)' },
				forceRefresh: { type: 'boolean', description: '跳过目录缓存强制拉最新' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			try {
				const a = args || {};
				const audit = await runAudit({ provider: a.provider, catalogFile: a.catalogFile, forceRefresh: a.forceRefresh });
				if (audit.error) return audit;
				const { policy } = loadPolicy(cfg);
				const profile = loadProfile(cfg);
				const { proposals, unproposable } = buildProposals(profile.text, profile.providers, audit.providers, policy, { models: a.models });
				return {
					ok: true,
					profilePath: cfg.profilePath,
					auditSummary: audit.summary,
					proposals,
					unproposable,
					nextSteps:
						'把 proposals 逐条展示给用户(模型/字段/现值→新值/理由);用户确认后用 edit 工具按 oldString→newString 落盘(edit.unique=false 的需人工扩大上下文);全部落盘后复跑 model_config_audit 与 dsh web --dump-config,两者通过才算完成。profile 热加载,无需重启,刷新 GUI 即可。',
				};
			} catch (e) {
				return { error: e.message };
			}
		},
	});

	ctx.tools.register({
		name: 'model_config_policy',
		description: '查看模型配置策略:各 provider 真值源、逐模型期望值(contextWindow/maxTokens/input/reasoningEfforts)与全局约束、不变量自检。修改策略=编辑 policy 文件(热读,改完即生效,无需重启)。',
		parameters: { type: 'object', properties: {} },
		output: anyJsonOutput,
		async execute() {
			try {
				const { policy, path } = loadPolicy(cfg);
				const headroom = policy.constraints?.headroomTokens ?? 65536;
				const violations = [];
				for (const [pn, p] of Object.entries(policy.providers ?? {})) {
					for (const m of p.models ?? []) {
						if (Number.isFinite(m.maxTokens) && Number.isFinite(m.contextWindow) && m.maxTokens + headroom > m.contextWindow) {
							violations.push({ provider: pn, id: m.id, note: `policy 自身违反 maxTokens+${headroom}<=contextWindow` });
						}
					}
				}
				return { policyPath: path, policy, invariantViolations: violations };
			} catch (e) {
				return { error: e.message };
			}
		},
	});

	ctx.tools.register({
		name: 'model_config_discover',
		description:
			'新端点接入第一步:拉取 OpenAI 兼容端点的模型列表(GET {baseUrl}/models),逐个与 OpenRouter 目录匹配并按策略预填建议参数(窗口钳制/maxTokens 预留/输入模态/思考档位/路由默认档交集),供用户挑选。只读不写文件;apiKey 仅用于本次请求,不落盘不回显不记日志。',
		parameters: {
			type: 'object',
			properties: {
				baseUrl: { type: 'string', description: '端点 base,如 https://x.example.com/v1(自动尝试 /models 与 /v1/models)' },
				apiKey: { type: 'string', description: 'API key(仅本次请求使用,不出现在输出里)' },
				provider: { type: 'string', description: '建议的 provider 名(之后写配置用;缺省留给用户定)' },
				contextWindowCap: { type: 'number', description: '窗口钳制上限,缺省 400000' },
				defaultMaxTokens: { type: 'number', description: '建议 maxTokens 预留输出,缺省 12288' },
				catalogFile: { type: 'string', description: '本地 OpenRouter models JSON(离线)' },
				modelsFile: { type: 'string', description: '本地端点 models JSON(离线调试,兼容 {data:[...]}/{models:[...]}/[id...];提供时忽略 baseUrl/apiKey)' },
				forceRefresh: { type: 'boolean', description: '跳过目录缓存强制拉最新 OpenRouter 目录' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			try {
				const a = args || {};
				const { policy } = loadPolicy(cfg);
				const headroom = policy.constraints?.headroomTokens ?? 65536;
				const cap = Number.isFinite(a.contextWindowCap) ? a.contextWindowCap : 400000;
				const defMax = Number.isFinite(a.defaultMaxTokens) ? a.defaultMaxTokens : 12288;
				let endpointIds = null;
				let source = null;
				if (a.modelsFile) {
					endpointIds = extractModelIds(JSON.parse(fs.readFileSync(a.modelsFile, 'utf8')));
					source = a.modelsFile;
				} else {
					if (!a.baseUrl || !a.apiKey) return { error: '需要 baseUrl 与 apiKey(或用 modelsFile 离线调试)' };
					const base = normalizeBaseUrl(a.baseUrl);
					const attempts = [/\/v\d+$/.test(base) ? `${base}/models` : null, `${base}/models`, `${base}/v1/models`].filter(Boolean);
					let lastErr = null;
					for (const u of [...new Set(attempts)]) {
						try {
							const res = await fetch(u, {
								headers: { Authorization: `Bearer ${a.apiKey}`, 'User-Agent': cfg.userAgent },
								signal: AbortSignal.timeout(cfg.requestTimeoutMs),
							});
							if (!res.ok) {
								lastErr = `HTTP ${res.status} @ ${u}`;
								continue;
							}
							endpointIds = extractModelIds(await res.json());
							source = u;
							break;
						} catch (e) {
							lastErr = `${u}: ${e.message}`;
						}
					}
					if (!endpointIds) return { error: `端点模型列表获取失败:${lastErr}` };
				}
				const catalog = await loadCatalog(cfg, a.catalogFile, { forceRefresh: a.forceRefresh });
				const allowFill = !a.catalogFile && cfg.catalogFillMissing !== false;
				const fillCachePath = () => catalog.cachePath ?? catalogCachePath(cfg);
				// 缺失补拉(两阶段):先按缓存匹配,未匹配的 id 集合做一次全量拉取合并,再重新匹配
				const phase1 = endpointIds.map((id) => ({ id, m: matchCatalogEntry(id, catalog.byId) }));
				const unmatchedRaw = phase1.filter((x) => !x.m.match).map((x) => x.id);
				const filledModels = [];
				if (allowFill && unmatchedRaw.length) {
					const fill = await fillMissingModels(cfg, unmatchedRaw, fillCachePath());
					if (fill.byId) for (const id of fill.filled) filledModels.push(id);
				}
				const models = [];
				const effortsList = [];
				for (const id of endpointIds) {
					const m = matchCatalogEntry(id, catalog.byId);
					if (!m.match) {
						models.push({ id, matched: false, note: 'OpenRouter 未匹配(含缺失补拉):参数需按官方文档人工提供,不猜' });
						continue;
					}
					const s = suggestModelParams(catalog.byId.get(m.match), { cap, headroom, defaultMaxTokens: defMax });
					if (s.reasoningEfforts && typeof s.reasoningEfforts === 'object') effortsList.push(s.reasoningEfforts);
					models.push({
						id,
						matched: true,
						openrouter: m.match,
						tier: m.tier,
						...(m.alternatives ? { alternatives: m.alternatives } : {}),
						suggested: {
							contextWindow: s.contextWindow,
							maxTokens: s.maxTokens,
							input: s.input,
							reasoningEfforts: s.reasoningEfforts,
						},
						...(s.upstreamDefaultEffort ? { upstreamDefaultEffort: s.upstreamDefaultEffort } : {}),
						...(s.reasoningNote ? { reasoningNote: s.reasoningNote } : {}),
					});
				}
				const intersection = intersectEfforts(effortsList);
				const routeDefault = intersection ? (ROUTE_EFFORT_PRIORITY.find((l) => intersection.includes(l)) ?? null) : null;
				return {
					ok: true,
					provider: a.provider ?? null,
					endpointSource: source ?? '(modelsFile)',
					catalogSource: catalog.source,
					contextWindowCap: cap,
					defaultMaxTokens: defMax,
					modelCount: models.length,
					models,
					...(filledModels.length ? { filledModels } : {}),
					suggestedRouteReasoning: routeDefault,
					routeIntersection: intersection,
					nextSteps:
						'把 models 展示给用户挑选,逐条收集特殊要求(窗口上限/别名/视觉桥接/manual 档位);选定后:①policy.json providers 加段(openrouter 映射+notes+期望值)②cordis.patch.yml 插模型块(展示 diff 经用户确认,edit 落盘)③凭据入 DSH credentials 并配 apiKeyEnv(密钥不进 patch/policy)④model_config_audit + dsh web --dump-config 双验证',
				};
			} catch (e) {
				return { error: e.message };
			}
		},
	});

	logger?.info?.('model-config: 已注册 model_config_audit / model_config_propose / model_config_policy / model_config_discover');
}

export {
	apply,
	name,
	inject,
	CONFIG_DEFAULTS,
	buildTree,
	splitTrailingComment,
	parseScalarValue,
	formatScalar,
	extractProviders,
	modelView,
	expectedEffortsFromCatalog,
	auditProvider,
	buildProposals,
	loadPolicy,
	loadCatalog,
	fillMissingModels,
	normalizeBaseUrl,
	extractModelIds,
	matchCatalogEntry,
	suggestModelParams,
	intersectEfforts,
};

// 不要 export default:dsh 以模块命名空间为 plugin 对象读取 inject/name,
// default 导出会让加载器取到裸 apply 函数丢失 inject 声明
// (cordis 报 cannot get property "tools" without inject,2026-10-28 实测)。
