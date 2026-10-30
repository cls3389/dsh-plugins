import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session-store.js';

describe('SessionStore workspace registry', () => {
  it('persists secret-free app identity and every known session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    store.setAppIdentity('cli_example', 'Test Bot');
    const first = store.get('chat-one');
    const second = store.get('chat-two');

    await store.save();

    const registry = JSON.parse(
      await readFile(join(directory, 'workspace.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(registry).toMatchObject({
      version: 2,
      appId: 'cli_example',
      appName: 'Test Bot',
      path: join(directory, 'apps', 'cli_example'),
      sessionIds: [first.sessionId, second.sessionId],
    });
    expect(registry).not.toHaveProperty('appSecret');
    expect(first.cwd).toBe(join(directory, 'apps', 'cli_example'));
    expect(second.cwd).toBe(join(directory, 'apps', 'cli_example'));
  });

  it('uses a visible fallback app name and includes reset sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    store.setAppIdentity('cli_example', '  ');
    const replacement = store.reset('chat-one');

    await store.save();

    const registry = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as {
      appName: string;
      sessionIds: string[];
    };
    expect(registry.appName).toBe('飞书应用');
    expect(registry.sessionIds).toEqual([replacement.sessionId]);
  });

  it('isolates user workspaces across chats and moves an existing chat by sender', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    store.setAppIdentity('cli_example', 'Test Bot');
    const a = store.get('shared-chat', 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = store.get('shared-chat', 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const aAgain = store.get('shared-chat', 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(a.sessionId).toBe(b.sessionId);
    expect(aAgain.sessionId).toBe(a.sessionId);
    expect(a.cwd).not.toBe(b.cwd);
    expect(aAgain.cwd).toBe(a.cwd);
    expect(a.cwd).not.toContain('ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await store.save();
    const registry = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
    expect(registry.sessionIds).toEqual([]);
    expect(Object.values(registry.users as Record<string, { sessionIds: string[] }>).flatMap((user) => user.sessionIds)).toEqual([a.sessionId]);
  });

  it('keeps existing sessions at their original cwd and excludes them from the new app workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    const historical = store.get('chat-one');
    store.setAppIdentity('cli_example', 'Test Bot');

    await store.save();

    expect(store.get('chat-one')).toEqual(historical);
    const registry = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as {
      sessionIds: string[];
    };
    expect(registry.sessionIds).toEqual([]);
  });
});
