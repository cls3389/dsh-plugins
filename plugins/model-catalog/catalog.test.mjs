import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProvider, parseCatalog, mergeModels, fetchCatalog } from './catalog.js';

test('normalizes provider display name, API and safe URLs without exposing credentials', () => {
	assert.deepEqual(normalizeProvider({
		id: 'codex', displayName: 'Codex Account', api: 'openai-responses',
		baseURL: 'https://api.example/v1/', apiKey: 'secret-value',
	}), { id: 'codex', displayName: 'Codex Account', api: 'openai-responses', baseURL: 'https://api.example/v1', models: Object.create(null) });
	assert.throws(() => normalizeProvider({ id: 'x', baseURL: 'https://user:pass@example.com' }), /invalid baseURL/);
	assert.throws(() => normalizeProvider({ id: '__proto__' }), /invalid provider id/);
	assert.throws(() => normalizeProvider({ id: 'x', api: 'unknown' }), /unsupported provider api/);
});

test('parses Codex catalog, excludes hidden models and maps supported reasoning', () => {
	assert.deepEqual(parseCatalog({ models: [
		{ slug: 'gpt-5', display_name: 'GPT 5', visibility: 'list', priority: 4, context_window: 272000, max_tokens: 32000, input_modalities: ['text', 'image', 'audio'], supported_reasoning_levels: ['none', 'low', 'high', 'ultra'], default_reasoning_level: 'high' },
		{ slug: 'hidden', visibility: 'hide' },
		{ slug: 'unknown-visibility', visibility: 'experimental' },
	] }), [{ id: 'gpt-5', name: 'GPT 5', enabled: true, priority: 4, contextWindow: 272000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: ['off', 'low', 'high'], defaultReasoning: 'high' }]);
});

test('parses standard OpenAI listing and rejects malformed payloads', () => {
	assert.deepEqual(parseCatalog(JSON.stringify({ data: [
		{ id: 'model-a', name: 'Model A', context_length: 1000, top_provider: { max_completion_tokens: 300 }, architecture: { input_modalities: ['text'] } },
		{ id: 'model-a', name: 'duplicate' },
	] })), [{ id: 'model-a', name: 'Model A', enabled: true, contextWindow: 1000, maxTokens: 300, input: ['text'] }]);
	assert.throws(() => parseCatalog('{'), /valid JSON/);
	assert.throws(() => parseCatalog({ data: {} }), /array/);
	assert.deepEqual(parseCatalog({ data: [{ id: '__proto__' }, null] }), []);
});

test('merges model overrides by ID, deep-merges compat and does not advertise absent overrides', () => {
	const remote = [{ id: 'a', name: 'A', enabled: true, reasoningEfforts: ['low', 'high'], compat: { stream: true, nested: { upstream: true } } }, { id: 'b', name: 'B' }];
	const result = mergeModels(remote, {
		a: { name: 'Override A', priority: 9, reasoningEfforts: ['medium'], compat: { nested: { local: true } } },
		missing: { enabled: true, name: 'Not advertised' },
		b: { enabled: false },
	});
	assert.deepEqual(result, [{ id: 'a', name: 'Override A', enabled: true, reasoningEfforts: ['medium'], compat: { stream: true, nested: { local: true }, supportsDeveloperRole: false }, priority: 9 }]);
	assert.throws(() => mergeModels(remote, JSON.parse('{"__proto__":{"enabled":true}}')), /unsafe/);
});

test('disables developer role by default for every model; explicit declarations win', () => {
	const merged = mergeModels([
		{ id: 'glm-5.3', name: 'GLM 5.3' },
		{ id: 'kimi-k3', name: 'kimi' },
		{ id: 'gpt-6-sol', name: 'GPT 6 Sol', compat: { supportsDeveloperRole: true } },
	], {});
	assert.deepEqual(merged[0].compat, { supportsDeveloperRole: false });
	assert.deepEqual(merged[1].compat, { supportsDeveloperRole: false });
	assert.equal(merged[2].compat.supportsDeveloperRole, true);
	const withOverride = mergeModels([{ id: 'glm-5.3', name: 'GLM 5.3' }], { 'glm-5.3': { compat: { thinkingFormat: 'zai' } } });
	assert.deepEqual(withOverride[0].compat, { thinkingFormat: 'zai', supportsDeveloperRole: false });
});

test('fetches Codex catalog at default path, passing auth and returning normalized entries', async () => {
	let args;
	const models = await fetchCatalog({ id: 'p', baseURL: 'https://api.example/v1' }, {
		apiKey: 'secret-value', fetchImpl: async (...callArgs) => {
			args = callArgs;
			return new Response(JSON.stringify({ models: [{ slug: 'gpt', visibility: 'list' }] }), { status: 200 });
		},
	});
	assert.equal(args[0], 'https://api.example/v1/models?client_version=0.166.0');
	assert.equal(args[1].headers.Authorization, 'Bearer secret-value');
	assert.equal(args[1].method, 'GET');
	assert.deepEqual(models, [{ id: 'gpt', name: 'gpt', enabled: true }]);
});

test('fetches custom catalog URL and redacts HTTP failures', async () => {
	let requested;
	await fetchCatalog({ id: 'p', baseURL: 'https://ignored.example/v1', catalogURL: 'https://custom.example/catalog?x=1' }, {
		apiKey: 'very-secret', fetchImpl: async (url) => { requested = url; return new Response('no', { status: 503 }); },
	}).then(() => assert.fail('expected HTTP failure'), (error) => assert.equal(error.message, 'catalog request failed (HTTP 503)'));
	assert.equal(requested, 'https://custom.example/catalog?x=1&client_version=0.166.0');
});

test('redacts API key from fetch implementation errors', async () => {
	await assert.rejects(fetchCatalog({ id: 'p', baseURL: 'https://api.example' }, {
		apiKey: 'secret-value', fetchImpl: async () => { throw new Error('request secret-value failed'); },
	}), (error) => {
		assert.equal(error.message, 'request [redacted] failed');
		assert.equal(error.message.includes('secret-value'), false);
		return true;
	});
});

test('enforces bounded response size', async () => {
	await assert.rejects(fetchCatalog({ id: 'p', baseURL: 'https://api.example' }, {
		apiKey: 'secret-value', fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
	}), /4 MiB/);
});
