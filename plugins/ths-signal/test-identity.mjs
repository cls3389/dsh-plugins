import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'ths-signal-'));
const openId = `ou_${'b'.repeat(32)}`;
const appId = 'cli_signal_test';
const usersFile = join(dir, 'users.json');
writeFileSync(usersFile, JSON.stringify({ applications: { [appId]: { [openId]: {
  enabled: true,
  features: { aiSignal: true },
  aiSignal: { baseUrl: 'http://user-signal', webuiToken: 'webui-user', webhookToken: 'webhook-user' },
} } } }));
const tools = new Map();
const ctx = { tools: { register: (def) => tools.set(def.name, def) }, logger: { info() {}, warn() {} } };
apply(ctx, { usersFile, defaultAppId: appId, signalTraderBaseUrl: 'http://global-signal', signalTraderWebuiToken: 'global' });
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init.headers });
  const body = String(url).endsWith('/health') ? { status: 'ok' } : String(url).includes('local-execution') ? { enabled: true, items: [] } : String(url).includes('dynamic-reeval') ? { enabled: true } : { items: [] };
  return { ok: true, text: async () => JSON.stringify(body) };
};
try {
  const result = await tools.get('ths_signal_status').execute({}, { agent: { larkUser: { openId, appId } } });
  assert.equal(result.baseUrl, 'http://user-signal');
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.ok(call.url.startsWith('http://user-signal/'), call.url);
    assert.equal(call.headers['X-Access-Token'], 'webui-user');
  }
  assert.deepEqual([...tools.keys()].sort(), ['ths_signal_explain', 'ths_signal_send', 'ths_signal_status']);
} finally { globalThis.fetch = originalFetch; }
console.log('ths-signal: status uses only app-scoped aiSignal connection');
