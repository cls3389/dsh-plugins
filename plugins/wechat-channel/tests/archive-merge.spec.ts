import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeArchive, type ArchiveMergeScope } from '../src/archive-merge.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const usersRoot = await mkdtemp(join(tmpdir(), 'wechat-merge-'));
  dirs.push(usersRoot);
  const scope: ArchiveMergeScope = { usersRoot, agentId: 'gtjs', oldUserId: 'u_old', targetUserId: 'u_target' };
  return { scope, old: join(usersRoot, 'u_old', 'gtjs'), target: join(usersRoot, 'u_target', 'gtjs') };
}
async function file(path: string, content = 'old') {
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe('scoped archive copy', () => {
  it('copies workspace and memory, preserves repeated conflicts and excludes owner config', async () => {
    const f = await fixture();
    await file(join(f.old, 'workspace', 'note.md'));
    await file(join(f.old, 'memory', 'topics', 'prefs.md'), 'memory');
    await file(join(f.old, 'config.yaml'), 'permissions');
    await file(join(f.scope.usersRoot, 'u_old', 'other', 'memory', 'secret.md'), 'other agent');
    await file(join(f.target, 'workspace', 'note.md'), 'target');
    await file(join(f.target, 'workspace', 'note.md.wechat-side'), 'previous conflict');
    const result = await mergeArchive(f.scope);
    expect(result.status).toBe('merged');
    expect(result.copiedFiles).toBe(2);
    expect(await readFile(join(f.target, 'workspace', 'note.md'), 'utf8')).toBe('target');
    expect(await readFile(join(f.target, 'workspace', 'note.md.wechat-side'), 'utf8')).toBe('previous conflict');
    expect(await readFile(join(f.target, 'workspace', 'note.md.wechat-side.2'), 'utf8')).toBe('old');
    expect(await readFile(join(f.target, 'memory', 'topics', 'prefs.md'), 'utf8')).toBe('memory');
    expect(await readdir(f.target)).toEqual(['memory', 'workspace']);
    expect(await readFile(join(f.old, 'workspace', 'note.md'), 'utf8')).toBe('old');
  });

  it('reports missing and same-root archives without creating target trees', async () => {
    const f = await fixture();
    expect((await mergeArchive(f.scope)).status).toBe('source_missing');
    expect(await readdir(f.scope.usersRoot)).toEqual([]);
    expect((await mergeArchive({ ...f.scope, targetUserId: 'u_old' })).status).toBe('same_root');
    expect((await mergeArchive()).status).toBe('skipped');
  });

  it('allows a trusted root alias while keeping owner paths below the canonical root', async () => {
    const f = await fixture();
    const aliasParent = await mkdtemp(join(tmpdir(), 'wechat-root-alias-'));
    dirs.push(aliasParent);
    const alias = join(aliasParent, 'users');
    await symlink(f.scope.usersRoot, alias);
    await file(join(f.old, 'memory', 'note'), 'memory');
    const result = await mergeArchive({ ...f.scope, usersRoot: alias });
    expect(result.status).toBe('merged');
    expect(await readFile(join(f.target, 'memory', 'note'), 'utf8')).toBe('memory');
  });

  it('never follows source links or target directory links', async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'wechat-outside-'));
    dirs.push(outside);
    await file(join(outside, 'secret'), 'outside');
    await file(join(f.old, 'workspace', 'safe'), 'safe');
    await symlink(outside, join(f.old, 'memory'));
    await symlink(join(outside, 'secret'), join(f.old, 'workspace', 'link'));
    await mkdir(join(f.target, 'workspace'), { recursive: true });
    await symlink(outside, join(f.target, 'workspace', 'directory'));
    await file(join(f.old, 'workspace', 'directory', 'escaped'));
    const result = await mergeArchive(f.scope);
    expect(result.status).toBe('partial');
    expect(result.copiedFiles).toBe(1);
    expect(await readdir(outside)).toEqual(['secret']);
    expect(await readFile(join(f.target, 'workspace', 'safe'), 'utf8')).toBe('safe');
  });

  it('rejects a symlink in the owner root and preserves destination symlink files as conflicts', async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'wechat-outside-'));
    dirs.push(outside);
    await file(join(f.old, 'workspace', 'note'));
    await symlink(outside, join(f.scope.usersRoot, 'u_target'));
    expect((await mergeArchive(f.scope)).status).toBe('failed');
    expect(await readdir(outside)).toEqual([]);

    const other = await fixture();
    await file(join(other.old, 'workspace', 'note'));
    await file(join(outside, 'secret'), 'unchanged');
    await mkdir(join(other.target, 'workspace'), { recursive: true });
    await symlink(join(outside, 'secret'), join(other.target, 'workspace', 'note'));
    const result = await mergeArchive(other.scope);
    expect(result.status).toBe('merged');
    expect(result.conflicts).toHaveLength(1);
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('unchanged');
    expect(await readFile(join(other.target, 'workspace', 'note.wechat-side'), 'utf8')).toBe('old');
  });
});
