import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, connectionForUser, stateFor, toolAllowFor, userKey, workspaceFor } from './index.js';

const A = `ou_${'a'.repeat(32)}`;
const B = `ou_${'b'.repeat(32)}`;

test('trusted identities derive stable distinct private workspace and state paths', () => {
  assert.equal(workspaceFor('/srv/app', A), workspaceFor('/srv/app', A));
  assert.notEqual(workspaceFor('/srv/app', A), workspaceFor('/srv/app', B));
  assert.equal(stateFor('/srv/state', A, 'ths-favorite'), path.join('/srv/state', `user-${userKey(A)}`, 'ths-favorite'));
  assert.throws(() => userKey('ou_fake'), /可信飞书用户身份/);
  assert.throws(() => stateFor('/srv/state', A, '../escape'), /登录态分类/);
});

test('tool defaults are inherited and per-user extras are additive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-tool-defaults-'));
  try {
    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify({ [A]: { tools: { extra: ['ths_account', 'feishu_*'] } } }), { mode: 0o600 });
    assert.deepEqual(toolAllowFor(B, ['web_search', 'ths_quote'], usersFile), ['web_search', 'ths_quote']);
    assert.deepEqual(toolAllowFor(A, ['web_search', 'ths_quote'], usersFile), ['web_search', 'ths_quote', 'ths_account', 'feishu_*']);
    assert.deepEqual(toolAllowFor(A, ['web_search'], usersFile), ['web_search', 'ths_account', 'feishu_*']);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('tool extras are additive per application and per user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-app-tool-extras-'));
  try {
    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify({
      [A]: { tools: { extra: ['feishu_*'] } },
      applications: { cli_other: { [A]: { tools: { extra: ['feishu_oauth'] } } } },
    }), { mode: 0o600 });
    assert.deepEqual(toolAllowFor(A, ['web_search'], usersFile, 'cli_primary', 'cli_primary'), ['web_search', 'feishu_*']);
    assert.deepEqual(toolAllowFor(A, ['web_search'], usersFile, 'cli_other', 'cli_primary'), ['web_search', 'feishu_oauth']);
    assert.deepEqual(toolAllowFor(A, ['web_search'], usersFile, 'cli_empty', 'cli_primary'), ['web_search']);
    assert.throws(() => connectionForUser(A, { usersFile, defaultAppId: 'cli_primary' }, 'trading', 'cli_other'), /未开通/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('principal Cordis service resolves enrolled users and fails closed for private connections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-principal-'));
  try {
    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify({ [A]: { trading: { baseUrl: 'http://127.0.0.1:19001', apiKey: 'private' } } }), { mode: 0o600 });
    const services = new Map();
    apply({ provide: (name, service) => services.set(name, service), logger: { info() {} } }, { usersFile });
    const principal = services.get('feishuPrincipal');
    assert.ok(principal);
    assert.equal(principal.connection(A, 'trading').xiadanBaseUrl, 'http://127.0.0.1:19001');
    assert.throws(() => principal.connection(B, 'trading'), /尚未配置/);
    assert.throws(() => principal.forAgent({}, 'trading'), /缺少用户身份/);
    assert.equal(connectionForUser(B, { usersFile, fqgateBaseUrl: 'http://public' }, 'market').fqgateBaseUrl, 'http://public');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
