import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, searchUserMemory } from './index.js';
import { workspaceFor } from '../feishu-principal/index.js';

const A = `ou_${'a'.repeat(32)}`;
const B = `ou_${'b'.repeat(32)}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

test('Feishu memory is private, searchable, readable, and writable per user', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-user-memory-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true }));
  const tools = new Map();
  const sections = [];
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: (definition) => { sections.push(definition); return () => {}; } }, effect: (setup) => setup() }, { workspaceRoot });
  const exec = (openId) => ({ agent: { larkUser: { openId } } });
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
  assert.equal(searchUserMemory(path.join(workspaceFor(workspaceRoot, A), '.dsh', 'memory'), '先给结论').totalHits, 1);
  assert.equal(searchUserMemory(path.join(workspaceFor(workspaceRoot, A), '.dsh', 'memory'), '简洁的中文表格').totalHits, 0);
  assert.match(sections[0].text({ agent: { larkUser: { openId: A } } }), /preferences/);
  assert.doesNotMatch(sections[0].text({ agent: { larkUser: { openId: B } } }), /先给结论/);
});

test('Feishu memory rejects secrets, malformed entries and missing identity', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-user-memory-guard-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true }));
  const tools = new Map();
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, systemPrompt: { section: () => () => {} }, effect: (setup) => setup() }, { workspaceRoot });
  const exec = { agent: { larkUser: { openId: A } } };
  await assert.rejects(tools.get('memory_write').execute({ topic: 'preferences', keywords: '凭据', entry: `- [${today}] apiKey=abcdefghijklmnop` }, exec), /凭据/);
  await assert.rejects(tools.get('memory_write').execute({ topic: 'preferences', keywords: '格式', entry: '没有日期格式' }, exec), /记忆格式/);
  await assert.rejects(tools.get('memory_search').execute({ query: '偏好' }, { agent: {} }), /可信飞书用户身份/);
  // 拒绝写入只留审计痕迹,绝不落记忆内容:.dsh/memory 下无 topics、至多 audit.log
  const deniedRoot = path.join(workspaceFor(workspaceRoot, A), '.dsh', 'memory');
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
  const exec = { agent: { larkUser: { openId: A } } };
  await assert.rejects(tools.get('memory_write').execute({ topic: 'preferences', keywords: '格式', entry: '没有日期格式' }, exec), /记忆格式/);
  const userRoot = path.join(workspaceFor(workspaceRoot, A), '.dsh', 'memory');
  assert.ok(fs.existsSync(userRoot), 'user memory root created by denial audit');
  const audit = fs.readFileSync(path.join(userRoot, 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].mode, 'denied');
  assert.match(audit[0].reason, /记忆格式/);
  assert.equal(audit[0].topic, 'preferences');
  assert.ok(!fs.existsSync(path.join(userRoot, 'topics')) || fs.readdirSync(path.join(userRoot, 'topics')).length === 0, 'no topic file written on denial');
});
