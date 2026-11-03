import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session-store.js';

describe('SessionStore workspace registry', () => {
  it('loads unnamed history before app initialization without writing an unscoped identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-history-'));
    const home = process.env.DSH_HOME!;
    const identitiesFile = join(home, 'identities.json');
    const before = await readFile(identitiesFile, 'utf8').catch(() => undefined);
    const openId = 'ou_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    await writeFile(join(directory, 'sessions.json'), JSON.stringify({ old: { sessionId: 'lark-old', cwd: directory, openId } }));
    const store = new SessionStore(directory, directory);
    await store.load();
    expect(await readFile(identitiesFile, 'utf8').catch(() => undefined)).toBe(before);
    expect(store.notificationTarget('lark-old')?.binding.openId).toBe(openId);
  });

  it('uses users.<userId>.displayName by a read-only scoped identity lookup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-configured-name-'));
    const home = process.env.DSH_HOME!;
    const openId = 'ou_ffffffffffffffffffffffffffffffff';
    const userId = 'u_configured_name';
    const identitiesFile = join(home, 'identities.json');
    const before = await readFile(identitiesFile, 'utf8').catch(() => undefined);
    const usersFile = join(home, 'lark', 'user-connections.json');
    const beforeUsers = await readFile(usersFile, 'utf8').catch(() => undefined);
    await mkdir(join(home, 'lark'), { recursive: true });
    await writeFile(identitiesFile, JSON.stringify({ users: { [userId]: { identities: [{ channel: 'feishu', appId: 'cli_configured', openId }] } } }));
    const identities = await readFile(identitiesFile, 'utf8');
    await writeFile(usersFile, JSON.stringify({ users: { [userId]: { displayName: '管理员指定名' } } }));
    try {
      await writeFile(join(directory, 'sessions.json'), JSON.stringify({ old: { sessionId: 'lark-name', cwd: directory, openId, displayName: '历史昵称' } }));
      const store = new SessionStore(directory, directory, join(directory, 'agents'));
      store.setAgentIdentity('goutoujunshi', 'Test Bot', 'cli_configured');
      await store.load();
      const binding = store.get('new', openId, '实时昵称');
      expect(binding.displayName).toBe('管理员指定名');
      await store.save();
      const registry = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
      expect(registry.users[userId].displayName).toBe('管理员指定名');
      expect(await readFile(identitiesFile, 'utf8')).toBe(identities);
    } finally {
      // These fixtures live only under the suite's isolated DSH_HOME.
      await writeFile(identitiesFile, before ?? JSON.stringify({ users: {} }));
      await writeFile(usersFile, beforeUsers ?? '{}');
    }
  });
  it('persists secret-free app identity and every known session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    store.setAgentIdentity('goutoujunshi', 'Test Bot', 'cli_example');
    const first = store.get('chat-one');
    const second = store.get('chat-two');

    await store.save();

    const registry = JSON.parse(
      await readFile(join(directory, 'workspace.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(registry).toMatchObject({
      version: 2,
      agentId: 'goutoujunshi',
      appId: 'cli_example',
      appName: 'Test Bot',
      path: join(directory, 'apps', 'goutoujunshi'),
      sessionIds: [first.sessionId, second.sessionId],
    });
    expect(registry).not.toHaveProperty('appSecret');
    expect(first.cwd).toBe(join(directory, 'apps', 'goutoujunshi'));
    expect(second.cwd).toBe(join(directory, 'apps', 'goutoujunshi'));
  });

  it('uses a visible fallback app name and includes reset sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    store.setAgentIdentity('goutoujunshi', '  ', 'cli_example');
    const replacement = store.reset('chat-one');

    await store.save();

    const registry = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as {
      appName: string;
      sessionIds: string[];
    };
    expect(registry.appName).toBe('goutoujunshi');
    expect(registry.sessionIds).toEqual([replacement.sessionId]);
  });

  it('isolates user workspaces across chats and moves an existing chat by sender', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-workspace-'));
    const store = new SessionStore(directory, '/workspace', join(directory, 'apps'));
    await store.load();
    store.setAgentIdentity('goutoujunshi', 'Test Bot', 'cli_example');
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
    store.setAgentIdentity('goutoujunshi', 'Test Bot', 'cli_example');

    await store.save();

    expect(store.get('chat-one')).toEqual(historical);
    const registry = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as {
      sessionIds: string[];
    };
    expect(registry.sessionIds).toEqual([]);
  });
});
