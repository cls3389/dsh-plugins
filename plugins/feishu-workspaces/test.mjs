import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRegistry, syncRegistries } from './main.js';

function entity(path, title, sessionIds = []) {
  return {
    id: path,
    path,
    title,
    sessionIds,
    async setTitle(value) {
      this.title = value;
    },
    async attachSession(id) {
      if (!this.sessionIds.includes(id)) this.sessionIds.unshift(id);
    },
  };
}

test('readRegistry validates and normalizes a real directory workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-workspaces-'));
  const path = join(directory, 'workspace.json');
  await writeFile(path, JSON.stringify({
    version: 2,
    appId: ' cli_app ',
    appName: ' Bot ',
    path: join(directory, 'app'),
    sessionIds: ['lark-1', 'lark-1'],
  }));
  assert.deepEqual(await readRegistry(path), {
    appId: 'cli_app',
    appName: 'Bot',
    path: join(directory, 'app'),
    sessionIds: ['lark-1'],
  });
});

test('syncRegistries creates the directory and adopts only listed same-cwd sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-workspaces-'));
  const appPath = join(directory, 'app');
  const registryPath = join(directory, 'workspace.json');
  await writeFile(registryPath, JSON.stringify({
    version: 2,
    appId: 'cli_app',
    appName: 'Bot',
    path: appPath,
    sessionIds: ['lark-current', 'lark-old'],
  }));
  const legacy = entity('lark://cli_app', 'Bot', ['lark-old']);
  const ordinary = entity('/repo', 'Repo', ['session-web']);
  const workspaces = [legacy, ordinary];
  const ctx = {
    workspaceRegistry: {
      list: () => workspaces,
      async create(path, title) {
        const created = entity(path, title);
        workspaces.push(created);
        return created;
      },
      async delete(id) {
        const index = workspaces.findIndex((workspace) => workspace.id === id);
        if (index >= 0) workspaces.splice(index, 1);
      },
    },
    sessionPersistence: {
      list: async () => [
        { header: { id: 'session-web', cwd: '/repo' } },
        { header: { id: 'lark-current', cwd: appPath } },
        { header: { id: 'lark-old', cwd: '/legacy' } },
        { header: { id: 'lark-unlisted', cwd: appPath } },
      ],
    },
    get: () => undefined,
  };

  const [result] = await syncRegistries(ctx, [registryPath]);

  assert.equal(result.workspaceId, await realpath(appPath));
  assert.equal(result.path, await realpath(appPath));
  assert.deepEqual(result.sessionIds, ['lark-current']);
  assert.equal(workspaces.some((workspace) => workspace.path.startsWith('lark://')), false);
  assert.deepEqual(ordinary.sessionIds, ['session-web']);
  assert.equal(workspaces[1].title, 'cli_app');

  workspaces[1].title = 'My custom name';
  await syncRegistries(ctx, [registryPath]);
  assert.equal(workspaces[1].title, 'My custom name');
});
