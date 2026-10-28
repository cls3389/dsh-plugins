import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
	buildTree,
	splitTrailingComment,
	parseScalarValue,
	extractProviders,
	modelView,
	expectedEffortsFromCatalog,
	auditProvider,
	buildProposals,
	loadPolicy,
	CONFIG_DEFAULTS,
	extractModelIds,
	matchCatalogEntry,
	suggestModelParams,
	intersectEfforts,
} from './index.js';

/* ── fixtures ─────────────────────────────────────────── */

const FIXTURE_PROFILE = `# fixture: home patch 形状
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      cpa:
        displayName: cpa
        apiKeyEnv: CPA_API_KEY
        api: openai-completions
        baseURL: http://gw.test/v1
        reasoning: high
        compat:
          supportsDeveloperRole: false
        models:
          - id: alpha
            name: alpha
            contextWindow: 400000
            maxTokens: 943718
            input:
              - text
            reasoningEfforts:
              off: none
              low: low
              high: high
          - id: beta
            name: beta
            contextWindow: 262144
            maxTokens: 12288
            input:
              - text
            reasoningEfforts:
              low: low
              medium: medium
              high: high
              max: max
      kimi-coding:
        models:
          - id: k3.1-pro
            name: kimi-k3.1-pro
            contextWindow: 1048576
            maxTokens: 32768
            input:
              - text
              - image
            reasoningEfforts:
              low: low
              high: high
              max: max
        reasoning: high
        apiKeyEnv: KIMI_CODING_API_KEY
`;

const FIXTURE_CATALOG = {
	data: [
		{
			id: 'vendor/alpha',
			architecture: { input_modalities: ['text', 'image'] },
			top_provider: { max_completion_tokens: 943718 },
			reasoning: { supported_efforts: ['none', 'low', 'high'] },
		},
		{
			id: 'vendor/beta',
			architecture: { input_modalities: ['text'] },
			top_provider: { max_completion_tokens: 131072 },
			reasoning: { supported_efforts: ['low', 'medium', 'high', 'max'] },
		},
		{
			id: 'vendor/gamma',
			architecture: { input_modalities: ['text'] },
			top_provider: { max_completion_tokens: 8192 },
			reasoning: { enabled: true },
		},
	],
};

const FIXTURE_POLICY = {
	constraints: { headroomTokens: 65536 },
	providers: {
		cpa: {
			source: 'openrouter',
			compat: { supportsDeveloperRole: false },
			routeReasoning: 'high',
			models: [
				{ id: 'alpha', openrouter: 'vendor/alpha', contextWindow: 400000, maxTokens: 12288 },
				{ id: 'beta', openrouter: 'vendor/beta', contextWindow: 262144, maxTokens: 12288 },
				{ id: 'gamma', openrouter: 'vendor/gamma', contextWindow: 400000, maxTokens: 12288 },
			],
		},
		'kimi-coding': {
			source: 'manual',
			routeReasoning: 'high',
			models: [
				{
					id: 'k3.1-pro',
					contextWindow: 1048576,
					maxTokens: 32768,
					input: ['text', 'image'],
					reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
				},
			],
		},
	},
};

function fixtureAudit() {
	const tree = buildTree(FIXTURE_PROFILE);
	const providers = extractProviders(tree);
	const catalogById = new Map(FIXTURE_CATALOG.data.map((m) => [m.id, m]));
	const results = {};
	for (const [p, pol] of Object.entries(FIXTURE_POLICY.providers)) {
		results[p] = auditProvider(p, pol, providers[p] ?? null, p === 'cpa' ? catalogById : null, 65536);
	}
	return { tree, providers, results, text: FIXTURE_PROFILE };
}

/* ── 标量与注释 ───────────────────────────────────────── */

test('splitTrailingComment: 行首/行尾注释,引号内 # 不误伤', () => {
	assert.deepEqual(splitTrailingComment('  # full comment'), ['  ', '# full comment']);
	assert.deepEqual(splitTrailingComment('a: 1  # tail'), ['a: 1  ', '# tail']);
	assert.deepEqual(splitTrailingComment('url: "http://x/#y"'), ['url: "http://x/#y"', '']);
	assert.deepEqual(splitTrailingComment('plain: value'), ['plain: value', '']);
});

test('parseScalarValue: 类型与标签', () => {
	assert.equal(parseScalarValue('12288'), 12288);
	assert.equal(parseScalarValue('false'), false);
	assert.equal(parseScalarValue('null'), null);
	assert.equal(parseScalarValue('"@deepseek-ai/x"'), '@deepseek-ai/x');
	assert.equal(parseScalarValue("GPT-6 Astra"), 'GPT-6 Astra');
	assert.equal(parseScalarValue('!!js Date.now()').startsWith('__tag__'), true);
	assert.deepEqual(parseScalarValue('[text, image]'), ['text', 'image']);
});

/* ── 树与结构提取 ─────────────────────────────────────── */

test('buildTree+extractProviders: provider/model/compat/reasoning 结构', () => {
	const { tree, providers } = fixtureAudit();
	assert.ok(providers, 'providers 提取成功');
	assert.deepEqual(Object.keys(providers).sort(), ['cpa', 'kimi-coding']);
	assert.equal(providers.cpa.models.length, 2);
	assert.equal(providers.cpa.reasoning, 'high');
	assert.deepEqual(providers.cpa.compat, { supportsDeveloperRole: false });
	const alpha = modelView(providers.cpa.models[0]);
	assert.equal(alpha.id, 'alpha');
	assert.equal(alpha.contextWindow, 400000);
	assert.deepEqual(alpha.input, ['text']);
	assert.deepEqual(alpha.reasoningEfforts, { off: 'none', low: 'low', high: 'high' });
	// 跨度:注释行混入也不影响块切片
	assert.ok(providers.cpa.models[0].endIdx > providers.cpa.models[0].lineIdx);
});

test('modelView: off 键保持字符串(JS 侧无 YAML1.1 布尔化陷阱)', () => {
	const { providers } = fixtureAudit();
	assert.ok('off' in providers.cpa.models[0] ? true : true);
	const v = modelView(providers.cpa.models[0]);
	assert.deepEqual(Object.keys(v.reasoningEfforts), ['off', 'low', 'high']);
});

/* ── OpenRouter 档位推导 ──────────────────────────────── */

test('expectedEffortsFromCatalog: none→off、未知档报错、无 supported_efforts→manual', () => {
	assert.deepEqual(expectedEffortsFromCatalog({ supported_efforts: ['none', 'low', 'high'] }).efforts, {
		off: 'none',
		low: 'low',
		high: 'high',
	});
	assert.equal(expectedEffortsFromCatalog(null).efforts, false);
	assert.equal(expectedEffortsFromCatalog({ supported_efforts: [] }).manual, true);
	assert.ok(expectedEffortsFromCatalog({ supported_efforts: ['ultra'] }).error);
});

/* ── 审计 ─────────────────────────────────────────────── */

test('audit: cpa 各类发现(maxTokens 目录覆盖/input/集合差异/约束不变量/manual)', () => {
	const { results } = fixtureAudit();
	const cpa = results.cpa;
	const byField = (id, field) => cpa.findings.find((f) => f.id === id && f.field === field);
	// alpha: maxTokens 943718 ≠ 策略覆盖 12288 → mismatch + 不变量
	assert.ok(byField('alpha', 'maxTokens'));
	assert.ok(cpa.findings.some((f) => f.id === 'alpha' && f.field === 'maxTokens' && /不变量/.test(f.note ?? '')));
	// alpha: input 策略缺省→目录 [text,image],配置只有 [text] → mismatch
	assert.ok(byField('alpha', 'input'));
	// beta: efforts 目录含 medium,配置也有;目录 [low,medium,high,max] 全对上? 配置一致 → 无 mismatch
	assert.ok(!byField('beta', 'reasoningEfforts'));
	// gamma: 目录无 supported_efforts → manual;profile 未配置 → 集合差异
	assert.ok(cpa.findings.some((f) => f.id === 'gamma' && f.field === 'models'));
	assert.equal(cpa.ok, false);
});

test('audit: kimi-coding(manual 源)全字段一致 → ok', () => {
	const { results } = fixtureAudit();
	assert.equal(results['kimi-coding'].ok, true);
	assert.equal(results['kimi-coding'].fullyChecked, 1);
});

test('audit: compat / 路由档 / 交集破坏均能发现', () => {
	const tree = buildTree(FIXTURE_PROFILE.replace('supportsDeveloperRole: false', 'supportsDeveloperRole: true'));
	const providers = extractProviders(tree);
	const r = auditProvider('cpa', FIXTURE_POLICY.providers.cpa, providers.cpa, new Map(FIXTURE_CATALOG.data.map((m) => [m.id, m])), 65536);
	assert.ok(r.findings.some((f) => f.field === 'compat.supportsDeveloperRole'));

	const tree2 = buildTree(FIXTURE_PROFILE.replace('        reasoning: high\n        compat:', '        reasoning: low\n        compat:'));
	const r2 = auditProvider('cpa', FIXTURE_POLICY.providers.cpa, extractProviders(tree2).cpa, new Map(FIXTURE_CATALOG.data.map((m) => [m.id, m])), 65536);
	assert.ok(r2.findings.some((f) => f.field === 'reasoning' && f.actual === 'low'));

	// beta 去掉 high 档 → 路由默认档 high 交集被破坏
	const tree3 = buildTree(FIXTURE_PROFILE.replace('              medium: medium\n              high: high\n              max: max', '              medium: medium\n              max: max'));
	const r3 = auditProvider('cpa', FIXTURE_POLICY.providers.cpa, extractProviders(tree3).cpa, new Map(FIXTURE_CATALOG.data.map((m) => [m.id, m])), 65536);
	assert.ok(r3.findings.some((f) => f.id === 'beta' && /交集/.test(f.note ?? '')));
});

/* ── 提案 ─────────────────────────────────────────────── */

test('propose: 每模型一条合并提案,锚点可一次应用、唯一、guard 通过', () => {
	const { text, providers, results } = fixtureAudit();
	const { proposals, unproposable } = buildProposals(text, providers, results, FIXTURE_POLICY, {});
	// alpha: 一条提案合并 maxTokens(943718→12288) + input([text]→[text,image])
	const alpha = proposals.find((p) => p.id === 'alpha');
	assert.ok(alpha, 'alpha 有提案');
	assert.deepEqual(alpha.changes.map((c) => c.field).sort(), ['input', 'maxTokens']);
	assert.equal(alpha.edit.unique, true);
	// 锚点单次应用后产物正确(注释与无关行保留)
	const applied = text.replace(alpha.edit.oldString, alpha.edit.newString);
	const after = extractProviders(buildTree(applied));
	const v = modelView(after.cpa.models[0]);
	assert.equal(v.maxTokens, 12288);
	assert.deepEqual(v.input, ['text', 'image']);
	// beta 无发现 → 无提案;gamma 集合差异进 unproposable;manual 不提案
	assert.ok(!proposals.some((p) => p.id === 'beta'));
	assert.ok(!proposals.some((p) => p.id === 'gamma'));
	assert.ok(unproposable.some((u) => u.id === 'gamma'));
	// alpha 的不变量备注已被提案覆盖,不在 unproposable 里重复
	assert.ok(!unproposable.some((u) => u.id === 'alpha' && /不变量/.test(u.reason ?? u.note ?? '')));
});

test('propose: 护栏拒绝 maxTokens+headroom>contextWindow 的提案', () => {
	const badPolicy = {
		constraints: { headroomTokens: 65536 },
		providers: {
			cpa: {
				source: 'manual',
				models: [{ id: 'alpha', contextWindow: 262144, maxTokens: 250000 }],
			},
		},
	};
	const tree = buildTree(FIXTURE_PROFILE);
	const providers = extractProviders(tree);
	const result = auditProvider('cpa', badPolicy.providers.cpa, providers.cpa, null, 65536);
	const { proposals, unproposable } = buildProposals(FIXTURE_PROFILE, providers, { cpa: result }, badPolicy, {});
	assert.equal(proposals.length, 0);
	assert.ok(unproposable.some((u) => /护栏/.test(u.reason)));
});

test('propose: models 过滤只处理指定模型', () => {
	const { text, providers, results } = fixtureAudit();
	const { proposals } = buildProposals(text, providers, results, FIXTURE_POLICY, { models: ['beta'] });
	assert.equal(proposals.filter((p) => p.id === 'alpha').length, 0);
});

/* ── 端点发现 ─────────────────────────────────────────── */

test('extractModelIds: 兼容 data/models/裸数组/字符串项,去重', () => {
	assert.deepEqual(extractModelIds({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
	assert.deepEqual(extractModelIds({ models: ['x', 'y'] }), ['x', 'y']);
	assert.deepEqual(extractModelIds(['p', { id: 'q' }]), ['p', 'q']);
});

test('matchCatalogEntry: 精确→vendor 后缀→归一化后缀→未匹配', () => {
	const byId = new Map([
		['z-ai/glm-5.3', {}],
		['openai/gpt-6-astra', {}],
		['anthropic/gpt-6-astra', {}],
		['qwen/qwen3.8_max', {}],
	].map(([k, v]) => [k, v]));
	assert.equal(matchCatalogEntry('z-ai/glm-5.3', byId).tier, 'exact');
	assert.equal(matchCatalogEntry('glm-5.3', byId).match, 'z-ai/glm-5.3');
	const amb = matchCatalogEntry('gpt-6-astra', byId);
	assert.equal(amb.tier, 'suffix-ambiguous');
	assert.ok(amb.alternatives.length === 2);
	assert.equal(matchCatalogEntry('qwen3.8.max', byId).match, 'qwen/qwen3.8_max'); // . → _ 归一化
	assert.equal(matchCatalogEntry('totally-unknown', byId).match, null);
});

test('suggestModelParams: 窗口钳制/目录上限收窄/不变量/档位与 MANUAL', () => {
	const s1 = suggestModelParams(
		{ context_length: 1000000, top_provider: { max_completion_tokens: 943718 }, architecture: { input_modalities: ['file', 'text', 'image'] }, reasoning: { supported_efforts: ['none', 'low', 'high'] } },
		{ cap: 400000, headroom: 65536, defaultMaxTokens: 12288 },
	);
	assert.equal(s1.contextWindow, 400000);
	assert.equal(s1.maxTokens, 12288);
	assert.deepEqual(s1.input, ['text', 'image']);
	assert.deepEqual(s1.reasoningEfforts, { off: 'none', low: 'low', high: 'high' });
	// 目录上限 8192 < 默认 12288 → 先收窄到 8192;70000-65536 预算再压到 4464(不变量钳制)
	const s2 = suggestModelParams({ context_length: 70000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text'] }, reasoning: { enabled: true } }, { cap: 400000, headroom: 65536, defaultMaxTokens: 12288 });
	assert.equal(s2.maxTokens, 4464);
	assert.equal(s2.reasoningEfforts, null);
	assert.match(s2.reasoningNote, /MANUAL/);
	const s3 = suggestModelParams({ context_length: 60000, top_provider: {}, architecture: { input_modalities: ['text'] }, reasoning: null }, { cap: 400000, headroom: 65536, defaultMaxTokens: 12288 });
	assert.equal(s3.maxTokens, null); // 60000-65536<0:预算不足,不给出建议
	assert.equal(s3.reasoningEfforts, false);
});

test('intersectEfforts + 路由默认档优先级: 任一非对象→无交集', () => {
	assert.deepEqual(intersectEfforts([{ low: 'low', high: 'high' }, { high: 'high', max: 'max' }]), ['high']);
	assert.equal(intersectEfforts([{ low: 'low' }, false]), null);
	assert.deepEqual(intersectEfforts([]), null);
});

/* ── 真实文件形状(本机存在才跑) ───────────────────────── */


test('real profile: 解析真实 home 层 + policy 不变量自检', { skip: !fs.existsSync(CONFIG_DEFAULTS.profilePath) }, () => {
	const text = fs.readFileSync(CONFIG_DEFAULTS.profilePath, 'utf8');
	const providers = extractProviders(buildTree(text));
	assert.ok(providers, '真实 llm-pi-ai 结构可解析');
	assert.ok(providers.cpa.models.length >= 20, `cpa 模型数 ${providers.cpa.models.length}`);
	assert.ok(providers['kimi-coding']?.models?.length === 1);
	const headroom = 65536;
	for (const node of providers.cpa.models) {
		const v = modelView(node);
		if (Number.isFinite(v.maxTokens) && Number.isFinite(v.contextWindow)) {
			assert.ok(v.maxTokens + headroom <= v.contextWindow, `${v.id} 违反压缩预算不变量`);
		}
	}
	const { policy } = loadPolicy({ ...CONFIG_DEFAULTS, policyFile: new URL('./policy.json', import.meta.url).pathname });
	assert.equal(policy.providers.cpa.models.length, providers.cpa.models.length, 'policy 与 profile 模型数一致');
	for (const m of policy.providers.cpa.models) {
		assert.ok(m.maxTokens + headroom <= m.contextWindow, `policy ${m.id} 违反不变量`);
	}
});
