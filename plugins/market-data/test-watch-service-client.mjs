import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createWatchServiceClient } from './index.js';

test('watch service client forwards identity and preserves CRUD contract', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST') res.end(JSON.stringify({ rule: { id: 'w1' }, active: { enabled: true, connected: true }, monitoring: true }));
    else if (req.method === 'DELETE') res.end(JSON.stringify({ removed: { id: 'w1' } }));
    else res.end(JSON.stringify({ enabled: true, connected: true, rules: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createWatchServiceClient({ watchServiceBaseUrl: `http://127.0.0.1:${server.address().port}`, watchServiceToken: 'test-token' });
  const agent = { larkUser: { openId: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', appId: 'cli_app' }, session: { header: { id: 'session-1' } } };
  const added = await client.addRule({ code: '600519', type: 'price_above', threshold: 9999 }, agent);
  assert.equal(added.monitoring, true);
  await client.status('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cli_app');
  const removed = await client.removeRule('w1', agent);
  assert.equal(removed.removed.id, 'w1');
  assert.equal(requests[0].headers.authorization, 'Bearer test-token');
  assert.equal(requests[0].headers['x-ths-open-id'], 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(requests[0].headers['x-ths-app-id'], 'cli_app');
  assert.equal(requests[0].headers['x-ths-session-id'], 'session-1');
  assert.deepEqual(requests.map((r) => r.method), ['POST', 'GET', 'DELETE']);
});

test('watch updates patch only editable fields and retain identity', async (t) => {
  let seen;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    seen = { method: req.method, path: req.url, body: JSON.parse(text), headers: req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ rule: { id: 'w1' }, turnStateReset: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createWatchServiceClient({ watchServiceBaseUrl: `http://127.0.0.1:${server.address().port}`, watchServiceToken: 'test-token' });
  await client.updateRule('w1', { note: '[2026-11-03] test', expiresAt: '2026-11-03T15:00:00+08:00' }, { larkUser: { openId: 'ou_' + 'a'.repeat(32), appId: 'cli_test' } });
  assert.equal(seen.method, 'PATCH'); assert.equal(seen.path, '/v1/rules/w1');
  assert.equal(seen.body.note, '[2026-11-03] test'); assert.equal(seen.body.id, undefined);
  assert.equal(seen.headers['x-ths-app-id'], 'cli_test');
});

test('watch service client propagates server error without creating a rule locally', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'big_order disabled' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createWatchServiceClient({ watchServiceBaseUrl: `http://127.0.0.1:${server.address().port}`, watchServiceToken: 'test-token' });
  await assert.rejects(() => client.addRule({ type: 'big_order' }, {}), /big_order disabled/);
});
