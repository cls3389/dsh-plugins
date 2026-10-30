import { describe, expect, it, vi } from 'vitest';
import {
  type OfficialTurnController,
  type OfficialTurnControllerFactory,
  OfficialTurnStream,
} from '../src/streaming.js';
import { getToolUseTraceSteps } from '../vendor/openclaw-lark/dist/card/tool-use-trace-store.js';
import { StreamingCardController } from '../vendor/openclaw-lark/dist/card/streaming-card-controller.js';

function fakeController() {
  return {
    cardMessageId: 'om_official_card',
    currentPhase: 'streaming',
    ensureCardCreated: vi.fn(async () => {}),
    onPartialReply: vi.fn(async (_payload: { text: string }) => {}),
    onReasoningStream: vi.fn(async (_payload: { text: string }) => {}),
    onDeliver: vi.fn(async (_payload: { text: string }) => {}),
    onToolStart: vi.fn(async (_payload: { name: string; phase: 'start' }) => {}),
    onToolPayload: vi.fn(async (_payload: { text: string }) => {}),
    onIdle: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    abortCard: vi.fn(async () => {}),
    markFullyComplete: vi.fn(),
  } satisfies OfficialTurnController;
}

describe('official CardKit turn stream', () => {
  it('passes cumulative snapshots and completes in official order', async () => {
    const controller = fakeController();
    let dependencies!: Parameters<OfficialTurnControllerFactory>[0];
    const stream = new OfficialTurnStream(
      'session-1',
      'oc_chat',
      'om_inbound',
      { channels: { feishu: {} } },
      (deps) => {
        dependencies = deps;
        return controller;
      },
    );
    await stream.start();
    await stream.text('Hello');
    await stream.text('Hello world');
    await stream.reasoning('Thinking');
    await stream.complete('Hello world');

    expect(controller.ensureCardCreated).toHaveBeenCalledOnce();
    expect(controller.onPartialReply.mock.calls.map((call) => call[0].text)).toEqual([
      'Hello',
      'Hello world',
    ]);
    expect(controller.onReasoningStream).not.toHaveBeenCalled();
    expect(dependencies.resolvedFooter).toEqual({
      status: false,
      elapsed: false,
      tokens: false,
      cache: false,
      context: false,
      model: false,
    });
    expect(controller.onDeliver).toHaveBeenCalledWith({ text: 'Hello world' });
    expect(controller.markFullyComplete).toHaveBeenCalledOnce();
    expect(controller.onIdle).toHaveBeenCalledOnce();
    expect(
      (controller.markFullyComplete.mock.invocationCallOrder[0] ?? 0) <
        (controller.onIdle.mock.invocationCallOrder[0] ?? 0),
    ).toBe(true);
  });

  it('records official tool traces and forwards cancellation', async () => {
    const controller = fakeController();
    const stream = new OfficialTurnStream(
      'session-2',
      'oc_chat',
      'om_inbound',
      { channels: { feishu: {} } },
      () => controller,
    );
    await stream.start();
    await stream.toolStart({ name: 'read', callId: 'call-1', params: { file_path: '/tmp/a' } });
    await stream.toolEnd({
      name: 'read',
      callId: 'call-1',
      params: { file_path: '/tmp/a' },
      result: 'ok',
      error: undefined,
      durationMs: 1,
    });
    const steps = getToolUseTraceSteps('session-2');
    await stream.abort();

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ toolCallId: 'call-1', status: 'success', result: 'ok' });
    expect(controller.onToolStart).toHaveBeenCalledWith({ name: 'read', phase: 'start' });
    expect(controller.onToolPayload).toHaveBeenCalledOnce();
    expect(controller.abortCard).toHaveBeenCalledOnce();
  });

  it('refreshes CardKit tool status even after answer streaming has started', async () => {
    const controller = new StreamingCardController({
      cfg: { channels: { feishu: {} } },
      accountId: undefined,
      replyToMessageId: 'om_inbound',
      sessionKey: 'session-live-tools',
      toolUseDisplay: { showToolUse: true },
    } as unknown as ConstructorParameters<typeof StreamingCardController>[0]);
    const internal = controller as unknown as {
      phase: string;
      cardKit: { cardMessageId: string | null; cardKitCardId: string | null };
      text: { accumulatedText: string };
      ensureCardCreated: () => Promise<void>;
      throttledToolUseStatusUpdate: () => Promise<void>;
      throttledCardUpdate: () => Promise<void>;
    };
    internal.phase = 'streaming';
    internal.cardKit.cardMessageId = 'om_card';
    internal.cardKit.cardKitCardId = 'card_id';
    internal.text.accumulatedText = 'Already streamed answer';
    internal.ensureCardCreated = vi.fn(async () => {});
    internal.throttledToolUseStatusUpdate = vi.fn(async () => {});
    internal.throttledCardUpdate = vi.fn(async () => {});

    await controller.onToolStart({ name: 'read', phase: 'start' });
    await controller.onToolPayload({ text: '' });

    expect(internal.throttledToolUseStatusUpdate).toHaveBeenCalledTimes(2);
    expect(internal.throttledCardUpdate).not.toHaveBeenCalled();
  });
});
