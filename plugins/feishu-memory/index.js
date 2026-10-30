import fs from 'node:fs';
import path from 'node:path';
import { entryRows, lexicalRequiredMatchCount, lexicalSearchTokens, scanSecrets } from '@jipika/dsh-memory';
import { assertOpenId, workspaceFor } from '../feishu-principal/index.js';

export const name = 'feishu-memory';
export const inject = ['tools'];
const writeQueues = new Map();
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };

function rootFor(config, openId, appId) {
  assertOpenId(openId);
  if (!config.workspaceRoot) throw new Error('飞书用户记忆尚未配置 workspaceRoot');
  if (appId && (!config.appsRoot || !/^cli_[a-z0-9]+$/i.test(appId))) throw new Error('飞书应用身份或记忆根目录无效');
  const appRoot = appId ? path.join(config.appsRoot, appId) : config.workspaceRoot;
  return path.join(workspaceFor(appRoot, openId), '.dsh', 'memory');
}
function agentRoot(config, exec) {
  return rootFor(config, exec?.agent?.larkUser?.openId, exec?.agent?.larkUser?.appId);
}
function shards(root) {
  const directory = path.join(root, 'topics');
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-z0-9][a-z0-9-]*\.md$/.test(entry.name))
      .map((entry) => ({ topic: entry.name.slice(0, -3), path: path.join(directory, entry.name), relative: `topics/${entry.name}` }));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function readShard(root, relative) {
  if (typeof relative !== 'string' || !/^topics\/[a-z0-9][a-z0-9-]*\.md$/.test(relative)) throw new Error('只能读取当前用户 topics/<主题>.md 记忆');
  const file = shards(root).find((shard) => shard.relative === relative);
  if (!file) throw new Error('记忆主题不存在');
  const stat = fs.lstatSync(file.path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('非法记忆文件');
  return { ...file, text: fs.readFileSync(file.path, 'utf8') };
}
function memoryMap(root) {
  return shards(root).map((shard) => {
    const text = fs.readFileSync(shard.path, 'utf8');
    const header = /^<!--\s*(.*?)\s*-->/.exec(text)?.[1] ?? shard.topic;
    const entries = entryRows(text);
    const dates = entries.map((entry) => /\[(\d{4}-\d{2}-\d{2})\]/.exec(entry.text)?.[1] ?? '').sort();
    return `## ${shard.topic} · ${entries.length} 条 · 最新 ${dates.at(-1) || '无日期'}\n${header}`;
  });
}
function prompt(config, context) {
  const openId = context?.agent?.larkUser?.openId;
  if (!openId) return '';
  const root = rootFor(config, openId, context?.agent?.larkUser?.appId);
  const map = memoryMap(root);
  return `<!-- 飞书用户级长期记忆 · 仅当前可信 senderOpenId 对应工作区；不读取管理员或其他用户记忆 -->\n${map.length ? map.join('\n') : '当前用户尚无长期记忆。'}\n<!-- 非琐碎任务先用 memory_search 查相关事实，再用 memory_read 按行读取；只把可复用的偏好、结论、坑写入 memory_write，不记过程叙述或任何凭据。 -->`;
}

/** Same lexical relevance model as dsh-memory, restricted to one user's shards. */
export function searchUserMemory(root, query, limit = 8) {
  const raw = String(query ?? '').trim();
  if (!raw) throw new Error('query 必填');
  const normalized = raw.normalize('NFKC').toLocaleLowerCase();
  const tokens = lexicalSearchTokens(normalized);
  const rows = [];
  const df = new Array(tokens.length).fill(0);
  let totalLength = 0;
  for (const shard of shards(root)) {
    const text = fs.readFileSync(shard.path, 'utf8');
    for (const entry of entryRows(text)) {
      const norm = entry.text.normalize('NFKC').toLocaleLowerCase();
      const hit = tokens.map((token, index) => norm.includes(token) ? index : -1).filter((index) => index >= 0);
      for (const index of hit) df[index]++;
      totalLength += norm.length;
      rows.push({ shard: shard.topic, path: shard.relative, line: entry.line, text: entry.text.replace(/\s+/g, ' '), norm, hit, exact: norm.includes(normalized), date: /\[(\d{4}-\d{2}-\d{2})\]/.exec(entry.text)?.[1] ?? '' });
    }
  }
  const weights = tokens.map((_, index) => df[index] ? Math.log(1 + rows.length / df[index]) : 0);
  const valid = tokens.filter((_, index) => weights[index] > 0);
  const required = valid.length ? lexicalRequiredMatchCount(valid) : 1;
  const average = rows.length ? totalLength / rows.length : 1;
  const results = [];
  for (const row of rows) {
    let score = row.exact ? Math.log(1 + rows.length) : 0;
    let matched = 0;
    for (const index of row.hit) { if (weights[index]) { score += weights[index]; matched++; } }
    if (!score || (valid.length && matched < required)) continue;
    const denominator = Math.max(0.5, 1 + 0.5 * (row.norm.length / average - 1));
    results.push({ path: row.path, shard: row.shard, line: row.line, date: row.date, score: +(score / denominator).toFixed(4), text: row.text.slice(0, 500) });
  }
  results.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.line - b.line);
  const capped = Math.max(1, Math.min(20, Math.trunc(limit)));
  const picked = [], counts = new Map();
  for (const result of results) {
    if ((counts.get(result.path) ?? 0) >= 2) continue;
    counts.set(result.path, (counts.get(result.path) ?? 0) + 1);
    picked.push(result);
    if (picked.length === capped) break;
  }
  if (picked.length < capped) for (const result of results) if (!picked.includes(result)) { picked.push(result); if (picked.length === capped) break; }
  return { ok: true, scope: 'current_feishu_user', totalHits: results.length, results: picked, scanned: { files: shards(root).length, entries: rows.length } };
}

function safeEntry(entry) {
  if (typeof entry !== 'string' || entry.length > 2000 || /[\r\n]/.test(entry)) throw new Error('记忆必须是单行、不超过 2000 字符');
  const match = /^- \[(\d{4}-\d{2}-\d{2})\] \S/.exec(entry);
  if (!match) throw new Error('记忆格式必须为 - [YYYY-MM-DD] 可复用事实');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (match[1] > today) throw new Error('记忆日期不能晚于今天');
  const secrets = scanSecrets(entry);
  if (secrets.length) throw new Error(`记忆疑似包含凭据（${secrets.map((hit) => hit.pattern).join('、')}），已拒绝写入`);
  return entry;
}
async function writeMemory(root, args) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(args.topic ?? '')) throw new Error('topic 使用小写字母/数字/连字符，最长 49 字符');
  if (typeof args.keywords !== 'string' || !args.keywords.trim() || /[\r\n]/.test(args.keywords)) throw new Error('新主题需要单行 keywords');
  const entry = safeEntry(args.entry);
  const mode = args.mode ?? 'append';
  if (!['append', 'replace'].includes(mode)) throw new Error('mode 只支持 append/replace');
  const relative = `topics/${args.topic}.md`;
  const previous = writeQueues.get(root) ?? Promise.resolve();
  const operation = previous.then(async () => {
    let shard;
    try { shard = readShard(root, relative); } catch (error) {
      if (!/记忆主题不存在/.test(error.message)) throw error;
      shard = { path: path.join(root, 'topics', `${args.topic}.md`), relative, text: '' };
    }
    const lines = shard.text.split('\n');
    if (!lines[0]?.startsWith('<!--')) lines.unshift(`<!-- ${args.topic} · 关键词: ${args.keywords.trim()} -->`);
    if (mode === 'replace') {
      if (!Number.isInteger(args.line) || args.line < 2 || !/^\s*-\s+\S/.test(lines[args.line - 1] ?? '')) throw new Error('replace 必须指定现有记忆条目的行号');
      lines[args.line - 1] = entry;
    } else {
      if (entryRows(shard.text).some((row) => row.text.trim() === entry)) return { written: false, duplicate: true, path: relative };
      while (lines.at(-1) === '') lines.pop();
      lines.push(entry, '');
    }
    fs.mkdirSync(path.dirname(shard.path), { recursive: true, mode: 0o700 });
    const temporary = `${shard.path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(temporary, shard.path);
    fs.appendFileSync(path.join(root, 'audit.log'), `${JSON.stringify({ at: new Date().toISOString(), topic: args.topic, mode, line: args.line ?? null })}\n`, { mode: 0o600 });
    return { written: true, mode, path: relative, line: mode === 'replace' ? args.line : lines.length - 1 };
  });
  writeQueues.set(root, operation.catch(() => {}));
  return operation;
}

export function apply(ctx, config) {
  const mountPrompt = (promptCtx) => promptCtx.systemPrompt.section({ name: 'feishu-memory:user-long-term', order: 9500, text: (context) => prompt(config, context) });
  if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], (promptCtx) => { ctx.effect(() => mountPrompt(promptCtx), 'feishu-memory: user memory map'); });
  else mountPrompt(ctx);
  ctx.tools.register({
    name: 'memory_search',
    description: '检索当前飞书用户的长期记忆，返回相关度、主题与行号。只搜索本人用户工作区，不支持跨用户或管理员记忆。任务开工找线索先用它，再 memory_read 按行读取。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '中文/英文检索词，越具体越好' }, limit: { type: 'integer', description: '最多 20 条，默认 8' } }, required: ['query'] }, output,
    execute: async (args, exec) => searchUserMemory(agentRoot(config, exec), args.query, args.limit),
  });
  ctx.tools.register({
    name: 'memory_read',
    description: '按行读取当前用户 memory_search 返回的 topics/<主题>.md；只读本人记忆，拒绝绝对路径和其他用户目录。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'topics/<主题>.md' }, offset: { type: 'integer', description: '起始行，默认 1' }, limit: { type: 'integer', description: '最多 100 行，默认 20' } }, required: ['path'] }, output,
    execute: async (args, exec) => {
      const shard = readShard(agentRoot(config, exec), args.path);
      const offset = Math.max(1, Math.trunc(args.offset ?? 1));
      const limit = Math.min(100, Math.max(1, Math.trunc(args.limit ?? 20)));
      const lines = shard.text.split('\n').slice(offset - 1, offset - 1 + limit);
      return { path: shard.relative, offset, count: lines.length, text: lines.map((line, index) => `${offset + index}: ${line}`).join('\n') };
    },
  });
  ctx.tools.register({
    name: 'memory_write',
    description: '写入当前用户自己的长期记忆。entry 格式 - [YYYY-MM-DD] 可复用事实；记偏好、结论和坑，不记过程叙述或凭据。默认 append 追加；mode=replace 带 memory_search 返回的 line 就地修正旧结论。只能修改本人主题分片。',
    parameters: { type: 'object', properties: { topic: { type: 'string', description: '小写主题名，如 preferences/trading' }, keywords: { type: 'string', description: '单行主题关键词，供检索路由' }, entry: { type: 'string', description: '- [YYYY-MM-DD] 一条可复用事实' }, mode: { type: 'string', enum: ['append', 'replace'], description: '默认 append' }, line: { type: 'integer', description: 'replace 时指定旧条目行号' } }, required: ['topic', 'keywords', 'entry'] }, output,
    execute: async (args, exec) => writeMemory(agentRoot(config, exec), args),
  });
  console.log('[feishu-memory] active: per-user memory_search/memory_read/memory_write');
}
