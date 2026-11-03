import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectionForExecution, connectionForOpenId } from './user-connections.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-user-connections-'));
  const usersFile = path.join(dir, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify({
    ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
      market: { fqgateBaseUrl: 'http://127.0.0.1:18001', dataCenterBaseUrl: 'http://127.0.0.1:18011' },
      trading: { baseUrl: 'http://127.0.0.1:19001', apiKey: 'a' },
      aiSignal: { baseUrl: 'http://127.0.0.1:19011', webuiToken: 'a', webhookToken: 'a' },
      limits: { maxOrderValue: 1234 },
    },
    ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: {
      trading: { baseUrl: 'http://127.0.0.1:19002', apiKey: 'b' },
      aiSignal: { baseUrl: 'http://127.0.0.1:19012', webuiToken: 'b', webhookToken: 'b' },
    },
  }), { mode: 0o600 });
  return { dir, cfg: { usersFile, xiadanBaseUrl: 'http://legacy', xiadanApiKey: 'legacy' } };
}

test('A/B connections and limits never resolve through the legacy account', (t) => {
  const { dir, cfg } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const a = connectionForOpenId('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cfg, 'trading');
  assert.equal(a.xiadanBaseUrl, 'http://127.0.0.1:19001');
  assert.equal(a.autoTradeMaxOrderValue, 1234);
  assert.equal(connectionForOpenId('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cfg, 'market').fqgateBaseUrl, 'http://127.0.0.1:18001');
  assert.equal(connectionForOpenId('ou_cccccccccccccccccccccccccccccccc', { ...cfg, fqgateBaseUrl: 'http://public' }, 'market').fqgateBaseUrl, 'http://public');
  assert.equal(connectionForOpenId('ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', cfg, 'trading').xiadanBaseUrl, 'http://127.0.0.1:19002');
  assert.equal(connectionForExecution({ agent: { larkUser: { openId: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } }, cfg, 'aiSignal').signalTraderBaseUrl, 'http://127.0.0.1:19011');
});

test('missing identity, configuration, or feature permission fails closed', (t) => {
  const { dir, cfg } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true }));
  assert.throws(() => connectionForOpenId('ou_cccccccccccccccccccccccccccccccc', cfg, 'trading'), /尚未配置/);
  assert.throws(() => connectionForOpenId(undefined, cfg, 'trading'), /可信飞书用户身份/);
  assert.throws(() => connectionForExecution({ agent: {} }, cfg, 'trading'), /缺少用户身份/);
  fs.writeFileSync(cfg.usersFile, JSON.stringify({ ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { features: { trading: false }, trading: { baseUrl: 'http://127.0.0.1:1', apiKey: 'a' } } }));
  assert.throws(() => connectionForOpenId('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cfg, 'trading'), /未开通或未完整配置独立的 xiadan 交易连接.*自选扫码登录不能开通交易功能/);
});
