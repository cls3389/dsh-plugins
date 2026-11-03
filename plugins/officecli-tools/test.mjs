import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apply } from './index.js';

async function setup(overrides = {}, wsDir) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'officecli-tools-'));
  const binary = path.join(root, 'fake-officecli.mjs');
  await writeFile(binary, `#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.OFFICECLI_ARGS_FILE, JSON.stringify(args) + '\\n');
if (process.env.OFFICECLI_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.OFFICECLI_SLEEP_MS)));
if (process.env.OFFICECLI_STDERR) process.stderr.write(process.env.OFFICECLI_STDERR);
if (process.env.OFFICECLI_STDOUT) process.stdout.write(process.env.OFFICECLI_STDOUT);
const oIdx = args.indexOf('-o');
if (oIdx !== -1 && process.env.OFFICECLI_OUTPUT_CONTENT !== undefined) {
  await writeFile(args[oIdx + 1], process.env.OFFICECLI_OUTPUT_CONTENT);
}
process.exit(Number(process.env.OFFICECLI_EXIT || 0));
`, 'utf8');
  await chmod(binary, 0o755);
  const argsFile = path.join(root, 'args.jsonl');
  const previousEnv = new Map();
  for (const key of ['OFFICECLI_ARGS_FILE', 'OFFICECLI_SLEEP_MS', 'OFFICECLI_STDERR', 'OFFICECLI_STDOUT', 'OFFICECLI_OUTPUT_CONTENT', 'OFFICECLI_EXIT']) previousEnv.set(key, process.env[key]);
  Object.assign(process.env, { OFFICECLI_ARGS_FILE: argsFile });
  const ctx = {
    tools: { register(def) { this.registry ??= new Map(); this.registry.set(def.name, def); } },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'attachments') return { async saveImage(input) { this.last = input; return { attachmentId: 'img-1' }; } };
      if (name === 'workingDirectory') return { get: (session) => (session === 'sess-friend' ? wsDir : undefined) };
      return undefined;
    },
  };
  apply(ctx, { binary, allowedPathPrefixes: [root], requestTimeoutMs: 200, maxOutputChars: 100, gateway: { enabled: false }, ...overrides });
  return { root, binary, argsFile, ctx, async cleanup() { for (const [key, value] of previousEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); } };
}

async function officeFile(root, name = 'document.docx') {
  const file = path.join(root, name);
  await writeFile(file, 'fixture');
  return file;
}

async function argsOf(argsFile) {
  const text = await readFile(argsFile, 'utf8');
  return JSON.parse(text.trim().split('\n').at(-1));
}

test('registers four tools and schemas', async () => {
  const s = await setup();
  try {
    assert.deepEqual([...s.ctx.tools.registry.keys()], ['office_create', 'office_view', 'office_edit', 'office_validate']);
    assert.deepEqual(s.ctx.tools.registry.get('office_view').parameters.properties.mode.enum, ['outline', 'text', 'annotated', 'stats', 'issues', 'html', 'screenshot', 'svg', 'pdf']);
    assert.deepEqual(s.ctx.tools.registry.get('office_edit').parameters.properties.operation.enum, ['add', 'set', 'remove', 'move', 'swap', 'batch']);
    const rendered = s.ctx.tools.registry.get('office_create').output.render({}, { status: 'ok', output: 'x' });
    assert.equal(rendered.length, 1);
    assert.deepEqual(JSON.parse(rendered[0].text), { status: 'ok', output: 'x' });
  } finally { await s.cleanup(); }
});

test('create passes structured arguments and json flag', async () => {
  const s = await setup();
  try {
    const file = path.join(s.root, 'new.docx');
    const tool = s.ctx.tools.registry.get('office_create');
    const result = await tool.execute({ file_path: file, locale: 'zh-CN', minimal: true });
    assert.equal(result.status, 'ok');
    assert.deepEqual(await argsOf(s.argsFile), ['create', file, '--locale', 'zh-CN', '--minimal', '--json']);
  } finally { await s.cleanup(); }
});

test('view passes mode, output and page and attaches png (direct mode)', async () => {
  const s = await setup();
  try {
    const file = await officeFile(s.root);
    const out = path.join(s.root, 'preview.png');
    process.env.OFFICECLI_OUTPUT_CONTENT = 'png';
    const tool = s.ctx.tools.registry.get('office_view');
    const result = await tool.execute({ file_path: file, mode: 'screenshot', output_path: out, page: 2 });
    assert.equal(result.status, 'ok');
    assert.equal(result.output_path, out);
    assert.equal(result.bytes, 3);
    assert.deepEqual(await argsOf(s.argsFile), ['view', file, 'screenshot', '-o', out, '--page', '2', '--json']);
    assert.deepEqual(result.attachment, { attachmentId: 'img-1' });
    const blocks = tool.output.render({}, result);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].type, 'image');
  } finally { await s.cleanup(); }
});

test('screenshot goes through browser-gateway with inline html', async () => {
  const captured = { auth: null, body: null };
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured.auth = req.headers.authorization;
      captured.body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(fakePng);
    });
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const s = await setup({ gateway: { enabled: true, baseUrl: `http://127.0.0.1:${gateway.address().port}`, apiToken: 'unit-token', requestTimeoutMs: 2000 } });
  try {
    const file = await officeFile(s.root);
    const out = path.join(s.root, 'shot.png');
    process.env.OFFICECLI_OUTPUT_CONTENT = '<html><body>rendered deck</body></html>';
    const tool = s.ctx.tools.registry.get('office_view');
    const result = await tool.execute({ file_path: file, mode: 'screenshot', output_path: out, page: 1, viewport: { width: 640, height: 480 }, device_scale_factor: 2 });
    assert.equal(result.status, 'ok');
    assert.equal(result.renderer, 'browser-gateway');
    assert.equal(result.bytes, fakePng.length);
    assert.deepEqual(await readFile(out), fakePng);
    assert.equal(captured.auth, 'Bearer unit-token');
    assert.equal(captured.body.html, '<html><body>rendered deck</body></html>');
    assert.equal(captured.body.full_page, true);
    assert.equal(captured.body.image_format, 'png');
    assert.deepEqual(captured.body.viewport, { width: 640, height: 480 });
    assert.equal(captured.body.device_scale_factor, 2);
    // 先渲染 HTML(带 --page),临时文件用完即删。
    assert.deepEqual(await argsOf(s.argsFile), ['view', file, 'html', '-o', `${out}.render.html`, '--page', '1', '--json']);
    assert.equal(await fsExists(`${out}.render.html`), false);
    const blocks = tool.output.render({}, result);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].type, 'image');
  } finally {
    await s.cleanup();
    gateway.close();
  }
});

test('screenshot via gateway reports structured failure when gateway is down', async () => {
  const s = await setup({ gateway: { enabled: true, baseUrl: 'http://127.0.0.1:1', apiToken: 'unit-token', requestTimeoutMs: 500 } });
  try {
    const file = await officeFile(s.root);
    process.env.OFFICECLI_OUTPUT_CONTENT = '<html></html>';
    const tool = s.ctx.tools.registry.get('office_view');
    const result = await tool.execute({ file_path: file, mode: 'screenshot', output_path: path.join(s.root, 'x.png') });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'screenshot_gateway_failed');
  } finally { await s.cleanup(); }
});

async function fsExists(p) {
  try { await readFile(p); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('workspaceFence restricts paths to the calling session workspace', async () => {
  const wsDir = await mkdtemp(path.join(os.tmpdir(), 'officecli-ws-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'officecli-out-'));
  const s = await setup({ workspaceFence: true }, wsDir);
  try {
    const exec = { agent: { session: 'sess-friend' } };
    const tool = s.ctx.tools.registry.get('office_create');
    // 工作区内允许。
    const inside = await tool.execute({ file_path: path.join(wsDir, 'ok.docx') }, exec);
    assert.equal(inside.status, 'ok');
    // 工作区外拒绝,即便在静态前缀(root)内。
    const blocked = await tool.execute({ file_path: path.join(outside, 'evil.docx') }, exec);
    assert.equal(blocked.status, 'error');
    assert.match(blocked.error, /前缀/);
    assert.equal(await fsExists(path.join(outside, 'evil.docx')), false);
    // 拿不到会话工作区时 fail-closed。
    const noSession = await tool.execute({ file_path: path.join(wsDir, 'x.docx') }, undefined);
    assert.equal(noSession.status, 'error');
    assert.match(noSession.error, /会话工作区/);
    // office_view 读同样受限。
    await writeFile(path.join(outside, 'secret.docx'), 'x');
    const leaked = await s.ctx.tools.registry.get('office_view').execute({ file_path: path.join(outside, 'secret.docx') }, exec);
    assert.equal(leaked.status, 'error');
  } finally {
    await s.cleanup();
    await rm(outside, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test('edit operations and props are passed without shell interpolation', async () => {
  const s = await setup();
  try {
    const file = await officeFile(s.root);
    const tool = s.ctx.tools.registry.get('office_edit');
    await tool.execute({ file_path: file, operation: 'add', parent: '/body', type: 'paragraph', props: { text: 'a;$(touch /tmp/pwned)', bold: true }, index: 1 });
    assert.deepEqual(await argsOf(s.argsFile), ['add', file, '/body', '--type', 'paragraph', '--prop', 'text=a;$(touch /tmp/pwned)', '--prop', 'bold=true', '--index', '1', '--json']);
    const bad = await tool.execute({ file_path: file, operation: 'set' });
    assert.equal(bad.status, 'error');
  } finally { await s.cleanup(); }
});

test('batch limits and path safety are enforced', async () => {
  const s = await setup();
  try {
    const file = await officeFile(s.root);
    const tool = s.ctx.tools.registry.get('office_edit');
    assert.equal((await tool.execute({ file_path: file, operation: 'batch', commands: Array.from({ length: 201 }, () => ({ op: 'get' })) })).code, 'invalid_input');
    assert.equal((await tool.execute({ file_path: file, operation: 'batch', commands: [{ op: 'set', props: 'x'.repeat(1_000_001) }] })).code, 'invalid_input');
    assert.equal((await tool.execute({ file_path: path.join(s.root, '..', path.basename(s.root), 'document.docx'), operation: 'set', path: '/' })).status, 'ok');
    assert.equal((await tool.execute({ file_path: 'relative.docx', operation: 'set', path: '/' })).code, 'invalid_input');
    assert.equal((await tool.execute({ file_path: path.join(s.root, 'document.txt'), operation: 'set', path: '/' })).code, 'invalid_input');
  } finally { await s.cleanup(); }
});

test('json, stderr, failure and timeout are structured', async () => {
  const s = await setup();
  try {
    const file = await officeFile(s.root);
    const tool = s.ctx.tools.registry.get('office_validate');
    process.env.OFFICECLI_STDOUT = JSON.stringify({ success: false, error: { code: 'file_not_found' } });
    process.env.OFFICECLI_STDERR = 'diagnostic';
    process.env.OFFICECLI_EXIT = '1';
    const failed = await tool.execute({ file_path: file });
    assert.equal(failed.status, 'error');
    assert.equal(failed.code, 'file_not_found');
    assert.equal(failed.exitCode, 1);
    assert.deepEqual(failed.data, { success: false, error: { code: 'file_not_found' } });
    assert.match(failed.error, /diagnostic/);
    process.env.OFFICECLI_STDOUT = '';
    process.env.OFFICECLI_STDERR = 'slow';
    process.env.OFFICECLI_EXIT = '0';
    process.env.OFFICECLI_SLEEP_MS = '1000';
    const timed = await tool.execute({ file_path: file });
    assert.equal(timed.status, 'error');
    assert.equal(timed.code, 'timeout');
  } finally { await s.cleanup(); }
});

test('exit code 2 with success envelope lands as ok with warnings', async () => {
  const s = await setup();
  try {
    const file = await officeFile(s.root);
    const tool = s.ctx.tools.registry.get('office_edit');
    process.env.OFFICECLI_STDOUT = JSON.stringify({ success: true, data: 'Added row at /Sheet1/row[1]', warnings: [{ code: 'unsupported_property' }] });
    process.env.OFFICECLI_STDERR = '';
    process.env.OFFICECLI_EXIT = '2';
    const warned = await tool.execute({ file_path: file, operation: 'add', parent: '/body', type: 'paragraph' });
    assert.equal(warned.status, 'ok');
    assert.deepEqual(warned.data.warnings, [{ code: 'unsupported_property' }]);
    const rendered = tool.output.render({}, warned);
    assert.equal(rendered.length, 1);
  } finally { await s.cleanup(); }
});
