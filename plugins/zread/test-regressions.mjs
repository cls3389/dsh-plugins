import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ZreadHttpClient,
  apply,
  cleanUpstreamText,
  formatToolResult,
  parseMcpMessages,
  readCredentialRef,
  resolveApiKey,
} from './main.js';

const config = {
  url: 'https://example.test/mcp',
  apiKeyRef: 'Z_AI_API_KEY',
  requestTimeoutMs: 1000,
  maxResponseBytes: 1024 * 1024,
  cacheTtlMs: 300000,
  cacheMaxEntries: 100,
};

function sse(body, sessionId) {
  return new Response(`event:message\ndata:${JSON.stringify(body)}\n\n`, {
    headers: {
      'content-type': 'text/event-stream;charset=UTF-8',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
  });
}

function initialize(id, sessionId = 'session-1') {
  return sse({
    jsonrpc: '2.0', id,
    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'zread', version: '1' } },
  }, sessionId);
}

function toolResult(id, text) {
  return sse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
}

test('parses JSON and SSE MCP responses', () => {
  assert.deepEqual(parseMcpMessages('{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json'), [
    { jsonrpc: '2.0', id: 1, result: {} },
  ]);
  assert.deepEqual(parseMcpMessages('id:1\nevent:message\ndata:{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n', 'text/event-stream'), [
    { jsonrpc: '2.0', id: 2, result: { ok: true } },
  ]);
  assert.deepEqual(parseMcpMessages('', 'application/json'), []);
});

test('formats text results and surfaces tool errors', () => {
  assert.equal(formatToolResult({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.throws(() => formatToolResult({ isError: true, content: [{ type: 'text', text: 'bad input' }] }), /bad input/);
});

test('decodes JSON text and removes upstream presentation wrappers', () => {
  const wrapped = JSON.stringify('File content for package.json\nSource: https://example.test\n\n<file_content>\n{"name":"demo"}\n</file_content>');
  assert.equal(cleanUpstreamText(wrapped), 'File content for package.json\nSource: https://example.test\n\n{"name":"demo"}');
  assert.equal(cleanUpstreamText(JSON.stringify('<excerpt>first</excerpt>\n\n<excerpt>second</excerpt>')), 'first\n\nsecond');
  assert.equal(cleanUpstreamText('plain text'), 'plain text');
});

test('reads credential file fallback', async () => {
  const base = await mkdtemp(join(tmpdir(), 'zread-test-'));
  try {
    await writeFile(join(base, '.credentials.yaml'), 'refs:\n  Z_AI_API_KEY: "file-secret"\nversion: 1\n');
    assert.equal(await readCredentialRef('Z_AI_API_KEY', base), 'file-secret');
    assert.equal(await readCredentialRef('MISSING', base), undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('credentials service takes precedence', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: 'service-secret' }) }) };
  assert.equal(await resolveApiKey(ctx, 'Z_AI_API_KEY'), 'service-secret');
});

test('initializes once, calls tools, and reuses the session', async () => {
  const responses = [
    initialize(1), new Response('', { status: 200 }), toolResult(2, 'first'), toolResult(3, 'second'),
  ];
  const calls = [];
  const client = new ZreadHttpClient(config, async () => 'test-secret', async (url, init) => {
    calls.push({ url, init });
    assert.equal(responses.length > 0, true, 'unexpected HTTP request');
    return responses.shift();
  });
  assert.equal(await client.callTool('search_doc', { repo_name: 'vitejs/vite', query: 'config' }), 'first');
  assert.equal(await client.callTool('read_file', { repo_name: 'vitejs/vite', file_path: 'README.md' }), 'second');
  assert.equal(calls.length, 4);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-secret');
  assert.equal(calls[2].init.headers['Mcp-Session-Id'], 'session-1');
  assert.equal(calls[2].init.headers['MCP-Protocol-Version'], '2024-11-05');
  assert.equal(calls[3].init.headers['Mcp-Session-Id'], 'session-1');
});

test('caches successful results using stable argument ordering', async () => {
  const responses = [initialize(1), new Response('', { status: 200 }), toolResult(2, 'cached')];
  let httpCalls = 0;
  const client = new ZreadHttpClient(config, async () => 'test-secret', async () => {
    httpCalls++;
    return responses.shift();
  });
  const args = { repo_name: 'vitejs/vite', file_path: 'package.json' };
  assert.equal(await client.callTool('read_file', args), 'cached');
  assert.equal(await client.callTool('read_file', { file_path: 'package.json', repo_name: 'vitejs/vite' }), 'cached');
  assert.equal(httpCalls, 3);
});

test('coalesces concurrent identical requests', async () => {
  let releaseTool;
  const gate = new Promise((resolve) => { releaseTool = resolve; });
  let toolCalls = 0;
  const client = new ZreadHttpClient(config, async () => 'test-secret', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return initialize(body.id);
    if (body.method === 'notifications/initialized') return new Response('', { status: 200 });
    toolCalls++;
    await gate;
    return toolResult(body.id, 'shared');
  });
  const first = client.callTool('read_file', { repo_name: 'vitejs/vite', file_path: 'package.json' });
  const second = client.callTool('read_file', { repo_name: 'vitejs/vite', file_path: 'package.json' });
  while (toolCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  releaseTool();
  assert.deepEqual(await Promise.all([first, second]), ['shared', 'shared']);
  assert.equal(toolCalls, 1);
});

test('renews an expired session once', async () => {
  const responses = [
    initialize(1), new Response('', { status: 200 }),
    new Response('gone', { status: 404 }),
    initialize(3, 'session-2'), new Response('', { status: 200 }), toolResult(4, 'recovered'),
  ];
  const client = new ZreadHttpClient(config, async () => 'test-secret', async () => responses.shift());
  assert.equal(await client.callTool('get_repo_structure', { repo_name: 'vitejs/vite' }), 'recovered');
  assert.equal(client.session.id, 'session-2');
});

test('apply registers exactly three native DSH tools', () => {
  const tools = [];
  const ctx = {
    get: () => undefined,
    tools: { register: (tool) => tools.push(tool) },
    effect: () => () => {},
  };
  apply(ctx, {});
  assert.deepEqual(tools.map((tool) => tool.name), [
    'zread_search_doc', 'zread_get_repo_structure', 'zread_read_file',
  ]);
});
