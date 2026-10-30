import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, connectionForUser, stateFor, toolAllowFor, userKey, workspaceFor } from './index.js';
import { bindIdentityWithCache, identityOf, listIdentities, principalOf, resolveIdentity } from './index.js';

const A = `ou_${'a'.repeat(32)}`;
const B = `ou_${'b'.repeat(32)}`;

// 测试全程隔离 DSH_HOME:userKey/identityOf 会经 resolveIdentity 写 $DSH_HOME/identities.json,
// 绝不能碰真实环境。进程级 mkdtemp 在所有测试前生效,结束清理。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-principal-home-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = testHome;
process.on('exit', () => {
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('trusted identities derive stable distinct private workspace and state paths', () => {
  assert.equal(workspaceFor('/srv/app', A), workspaceFor('/srv/app', A));
  assert.notEqual(workspaceFor('/srv/app', A), workspaceFor('/srv/app', B));
  assert.equal(stateFor('/srv/state', A, 'ths-favorite'), path.join('/srv/state', `user-${userKey(A)}`, 'ths-favorite'));
  assert.throws(() => userKey('ou_fake'), /可信飞书用户身份/);
  assert.throws(() => stateFor('/srv/state', A, '../escape'), /登录态分类/);
});

test('identity clusters: first sight creates, bind merges, workspace follows the cluster', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-identity-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    // 首个渠道身份自动建档
    const first = resolveIdentity({ channel: 'feishu', appId: 'cli_aaa', openId: A, displayName: '军' });
    assert.equal(first.created, true);
    // 同身份重复解析 → 同 userId,不新建
    const again = resolveIdentity({ channel: 'feishu', appId: 'cli_aaa', openId: A });
    assert.equal(again.userId, first.userId);
    // 另一 app 的身份 → 独立簇(未 bind 前互不相认)
    const other = resolveIdentity({ channel: 'feishu', appId: 'cli_bbb', openId: B });
    assert.notEqual(other.userId, first.userId);
    assert.notEqual(workspaceFor('/srv/app', A, 'cli_aaa'), workspaceFor('/srv/app', B, 'cli_bbb'));
    // 管理员 bind:把 B 并入军的簇,旧簇清理
    const merged = bindIdentityWithCache(first.userId, { channel: 'feishu', appId: 'cli_bbb', openId: B });
    assert.equal(merged.previousUserId, other.userId);
    // bind 后:两身份解析到同一 userId,workspace 合流
    assert.equal(userKey(B, 'cli_bbb'), first.userId);
    assert.equal(workspaceFor('/srv/app', B, 'cli_bbb'), workspaceFor('/srv/app', A, 'cli_aaa'));
    const users = listIdentities();
    assert.equal(users[other.userId], undefined);
    assert.equal(Object.keys(users[first.userId].identities).length, 2);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('identityOf prefers agent.identity, synthesizes from larkUser, and returns undefined without either', () => {
  const bound = { channel: 'feishu', agentId: 'dsh-assistant', appId: 'cli_x', subjectId: A, userId: 'u_prebound', context: { chatId: 'oc_1', accountId: 'default' } };
  // identity 优先:即使 larkUser 同时存在也原样返回宿主写入的 identity
  assert.equal(identityOf({ identity: bound, larkUser: { openId: B } }), bound);
  assert.equal(identityOf({ identity: bound }), bound);
  // larkUser 合成:channel 固定 feishu,subjectId=openId,userId=身份簇键,可选字段按需保留
  const synthesized = identityOf({ larkUser: { openId: A, chatId: 'oc_g', appId: 'cli_app', agentId: 'goutoujunshi', accountId: 'SalesBot' } });
  assert.equal(synthesized.channel, 'feishu');
  assert.equal(synthesized.subjectId, A);
  assert.equal(synthesized.appId, 'cli_app');
  assert.equal(synthesized.agentId, 'goutoujunshi');
  assert.equal(synthesized.userId, userKey(A, 'cli_app'));
  assert.equal(synthesized.context.chatId, 'oc_g');
  assert.equal(synthesized.context.accountId, 'SalesBot');
  const minimal = identityOf({ larkUser: { openId: B } });
  assert.equal(minimal.channel, 'feishu');
  assert.equal(minimal.subjectId, B);
  assert.equal(minimal.userId, userKey(B));
  assert.deepEqual(minimal.context, {});
  // 两者皆无 → undefined
  assert.equal(identityOf(undefined), undefined);
  assert.equal(identityOf({}), undefined);
  assert.equal(identityOf({ larkUser: {} }), undefined);
  // principalOf(deprecated):identity 或合成形态统一提取 {openId, appId, agentId}
  const principal = principalOf({ larkUser: { openId: A, appId: 'cli_app', agentId: 'goutoujunshi' } });
  assert.deepEqual(principal, { openId: A, appId: 'cli_app', agentId: 'goutoujunshi' });
  assert.deepEqual(principalOf({ identity: { channel: 'feishu', subjectId: B, appId: 'cli_b' } }), { openId: B, appId: 'cli_b' });
  assert.equal(principalOf(undefined), undefined);
});

test('agentIdentity service exposes userIdOf/connection/toolsFor with legacy fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-agentidentity-'));
  try {
    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify({
      [A]: { trading: { baseUrl: 'http://127.0.0.1:19001', apiKey: 'private' }, tools: { extra: ['ths_account'] } },
    }), { mode: 0o600 });
    const services = new Map();
    apply({ provide: (name, service) => services.set(name, service), logger: { info() {} } }, { usersFile });
    const identityService = services.get('agentIdentity');
    assert.ok(identityService);
    const legacy = { fqgateBaseUrl: 'http://legacy' };
    // resolve:渠道无关包装 identities.js
    const resolved = identityService.resolve({ channel: 'feishu', appId: 'cli_r', subjectId: B });
    assert.equal(typeof resolved.userId, 'string');
    assert.equal(resolved.created, true);
    // userIdOf:agent 或 exec 形态都能取簇键(合成走 larkUser)
    assert.equal(identityService.userIdOf({ larkUser: { openId: A } }), userKey(A));
    assert.equal(identityService.userIdOf({ agent: { larkUser: { openId: A } } }), userKey(A));
    assert.equal(identityService.userIdOf({ agent: { identity: { channel: 'feishu', subjectId: A, userId: 'u_direct' } } }), 'u_direct');
    assert.equal(identityService.userIdOf({}), undefined);
    // connection:无身份但已配置 usersFile → 拒绝(与 feishuPrincipal.forAgent 同语义);
    // legacy cfg 回退仅发生在调用方未配 usersFile 的场合(lib 壳 connectionForExecution 直连场景)。
    assert.throws(() => identityService.connection({}, 'trading', {}), /缺少用户身份/);
    assert.throws(() => identityService.connection({}, 'market', legacy), /缺少用户身份/);
    // connection:market 对未注册用户回退公共默认
    assert.equal(identityService.connection({ larkUser: { openId: B } }, 'market', legacy).fqgateBaseUrl, 'http://legacy');
    // toolsFor:extras 仅归属用户可见;无身份时 defaults 原样返回
    assert.deepEqual(identityService.toolsFor({ larkUser: { openId: A } }, ['web_search']), ['web_search', 'ths_account']);
    assert.deepEqual(identityService.toolsFor({ larkUser: { openId: B } }, ['web_search']), ['web_search']);
    assert.deepEqual(identityService.toolsFor({}, ['web_search']), ['web_search']);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
