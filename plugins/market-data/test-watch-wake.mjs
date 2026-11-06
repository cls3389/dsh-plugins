import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverWatchWake } from './index.js';

const rule = { id: 'w1', ownerOpenId: 'ou_cccccccccccccccccccccccccccccccc', ownerAppId: 'cli_owner', sessionId: 'owner-session' };

test('watch wake uses formal channel reply service with stable event identity', async () => {
  const calls = [];
  const ctx = { get(name) {
    assert.equal(name, 'feishuNotifications');
    return { deliver: async (input) => calls.push(input) };
  } };
  await deliverWatchWake(ctx, {}, rule, 'test alert', 'owner-session', 'event-1');
  assert.deepEqual(calls, [{ sessionId: 'owner-session', ownerOpenId: rule.ownerOpenId, ownerAppId: rule.ownerAppId, text: 'test alert', eventId: 'ths-watch-event-1', immediateAlert: true }]);
});

test('watch wake cannot override rule session or fall back to other live agents', async () => {
  const ctx = { get() { throw new Error('must reject before resolving a service'); } };
  await assert.rejects(() => deliverWatchWake(ctx, {}, rule, 'alert', 'foreign-session', 'e'), /会话与规则归属不一致/);
  await assert.rejects(() => deliverWatchWake(ctx, {}, { ...rule, sessionId: undefined }, 'alert', undefined, 'e'), /缺少归属会话/);
  await assert.rejects(() => deliverWatchWake(ctx, {}, { ...rule, ownerAppId: '' }, 'alert', undefined, 'e'), /用户\/应用归属/);
  await assert.rejects(() => deliverWatchWake(ctx, {}, rule, 'alert', undefined, undefined), /稳定事件 ID/);
});

test('watch wake reports unavailable channel and propagates acceptance failures for retry', async () => {
  await assert.rejects(() => deliverWatchWake({ get() {} }, {}, rule, 'alert', undefined, 'e'), /等待重试/);
  const ctx = { get: () => ({ deliver: async () => { throw new Error('notification state write failed'); } }) };
  await assert.rejects(() => deliverWatchWake(ctx, {}, rule, 'alert', undefined, 'e'), /state write failed/);
});
