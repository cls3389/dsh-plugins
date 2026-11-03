/**
 * Register the official openclaw-lark tools on DSH's native tool runtime.
 * Only the small host contract is adapted; Feishu API behavior remains upstream.
 *
 * @module @larksuite/dsh-lark/official-tools
 */

import type { Context } from '@deepseek-ai/cordis';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { type LarkTicket, withTicket } from '../vendor/openclaw-lark/dist/core/lark-ticket.js';
import { LarkClient } from '../vendor/openclaw-lark/dist/core/lark-client.js';
import { registerFeishuMcpDocTools } from '../vendor/openclaw-lark/dist/tools/mcp/doc/index.js';
import { registerOapiTools } from '../vendor/openclaw-lark/dist/tools/oapi/index.js';
import { registerFeishuOAuthTool } from '../vendor/openclaw-lark/dist/tools/oauth.js';
import { registerFeishuOAuthBatchAuthTool } from '../vendor/openclaw-lark/dist/tools/oauth-batch-auth.js';
import type { Credentials } from './config.js';

interface OfficialTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(callId: string, params: unknown): Promise<OfficialToolResult>;
}

interface OfficialToolResult {
  readonly content?: readonly ContentBlock[];
  readonly details?: unknown;
}

interface OfficialToolHost {
  readonly config: OpenClawPluginApi['config'];
  readonly logger: OpenClawPluginApi['logger'];
  registerTool(tool: OfficialTool): void;
}

/** LarkTicket + 发送者 union_id（飞书跨应用人标识，用于身份簇归并）。 */
export type FeishuLarkTicket = LarkTicket & { readonly senderUnionId?: string };

/** Session-scoped Feishu identity used by user-token and proactive tools. */
export class OfficialToolContexts {
  private readonly sessions = new Map<string, FeishuLarkTicket>();

  /** Remember the latest accepted inbound message for one DSH session. */
  bind(sessionId: string, ticket: FeishuLarkTicket): void {
    this.sessions.set(sessionId, ticket);
  }

  /** Resolve a session binding for the tool adapter. */
  get(sessionId: string): FeishuLarkTicket | undefined {
    return this.sessions.get(sessionId);
  }

  /** Drop all bindings when the surface is disposed. */
  clear(): void {
    this.sessions.clear();
  }
}

/** Build the OpenClaw-shaped config consumed by the untouched official modules. */
export function officialConfig(
  config: Record<string, unknown>,
  credentials: Credentials,
): {
  channels: { feishu: Record<string, unknown> };
} {
  const configuredAccounts = config.accounts !== null && typeof config.accounts === 'object'
    ? config.accounts as Record<string, unknown>
    : {};
  const botAccounts = Object.fromEntries((Array.isArray(config.bots) ? config.bots : []).map((entry) => {
    const bot = entry as Record<string, unknown>;
    return [String(bot.accountId).toLowerCase(), { ...bot, accountId: String(bot.accountId).toLowerCase(), enabled: true, connectionMode: 'websocket' }];
  }));
  return {
    channels: {
      feishu: {
        ...config,
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        accounts: { ...configuredAccounts, ...botAccounts },
        enabled: true,
        connectionMode: 'websocket',
      },
    },
  };
}

/** Convert TypeBox's JSON Schema dialect to DSH's supported schema subset. */
export function toDshSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of [
    'type',
    'enum',
    'const',
    'required',
    'description',
    'title',
    'default',
    'examples',
  ]) {
    if (key in schema) output[key] = schema[key];
  }
  if (schema.properties !== null && typeof schema.properties === 'object') {
    output.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [
        name,
        toDshSchema(child as Record<string, unknown>),
      ]),
    );
  }
  if (schema.items !== null && typeof schema.items === 'object') {
    output.items = toDshSchema(schema.items as Record<string, unknown>);
  }
  if (typeof schema.additionalProperties === 'boolean') {
    output.additionalProperties = schema.additionalProperties;
  } else if (schema.additionalProperties !== undefined || schema.patternProperties !== undefined) {
    output.additionalProperties = true;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    output.oneOf = union.map((entry) => toDshSchema(entry as Record<string, unknown>));
  }
  return output;
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      ),
    ) as unknown;
  } catch {
    return String(value);
  }
}

function adaptTool(tool: OfficialTool, contexts: OfficialToolContexts): ToolDefinition {
  let parameters = toDshSchema(tool.parameters);
  if (Array.isArray(parameters.oneOf)) {
    const branches = parameters.oneOf as Record<string, unknown>[];
    const properties: Record<string, unknown> = {};
    for (const branch of branches) {
      for (const [name, schema] of Object.entries(branch.properties ?? {})) {
        if (!(name in properties)) {
          properties[name] = schema;
        } else if (name === 'action') {
          const values = branches
            .map((item) => (item.properties as Record<string, { const?: string }>)?.[name]?.const)
            .filter((value): value is string => value !== undefined);
          properties[name] = { type: 'string', enum: values };
        }
      }
    }
    const required = branches.map(
      (branch) => new Set((branch.required as string[] | undefined) ?? []),
    );
    parameters = {
      type: 'object',
      properties,
      required: [...(required[0] ?? new Set<string>())].filter((name) =>
        required.every((branch) => branch.has(name)),
      ),
      additionalProperties: true,
    };
  }
  parameters.type ??= 'object';
  return {
    name: tool.name,
    description: tool.description,
    parameters: parameters as ToolDefinition['parameters'],
    output: {
      schema: {},
      render(_args, value) {
        const envelope = value as { content?: ContentBlock[]; details?: unknown };
        return (
          envelope.content ?? [
            { type: 'text', text: JSON.stringify(envelope.details ?? null, null, 2) },
          ]
        );
      },
    },
    async execute(args, exec: ToolRunContext) {
      const sessionId = exec.agent?.session.id;
      const ticket = sessionId === undefined ? undefined : contexts.get(sessionId);
      const invoke = () => tool.execute(exec.callId, args);
      const result = ticket === undefined ? await invoke() : await withTicket(ticket, invoke);
      return {
        content: jsonValue(result.content ?? []) as unknown as ContentBlock[],
        details: jsonValue(result.details),
      };
    },
  };
}

/**
 * Register OAPI, MCP document and OAuth tools. DSH's native `ask_user`
 * remains the interactive-question implementation, so the OpenClaw-specific
 * synthetic-card tool is deliberately not mounted.
 */
export function registerOfficialTools(
  ctx: Context,
  config: Record<string, unknown>,
  credentials: Credentials,
  contexts: OfficialToolContexts,
  hostConfig = officialConfig(config, credentials),
  mode: 'all' | 'messages' = 'all',
): () => void {
  const tools = ctx.get('tools');
  if (tools === undefined) {
    ctx.logger.warn('[feishu] tools service unavailable; official Lark tools not registered');
    return () => {};
  }
  const disposers: Array<() => void> = [];
  const registered: string[] = [];
  let imagePreviewCounter = 0;
  const sentImagePreviews = new Map<string, Extract<ContentBlock, { type: 'image' }>['attachment']>();
  const registerImagePreview = async (path: string): Promise<string | undefined> => {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(path);
    const mediaType = /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : 'image/png';
    const attachment = await ctx.get('attachments')?.saveImage({ data: bytes, mediaType, name: path.split('/').pop() ?? 'image' });
    if (!attachment) return undefined;
    const previewId = `feishu-sent-${++imagePreviewCounter}`;
    sentImagePreviews.set(previewId, attachment);
    return previewId;
  };
  const host: OfficialToolHost = {
    config: hostConfig,
    logger: ctx.logger,
    registerTool(tool) {
      if (mode === 'messages' && !['feishu_im_user_message', 'feishu_im_user_fetch_resource', 'feishu_im_bot_image', 'feishu_send_file'].includes(tool.name)) return;
      disposers.push(tools.register(adaptTool(tool, contexts)));
      registered.push(tool.name);
      ctx.logger.debug(`[feishu] official tool registered: ${tool.name}`);
    },
  };
  // Only approved media directories can leave the host, and only to the current chat.
  disposers.push(tools.register({
    name: 'feishu_send_image',
    description: '把本地图片发送到当前飞书对话，并回显实际发送的图片供模型检查。支持 ths_qr_login 的 output、image_generate/image_edit 的 image_path，以及 feishu_group_image、browser_screenshot 等工作区图片。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '图片文件路径' } },
      required: ['path'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const result = value as { previewId?: string };
        const blocks: ContentBlock[] = [{ type: 'text', text: JSON.stringify(value) }];
        const attachment = result.previewId === undefined ? undefined : sentImagePreviews.get(result.previewId);
        if (attachment) blocks.push({ type: 'image', attachment });
        sentImagePreviews.delete(result.previewId ?? '');
        return blocks;
      },
    },
    async execute(args: unknown, exec) {
      const { path: inputPath } = args as { path: string };
      const sessionId = exec.agent?.session.id;
      const ticket = sessionId === undefined ? undefined : contexts.get(sessionId);
      if (!ticket) throw new Error('当前对话没有可信飞书用户身份');
      const { realpathSync } = await import('node:fs');
      const path = realpathSync(resolve(String(inputPath)));
      const agentsRoot = realpathSync(resolve(process.env.DSH_HOME ?? '/data/dsh', 'home', 'agents'));
      const isQr = path.startsWith(`${realpathSync('/tmp/openclaw-ths-qr')}/`) && /\/qr-[a-f0-9]+\.png$/.test(path);
      const isGenerated = path.startsWith(`${realpathSync('/data/dsh/tmp/media-images')}/`) && /\.(png|jpe?g|webp)$/i.test(path);
      const isWorkspace = path.startsWith(`${agentsRoot}/`) && /\.(png|jpe?g|webp|gif|bmp)$/i.test(path);
      if (!isQr && !isGenerated && !isWorkspace) throw new Error('图片路径不属于受支持的扫码、生图或工作区目录');
      const client = LarkClient.fromCfg(host.config, ticket.accountId);
      const uploaded = await client.sdk.im.image.create({ data: { image_type: 'message', image: createReadStream(path) } });
      const response = uploaded as { image_key?: string; data?: { image_key?: string }; code?: number; msg?: string } | null;
      const imageKey = response?.data?.image_key ?? response?.image_key;
      if ((response?.code !== undefined && response.code !== 0) || !imageKey) throw new Error(`图片上传失败: ${response?.msg ?? response?.code ?? 'missing image_key'}`);
      const sent = await client.sdk.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: ticket.chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      });
      if (sent.code !== 0) throw new Error(`图片发送失败: ${sent.msg ?? sent.code}`);
      const previewId = await registerImagePreview(path);
      return { sent: true, messageId: sent.data?.message_id, ...(previewId === undefined ? {} : { previewId }) };
    },
  }));
  // Send arbitrary files (csv/xlsx/pdf/etc) to the current chat.
  disposers.push(tools.register({
    name: 'feishu_send_file',
    description: '把本地文件(csv/xlsx/pdf/txt 等)发送到当前飞书对话。文件需在当前用户工作区 agents/ 目录下。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec) {
      const { path: inputPath } = args as { path: string };
      const sessionId = exec.agent?.session.id;
      const ticket = sessionId === undefined ? undefined : contexts.get(sessionId);
      if (!ticket) throw new Error('当前对话没有可信飞书用户身份');
      const { realpathSync } = await import('node:fs');
      const rawPath = String(inputPath);
      let base: string | undefined;
      if (exec.agent) {
        const workingDirectory = exec.agent.ctx.get('workingDirectory') as
          | { ensure(agent: unknown, signal?: AbortSignal): Promise<string> }
          | undefined;
        base = workingDirectory ? await workingDirectory.ensure(exec.agent, exec.signal) : undefined;
      }
      const path = realpathSync(resolve(base ?? process.cwd(), rawPath));
      const agentsRoot = realpathSync(resolve(process.env.DSH_HOME ?? '/data/dsh', 'home', 'agents'));
      if (!path.startsWith(`${agentsRoot}/`)) throw new Error('文件路径必须在当前用户工作区 agents/ 目录下');
      const { stat } = await import('node:fs/promises');
      const info = await stat(path);
      if (!info.isFile() || info.size > 30 * 1024 * 1024) throw new Error('文件不存在或超过 30MB 限制');
      const client = LarkClient.fromCfg(host.config, ticket.accountId);
      const fileType = /\.(pdf)$/i.test(path) ? 'pdf' : /\.(xlsx?|csv)$/i.test(path) ? 'xls' : /\.(docx?)$/i.test(path) ? 'doc' : 'stream';
      const uploaded = await client.sdk.im.file.create({ data: { file_type: fileType, file_name: path.split('/').pop() ?? 'file', file: createReadStream(path) } });
      const response = uploaded as { file_key?: string; data?: { file_key?: string }; code?: number; msg?: string } | null;
      const fileKey = response?.data?.file_key ?? response?.file_key;
      if ((response?.code !== undefined && response.code !== 0) || !fileKey) throw new Error(`文件上传失败: ${response?.msg ?? response?.code ?? 'missing file_key'}`);
      const sent = await client.sdk.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: ticket.chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
      });
      if (sent.code !== 0) throw new Error(`文件发送失败: ${sent.msg ?? sent.code}`);
      return { sent: true, messageId: sent.data?.message_id, fileName: path.split('/').pop() };
    },
  }));
  const api = host as unknown as OpenClawPluginApi;
  registerOapiTools(api);
  registerFeishuMcpDocTools(api);
  registerFeishuOAuthTool(api);
  registerFeishuOAuthBatchAuthTool(api);
  ctx.logger.info(
    `[feishu] registered ${disposers.length} official Lark tools: ${registered.join(', ')}`,
  );
  for (const name of [
    'feishu_search_doc_wiki',
    'feishu_search_user',
    'feishu_im_user_search_messages',
  ]) {
    if (tools.get(name) === undefined)
      ctx.logger.warn(`[feishu] search tool is not visible: ${name}`);
  }
  return () => {
    contexts.clear();
    for (const dispose of disposers.reverse()) dispose();
  };
}
