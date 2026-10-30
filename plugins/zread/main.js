import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DEFAULTS = {
  url: 'https://open.bigmodel.cn/api/mcp/zread/mcp',
  apiKeyRef: 'Z_AI_API_KEY',
  requestTimeoutMs: 120000,
  maxResponseBytes: 4 * 1024 * 1024,
  cacheTtlMs: 300000,
  cacheMaxEntries: 100,
};

export const name = 'zread';
export const inject = ['tools'];

/** Read a scalar credential when the credentials service is unavailable. */
export async function readCredentialRef(refName, base = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  try {
    const text = await readFile(join(base, '.credentials.yaml'), 'utf8');
    const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRe = new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`);
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true;
        continue;
      }
      if (!inRefs) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(lineRe);
      if (!match) continue;
      let value = match[1];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
  } catch {
    // A missing or unreadable local fallback is equivalent to no credential.
  }
  return undefined;
}

export async function resolveApiKey(ctx, refName) {
  const stored = await ctx.get('credentials')?.resolve(refName);
  return stored?.value ?? await readCredentialRef(refName) ?? process.env[refName];
}

/** Parse both JSON and Streamable-HTTP SSE responses without an MCP SDK. */
export function parseMcpMessages(text, contentType = '') {
  if (!text.trim()) return [];
  if (!contentType.includes('text/event-stream') && !/^(?:event|id|data):/m.test(text)) {
    return [JSON.parse(text)];
  }
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    messages.push(JSON.parse(data));
  }
  return messages;
}

function responseError(message, status = 0) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resultFor(messages, id) {
  for (const message of messages) {
    if (typeof message?.code === 'number' && message.code >= 400 && message.success === false) {
      throw responseError(`Zread HTTP ${message.code}: ${message.msg ?? 'request failed'}`, message.code);
    }
    if (message?.id !== id) continue;
    if (message.error) {
      throw responseError(`Zread MCP ${message.error.code ?? 'error'}: ${message.error.message ?? JSON.stringify(message.error)}`);
    }
    if (message.result !== undefined) return message.result;
  }
  throw new Error('Zread returned no matching JSON-RPC result');
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Zread response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response exceeds configured limit').catch(() => {});
        throw new Error(`Zread response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export function cleanUpstreamText(text) {
  let output = text;
  // Zread currently wraps text in a JSON string literal. Decode at most twice
  // so future server versions that return plain text remain unaffected.
  for (let i = 0; i < 2 && typeof output === 'string' && output.trimStart().startsWith('"'); i++) {
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed !== 'string') break;
      output = parsed;
    } catch {
      break;
    }
  }
  return output.replace(/\r\n/g, '\n')
    .replace(/<\/?(?:structure|file_content|excerpt)>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatToolResult(result) {
  const text = (result.content ?? []).map((item) => {
    if (item.type === 'text') return item.text;
    return JSON.stringify(item);
  }).filter(Boolean).join('\n');
  const output = cleanUpstreamText(text || (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent)));
  if (result.isError) throw new Error(`Zread tool failed: ${output || 'unknown error'}`);
  return output;
}

/** Minimal Zread-specific Streamable HTTP client; no MCP package is used. */
export class ZreadHttpClient {
  constructor(config, getApiKey, fetchImpl = fetch) {
    this.config = config;
    this.getApiKey = getApiKey;
    this.fetch = fetchImpl;
    this.session = undefined;
    this.initializing = undefined;
    this.nextId = 1;
    this.cache = new Map();
    this.inflight = new Map();
  }

  async request(body, { session, signal } = {}) {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error(`zread: API key not configured; set credential reference ${this.config.apiKeyRef}`);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (session?.id) headers['Mcp-Session-Id'] = session.id;
    if (session?.protocolVersion) headers['MCP-Protocol-Version'] = session.protocolVersion;
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const response = await this.fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await readBoundedBody(response, this.config.maxResponseBytes);
    if (!response.ok) throw responseError(`Zread HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
    let messages;
    try {
      messages = parseMcpMessages(text, response.headers.get('content-type') ?? '');
    } catch (error) {
      throw new Error(`Zread returned invalid MCP payload: ${error.message}`);
    }
    return { messages, sessionId: response.headers.get('mcp-session-id') ?? session?.id };
  }

  async ensureSession(signal, force = false) {
    if (this.session && !force) return this.session;
    if (this.initializing && !force) return this.initializing;
    const task = (async () => {
      const id = this.nextId++;
      const init = await this.request({
        jsonrpc: '2.0', id, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-zread', version: '0.2.0' },
        },
      }, { signal });
      const result = resultFor(init.messages, id);
      const session = { id: init.sessionId, protocolVersion: result.protocolVersion };
      await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session, signal });
      this.session = session;
      return session;
    })();
    this.initializing = task;
    try {
      return await task;
    } finally {
      if (this.initializing === task) this.initializing = undefined;
    }
  }

  cacheKey(toolName, args) {
    const normalize = (value) => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
      }
      return value;
    };
    return `${toolName}:${JSON.stringify(normalize(args))}`;
  }

  cached(key) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.value;
  }

  storeCache(key, value) {
    if (this.config.cacheTtlMs <= 0 || this.config.cacheMaxEntries <= 0) return;
    this.cache.set(key, { value, expiresAt: Date.now() + this.config.cacheTtlMs });
    while (this.cache.size > this.config.cacheMaxEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  async callToolRemote(toolName, args, signal) {
    let session = await this.ensureSession(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = this.nextId++;
      try {
        const response = await this.request({
          jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args },
        }, { session, signal });
        return formatToolResult(resultFor(response.messages, id));
      } catch (error) {
        if (attempt === 0 && [404, 410].includes(error.status)) {
          this.session = undefined;
          session = await this.ensureSession(signal, true);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Zread request failed after session renewal');
  }

  async callTool(toolName, args, signal) {
    const key = this.cacheKey(toolName, args);
    const cached = this.cached(key);
    if (cached !== undefined) return cached;
    if (!this.inflight.has(key)) {
      const task = this.callToolRemote(toolName, args, signal)
        .then((output) => {
          this.storeCache(key, output);
          return output;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
    }
    return this.inflight.get(key);
  }

  async close() {
    const session = this.session;
    this.session = undefined;
    if (!session?.id) return;
    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) return;
      await this.fetch(this.config.url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}`, 'Mcp-Session-Id': session.id },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best-effort session cleanup; server-side expiry is the fallback.
    }
  }
}

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

function registerTool(ctx, client, { name, description, parameters }) {
  ctx.tools.register({
    name: `zread_${name}`,
    description,
    parameters,
    output: stringOutput,
    execute: async (args, exec) => {
      try {
        return await client.callTool(name, args, exec.signal);
      } catch (error) {
        ctx.logger?.warn?.(`zread ${name} failed: ${error?.message ?? error}`);
        throw error;
      }
    },
  });
}

export function apply(ctx, config) {
  const cfg = { ...CONFIG_DEFAULTS, ...config };
  const client = new ZreadHttpClient(cfg, () => resolveApiKey(ctx, cfg.apiKeyRef));
  registerTool(ctx, client, {
    name: 'search_doc',
    description: '搜索 GitHub 公开仓库的文档、Issue 和 Commit。仅用于远程开源仓库；本地项目优先使用本地 read/grep/git。',
    parameters: {
      type: 'object',
      properties: {
        repo_name: { type: 'string', description: 'GitHub 仓库 owner/repo，例如 vitejs/vite' },
        query: { type: 'string', description: '搜索关键词或关于仓库的问题' },
        language: { type: 'string', enum: ['zh', 'en'], description: '回答语言：zh 或 en，默认按问题语言' },
      },
      required: ['repo_name', 'query'],
      additionalProperties: false,
    },
  });
  registerTool(ctx, client, {
    name: 'get_repo_structure',
    description: '获取 GitHub 公开仓库的目录结构和文件列表，无需克隆。仅用于远程开源仓库。',
    parameters: {
      type: 'object',
      properties: {
        repo_name: { type: 'string', description: 'GitHub 仓库 owner/repo，例如 vitejs/vite' },
        dir_path: { type: 'string', description: '要查看的相对目录；缺省为仓库根目录' },
      },
      required: ['repo_name'],
      additionalProperties: false,
    },
  });
  registerTool(ctx, client, {
    name: 'read_file',
    description: '读取 GitHub 公开仓库中指定文件的完整源码，无需克隆。仅用于远程开源仓库；本地文件使用 read。',
    parameters: {
      type: 'object',
      properties: {
        repo_name: { type: 'string', description: 'GitHub 仓库 owner/repo，例如 vitejs/vite' },
        file_path: { type: 'string', description: '仓库内相对文件路径，例如 src/index.ts' },
      },
      required: ['repo_name', 'file_path'],
      additionalProperties: false,
    },
  });
  ctx.effect(() => () => client.close(), 'zread.close');
}
