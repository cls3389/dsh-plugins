import { StreamingCardController as OfficialCardController } from '../vendor/openclaw-lark/dist/card/streaming-card-controller.js';
import {
  recordToolUseEnd,
  recordToolUseStart,
  startToolUseTraceRun,
} from '../vendor/openclaw-lark/dist/card/tool-use-trace-store.js';
import type { LarkRuntimeConfig } from './runtime-config.js';

export interface OfficialTurnController {
  readonly cardMessageId: string | null;
  readonly currentPhase: string;
  ensureCardCreated(): Promise<void>;
  onPartialReply(payload: { text: string }): Promise<void>;
  onReasoningStream(payload: { text: string }): Promise<void>;
  onDeliver(payload: { text: string }): Promise<void>;
  onToolStart(payload: { name: string; phase: 'start' }): Promise<void>;
  onToolPayload(payload: { text: string }): Promise<void>;
  onIdle(): Promise<void>;
  onError(error: unknown, info: { kind: string }): Promise<void>;
  abortCard(): Promise<void>;
  markFullyComplete(): void;
}

export type OfficialTurnControllerFactory = (deps: {
  cfg: LarkRuntimeConfig;
  agentId: string;
  sessionKey: string;
  accountId: string | undefined;
  chatId: string;
  replyToMessageId: string;
  replyInThread: false;
  toolUseDisplay: {
    mode: 'on';
    showToolUse: true;
    showToolResultDetails: false;
    showFullPaths: false;
  };
  resolvedFooter: {
    status: false;
    elapsed: false;
    tokens: false;
    cache: false;
    context: false;
    model: false;
  };
}) => OfficialTurnController;

const defaultFactory: OfficialTurnControllerFactory = (deps) =>
  new OfficialCardController(
    deps as unknown as ConstructorParameters<typeof OfficialCardController>[0],
  ) as OfficialTurnController;

/** One official CardKit turn. No legacy card builder or legacy fallback exists here. */
export class OfficialTurnStream {
  private readonly controller: OfficialTurnController;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionKey: string,
    chatId: string,
    replyToMessageId: string,
    cfg: LarkRuntimeConfig,
    factory: OfficialTurnControllerFactory = defaultFactory,
    accountId?: string,
  ) {
    this.controller = factory({
      cfg,
      agentId: 'dsh',
      sessionKey,
      accountId,
      chatId,
      replyToMessageId,
      replyInThread: false,
      toolUseDisplay: {
        mode: 'on',
        showToolUse: true,
        showToolResultDetails: false,
        showFullPaths: false,
      },
      resolvedFooter: {
        status: false,
        elapsed: false,
        tokens: false,
        cache: false,
        context: false,
        model: false,
      },
    });
  }

  get phase(): string {
    return this.controller.currentPhase;
  }

  get messageId(): string | null {
    return this.controller.cardMessageId;
  }

  async start(): Promise<void> {
    startToolUseTraceRun(this.sessionKey);
    await this.controller.ensureCardCreated();
  }

  text(snapshot: string): Promise<void> {
    return this.enqueue(() => this.controller.onPartialReply({ text: snapshot }));
  }

  reasoning(_snapshot: string): Promise<void> {
    // DSH keeps reasoning available in its own session log; the Feishu card
    // intentionally presents only the answer and actual tool execution.
    return Promise.resolve();
  }

  toolStart(input: {
    name: string;
    callId: string | undefined;
    params: Record<string, unknown> | undefined;
  }): Promise<void> {
    return this.enqueue(async () => {
      recordToolUseStart({
        sessionKey: this.sessionKey,
        toolName: input.name,
        ...(input.callId !== undefined ? { toolCallId: input.callId } : {}),
        ...(input.params !== undefined ? { toolParams: input.params } : {}),
      });
      await this.controller.onToolStart({ name: input.name, phase: 'start' });
    });
  }

  toolEnd(input: {
    name: string;
    callId: string | undefined;
    params: Record<string, unknown> | undefined;
    result?: unknown;
    error: string | undefined;
    durationMs: number | undefined;
  }): Promise<void> {
    return this.enqueue(async () => {
      recordToolUseEnd({
        sessionKey: this.sessionKey,
        toolName: input.name,
        ...(input.callId !== undefined ? { toolCallId: input.callId } : {}),
        ...(input.params !== undefined ? { toolParams: input.params } : {}),
        result: input.result,
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      });
      await this.controller.onToolPayload({ text: '' });
    });
  }

  complete(answer: string): Promise<void> {
    return this.enqueue(async () => {
      if (answer.trim()) await this.controller.onDeliver({ text: answer });
      this.controller.markFullyComplete();
      await this.controller.onIdle();
    });
  }

  fail(error: unknown): Promise<void> {
    return this.enqueue(() => this.controller.onError(error, { kind: 'turn' }));
  }

  abort(): Promise<void> {
    return this.enqueue(() => this.controller.abortCard());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}
