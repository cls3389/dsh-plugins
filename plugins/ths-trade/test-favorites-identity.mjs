// ⚠️ 过时测试（2026-11-03 标注）：本文件期望旧版 ths_fav_* 工具，但自选股职责
// 已拆到 @dsh-friends/ths-favorites（ths-trade 不再有自选工具）。保留仅作历史参考，
// 请勿据此判断功能正常性。自选测试见 dsh-plugins/plugins/ths-favorites/test-adapter.mjs。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

const home = mkdtempSync(join(tmpdir(), 'ths-trade-fav-'));
process.env.DSH_HOME = home;
const openId = `ou_${'a'.repeat(32)}`;
const appId = 'cli_personal';
const usersFile = join(home, 'users.json');
writeFileSync(usersFile, JSON.stringify({
  applications: {
    [appId]: {
      [openId]: {
        enabled: true,
        features: { market: true },
        market: { dataCenterBaseUrl: 'http://user-dc', dataCenterApiKey: 'user-key' },
      },
    },
  },
}));

const tools = new Map();
const ctx = { tools: { register: (definition) => tools.set(definition.name, definition) }, logger: { warn() {}, info() {} } };
apply(ctx, { usersFile, defaultAppId: appId, dataCenterBaseUrl: 'http://global-dc', dataCenterApiKey: 'global-key' });
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), key: init.headers['X-API-Key'] });
  return { ok: true, text: async () => JSON.stringify({ ok: true, items: [] }) };
};
const exec = { agent: { larkUser: { openId, appId } } };
try {
  await tools.get('ths_fav_get_self').execute({}, exec);
  await tools.get('ths_fav_list_groups').execute({}, exec);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.startsWith('http://user-dc/'), call.url);
    assert.equal(call.key, 'user-key');
  }
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.DSH_HOME;
}
console.log('ths-trade: favorites use app-scoped user market credentials');
