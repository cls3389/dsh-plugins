import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceForIdentity } from '@dsh-friends/feishu-principal';
import { SessionStore } from '../src/session-store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-sessions-'));
  dirs.push(dir);
  let userId = 'u_first';
  const resolver = vi.fn(() => userId);
  const store = new SessionStore(dir, dir, join(dir, 'agents'), resolver);
  store.setIdentity('gtjs', 'trusted-bot');
  return { dir, store, resolver, setUser: (value: string) => { userId = value; } };
}
const cwd = (userId: string) => workspaceForIdentity('/unused/gtjs', { userId, agentId: 'gtjs' });

describe('trusted session archive ownership', () => {
  it('refreshes both cwd and userId after identity changes using a single resolution', async () => {
    const f = await fixture();
    await f.store.load();
    const original = f.store.get('chat', 'subject');
    f.setUser('u_bound');
    f.resolver.mockClear();
    const rebound = f.store.get('chat', 'subject');
    expect(rebound).toMatchObject({ sessionId: original.sessionId, userId: 'u_bound', cwd: cwd('u_bound') });
    expect(f.resolver).toHaveBeenCalledExactlyOnceWith({ appId: 'trusted-bot', subjectId: 'subject' });
    f.resolver.mockClear();
    expect(f.store.reset('chat', 'subject')).toMatchObject({ userId: 'u_bound', cwd: cwd('u_bound') });
    expect(f.resolver).toHaveBeenCalledTimes(1);
  });

  it('rebinds persisted stale owner/path before exposing or saving loaded sessions', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, 'sessions.json'), JSON.stringify({ chat: {
      sessionId: 'old-session', subjectId: 'subject', userId: 'u_stale', cwd: '/old/agents/users/stale',
    } }));
    f.setUser('u_current');
    await f.store.load();
    expect(f.store.listBindings()).toEqual([expect.objectContaining({
      sessionId: 'old-session', userId: 'u_current', cwd: cwd('u_current'),
    })]);
    await f.store.save();
    const registry = JSON.parse(await readFile(join(f.dir, 'workspace.json'), 'utf8'));
    expect(Object.keys(registry.users)).toEqual(['u_current']);
    expect(registry.users.u_current.path).toBe(cwd('u_current'));
  });
});
