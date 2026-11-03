import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 隔离 DSH_HOME 必须先于插件 import(USER_ROOT 在模块顶层固化):
// rootFor/memoryForIdentity 会写 $DSH_HOME/...,测试绝不能碰真实环境。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-home-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = testHome;
process.on('exit', () => {
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

const { apply, searchUserMemory } = await import('./index.js');
const { memoryForIdentity } = await import('../feishu-principal/index.js');

const A = `ou_${'a'.repeat(32)}`;
const B = `ou_${'b'.repeat(32)}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

test('Feishu memory is private, searchable, readable, and writable per user', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-user-memory-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true }));
  const tools = new Map();
  const sections = [];
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: (definition) => { sections.push(definition); return () => {}; } }, effect: (setup) => setup() }, { workspaceRoot });
  const exec = (openId) => ({ agent: { larkUser: { openId }, identity: { channel: 'feishu', agentId: 'agent-a', appId: 'cli_test', subjectId: openId, userId: openId.startsWith('u_') ? openId : `u_test_${openId.slice(-8)}` } } });
  const write = await tools.get('memory_write').execute({ topic: 'preferences', keywords: '用户偏好 输出格式', entry: `- [${today}] 用户偏好简洁的中文表格。` }, exec(A));
  assert.equal(write.written, true);
  assert.equal(write.line, 2);
  const duplicate = await tools.get('memory_write').execute({ topic: 'preferences', keywords: '用户偏好', entry: `- [${today}] 用户偏好简洁的中文表格。` }, exec(A));
  assert.equal(duplicate.duplicate, true);
  const hit = await tools.get('memory_search').execute({ query: '表格' }, exec(A));
  assert.equal(hit.results[0].path, 'topics/preferences.md');
  assert.equal(hit.results[0].line, 2);
  const read = await tools.get('memory_read').execute({ path: hit.results[0].path, offset: 2, limit: 1 }, exec(A));
  assert.match(read.text, /简洁的中文表格/);
  const other = await tools.get('memory_search').execute({ query: '表格' }, exec(B));
  assert.equal(other.results.length, 0);
  assert.equal(other.scanned.entries, 0);
  await assert.rejects(tools.get('memory_read').execute({ path: '../preferences.md' }, exec(B)), /只能读取当前用户/);
  await assert.rejects(tools.get('memory_read').execute({ path: '/etc/passwd' }, exec(A)), /只能读取当前用户/);
  await tools.get('memory_write').execute({ topic: 'preferences', keywords: '用户偏好', entry: `- [${today}] 用户偏好先给结论。`, mode: 'replace', line: 2 }, exec(A));
  const memRootA = memoryForIdentity({ userId: `u_test_${A.slice(-8)}`, agentId: 'agent-a' });
  assert.equal(searchUserMemory(memRootA, '先给结论').totalHits, 1);
  assert.equal(searchUserMemory(memRootA, '简洁的中文表格').totalHits, 0);
  const carrier = (openId) => ({ agent: { larkUser: { openId }, identity: { channel: 'feishu', agentId: 'agent-a', appId: 'cli_test', subjectId: openId, userId: openId.startsWith('u_') ? openId : `u_test_${openId.slice(-8)}` } } });
  assert.match(sections[0].text(carrier(A)), /preferences/);
  assert.doesNotMatch(sections[0].text(carrier(B)), /先给结论/);
});

test('Feishu memory rejects secrets, malformed entries and missing identity', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-user-memory-guard-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true }));
  const tools = new Map();
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: () => () => {} }, effect: (setup) => setup() }, { workspaceRoot });
  const exec = { agent: { larkUser: { openId: A }, identity: { channel: 'feishu', agentId: 'agent-secrets', appId: 'cli_test', subjectId: A, userId: 'u_secrets_audit' } } };
  await assert.rejects(tools.get('memory_write').execute({ topic: 'preferences', keywords: '凭据', entry: `- [${today}] apiKey=abcdefghijklmnop` }, exec), /凭据/);
  await assert.rejects(tools.get('memory_write').execute({ topic: 'preferences', keywords: '格式', entry: '没有日期格式' }, exec), /记忆格式/);
  await assert.rejects(tools.get('memory_search').execute({ query: '偏好' }, { agent: {} }), /可信用户身份/);
  // 拒绝写入只留审计痕迹,绝不落记忆内容:.dsh/memory 下无 topics、至多 audit.log
  const deniedRoot = memoryForIdentity({ userId: 'u_secrets_audit', agentId: 'agent-secrets' });
  if (fs.existsSync(deniedRoot)) {
    const inside = fs.readdirSync(deniedRoot);
    assert.ok(inside.every((name) => name === 'audit.log' || name === 'topics'), `unexpected file: ${inside.join(',')}`);
    if (inside.includes('topics')) assert.equal(fs.readdirSync(path.join(deniedRoot, 'topics')).length, 0);
  }
});

test('denied memory_write leaves a reason in audit.log', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-user-memory-deny-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true }));
  const tools = new Map();
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: () => () => {} }, effect: (setup) => setup() }, { workspaceRoot });
  const exec = { agent: { larkUser: { openId: A }, identity: { channel: 'feishu', agentId: 'agent-deny', appId: 'cli_test', subjectId: A, userId: 'u_deny_audit' } } };
  await assert.rejects(tools.get('memory_write').execute({ topic: 'preferences', keywords: '格式', entry: '没有日期格式' }, exec), /记忆格式/);
  const userRoot = memoryForIdentity({ userId: 'u_deny_audit', agentId: 'agent-deny' });
  assert.ok(fs.existsSync(userRoot), 'user memory root created by denial audit');
  const audit = fs.readFileSync(path.join(userRoot, 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].mode, 'denied');
  assert.match(audit[0].reason, /记忆格式/);
  assert.equal(audit[0].topic, 'preferences');
  assert.ok(!fs.existsSync(path.join(userRoot, 'topics')) || fs.readdirSync(path.join(userRoot, 'topics')).length === 0, 'no topic file written on denial');
});

test('memory identity reads agent.identity first and falls back to larkUser', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-identity-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true }));
  const tools = new Map();
  const sections = [];
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: (definition) => { sections.push(definition); return () => {}; } }, effect: (setup) => setup() }, { workspaceRoot });
  const identity = { channel: 'feishu', agentId: 'agent-a', appId: 'cli_test', subjectId: A, userId: 'u_identity_track' };
  const write = await tools.get('memory_write').execute({ topic: 'preferences', keywords: '身份双读', entry: `- [${today}] identity 载体写入。` }, { agent: { identity } });
  assert.equal(write.written, true);
  // 只有 identity 载体也能检索回来(基座化新链路)
  const hit = await tools.get('memory_search').execute({ query: '载体' }, { agent: { identity } });
  assert.equal(hit.results.length, 1);
  assert.match(hit.results[0].text, /identity 载体/);
  // prompt 装载同样双读:identity 载体可见
  assert.match(sections[0].text({ agent: { identity } }), /preferences/);
  // larkUser 旧载体且无 agentId 簇 → fail-closed 拒绝(2026-11-02 收敛:记忆必须走簇身份)
  await assert.rejects(tools.get('memory_search').execute({ query: '载体' }, { agent: { larkUser: { openId: A } } }), /身份簇/);
});

test('Weixin-channel users get an independent memory archive via channel-neutral identity', async (t) => {
  const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-wechat-'));
  t.after(() => fs.rmSync(agentsRoot, { recursive: true }));
  const tools = new Map();
  const sections = [];
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: (definition) => { sections.push(definition); return () => {}; } }, effect: (setup) => setup() }, { agentsRoot });
  const exec = (subjectId) => ({
    agent: {
      identity: {
        channel: 'wechat',
        agentId: 'gtjs',
        appId: 'wxbot-1',
        subjectId,
        userId: `u_wx_${subjectId.split('@')[0]}`,
        context: { chatId: subjectId, accountId: 'main' },
      },
    },
  });
  // 微信侧新用户首见:可写可读,档案在用户中心 users/<userId>/<agentId>/memory(围栏外)
  const write = await tools.get('memory_write').execute({ topic: 'preferences', keywords: '微信 用户偏好', entry: `- [${today}] 微信新用户首次写入。` }, exec('friend@im'));
  assert.equal(write.written, true);
  const hit = await tools.get('memory_search').execute({ query: '微信' }, exec('friend@im'));
  assert.equal(hit.results.length, 1);
  assert.match(hit.results[0].text, /微信新用户/);
  const memRoot = memoryForIdentity({ userId: 'u_wx_friend', agentId: 'gtjs' });
  assert.ok(fs.existsSync(path.join(memRoot, 'topics', 'preferences.md')));
  // 渠道隔离:飞书用户(即便同 subjectId 文本)读不到微信档案
  const feishuExec = { agent: { identity: { channel: 'feishu', agentId: 'gtjs', subjectId: A, userId: 'u_feishu_a', appId: 'cli_x' } } };
  const cross = await tools.get('memory_search').execute({ query: '微信新用户' }, feishuExec);
  assert.equal(cross.results.length, 0);
  // 微信身份缺 userId 拒绝(fail-closed)
  await assert.rejects(
    tools.get('memory_search').execute({ query: 'x' }, { agent: { identity: { channel: 'wechat', agentId: 'gtjs', subjectId: 'ghost@im' } } }),
    /userId/,
  );
  // 无身份拒绝
  await assert.rejects(tools.get('memory_search').execute({ query: 'x' }, {}), /身份/);
  // prompt 装载同样按渠道分流
  assert.match(sections[0].text(exec('friend@im')), /preferences/);
});
