import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkClient } from '../vendor/openclaw-lark/dist/core/lark-client.js';

interface FakeOptions {
  onReady?: () => void;
  onError?: (error: unknown) => void;
}
class FakeSocket {
  state = 'idle';
  constructor(readonly options: FakeOptions) {}
  handleEventData(): void {}
  getConnectionStatus() { return { state: this.state }; }
  start(): void {
    queueMicrotask(() => {
      if (this.state === 'closed') return;
      if (fakeOutage) {
        this.options.onError?.(new Error('temporary outage'));
        return;
      }
      this.state = 'connected';
      this.options.onReady?.();
    });
  }
  close(): void { this.state = 'closed'; }
}

const clients: LarkClient[] = [];
let fakeOutage = false;
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await LarkClient.clearCache();
  fakeOutage = false;
});

describe('Feishu WebSocket liveness', () => {
  it('recreates a failed socket, retries after an outage, and preserves abort', { timeout: 20000 }, async () => {
    await LarkClient.clearCache();
    const sockets: FakeSocket[] = [];
    const instance = LarkClient.fromCredentials(
      { accountId: 'test-recovery', appId: 'cli_test', appSecret: 'test' },
      { wsFactory: (params: FakeOptions) => {
        const socket = new FakeSocket(params);
        sockets.push(socket);
        return socket as never;
      } },
    );
    clients.push(instance);
    const abort = new AbortController();
    const starting = instance.startWS({ handlers: {}, abortSignal: abort.signal, autoProbe: false });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.state = 'idle';
    // Terminal error is the SDK's explicit non-recoverable notification.
    fakeOutage = true;
    sockets[0]!.options.onError?.(new Error('connection lost'));
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(3), { timeout: 12000 });
    fakeOutage = false;
    await starting;
    await vi.waitFor(() => expect(instance.wsConnected).toBe(true), { timeout: 12000 });
    const count = sockets.length;
    abort.abort();
    await vi.waitFor(() => expect(instance.wsConnected).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(count);
  });

  it('does not connect an already aborted initial attempt', async () => {
    await LarkClient.clearCache();
    const instance = LarkClient.fromCredentials(
      { accountId: 'test-abort', appId: 'cli_test', appSecret: 'test' },
      { wsFactory: (params: FakeOptions) => new FakeSocket(params) as never },
    );
    clients.push(instance);
    const abort = new AbortController();
    const starting = instance.startWS({ handlers: {}, abortSignal: abort.signal, autoProbe: false });
    abort.abort();
    await starting;
    expect(instance.wsConnected).toBe(false);
  });
});
