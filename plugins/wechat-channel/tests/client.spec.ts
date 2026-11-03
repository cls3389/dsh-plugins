import { describe, expect, it, vi } from 'vitest';
import { createILinkClient, parseLosslessJson } from '../src/protocol/client.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Raw wire JSON so uint64 ids stay unquoted numbers until the parser sees them. */
function rawResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}

function account() {
  return { accountId: 'main', botId: 'bot-1', token: 'tok', baseUrl: 'https://ilink.test' };
}

describe('parseLosslessJson', () => {
  it('quotes uint64 id fields so no precision is lost', () => {
    const parsed = parseLosslessJson<{ message_id: string; other: number }>(
      '{"message_id": 7300620851185105922, "other": 42}',
    );
    expect(parsed.message_id).toBe('7300620851185105922');
    expect(parsed.other).toBe(42);
  });

  it('never rewrites ids inside string values', () => {
    const parsed = parseLosslessJson<{ text: string; message_id?: string }>(
      '{"text": "message_id: 123 not a key", "message_id": 9}',
    );
    expect(parsed.text).toBe('message_id: 123 not a key');
    expect(parsed.message_id).toBe('9');
  });
});

describe('ILinkClient', () => {
  it('sends protocol headers and bearer token on getupdates', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'b1' }));
    const client = createILinkClient({ account: account(), fetchImpl });
    await client.getUpdates('');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ilink.test/ilink/bot/getupdates');
    const headers = init.headers as Record<string, string>;
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    expect(headers['iLink-App-Id']).toBe('bot');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toMatchObject({ get_updates_buf: '', base_info: {} });
  });

  it('normalizes direct text messages and drops group traffic', async () => {
    const fetchImpl = vi.fn(async () =>
      rawResponse(
        '{"ret":0,"get_updates_buf":"b2","msgs":[' +
          '{"message_id":7300620851185105922,"from_user_id":"user-1@im","context_token":"ctx-1","item_list":[{"type":1,"text_item":{"text":"你好"}}]},' +
          '{"message_id":2,"from_user_id":"user-1@im","group_id":"g1","item_list":[{"type":1,"text_item":{"text":"群消息"}}]}]}',
      ),
    );
    const client = createILinkClient({ account: account(), fetchImpl });
    const batch = await client.pollBatch('');
    expect(batch.messages).toHaveLength(1);
    const message = batch.messages[0]!;
    expect(message).toMatchObject({
      messageId: '7300620851185105922',
      subjectId: 'user-1@im',
      conversationId: 'user-1@im',
      text: '你好',
      contextToken: 'ctx-1',
    });
    expect(batch.nextCursor).toBe('b2');
  });

  it('surfaces API errors instead of swallowing them', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: -14, errmsg: 'stale token' }));
    const client = createILinkClient({ account: account(), fetchImpl });
    await expect(client.pollBatch('')).rejects.toThrow(/-14/);
  });

  it('builds the BOT FINISH text wire body and echoes the context token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 0, message_id: '7300620851185105923' }));
    const client = createILinkClient({ account: account(), fetchImpl });
    const result = await client.sendText({ to: 'user-1@im', text: '**答案** ![i](https://x/y.png)', contextToken: 'ctx-9' });
    expect(result.serverMessageId).toBe('7300620851185105923');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ilink.test/ilink/bot/sendmessage');
    const body = JSON.parse(init.body as string) as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({
      to_user_id: 'user-1@im',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-9',
    });
    const items = body.msg.item_list as Array<{ type: number; text_item: { text: string } }>;
    expect(items[0]!.type).toBe(1);
    // Lightweight markdown retained; unsupported image syntax stripped.
    expect(items[0]!.text_item.text).toBe('**答案** ');
  });

  it('throws when sendMessage reports a non-zero ret', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 1, errmsg: 'denied' }));
    const client = createILinkClient({ account: account(), fetchImpl });
    await expect(client.sendText({ to: 'u', text: 'x' })).rejects.toThrow(/denied/);
  });
});
