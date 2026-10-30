import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import {
  createAssistantMessage,
  createToolResultMessage,
  LlmAttemptId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkChannel } from '../src/channel.js';
import { SessionStore } from '../src/session-store.js';
import type { OfficialTurnController } from '../src/streaming.js';
import { OfficialToolContexts } from '../src/tools.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function controller(): OfficialTurnController {
  return {
    cardMessageId: 'om_official_card',
    currentPhase: 'streaming',
    ensureCardCreated: vi.fn(async () => {}),
    onPartialReply: vi.fn(async () => {}),
    onReasoningStream: vi.fn(async () => {}),
    onDeliver: vi.fn(async () => {}),
    onToolStart: vi.fn(async () => {}),
    onToolPayload: vi.fn(async () => {}),
    onIdle: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    abortCard: vi.fn(async () => {}),
    markFullyComplete: vi.fn(),
  };
}

function frame(text: string): AssistantStreamFrame {
  return {
    type: 'chunk',
    attemptId: LlmAttemptId('attempt-1'),
    revision: 1,
    index: 0,
    time: Date.now(),
    chunk: { type: 'text-delta', index: 0, text },
  };
}

function assistantMessage(text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: 1 as SessionEvent['seq'],
    time: Date.now(),
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test', model: 'test' },
      }),
    },
  };
}

function event<T extends SessionEvent['type']>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
  return { type, data, seq: 1, time: Date.now() } as SessionEvent<T>;
}

function inbound(text: string) {
  return {
    sender: { sender_id: { open_id: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, sender_type: 'user' },
    message: {
      message_id: 'om_inbound',
      chat_id: 'oc_chat',
      chat_type: 'p2p' as const,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: `${Date.now()}`,
    },
  };
}

describe('official Lark channel to DSH', () => {
  it('rejects a redelivered message after the channel restarts', async () => {
    const dir = await mkdtemp(join(process.cwd(), '_dev', 'dedup-'));
    temporary.push(dir);
    const sessions = new SessionStore(dir, dir);
    await sessions.load();
    const resolveAgent = vi.fn();
    const makeChannel = () => new LarkChannel({
      config: { dataDir: dir },
      officialConfig: { channels: { feishu: {} } },
      sessions,
      toolContexts: new OfficialToolContexts(),
      resolveAgent,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const first = makeChannel();
    const dispatch = vi
      .spyOn(first as unknown as { dispatch: (message: unknown) => Promise<void> }, 'dispatch')
      .mockResolvedValue(undefined);

    await first.receive(inbound('Only once'));
    await first.stop();
    const restarted = makeChannel();
    await restarted.receive(inbound('Only once'));
    await restarted.stop();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(resolveAgent).not.toHaveBeenCalled();
  });

  it('drives one DSH turn through the official controller without legacy cards', async () => {
    const dir = await mkdtemp(join(process.cwd(), '_dev', 'channel-'));
    temporary.push(dir);
    const sessions = new SessionStore(dir, dir);
    await sessions.load();
    const sessionId = sessions.get('oc_chat').sessionId;
    const official = controller();
    let channel!: LarkChannel;
    const agent = {
      followup: vi.fn(() => {
        void (async () => {
          channel.assistantFrame(sessionId, frame('Official answer'));
          await channel.sessionEvent(sessionId, assistantMessage('Official answer'));
          await channel.sessionEvent(
            sessionId,
            event('tool/call', {
              turn: 1,
              step: 1,
              callId: ToolCallId('call-1'),
              name: 'read',
              arguments: '{"file_path":"/tmp/a"}',
            }),
          );
          await channel.sessionEvent(
            sessionId,
            event('tool/result', {
              turn: 1,
              step: 1,
              message: createToolResultMessage({
                callId: ToolCallId('call-1'),
                isError: false,
                content: [{ type: 'text', text: 'ok' }],
              }),
            }),
          );
          channel.assistantFrame(sessionId, frame('Done'));
          await channel.sessionEvent(sessionId, assistantMessage('Done'));
          await channel.sessionEvent(
            sessionId,
            event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
          );
        })();
      }),
      cancel: vi.fn(),
    } as unknown as Agent;
    channel = new LarkChannel({
      config: { replyMode: 'streaming', dataDir: dir },
      officialConfig: {
        channels: { feishu: { appId: 'cli_test', appSecret: 'secret' } },
      },
      sessions,
      toolContexts: new OfficialToolContexts(),
      resolveAgent: async () => agent,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      streamFactory: () => official,
    });

    await channel.receive(inbound('Hello'));

    expect(agent.followup).toHaveBeenCalledOnce();
    expect(official.onPartialReply).toHaveBeenCalledWith({ text: 'Official answer' });
    expect(official.onToolStart).toHaveBeenCalledWith({ name: 'read', phase: 'start' });
    expect(official.onToolPayload).toHaveBeenCalledOnce();
    expect(official.onDeliver).toHaveBeenCalledWith({ text: 'Official answer\n\nDone' });
    expect(official.onIdle).toHaveBeenCalledOnce();
  });

  it('discards abandoned attempt text and keeps committed multi-step text', async () => {
    const dir = await mkdtemp(join(process.cwd(), '_dev', 'channel-'));
    temporary.push(dir);
    const sessions = new SessionStore(dir, dir);
    await sessions.load();
    const sessionId = sessions.get('oc_chat').sessionId;
    const official = controller();
    let channel!: LarkChannel;
    const agent = {
      followup: vi.fn(() => {
        void (async () => {
          channel.assistantFrame(sessionId, frame('Failed prefix'));
          channel.assistantFrame(sessionId, {
            type: 'end',
            attemptId: LlmAttemptId('attempt-1'),
            revision: 1,
            index: 1,
            outcome: { kind: 'abandoned' },
          });
          channel.assistantFrame(sessionId, {
            type: 'start',
            attemptId: LlmAttemptId('attempt-2'),
            revision: 1,
            turn: 1,
            step: 1,
          });
          channel.assistantFrame(sessionId, frame('Working'));
          await channel.sessionEvent(sessionId, assistantMessage('Working'));
          channel.assistantFrame(sessionId, {
            type: 'start',
            attemptId: LlmAttemptId('attempt-3'),
            revision: 1,
            turn: 1,
            step: 2,
          });
          channel.assistantFrame(sessionId, frame('Done'));
          await channel.sessionEvent(sessionId, assistantMessage('Done'));
          await channel.sessionEvent(
            sessionId,
            event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
          );
        })();
      }),
      cancel: vi.fn(),
    } as unknown as Agent;
    channel = new LarkChannel({
      config: { dataDir: dir },
      officialConfig: { channels: { feishu: {} } },
      sessions,
      toolContexts: new OfficialToolContexts(),
      resolveAgent: async () => agent,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      streamFactory: () => official,
    });

    await channel.receive(inbound('Retry'));

    expect(official.onPartialReply).not.toHaveBeenCalledWith({ text: 'Failed prefixWorking' });
    expect(official.onDeliver).toHaveBeenCalledWith({ text: 'Working\n\nDone' });
    expect(official.onIdle).toHaveBeenCalledOnce();
  });

  it('does not start the agent when stopped while creating the card', async () => {
    const dir = await mkdtemp(join(process.cwd(), '_dev', 'channel-'));
    temporary.push(dir);
    const sessions = new SessionStore(dir, dir);
    await sessions.load();
    let releaseCard!: () => void;
    const cardCreated = new Promise<void>((resolve) => {
      releaseCard = resolve;
    });
    const official = { ...controller(), ensureCardCreated: vi.fn(() => cardCreated) };
    const agent = { followup: vi.fn(), cancel: vi.fn() } as unknown as Agent;
    const channel = new LarkChannel({
      config: { dataDir: dir },
      officialConfig: { channels: { feishu: {} } },
      sessions,
      toolContexts: new OfficialToolContexts(),
      resolveAgent: async () => agent,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      streamFactory: () => official,
    });

    const receiving = channel.receive(inbound('Stop during startup'));
    await vi.waitFor(() => expect(official.ensureCardCreated).toHaveBeenCalledOnce());
    await channel.receive({
      ...inbound('/stop'),
      message: { ...inbound('/stop').message, message_id: 'om_stop' },
    });
    releaseCard();
    await receiving;

    expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.cancel).toHaveBeenCalledOnce();
    expect(official.abortCard).toHaveBeenCalledOnce();
  });

  it('answers /model commands immediately without driving the agent', async () => {
    const dir = await mkdtemp(join(process.cwd(), '_dev', 'channel-'));
    temporary.push(dir);
    const sessions = new SessionStore(dir, dir);
    await sessions.load();
    const resolveAgent = vi.fn();
    const models = { handle: vi.fn(async () => '模型列表') };
    const channel = new LarkChannel({
      config: { dataDir: dir },
      officialConfig: { channels: { feishu: {} } },
      sessions,
      toolContexts: new OfficialToolContexts(),
      resolveAgent,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      models,
    });
    const send = vi
      .spyOn(
        channel as unknown as { send: (chatId: string, text: string) => Promise<void> },
        'send',
      )
      .mockResolvedValue(undefined);

    await channel.receive(inbound('/model'));

    expect(models.handle).toHaveBeenCalledWith('oc_chat', '/model');
    expect(send).toHaveBeenCalledWith('oc_chat', '模型列表');
    expect(resolveAgent).not.toHaveBeenCalled();
  });
});
