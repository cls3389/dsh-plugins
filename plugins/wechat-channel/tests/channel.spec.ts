import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { WeixinChannel } from '../src/channel.js';
import type { ILinkClient } from '../src/protocol/client.js';
import type { Config } from '../src/config.js';
import { WeixinStateStore } from '../src/protocol/state.js';
import type { SendTextInput, SendTextResult, UpdateBatch, WeixinInboundEvent } from '../src/protocol/types.js';
import { SessionStore } from '../src/session-store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeClient {
  readonly sent: SendTextInput[] = [];
  private readonly batches: UpdateBatch[] = [];
  private releaseHang?: (batch: UpdateBatch) => void;
  private readonly hang = new Promise<UpdateBatch>((resolve) => {
    this.releaseHang = resolve;
  });

  queue(...batches: UpdateBatch[]): void {
    this.batches.push(...batches);
  }

  drain(): void {
    this.releaseHang?.({ messages: [], nextCursor: '' });
  }

  async pollBatch(): Promise<UpdateBatch> {
    const batch = this.batches.shift();
    return batch ?? this.hang;
  }

  async sendText(input: SendTextInput): Promise<SendTextResult> {
    this.sent.push(input);
    return { clientId: `c${this.sent.length}` };
  }
}

function inbound(messageId: string, text: string, contextToken?: string): WeixinInboundEvent {
  return {
    messageId,
    accountId: 'main',
    subjectId: 'user-1@im',
    conversationId: 'user-1@im',
    text,
    ...(contextToken ? { contextToken } : {}),
    raw: {},
  };
}

interface Harness {
  channel: WeixinChannel;
  client: FakeClient;
  state: WeixinStateStore;
  sessions: SessionStore;
  followup: ReturnType<typeof vi.fn>;
  lastSession: () => string;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-channel-'));
  dirs.push(dir);
  const client = new FakeClient();
  const state = new WeixinStateStore(dir, 'main');
  const sessions = new SessionStore(dir, join(dir, 'agents'), join(dir, 'agents'), ({ subjectId }) => {
    const id = subjectId.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 20) || 'anon';
    return `u_${id}`;
  });
  const followup = vi.fn();
  let lastSessionId = '';
  const config: Config = { accountId: 'main', agentId: 'bot1' };
  const channel = new WeixinChannel({
    config,
    state,
    sessions,
    resolveAgent: async (sessionId) => {
      lastSessionId = sessionId;
      return {
        session: { id: sessionId },
        followup,
        cancel: vi.fn(),
      } as unknown as Agent;
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    tokenFallback: 'tok',
    clientFactory: () => client as unknown as ILinkClient,
  });
  return { channel, client, state, sessions, followup, lastSession: () => lastSessionId };
}

function textFrame(text: string): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } } as unknown as AssistantStreamFrame;
}

function assistantEvent(text: string): SessionEvent {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        id: 'm' as never,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { provider: 't', model: 't' } as never,
      },
    },
    seq: 1 as never,
    time: Date.now(),
  } as unknown as SessionEvent;
}

function turnEnd(kind: 'completed' | 'error', message?: string): SessionEvent {
  return {
    type: 'turn/end',
    data: {
      turn: 1,
      reason: kind === 'error' ? { kind, error: new Error(message ?? 'boom') } : { kind },
    },
    seq: 2 as never,
    time: Date.now(),
  } as unknown as SessionEvent;
}

async function completeTurn(h: Harness, text: string, kind: 'completed' | 'error' = 'completed'): Promise<void> {
  h.channel.assistantFrame(h.lastSession(), textFrame('流式'));
  await h.channel.sessionEvent(h.lastSession(), assistantEvent(text));
  await h.channel.sessionEvent(h.lastSession(), turnEnd(kind));
}

describe('WeixinChannel', () => {
  it('delivers a message, replies once with filtered markdown, then commits the cursor', async () => {
    const h = await harness();
    h.client.queue({ messages: [inbound('m-1', '你好', 'ctx-1')], nextCursor: 'cur-1' });
    await h.channel.start();
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1));
    expect(await h.state.loadCursor()).toBe(''); // cursor waits for delivery
    await completeTurn(h, '**答案** ![图](https://x/y.png)');
    await vi.waitFor(() => expect(h.client.sent.length).toBe(1));
    expect(h.client.sent[0]).toMatchObject({ to: 'user-1@im', text: '**答案** ', contextToken: 'ctx-1' });
    await vi.waitFor(async () => expect(await h.state.loadCursor()).toBe('cur-1'));
    h.client.drain();
    await h.channel.stop();
  });

  it('suppresses duplicate delivery of the same message id', async () => {
    const h = await harness();
    h.client.queue({ messages: [inbound('m-dup', '你好', 'ctx-1')], nextCursor: 'cur-1' });
    await h.channel.start();
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1));
    await completeTurn(h, '回复');
    await h.channel.deliver(inbound('m-dup', '你好', 'ctx-1'));
    expect(h.followup).toHaveBeenCalledTimes(1);
    h.client.drain();
    await h.channel.stop();
  });

  it('serializes messages within one conversation in arrival order', async () => {
    const h = await harness();
    await h.channel.start();
    const first = h.channel.deliver(inbound('m-a', '第一条', 'ctx-a'));
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1));
    const second = h.channel.deliver(inbound('m-b', '第二条', 'ctx-b'));
    await completeTurn(h, '回复A');
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(2));
    await completeTurn(h, '回复B');
    await Promise.all([first, second]);
    expect(h.followup.mock.calls.map((call) => (call[0] as { content: Array<{ text: string }> }).content[0]!.text)).toEqual(['第一条', '第二条']);
    expect(h.client.sent.map((sent) => sent.text)).toEqual(['回复A', '回复B']);
    h.client.drain();
    await h.channel.stop();
  });

  it('answers /new and /stop without driving the agent', async () => {
    const h = await harness();
    await h.channel.start();
    await h.channel.deliver(inbound('m-c1', '/new'));
    expect(h.client.sent.at(-1)?.text).toContain('新的 DSH 会话');
    await h.channel.deliver(inbound('m-c2', '/stop'));
    expect(h.client.sent.at(-1)?.text).toContain('没有执行中的任务');
    expect(h.followup).not.toHaveBeenCalled();
    h.client.drain();
    await h.channel.stop();
  });

  it('reports turn errors to the user', async () => {
    const h = await harness();
    await h.channel.start();
    const delivery = h.channel.deliver(inbound('m-err', '触发错误', 'ctx-e'));
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1));
    await completeTurn(h, '部分输出', 'error');
    await delivery;
    expect(h.client.sent[0]!.text).toContain('任务执行失败');
    h.client.drain();
    await h.channel.stop();
  });
});
