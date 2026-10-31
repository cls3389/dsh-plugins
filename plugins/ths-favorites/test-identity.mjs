import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, storedStockKey } from './index.js';

const stateDir = mkdtempSync(join(tmpdir(), 'ths-fav-web-'));
const tools = new Map();
const ctx = { tools: { register: (def) => tools.set(def.name, def) }, logger: { info() {}, warn() {} } };
apply(ctx, { stateDir, defaultAgentId: 'u_webowner', defaultAppId: 'cli_default' });
assert.equal(tools.size, 12);
// 无身份 Web 调用走 web-owner；构造一个不访问网络的未登录查询，错误信息不应是身份拒绝。
const result = await tools.get('ths_get_self_stocks').execute({}, { agent: {} });
const text = JSON.stringify(result);
assert.ok(!text.includes('无法确认飞书用户身份'), text);
// 有飞书身份时不允许使用 Web 默认登录态；同样未登录，但身份校验通过。
const openId = `ou_${'c'.repeat(32)}`;
const feishuResult = await tools.get('ths_get_self_stocks').execute({}, { agent: { larkUser: { openId, appId: 'cli_other' } } });
assert.ok(!JSON.stringify(feishuResult).includes('无法确认飞书用户身份'));
assert.equal(storedStockKey('01060', 'HK'), storedStockKey('HK1060', '177'));
assert.equal(storedStockKey('1060', '55'), storedStockKey('01060', '55'));
assert.equal(storedStockKey('02689', 'HK'), storedStockKey('HK2689', '177'));
assert.notEqual(storedStockKey('01060', 'HK'), storedStockKey('1060', 'SH'));
console.log('ths-favorites: Web default and Feishu identities route independently; HK deletion matches stored forms');
