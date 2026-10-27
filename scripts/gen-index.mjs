#!/usr/bin/env node
/**
 * gen-index.mjs — 生成 dsh 插件市场 format-1 索引。
 *
 * 扫描 plugins/ 下每个插件目录:
 *   - package.json: name/version/description/keywords
 *   - locale/zh.json + en.json: meta.title / meta.description 作为市场标题与描述
 *   - git: 用仓库 HEAD 的最新 commit SHA 把 git 源 pin 到精确版本
 * 输出 docs/index.json(静态托管根 = docs/,GitHub Pages 直接指 docs/)。
 *
 * 用法: node scripts/gen-index.mjs [--repo-url https://github.com/<user>/dsh-plugins]
 *       不传 --repo-url 时读 package.json 的 repository.url。
 *   --npm-registry <url>  版本源改为 npm(registry 分发),并附 --with-test 掯针;
 *                         生成 docs/index-local.json 用于本地安装链路实测。
 *   --with-test           把 plugins-test/ 下的探针也纳入索引。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = join(root, 'plugins');
const testPluginsDir = join(root, 'plugins-test');

// ── 参数 ──
const argv = process.argv.slice(2);
const repoFlag = argv.indexOf('--repo-url');
const repoUrlArg = repoFlag >= 0 ? argv[repoFlag + 1] : undefined;
const registryFlag = argv.indexOf('--npm-registry');
const registryArg = registryFlag >= 0 ? argv[registryFlag + 1] : undefined;
const withTest = argv.includes('--with-test');

const outPath = registryArg === undefined
  ? join(root, 'docs', 'index.json')
  : join(root, 'docs', 'index-local.json');

const repoMeta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  .repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
const repoUrl = repoUrlArg ?? repoMeta;
if (repoUrl === undefined || !/^https:\/\/[^/]+\/[^/]+\/[^/]+$/u.test(repoUrl)) {
  console.error('gen-index: 需要 --repo-url https://github.com/<user>/<repo> 或 package.json repository.url');
  process.exit(1);
}

// 当前 commit:仓库里 plugins/ 子目录各自独立的最新提交(子目录级 git log)
function latestCommitFor(relDir) {
  return execSync(`git log -1 --format=%H -- ${JSON.stringify(relDir)}`, { cwd: root, encoding: 'utf8' }).trim();
}

// locale 标题/描述:zh 为主,en 必填(format 要求 en 必须存在)
function localizedMeta(dir) {
  const read = (lang) => {
    try { return JSON.parse(readFileSync(join(dir, 'locale', `${lang}.json`), 'utf8')).meta ?? {}; }
    catch { return {}; }
  };
  const zh = read('zh');
  const en = read('en');
  const build = (field) => {
    const zhText = zh[field] ?? en[field];
    const enText = en[field] ?? zh[field];
    return zhText === undefined ? undefined : { zh: zhText, en: enText ?? zhText };
  };
  return { title: build('title'), description: build('description') };
}

function buildPluginEntry(baseDir, relDir, entryName) {
  const dir = join(baseDir, entryName);
  const manifestPath = join(dir, 'package.json');
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory() || !statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const meta = localizedMeta(dir);
  // npm 模式不写 registry 字段:installBundle 对带 registry 的源会传 --registry=<url>,
  // pnpm 会把 profile 全部依赖(含 @deepseek-ai 官方包)都指到该 registry → 404。
  // 正确做法:scoped registry 走各 profile 的 .npmrc(@dsh-friends:registry=...),
  // 索引里省略 registry → 安装不传 --registry → scope 路由,官方包仍走默认源。
  const source = registryArg === undefined
    ? { type: 'git', url: repoUrl, commit: latestCommitFor(relDir), path: relDir }
    : { type: 'npm' };
  return {
    name: manifest.name,
    ...meta.title === undefined ? {} : { title: meta.title },
    ...meta.description === undefined ? {} : { description: meta.description },
    author: manifest.author ?? 'dsh-friends',
    homepage: manifest.homepage ?? `${repoUrl}#readme`,
    repository: { url: repoUrl, directory: relDir },
    metadata: {
      keywords: manifest.keywords ?? [],
    },
    versions: [{
      version: manifest.version,
      publishTimestamp: Math.floor(statSync(manifestPath).mtimeMs / 1000),
      source,
      engines: manifest.engines?.dsh === undefined ? {} : { dsh: manifest.engines.dsh },
    }],
  };
}

const plugins = [];
for (const entry of readdirSync(pluginsDir)) {
  const plugin = buildPluginEntry(pluginsDir, `plugins/${entry}`, entry);
  if (plugin !== undefined) plugins.push(plugin);
}
if (withTest) {
  for (const entry of readdirSync(testPluginsDir)) {
    const plugin = buildPluginEntry(testPluginsDir, `plugins-test/${entry}`, entry);
    if (plugin !== undefined) plugins.push(plugin);
  }
}

if (plugins.length === 0) {
  console.error('gen-index: plugins/ 下没有可用的插件');
  process.exit(1);
}

const index = {
  format: 1,
  title: { zh: 'DSH Friends 插件市场', en: 'DSH Friends Plugin Market' },
  description: {
    zh: '朋友间共享的 DSH 插件集合:会话标题自动维护、中断任务自动续接等实用工具',
    en: 'A shared collection of DSH plugins: session title keeping, interrupted turn resuming, and more.',
  },
  metadata: {},
  plugins,
};

writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log(`gen-index: 写入 ${plugins.length} 个插件 → ${outPath}`);
for (const p of plugins) {
  const src = p.versions[0].source;
  const origin = src.type === 'git' ? `git ${src.commit.slice(0, 8)}` : `npm ${src.registry}`;
  console.log(`  - ${p.name}@${p.versions[0].version} (${origin})`);
}
