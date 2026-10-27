#!/usr/bin/env node
/**
 * validate.mjs — 用 dsh 官方 format-1 校验器验证 docs/index.json。
 * 依赖宿主已安装 @deepseek-ai/dsh（校验器从其 node_modules 解析）。
 * 用法: node scripts/validate.mjs [索引URL]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexUrl = process.argv[2] ?? 'https://dsh-friends.github.io/dsh-plugins/index.json';

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const require = createRequire(pathToFileURL(join(dshRoot, "package.json")).href);
const { parseMarketIndex, marketInstallTarget } = require('@deepseek-ai/dsh-plugin-market-index');

const raw = JSON.parse(readFileSync(join(root, 'docs', 'index.json'), 'utf8'));
try {
  const index = parseMarketIndex(raw, indexUrl);
  console.log(`✓ 索引格式校验通过 (${indexUrl})`);
  console.log(`  市场: ${index.title[Object.keys(index.title).includes('zh') ? 'zh' : 'en']}`);
  for (const p of index.plugins) {
    for (const v of p.versions) {
      const target = marketInstallTarget(p.name, v);
      console.log(`  - ${p.name}@${v.version}`);
      console.log(`      install: ${target.spec}${target.registry ? ` (registry ${target.registry})` : ''}`);
    }
  }
} catch (error) {
  console.error(`✗ 索引校验失败: ${error.message}`);
  process.exit(1);
}
