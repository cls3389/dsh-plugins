import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSessionToGlobalRegistry } from '../src/workspace-registry.js';

const dirs: string[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.DSH_HOME;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ home: string; registryPath: string; userPath: string }> {
  const home = await mkdtemp(join(tmpdir(), 'wechat-registry-'));
  dirs.push(home);
  await mkdir(join(home, 'storages'), { recursive: true });
  const registryPath = join(home, 'storages', 'workspace.json');
  const userPath = join(home, 'agents', 'gtjs', 'users', 'u_abc123');
  await mkdir(userPath, { recursive: true });
  process.env.DSH_HOME = home;
  return { home, registryPath, userPath };
}

describe('attachSessionToGlobalRegistry', () => {
  it('appends the sessionId to an existing user workspace entry (idempotent)', async () => {
    const f = await fixture();
    await writeFile(f.registryPath, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w1'] },
      tables: { workspaces: { w1: { path: f.userPath, title: '用户 u_abc · 狗头军师', sessionIds: ['lark-1'], createdAt: 't', updatedAt: 't' } } },
    }), 'utf8');
    await attachSessionToGlobalRegistry({ userPath: f.userPath, sessionId: 'wechat-1', title: '用户 u_abc · 狗头军师' });
    const after = JSON.parse(await readFile(f.registryPath, 'utf8'));
    expect(after.tables.workspaces.w1.sessionIds).toEqual(['wechat-1', 'lark-1']);
    // 幂等：重复 attach 不产生重复项。
    await attachSessionToGlobalRegistry({ userPath: f.userPath, sessionId: 'wechat-1', title: 'x' });
    const again = JSON.parse(await readFile(f.registryPath, 'utf8'));
    expect(again.tables.workspaces.w1.sessionIds).toEqual(['wechat-1', 'lark-1']);
  });

  it('matches an existing entry through a symlinked path spelling (idempotent across spellings)', async () => {
    const f = await fixture();
    await writeFile(f.registryPath, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w1'] },
      tables: { workspaces: { w1: { path: f.userPath, title: '用户 u_abc · 狗头军师', sessionIds: ['lark-1'], createdAt: 't', updatedAt: 't' } } },
    }), 'utf8');
    // 用真实 realpath 形态的等价拼写(测试目录无软链,canonical 后相等)。
    const alt = `${f.userPath}/../u_abc123`;
    await attachSessionToGlobalRegistry({ userPath: alt, sessionId: 'wechat-2', title: 'x' });
    const after = JSON.parse(await readFile(f.registryPath, 'utf8'));
    expect(Object.keys(after.tables.workspaces)).toEqual(['w1']); // 不分家
    expect(after.tables.workspaces.w1.sessionIds).toEqual(['wechat-2', 'lark-1']);
  });

  it('creates the user workspace entry when absent and registers it in the order list', async () => {
    const f = await fixture();
    await writeFile(f.registryPath, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [] },
      tables: { workspaces: {} },
    }), 'utf8');
    await attachSessionToGlobalRegistry({ userPath: f.userPath, sessionId: 'wechat-9', title: '用户 u_abc · 狗头军师' });
    const after = JSON.parse(await readFile(f.registryPath, 'utf8'));
    const entries = Object.values(after.tables.workspaces) as Array<{ path?: string; sessionIds?: string[]; title?: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe(f.userPath);
    expect(entries[0]!.sessionIds).toEqual(['wechat-9']);
    expect(entries[0]!.title).toBe('用户 u_abc · 狗头军师');
    expect(after.global.workspaceIds).toHaveLength(1);
  });

  it('is a no-op when the global registry does not exist yet', async () => {
    const f = await fixture();
    // 不写注册表文件。
    await expect(attachSessionToGlobalRegistry({ userPath: f.userPath, sessionId: 'w', title: 'x' })).resolves.toBeUndefined();
    const after = JSON.parse(await readFile(f.registryPath, 'utf8').catch(() => 'null'));
    expect(after).toBeNull();
  });
});
