#!/usr/bin/env node
/**
 * serve-docs.mjs — 本地插件市场三合一服务(实测用,GitHub Pages 发布后可停):
 *
 *   端口 18731:
 *     /index.json | /index-local.json   docs/ 静态索引
 *     /tarballs/<file>.tgz              插件 tarball
 *     /@scope%2fname | /@scope/name     最小 npm registry packument
 *     /(其它路径)                       回退 index.json
 *
 *   端口 18732(--gui-proxy 开启):
 *     全路径明文反代 127.0.0.1:3080(Web GUI,含 WebSocket upgrade)。
 *     自签证书环境下给 browser-gateway 的 Playwright 浏览器提供 http 入口。
 *
 * 用法: node scripts/serve-docs.mjs [--gui-proxy]
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'docs');
const tarballDir = join(root, 'tarballs');
const PORT = Number(process.env.PORT ?? 18731);
const GUI_PORT = Number(process.env.GUI_PORT ?? 18732);
const GUI_PROXY = process.env.GUI_PROXY === '1' || process.argv.includes('--gui-proxy');
const GUI_UPSTREAM = { host: '127.0.0.1', port: 3080 };

// ── registry:预先扫描 tarballs/ 构建 packument ──
function readTarManifest(tgzBytes) {
  const raw = gunzipSync(tgzBytes);
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const dataStart = offset + 512;
    if (name === 'package/package.json') {
      const manifest = JSON.parse(raw.toString('utf8', dataStart, dataStart + size));
      return { name: manifest.name, version: manifest.version };
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

const packuments = new Map(); // name -> packument string
for (const file of readdirSync(tarballDir)) {
  if (!file.endsWith('.tgz')) continue;
  const bytes = readFileSync(join(tarballDir, file));
  const manifest = readTarManifest(bytes);
  if (manifest === undefined) continue;
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const doc = packuments.has(manifest.name) ? JSON.parse(packuments.get(manifest.name)) : { name: manifest.name, 'dist-tags': {}, versions: {} };
  doc['dist-tags'].latest = manifest.version;
  doc.versions[manifest.version] = {
    name: manifest.name,
    version: manifest.version,
    dist: { tarball: `http://127.0.0.1:${PORT}/tarballs/${file}`, integrity },
  };
  packuments.set(manifest.name, JSON.stringify(doc));
}

const mimeOf = (file) => (file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');

const main = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // npm packument:/@scope/name 或 /@scope%2fname(pnpm 两种都会用)
  const packumentMatch = url.match(/^\/(@[^/]+)(?:\/|%2F)(.+)$/i);
  if (packumentMatch !== null) {
    const name = `${packumentMatch[1]}/${packumentMatch[2]}`;
    const doc = packuments.get(name);
    if (doc !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(doc);
      return;
    }
  }
  // 静态:tarballs/ 与 docs/(回退 index.json)
  const isTarball = url.startsWith('/tarballs/');
  const staticRoot = isTarball ? tarballDir : docsDir;
  const rel = normalize(url.replace(/^\/tarballs\//, '').replace(/^\/+/, ''));
  const file = rel === '' ? join(docsDir, 'index.json') : join(staticRoot, rel);
  if (file.startsWith(staticRoot)) {
    try {
      const target = statSync(file).isFile() ? file : join(docsDir, 'index.json');
      res.writeHead(200, { 'content-type': mimeOf(target), 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(readFileSync(target));
      return;
    } catch { /* fall through 404 */ }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`not found: ${url}`);
});

main.listen(PORT, '0.0.0.0', () => {
  console.log(`[serve-docs] docs+registry → http://0.0.0.0:${PORT}/ (${packuments.size} packages: ${[...packuments.keys()].join(', ')})`);
});

// ── GUI 明文反代(含 WebSocket) ──
if (GUI_PROXY) {
  const proxy = createServer((req, res) => {
    const upstream = httpRequest(
      { host: GUI_UPSTREAM.host, port: GUI_UPSTREAM.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${GUI_UPSTREAM.host}:${GUI_UPSTREAM.port}` } },
      (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); },
    );
    upstream.on('error', () => { res.writeHead(502); res.end('gui proxy upstream error'); });
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = tcpConnect(GUI_UPSTREAM.port, GUI_UPSTREAM.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
      lines.push(`host: ${GUI_UPSTREAM.host}:${GUI_UPSTREAM.port}`, '', '');
      upstream.write(lines.join('\r\n'));
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  proxy.listen(GUI_PORT, '0.0.0.0', () => {
    console.log(`[serve-docs] gui proxy → http://0.0.0.0:${GUI_PORT}/ ⇄ http://${GUI_UPSTREAM.host}:${GUI_UPSTREAM.port}/`);
  });
}
