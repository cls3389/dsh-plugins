#!/usr/bin/env node
/**
 * model-config 库命令行入口(skill 驱动用;插件工具注册与此同源,index.js 单一实现)。
 *
 * 用法:
 *   node cli.mjs audit     [--provider P] [--json] [--force-refresh] [--catalog-file F]
 *   node cli.mjs propose   [--provider P] [--models a,b] [--json] [--force-refresh] [--catalog-file F]
 *   node cli.mjs discover  --base-url U --api-key K [--models-file F] [--catalog-file F] [--json]
 *   node cli.mjs policy    [--json]
 *   通用: --profile PATH / --policy-file PATH(或环境变量 MC_PROFILE / MC_POLICY)
 *
 * 退出码:0=通过;1=审计有 mismatch / 执行错误;2=用法错误。
 */
import { apply } from './index.js';

const [cmd, ...rest] = process.argv.slice(2);
const COMMANDS = {
	audit: 'model_config_audit',
	propose: 'model_config_propose',
	discover: 'model_config_discover',
	policy: 'model_config_policy',
};
if (!cmd || !COMMANDS[cmd]) {
	console.error('用法: node cli.mjs <audit|propose|discover|policy> [--provider P] [--json] [--force-refresh] [--catalog-file F] [--models-file F] [--base-url U] [--api-key K] [--models a,b] [--profile PATH] [--policy-file PATH]');
	process.exit(2);
}
const args = {};
for (let i = 0; i < rest.length; i++) {
	const a = rest[i];
	if (a === '--json') args.json = true;
	else if (a === '--force-refresh') args.forceRefresh = true;
	else if (a === '--provider') args.provider = rest[++i];
	else if (a === '--catalog-file') args.catalogFile = rest[++i];
	else if (a === '--models-file') args.modelsFile = rest[++i];
	else if (a === '--base-url') args.baseUrl = rest[++i];
	else if (a === '--api-key') args.apiKey = rest[++i];
	else if (a === '--context-window-cap') args.contextWindowCap = Number(rest[++i]);
	else if (a === '--default-max-tokens') args.defaultMaxTokens = Number(rest[++i]);
	else if (a === '--models') args.models = rest[++i].split(',').map((s) => s.trim()).filter(Boolean);
	else if (a === '--profile') process.env.MC_PROFILE = rest[++i];
	else if (a === '--policy-file') process.env.MC_POLICY = rest[++i];
	else {
		console.error('未知参数:', a);
		process.exit(2);
	}
}
const config = {};
if (process.env.MC_PROFILE) config.profilePath = process.env.MC_PROFILE;
if (process.env.MC_POLICY) config.policyFile = process.env.MC_POLICY;

const tools = [];
apply({ tools: { register: (t) => tools.push(t) }, logger: { info() {} } }, config);
const tool = tools.find((t) => t.name === COMMANDS[cmd]);
const result = await tool.execute(args);

if (result.error) {
	console.error('ERROR:', result.error);
	process.exit(1);
}
if (args.json) {
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.ok === false ? 1 : 0);
}

/* 人类可读输出 */
if (cmd === 'policy') {
	console.log('policy:', result.policyPath, '| 不变量违规:', result.invariantViolations.length);
	for (const [name, p] of Object.entries(result.policy.providers)) {
		console.log(`  ${name}: source=${p.source} models=${p.models.length} routeReasoning=${p.routeReasoning ?? '-'}`);
	}
	process.exit(result.invariantViolations.length ? 1 : 0);
}
if (cmd === 'audit') {
	console.log((result.ok ? 'OK ' : 'FAIL ') + result.summary);
	console.log('catalog:', result.catalogSource);
	if (result.filledModels?.length) console.log('filledModels:', result.filledModels.join(','));
	for (const [name, p] of Object.entries(result.providers)) {
		for (const f of p.findings) {
			console.log(`  ${p.provider} ${f.severity.toUpperCase()} ${f.id ?? ''} ${f.field} ${f.note ?? `expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual ?? null)}`}`);
		}
	}
	console.log(result.hint);
	process.exit(result.ok ? 0 : 1);
}
if (cmd === 'propose') {
	console.log('审计:', result.auditSummary, '| 提案:', result.proposals.length, '| 不自动提案:', result.unproposable.length);
	for (const p of result.proposals) {
		console.log(`  [${p.provider}] ${p.id}:`);
		for (const c of p.changes) console.log(`    ${c.field}: ${JSON.stringify(c.current)} → ${JSON.stringify(c.proposed)}  (${c.rationale})`);
		console.log(`    edit.unique=${p.edit.unique}${p.edit.warning ? ' ⚠ ' + p.edit.warning : ''}`);
	}
	for (const u of result.unproposable) {
		console.log(`  ✗ [${u.provider}] ${u.id ?? u.field}: ${u.reason ?? JSON.stringify(u.expected ?? null)}`);
	}
	console.log('下一步:', result.nextSteps);
	process.exit(0);
}
if (cmd === 'discover') {
	console.log(`模型 ${result.modelCount} 个 | 目录: ${result.catalogSource} | 路由交集建议: ${result.suggestedRouteReasoning ?? '无'} ${JSON.stringify(result.routeIntersection ?? [])}`);
	if (result.filledModels?.length) console.log('缺失补拉:', result.filledModels.join(','));
	for (const m of result.models) {
		if (m.matched) {
			const eff = m.suggested.reasoningEfforts === false ? 'false' : m.suggested.reasoningEfforts ? Object.keys(m.suggested.reasoningEfforts).join('/') : 'MANUAL';
			console.log(`  ✓ ${m.id} → ${m.openrouter} [${m.tier}] ctx=${m.suggested.contextWindow} max=${m.suggested.maxTokens} input=${m.suggested.input.join('+')} efforts=${eff}${m.reasoningNote ? ' | ' + m.reasoningNote : ''}`);
		} else {
			console.log(`  ✗ ${m.id} | ${m.note}`);
		}
	}
	console.log('下一步:', result.nextSteps);
	process.exit(0);
}
