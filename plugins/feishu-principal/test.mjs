import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, connectionForUser, stateFor, toolAllowFor, userKey, workspaceFor } from './index.js';
import { bindIdentity, bindIdentityWithCache, identityOf, listIdentities, principalOf, resolveIdentity } from './index.js';

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

// ── union_id 归并：一个飞书账号 = 一个身份 ──────────────────────────────
// 飞书 open_id 是「应用内唯一」，同一个人跟不同 bot（不同 appId）聊天 open_id 不同；
// union_id 在同一开发者旗下跨应用稳定 → 身份簇必须按 union_id 归并，
// 否则同一个人会被算成 N 个身份，每换一个 bot 就要重新登录一次。
test('union_id 把同一个人跨 bot 归并到同一身份簇', () => {
  const unionId = `on_${'u'.repeat(32)}`;
  const openIdInApp1 = `ou_${'1'.repeat(32)}`;
  const openIdInApp2 = `ou_${'2'.repeat(32)}`;
  const app1 = 'cli_aaunion0001';
  const app2 = 'cli_aaunion0002';

  const first = userKey(openIdInApp1, app1, unionId);
  const second = userKey(openIdInApp2, app2, unionId);
  assert.equal(second, first, '同一个人的另一个 bot 身份必须归并到同一 userId');

  // 另一人（不同 union）不串。
  const other = userKey(`ou_${'3'.repeat(32)}`, app1, `on_${'v'.repeat(32)}`);
  assert.notEqual(other, first, '不同 union_id 不应串到同一身份');

  // 一个簇里应该登记了两个 app 的身份（可审计）。
  const identities = listIdentities();
  const cluster = identities[first];
  assert.ok(cluster, '簇应存在');
  assert.equal(cluster.identities.length, 2, `簇内应有两个 bot 身份，实际 ${cluster.identities.length}`);
  assert.ok(cluster.identities.every((i) => i.unionId === unionId));
});

// 没有 union_id 时保持旧行为：openId+appId 各自成簇（向后兼容）。
test('缺 union_id 时按 openId+appId 独立成簇（向后兼容）', () => {
  const openId = `ou_${'4'.repeat(32)}`;
  const a = userKey(openId, 'cli_aanoUnion01');
  const b = userKey(openId, 'cli_aanoUnion02');
  assert.notEqual(a, b, '无 union_id 时不同 app 仍是不同簇（旧语义保留）');
});

// 历史簇补录：老用户第一次带 union_id 出现时要就地补上，否则跨 bot 归并永远不生效。
test('union_id 命中历史簇时就地补录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-union-backfill-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const openId = `ou_${'5'.repeat(32)}`;
    const unionId = `on_${'w'.repeat(32)}`;
    // 先造一个没有 unionId 的历史簇（模拟改造前的旧数据）。
    const legacy = resolveIdentity({ channel: 'feishu', appId: 'cli_aalegacy01', openId });
    assert.equal(Object.hasOwn(listIdentities()[legacy.userId].identities[0], 'unionId'), false);
    // 同一身份再次出现，这次带 union_id → 补录，userId 不变。
    const again = resolveIdentity({ channel: 'feishu', appId: 'cli_aalegacy01', openId, unionId });
    assert.equal(again.userId, legacy.userId);
    assert.equal(listIdentities()[legacy.userId].identities[0].unionId, unionId);
    // 补录后从另一个 bot 来 → 归并到同一簇。
    const otherBot = resolveIdentity({ channel: 'feishu', appId: 'cli_aalegacy02', openId: `ou_${'6'.repeat(32)}`, unionId });
    assert.equal(otherBot.userId, legacy.userId);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 旧簇先被另一 bot 抢先建了新簇时，要把两簇合并（保留有数据目录的那边）。
test('union_id 冲突时合并两个簇，保留有档案目录的一侧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-union-merge-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const openIdOld = `ou_${'7'.repeat(32)}`;
    const openIdNew = `ou_${'8'.repeat(32)}`;
    const unionId = `on_${'m'.repeat(32)}`;
    // 历史簇（模拟有真实档案目录的老用户）
    const legacy = resolveIdentity({ channel: 'feishu', appId: 'cli_aamerge01', openId: openIdOld });
    fs.mkdirSync(path.join(dir, 'home', 'users', legacy.userId), { recursive: true });
    // 新的 bot 先来一步，带 union_id，但旧簇还没补录 → 新建一个簇
    const fresh = resolveIdentity({ channel: 'feishu', appId: 'cli_aamerge02', openId: openIdNew, unionId });
    assert.notEqual(fresh.userId, legacy.userId);
    // 老身份再出现 → union 冲突，两簇合并，且保留有目录的 legacy.userId
    const resolved = resolveIdentity({ channel: 'feishu', appId: 'cli_aamerge01', openId: openIdOld, unionId });
    assert.equal(resolved.userId, legacy.userId, '应保留有档案目录的老簇');
    const users = listIdentities();
    assert.equal(users[fresh.userId], undefined, '被并入的簇应删除');
    assert.equal(users[legacy.userId].identities.length, 2, '两边的身份记录都要保留');
    // 合并后从任一 bot 来都是同一 userId
    assert.equal(resolveIdentity({ channel: 'feishu', appId: 'cli_aamerge02', openId: openIdNew, unionId }).userId, legacy.userId);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 回归：簇里已有别的身份带 union_id 时，本身份首次带 union 仍必须补录。
// （此前 owner 存在就跳过补录，导致同簇内部分身份永远没有 unionId，跨 bot 归并失效。）
test('同簇内其它身份已有 union 时，本身份仍要补录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-union-samecluster-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const unionId = `on_${'s'.repeat(32)}`;
    const appA = 'cli_aasamecluster01';
    const appB = 'cli_aasamecluster02';
    const openA = `ou_${'1'.repeat(32)}`;
    const openB = `ou_${'2'.repeat(32)}`;
    // A 先带 union 建簇
    const a = resolveIdentity({ channel: 'feishu', appId: appA, openId: openA, unionId });
    // B 并入同簇但当时没带 union
    const b1 = resolveIdentity({ channel: 'feishu', appId: appB, openId: openB });
    assert.notEqual(b1.userId, a.userId, '起初是独立簇');
    bindIdentityWithCache(a.userId, { channel: 'feishu', appId: appB, openId: openB });
    // 现在 B 带 union 再来：必须补录到 B 自己那条身份记录上
    resolveIdentity({ channel: 'feishu', appId: appB, openId: openB, unionId });
    const cluster = listIdentities()[a.userId];
    const bEntry = cluster.identities.find((i) => i.openId === openB);
    assert.equal(bEntry.unionId, unionId, 'B 的 unionId 必须补录（此前会漏）');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bind moves one identity from a multi-identity cluster without resurrecting it or losing disk additions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bind-partial-'));
  const file = path.join(dir, 'identities.json');
  const moving = { channel: 'feishu', appId: 'cli_move', openId: A };
  const staying = { channel: 'feishu', appId: 'cli_stay', openId: B };
  const diskAdded = { channel: 'feishu', appId: 'cli_disk', openId: `ou_${'c'.repeat(32)}` };
  const users = { u_source: { identities: [moving, staying] }, u_target: { identities: [] } };
  fs.writeFileSync(file, JSON.stringify({ users }));
  const options = { identitiesFile: file };
  try {
    listIdentities(options); // Prime a stale process snapshot before another writer adds data.
    users.u_source.identities.push(diskAdded);
    users.u_new = { identities: [{ channel: 'feishu', appId: 'cli_new', openId: `ou_${'d'.repeat(32)}` }] };
    fs.writeFileSync(file, JSON.stringify({ users }));
    bindIdentity('u_target', moving, options);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(disk.users.u_source.identities, [staying, diskAdded]);
    assert.equal(disk.users.u_target.identities.length, 1);
    assert.deepEqual(disk.users.u_new, users.u_new);
    const owners = Object.entries(disk.users).filter(([, user]) => user.identities.some((identity) =>
      identity.channel === moving.channel && identity.appId === moving.appId && identity.openId === moving.openId));
    assert.deepEqual(owners.map(([userId]) => userId), ['u_target']);
    assert.equal(resolveIdentity(moving, { identitiesFile: file }).userId, 'u_target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bind of the last known identity preserves identities added to that source on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bind-last-'));
  const file = path.join(dir, 'identities.json');
  const moving = { channel: 'feishu', appId: 'cli_last', openId: A };
  const added = { channel: 'feishu', appId: 'cli_added', openId: B };
  const options = { identitiesFile: file };
  fs.writeFileSync(file, JSON.stringify({ users: { u_source: { identities: [moving] }, u_target: { identities: [] } } }));
  try {
    listIdentities(options);
    fs.writeFileSync(file, JSON.stringify({ users: { u_source: { identities: [moving, added] }, u_target: { identities: [] } } }));
    bindIdentity('u_target', moving, options);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(disk.users.u_source.identities, [added]);
    assert.equal(disk.users.u_target.identities.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 回归：多个身份服务进程共享 identities.json，任何一个写盘都不能抹掉别人刚建的身份。
// （web / personal-investment / guests 三进程各自内存一份副本，整体覆盖写会丢用户。）
test('多进程并发写 identities.json 不丢更新', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-multiproc-'));
  const file = path.join(dir, 'identities.json');
  fs.writeFileSync(file, JSON.stringify({ users: {} }));
  try {
    // 两个独立 state 槽 = 两个进程的内存副本
    const PA = { identitiesFile: file };
    const PB = { identitiesFile: file };
    const a = resolveIdentity({ channel: 'feishu', appId: 'cli_p1', openId: A }, PA);
    const b = resolveIdentity({ channel: 'feishu', appId: 'cli_p1', openId: B }, PB);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(disk.users[a.userId], 'A 建的身份必须保留（不能被 B 覆盖）');
    assert.ok(disk.users[b.userId], 'B 建的身份必须保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
