import { createHash, randomUUID, randomBytes } from 'node:crypto';
import type {
  GetConfigResp,
  GetUpdatesResp,
  QRCodeResponse,
  QRStatusResponse,
  SendTextInput,
  SendTextResult,
  SendTypingResp,
  UpdateBatch,
  WeixinInboundEvent,
  WeixinMessage,
  ILinkClientOptions,
} from './types.js';
import { MessageItemType, MessageState, MessageType, TypingStatus } from './types.js';
import { filterMarkdown } from './markdown.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_MS = 35_000;
const DEFAULT_REQUEST_MS = 15_000;
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

export function parseLosslessJson<T>(text: string): T {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      out += text[i++];
      continue;
    }
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++]!;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') break;
    }
    const token = text.slice(start, i);
    out += token;
    let cursor = i;
    while (/\s/.test(text[cursor] ?? '')) cursor++;
    if (text[cursor] !== ':') continue;
    let key: unknown;
    try { key = JSON.parse(token); } catch { continue; }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;
    out += text.slice(i, cursor + 1);
    cursor++;
    while (/\s/.test(text[cursor] ?? '')) out += text[cursor++];
    const numberStart = cursor;
    if (text[cursor] === '-') cursor++;
    while (/\d/.test(text[cursor] ?? '')) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && text[numberStart] === '-')) {
      out += `"${text.slice(numberStart, cursor)}"`;
      i = cursor;
    } else i = numberStart;
  }
  return JSON.parse(out) as T;
}

function randomUin(): string {
  return randomBytes(4).toString('hex');
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function timeoutSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}

async function postJson<T>(options: {
  baseUrl: string;
  token?: string;
  endpoint: string;
  body: unknown;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const timeout = timeoutSignal(options.timeoutMs, options.abortSignal);
  try {
    const response = await options.fetchImpl(endpointUrl(options.baseUrl, options.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '2.4.10',
        'X-WECHAT-UIN': randomUin(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(options.body),
      signal: timeout.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Weixin ${options.endpoint} HTTP ${response.status}: ${raw.slice(0, 300)}`);
    return parseLosslessJson<T>(raw);
  } finally {
    timeout.cleanup();
  }
}

async function getJson<T>(options: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const timeout = timeoutSignal(options.timeoutMs, options.abortSignal);
  try {
    const response = await options.fetchImpl(endpointUrl(options.baseUrl, options.endpoint), {
      headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '2.4.10' },
      signal: timeout.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Weixin ${options.endpoint} HTTP ${response.status}: ${raw.slice(0, 300)}`);
    return parseLosslessJson<T>(raw);
  } finally {
    timeout.cleanup();
  }
}

function messageId(message: WeixinMessage): string {
  const direct = message.message_id?.trim();
  if (direct) return direct;
  for (const item of message.item_list ?? []) {
    if (item.msg_id?.trim()) return item.msg_id.trim();
  }
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

function messageText(message: WeixinMessage): string {
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) return String(item.text_item.text);
    if (item.voice_item?.text) return item.voice_item.text;
  }
  return '';
}

function normalizeMessage(message: WeixinMessage, accountId: string): WeixinInboundEvent | undefined {
  const subjectId = message.from_user_id?.trim();
  if (!subjectId || message.group_id) return undefined;
  const id = messageId(message);
  return {
    messageId: id,
    accountId,
    subjectId,
    conversationId: subjectId,
    text: messageText(message),
    ...(message.context_token ? { contextToken: message.context_token } : {}),
    ...(message.create_time_ms ? { timestamp: message.create_time_ms } : {}),
    raw: message,
  };
}

export class ILinkClient {
  readonly account: ILinkClientOptions['account'];
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly longPollTimeoutMs: number;

  constructor(options: ILinkClientOptions) {
    this.account = options.account;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_MS;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_MS;
  }

  async getUpdates(cursor: string, abortSignal?: AbortSignal): Promise<GetUpdatesResp> {
    return postJson<GetUpdatesResp>({
      baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
      token: this.account.token,
      endpoint: 'ilink/bot/getupdates',
      body: { get_updates_buf: cursor, base_info: {} },
      timeoutMs: this.longPollTimeoutMs,
      fetchImpl: this.fetchImpl,
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  async pollBatch(cursor: string, abortSignal?: AbortSignal): Promise<UpdateBatch> {
    const response = await this.getUpdates(cursor, abortSignal);
    const code = response.ret ?? response.errcode ?? 0;
    if (code !== 0) throw new Error(`getUpdates ret=${code} ${response.errmsg ?? ''}`.trim());
    const messages = (response.msgs ?? [])
      .map((message) => normalizeMessage(message, this.account.accountId))
      .filter((message): message is WeixinInboundEvent => message !== undefined);
    return {
      messages,
      nextCursor: response.get_updates_buf ?? cursor,
      ...(response.longpolling_timeout_ms ? { longPollTimeoutMs: response.longpolling_timeout_ms } : {}),
    };
  }

  async sendText(input: SendTextInput): Promise<SendTextResult> {
    const clientId = `dsh-wechat-${randomUUID()}`;
    const text = filterMarkdown(input.text);
    const response = await postJson<{ message_id?: string; ret?: number; errmsg?: string }>({
      baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
      token: this.account.token,
      endpoint: 'ilink/bot/sendmessage',
      body: {
        msg: {
          from_user_id: '',
          to_user_id: input.to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : [],
          ...(input.contextToken ? { context_token: input.contextToken } : {}),
          ...(input.runId ? { run_id: input.runId } : {}),
        },
        base_info: {},
      },
      timeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (response.ret && response.ret !== 0) throw new Error(`sendMessage ret=${response.ret} ${response.errmsg ?? ''}`.trim());
    return { clientId, ...(response.message_id ? { serverMessageId: response.message_id } : {}) };
  }

  async getConfig(subjectId: string, contextToken?: string): Promise<GetConfigResp> {
    return postJson<GetConfigResp>({
      baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
      token: this.account.token,
      endpoint: 'ilink/bot/getconfig',
      body: { ilink_user_id: subjectId, ...(contextToken ? { context_token: contextToken } : {}), base_info: {} },
      timeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  async sendTyping(subjectId: string, ticket: string, typing: boolean): Promise<SendTypingResp> {
    return postJson<SendTypingResp>({
      baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
      token: this.account.token,
      endpoint: 'ilink/bot/sendtyping',
      body: { ilink_user_id: subjectId, typing_ticket: ticket, status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL },
      timeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

export function createILinkClient(options: ILinkClientOptions): ILinkClient {
  return new ILinkClient(options);
}

export async function fetchQrCode(options: { baseUrl?: string; botType?: string; fetchImpl?: typeof fetch }): Promise<QRCodeResponse> {
  return postJson<QRCodeResponse>({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(options.botType ?? '3')}`,
    body: { local_token_list: [] },
    timeoutMs: DEFAULT_REQUEST_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  });
}

export async function pollQrStatus(options: { qrcode: string; baseUrl?: string; verifyCode?: string; fetchImpl?: typeof fetch; abortSignal?: AbortSignal }): Promise<QRStatusResponse> {
  const query = new URLSearchParams({ qrcode: options.qrcode });
  if (options.verifyCode) query.set('verify_code', options.verifyCode);
  return getJson<QRStatusResponse>({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
    timeoutMs: DEFAULT_LONG_POLL_MS,
    fetchImpl: options.fetchImpl ?? fetch,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
}
