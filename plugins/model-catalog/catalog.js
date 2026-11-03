const REASONING = new Map([
	['none', 'off'], ['off', 'off'], ['minimal', 'minimal'], ['low', 'low'],
	['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
]);
const REASONING_VALUES = new Set(REASONING.values());
const APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function plainObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new TypeError(`${label} must be a plain object`);
	return value;
}
function safeId(value, label = 'id') {
	if (typeof value !== 'string' || !value.trim() || value.length > 200 || BLOCKED_KEYS.has(value)) throw new TypeError(`invalid ${label}`);
	return value;
}
function safeUrl(value, label) {
	if (value == null || value === '') return undefined;
	let url;
	try { url = new URL(value); } catch { throw new TypeError(`invalid ${label}`); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError(`invalid ${label}`);
	return url.href.replace(/\/$/, '');
}
function finitePositive(value) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined; }
function normalizeReasoning(values) {
	if (!Array.isArray(values)) return undefined;
	const result = [...new Set(values.map((v) => REASONING.get(String(v).toLowerCase())).filter(Boolean))];
	return result.length ? result : undefined;
}
function normalizeInput(values) {
	if (!Array.isArray(values)) return undefined;
	return [...new Set(values.filter((v) => v === 'text' || v === 'image'))];
}
function copyPlain(value, label) {
	const obj = plainObject(value, label);
	const out = Object.create(null);
	for (const [key, item] of Object.entries(obj)) {
		if (BLOCKED_KEYS.has(key)) throw new TypeError(`unsafe ${label} key`);
		out[key] = item;
	}
	return out;
}

export function normalizeProvider(raw) {
	plainObject(raw, 'provider');
	const id = safeId(raw.id ?? raw.provider, 'provider id');
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) throw new TypeError('invalid provider id');
	const name = typeof raw.displayName === 'string' && raw.displayName.trim()
		? raw.displayName.trim()
		: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
	const api = raw.api ?? 'openai-completions';
	if (!APIS.has(api)) throw new TypeError('unsupported provider api');
	const baseURL = safeUrl(raw.baseURL, 'baseURL');
	const catalogURL = safeUrl(raw.catalogURL, 'catalogURL');
	const overrides = Object.create(null);
	if (raw.models != null) {
		const models = plainObject(raw.models, 'models');
		for (const [modelId, value] of Object.entries(models)) {
			safeId(modelId, 'model id');
			const model = copyPlain(value, 'model override');
			const normalized = Object.create(null);
			for (const field of ['enabled', 'name', 'priority', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'defaultReasoning', 'compat']) {
				if (Object.hasOwn(model, field)) normalized[field] = model[field];
			}
			if ('enabled' in normalized && typeof normalized.enabled !== 'boolean') throw new TypeError(`invalid enabled override for ${modelId}`);
			if ('name' in normalized && (typeof normalized.name !== 'string' || !normalized.name.trim())) throw new TypeError(`invalid name override for ${modelId}`);
			for (const field of ['priority', 'contextWindow', 'maxTokens']) {
				if (field in normalized && !Number.isFinite(normalized[field])) throw new TypeError(`invalid ${field} override for ${modelId}`);
			}
			if ('input' in normalized && (!Array.isArray(normalized.input) || normalized.input.some((x) => !['text', 'image'].includes(x)))) throw new TypeError(`invalid input override for ${modelId}`);
			if ('reasoningEfforts' in normalized && normalized.reasoningEfforts !== false && (!Array.isArray(normalized.reasoningEfforts) || normalized.reasoningEfforts.some((x) => !REASONING_VALUES.has(x)))) throw new TypeError(`invalid reasoningEfforts override for ${modelId}`);
			if ('defaultReasoning' in normalized && normalized.defaultReasoning != null && !REASONING_VALUES.has(normalized.defaultReasoning)) throw new TypeError(`invalid defaultReasoning override for ${modelId}`);
			if ('compat' in normalized) normalized.compat = copyPlain(normalized.compat, 'compat override');
			overrides[modelId] = normalized;
		}
	}
	return { id, displayName: name, api, ...(baseURL ? { baseURL } : {}), ...(catalogURL ? { catalogURL } : {}), models: overrides };
}

function mapModel(model, format) {
	if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
	const id = model.slug ?? model.id;
	if (typeof id !== 'string' || !id.trim() || BLOCKED_KEYS.has(id)) return null;
	if (model.visibility === 'hide' || model.enabled === false) return null;
	const effortsSource = model.supported_reasoning_levels ?? model.reasoning?.supported_efforts;
	const mappedEfforts = normalizeReasoning(Array.isArray(effortsSource)
		? effortsSource.map((v) => typeof v === 'string' ? v : v?. effort ?? v?.reasoning_effort).filter((v) => typeof v === 'string')
		: undefined);
	const defaultRaw = model.default_reasoning_level ?? model.reasoning?.default_effort;
	const defaultReasoning = typeof defaultRaw === 'string' ? REASONING.get(defaultRaw.toLowerCase()) : undefined;
	const contextWindow = finitePositive(model.context_window ?? model.max_context_window ?? model.context_length);
	const maxTokens = finitePositive(model.max_tokens ?? model.top_provider?.max_completion_tokens);
	const modalities = model.input_modalities ?? model.architecture?.input_modalities;
	const entry = {
		id,
		name: typeof (model.display_name ?? model.name) === 'string' ? (model.display_name ?? model.name) : id,
		enabled: true,
		...(Number.isFinite(model.priority) ? { priority: model.priority } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		...(normalizeInput(modalities) ? { input: normalizeInput(modalities) } : {}),
		...(mappedEfforts ? { reasoningEfforts: mappedEfforts } : {}),
		...(defaultReasoning ? { defaultReasoning } : {}),
	};
	if (format === 'codex' && model.visibility && model.visibility !== 'list') return null;
	return entry;
}

export function parseCatalog(json) {
	let value = json;
	if (typeof json === 'string') {
		try { value = JSON.parse(json); } catch { throw new TypeError('catalog response is not valid JSON'); }
	}
	plainObject(value, 'catalog');
	const codex = Array.isArray(value.models);
	const models = codex ? value.models : value.data;
	if (!Array.isArray(models)) throw new TypeError('catalog must contain a models or data array');
	const seen = new Set();
	const result = [];
	for (const raw of models) {
		const entry = mapModel(raw, codex ? 'codex' : 'standard');
		if (entry && !seen.has(entry.id)) { seen.add(entry.id); result.push(entry); }
	}
	return result;
}

export function mergeModels(remote, overrides = {}) {
	if (!Array.isArray(remote)) throw new TypeError('remote models must be an array');
	plainObject(overrides, 'model overrides');
	const overrideMap = copyPlain(overrides, 'model overrides');
	const seen = new Set();
	return remote.flatMap((raw) => {
		if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || BLOCKED_KEYS.has(raw.id) || seen.has(raw.id)) return [];
		seen.add(raw.id);
		const override = overrideMap[raw.id];
		if (override !== undefined && (override.enabled === false)) return [];
		const merged = { ...raw, enabled: true };
		if (override) {
			for (const field of ['name', 'priority', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'defaultReasoning']) {
				if (Object.hasOwn(override, field)) merged[field] = Array.isArray(override[field]) ? [...override[field]] : override[field];
			}
			if (override.compat !== undefined) merged.compat = { ...(raw.compat ?? {}), ...copyPlain(override.compat, 'compat override') };
		}
		return [merged];
	});
}

export async function fetchCatalog(provider, { apiKey, signal, fetchImpl = fetch } = {}) {
	const normalized = normalizeProvider(provider);
	if (typeof apiKey !== 'string' || !apiKey) throw new TypeError('apiKey is required');
	const endpoint = normalized.catalogURL ?? (normalized.baseURL ? `${normalized.baseURL}/models` : null);
	if (!endpoint) throw new TypeError('baseURL or catalogURL is required');
	const catalogUrl = new URL(endpoint);
	if (!catalogUrl.searchParams.has('client_version')) catalogUrl.searchParams.set('client_version', '0.166.0');
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error('catalog request timed out')), DEFAULT_TIMEOUT_MS);
	const abort = () => controller.abort(signal.reason);
	if (signal) {
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });
	}
	try {
		const response = await fetchImpl(catalogUrl.href, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
		if (!response?.ok) throw new Error(`catalog request failed (HTTP ${Number(response?.status) || 0})`);
		const declared = Number(response.headers?.get?.('content-length'));
		if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('catalog response exceeds 4 MiB limit');
		let text;
		if (response.body?.getReader) {
			const reader = response.body.getReader();
			const chunks = [];
			let total = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value.byteLength;
					if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('catalog response exceeds 4 MiB limit'); }
					chunks.push(value);
				}
			} finally { reader.releaseLock?.(); }
			const bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			text = new TextDecoder().decode(bytes);
		} else {
			text = await response.text();
			if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('catalog response exceeds 4 MiB limit');
		}
		return parseCatalog(text);
	} catch (error) {
		if (error?.name === 'AbortError' || controller.signal.aborted) throw new Error('catalog request timed out or was aborted');
		const message = String(error?.message ?? 'catalog request failed');
		throw new Error(message.split(apiKey).join('[redacted]'));
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', abort);
	}
}
