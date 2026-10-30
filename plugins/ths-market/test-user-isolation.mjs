import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWatchEngine } from './index.js';

// 隔离 DSH_HOME:identityOf → userKey 会经 resolveIdentity 读写 $DSH_HOME/identities.json,
// 测试绝不能碰真实环境(进程级 mkdtemp,退出清理)。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-home-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = testHome;
process.on('exit', () => {
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

function fixture(t, users = { ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { trading: { baseUrl: 'http://127.0.0.1:1', apiKey: 'a' } } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-users-'));
  const usersFile = path.join(dir, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify(users));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const ctx = {
    logger: { info() {}, warn() {} },
    sessionQuery: { listSessions: async () => [] },
    get: () => undefined,
  };
  return createWatchEngine(ctx, { usersFile, watchEnabled: false, watchRulesFile: path.join(dir, 'rules.json') }, { xd: null });
}

const agent = (openId, session) => ({ larkUser: { openId }, session: { header: { id: session } } });
// 基座化双载体:仅 identity(无 larkUser)的 agent 也必须完成同一套所有者隔离。
const identityAgent = (openId, session) => ({ identity: { channel: 'feishu', subjectId: openId }, session: { header: { id: session } } });

test('watch rules, ledgers, and removal are private to their owner', (t) => {
  const engine = fixture(t);
  const a = engine.addRule({ code: '600000', type: 'price_above', threshold: 10 }, agent('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session-a'));
  engine.addRule({ code: '600000', type: 'price_above', threshold: 11 }, agent('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'session-b'));
  assert.deepEqual(engine.status('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').rules.map((rule) => rule.id), [a.id]);
  assert.equal(engine.status('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').rules.length, 1);
  assert.equal(engine.removeRule(a.id, 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), null);
  assert.equal(engine.removeRule(a.id, 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').id, a.id);
});

test('identity-only agents get the same owner isolation as larkUser agents (dual-read)', (t) => {
  const engine = fixture(t);
  const a = engine.addRule({ code: '600000', type: 'price_above', threshold: 10 }, identityAgent('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session-a'));
  engine.addRule({ code: '600000', type: 'price_above', threshold: 11 }, identityAgent('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'session-b'));
  // owner 快照来自 identityOf(subjectId 双读)
  assert.equal(a.ownerOpenId, 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(engine.status('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').rules.map((rule) => rule.id), [a.id]);
  assert.equal(engine.status('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').rules.length, 1);
  // 所有者校验:他人删不掉
  assert.equal(engine.removeRule(a.id, 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), null);
  assert.equal(engine.removeRule(a.id, 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').id, a.id);
});

test('monitor status hides trading limits unless the current user has a trading connection', (t) => {
  const engine = fixture(t);
  const monitor = engine.status('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(monitor.engine, '行情监控引擎');
  assert.equal(monitor.mode, 'market_monitor');
  assert.equal(monitor.canTrade, false);
  assert.equal(Object.hasOwn(monitor, 'autoTradeGuardrails'), false);
  const trader = engine.status('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(trader.mode, 'monitor_and_conditional_orders');
  assert.equal(trader.canTrade, true);
  assert.ok(trader.autoTradeGuardrails);
});

test('owner-only execution never falls back to a shared trading account', async (t) => {
  const engine = fixture(t);
  const a = engine.addRule({ code: '600000', type: 'price_above', threshold: 10, action: { side: 'sell', quantity: 100 } }, agent('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session-a'));
  engine.testEvaluate('600000', { price: 20, preClose: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Port 1 rejects locally. No shared account is available as a fallback.
  assert.equal(engine.status('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').ledger[0].status, 'blocked');
  assert.equal(engine.status('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').ledger.length, 0);
});

test('a user without a trading connection is blocked before any account call', async (t) => {
  const engine = fixture(t, {});
  engine.addRule({ code: '600000', type: 'price_above', threshold: 10, action: { side: 'buy', quantity: 100 } }, agent('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'session-b'));
  engine.testEvaluate('600000', { price: 20, preClose: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  const entry = engine.status('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').ledger[0];
  assert.equal(entry.status, 'blocked');
  assert.match(entry.reason, /尚未配置/);
});
