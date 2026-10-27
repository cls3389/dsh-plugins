#!/usr/bin/env node
/**
 * serve-docs.mjs — 本地托管 docs/ 目录(市场索引静态服务)。
 * 监听 0.0.0.0:18731,默认返回 index.json;供本机 dsh 宿主与
 * browser-gateway 容器测试「发现」页使用。发布到 GitHub Pages 后可停掉。
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT ?? 18731);

const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
  const file = rel === '' ? join(root, 'index.json') : join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = readFileSync(statSync(file).isFile() ? file : join(root, 'index.json'));
    res.writeHead(200, {
      'content-type': file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[serve-docs] ${root} → http://0.0.0.0:${PORT}/ (fallback: index.json)`);
});
