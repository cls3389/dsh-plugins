import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkChannel } from '../src/channel.js';
import { SessionStore } from '../src/session-store.js';
import { OfficialToolContexts } from '../src/tools.js';
import type { OfficialTurnController } from '../src/streaming.js';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const ev = (type: string, data: unknown) => ({ type, data, seq: 1, time: Date.now() }) as SessionEvent;
const owner = 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
async function fixture(dir?: string, store?: SessionStore) {
  dir ??= await mkdtemp(join(tmpdir(), 'feishu-notifications-'));
  if (!directories.includes(dir)) directories.push(dir);
  vi.stubEnv('DSH_HOME', dir);
  const sessions = store ?? new SessionStore(dir, dir);
  await sessions.load();
  const binding = sessions.get('oc_test', owner, undefined, 'on_union');
  await sessions.save();
  const controllers: OfficialTurnController[] = [];
  const history: SessionEvent[] = [];
  const contexts = new OfficialToolContexts();
  let channel!: LarkChannel;
  let release: (() => void) | undefined;
  let auto = true;
  const agent = {
    status: 'idle', session: { id: binding.sessionId, snapshotEvents: () => history },
    inbox: { nextTurn: [], nextStep: [] }, whenIdle: vi.fn(async () => {}), cancel: vi.fn(),
    followup: vi.fn((message) => {
      const turn = history.filter((event) => event.type === 'turn/start').length + 1;
      const finish = async () => {
        const events = [ev('turn/start', { turn }), ev('user/message', message), ev('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: `reply:${message.content[0].text}` }], source: { provider: 'test', model: 'test' } }) }), ev('turn/end', { turn, reason: { kind: 'completed' } })];
        for (const event of events) { history.push(event); await channel.sessionEvent(sessions.notificationTarget(binding.sessionId)!.binding.sessionId, event); }
      };
      release = () => { void finish(); };
      if (auto) release();
    }),
  } as unknown as Agent;
  const factory = vi.fn((deps) => {
    const controller: OfficialTurnController = { cardMessageId: deps.notification?.state?.cardMessageId ?? `om_card_${controllers.length}`, currentPhase: 'streaming', ensureCardCreated: vi.fn(async () => { deps.notification?.checkpoint({ cardMessageId: controller.cardMessageId, cardKitCardId: 'card_entity', cardKitSequence: 1 }); }), onPartialReply: vi.fn(async () => {}), onReasoningStream: vi.fn(async () => {}), onDeliver: vi.fn(async () => {}), onToolStart: vi.fn(async () => {}), onToolPayload: vi.fn(async () => {}), onIdle: vi.fn(async () => {}), onError: vi.fn(async () => {}), abortCard: vi.fn(async () => {}), markFullyComplete: vi.fn() };
    controllers.push(controller); return controller;
  });
  channel = new LarkChannel({ config: { dataDir: dir, appId: 'cli_test' }, officialConfig: { channels: { feishu: {} } }, sessions, toolContexts: contexts, agentsRoot: dir, resolveAgent: vi.fn(async () => agent), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, streamFactory: factory });
  const input = { sessionId: binding.sessionId, ownerOpenId: owner, ownerAppId: 'cli_test', text: 'wake', eventId: 'ths-watch-event' };
  return { dir, sessions, channel, agent, controllers, contexts, factory, input, history, pause: () => { auto = false; }, release: () => release?.() };
}

describe('durable official Feishu notifications', () => {
  it('accepts durably before model settlement, sends proactive official card and terminal text, deduplicates retries', async () => {
    const f = await fixture(); f.pause(); f.channel.startNotifications();
    await f.channel.deliverNotification(f.input);
    expect(JSON.parse(await readFile(join(f.dir, 'notifications.json'), 'utf8')).records[0].status).toBe('accepted');
    await vi.waitFor(() => expect(f.agent.followup).toHaveBeenCalledOnce());
    expect(f.factory.mock.calls[0]![0].replyToMessageId).toBeUndefined();
    expect(f.agent.followup).toHaveBeenCalledWith(expect.objectContaining({ id: f.input.eventId, source: { kind: 'schedule' } }));
    expect(f.contexts.get(f.input.sessionId)).toMatchObject({ chatId: 'oc_test', senderOpenId: owner, accountId: 'default', senderUnionId: 'on_union' });
    await f.channel.deliverNotification(f.input);
    f.release();
    await vi.waitFor(() => expect(f.channel.notificationStatus()[0]?.status).toBe('completed'));
    expect(f.controllers[0]!.onDeliver).toHaveBeenCalledWith({ text: 'reply:wake' });
    expect(f.controllers[0]!.onIdle).toHaveBeenCalledOnce();
    await f.channel.deliverNotification(f.input);
    expect(f.agent.followup).toHaveBeenCalledOnce();
    await f.channel.stop();
  });

  it('rejects owner, app, unknown session and event payload reuse without creating bindings', async () => {
    const f = await fixture();
    for (const input of [{ ...f.input, ownerOpenId: 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, { ...f.input, ownerAppId: 'cli_other' }, { ...f.input, sessionId: 'lark_missing' }]) await expect(f.channel.deliverNotification(input)).rejects.toThrow();
    expect(f.channel.notificationStatus()).toEqual([]);
    await f.channel.deliverNotification(f.input);
    await expect(f.channel.deliverNotification({ ...f.input, text: 'different' })).rejects.toThrow('payload conflict');
    await f.channel.stop();
  });

  it('replays durable accepted records after restart and keeps completed event dedup', async () => {
    const f = await fixture(); await f.channel.deliverNotification(f.input); await f.channel.stop();
    const next = await fixture(f.dir, new SessionStore(f.dir, f.dir)); next.channel.startNotifications();
    await vi.waitFor(() => expect(next.channel.notificationStatus()[0]?.status).toBe('completed'));
    expect(next.agent.followup).toHaveBeenCalledOnce(); await next.channel.stop();
    const final = await fixture(f.dir, new SessionStore(f.dir, f.dir)); final.channel.startNotifications();
    await final.channel.deliverNotification(f.input); expect(final.agent.followup).not.toHaveBeenCalled(); await final.channel.stop();
  });

  it('serializes ordinary inbound behind a notification and ignores unrelated turn termination', async () => {
    const f = await fixture(); f.pause(); f.channel.startNotifications(); await f.channel.deliverNotification(f.input);
    await vi.waitFor(() => expect(f.agent.followup).toHaveBeenCalledOnce());
    await f.channel.sessionEvent(f.input.sessionId, ev('turn/end', { turn: 99, reason: { kind: 'completed' } }));
    expect(f.controllers[0]!.onIdle).not.toHaveBeenCalled();
    const ordinary = f.channel.receive({ sender: { sender_id: { open_id: owner }, sender_type: 'user' }, message: { message_id: 'om_inbound_serial', chat_id: 'oc_test', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'ordinary' }) } });
    await Promise.resolve(); expect(f.agent.followup).toHaveBeenCalledOnce(); f.release();
    await vi.waitFor(() => expect(f.agent.followup).toHaveBeenCalledTimes(2)); f.release(); await ordinary; await f.channel.stop();
  });

  it('retries card creation failure before followup and restores a persisted terminal result without another model turn', async () => {
    const f = await fixture();
    f.factory.mockImplementationOnce((deps) => { throw new Error('card transport unavailable'); });
    f.channel.startNotifications(); await f.channel.deliverNotification(f.input);
    await vi.waitFor(() => expect(f.channel.notificationStatus()[0]?.lastError).toContain('card transport unavailable'));
    expect(f.agent.followup).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.channel.notificationStatus()[0]?.status).toBe('completed'), { timeout: 2500 });
    expect(f.agent.followup).toHaveBeenCalledOnce();
    await f.channel.stop();
    const journal = JSON.parse(await readFile(join(f.dir, 'notifications.json'), 'utf8'));
    journal.records[0].status = 'running';
    await writeFile(join(f.dir, 'notifications.json'), JSON.stringify(journal));
    const next = await fixture(f.dir, new SessionStore(f.dir, f.dir)); next.channel.startNotifications();
    await vi.waitFor(() => expect(next.channel.notificationStatus()[0]?.status).toBe('completed'));
    expect(next.agent.followup).not.toHaveBeenCalled();
    expect(next.factory.mock.calls[0]![0].notification.state.cardMessageId).toBe(journal.records[0].card.cardMessageId);
    expect(next.controllers[0]!.onDeliver).toHaveBeenCalledWith({ text: 'reply:wake' }); await next.channel.stop();
  });

  it('does not acknowledge an enqueue whose journal cannot be persisted', async () => {
    const f = await fixture(); await mkdir(join(f.dir, 'notifications.json'));
    await expect(f.channel.deliverNotification(f.input)).rejects.toThrow();
    expect(f.channel.notificationStatus()).toEqual([]); expect(f.agent.followup).not.toHaveBeenCalled(); await f.channel.stop();
  });

  it('retains owner and union after reload/reset/clearModel and resolves only same-chat aliases', async () => {
    const f = await fixture();
    f.sessions.setModel('oc_test', { provider: 'test', model: 'test' }); f.sessions.clearModel('oc_test');
    const replacement = f.sessions.reset('oc_test', owner); await f.sessions.save();
    const loaded = new SessionStore(f.dir, f.dir); await loaded.load();
    expect(loaded.notificationTarget(f.input.sessionId)).toMatchObject({ chatId: 'oc_test', binding: { sessionId: replacement.sessionId, openId: owner, unionId: 'on_union' } });
    await f.channel.rebindPreviousSession({ sessionId: replacement.sessionId, previousSessionId: 'lark-old-evidence', ownerOpenId: owner, ownerAppId: 'cli_test' });
    const other = f.sessions.get('oc_other', 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await expect(f.channel.rebindPreviousSession({ sessionId: replacement.sessionId, previousSessionId: other.sessionId, ownerOpenId: owner, ownerAppId: 'cli_test' })).rejects.toThrow('another chat');
    f.channel.startNotifications(); await f.channel.deliverNotification(f.input);
    await vi.waitFor(() => expect(f.channel.notificationStatus()[0]?.status).toBe('completed')); await f.channel.stop();
  });
});
