import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
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
    async detachSession(id) {
      this.sessionIds = this.sessionIds.filter((sessionId) => sessionId !== id);
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
    users: {},
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
    sessionIds: ['lark-current'],
    users: { aaaaaaaaaaaaaaaaaaaaaaaa: { displayName: 'Alice', path: join(directory, 'app', 'users', 'user-hash'), sessionIds: ['lark-user'] } },
  }));
  const userPath = join(appPath, 'users', 'user-hash');
  await mkdir(userPath, { recursive: true });
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
        { header: { id: 'lark-user', cwd: userPath } },
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
  const canonicalUserPath = await realpath(userPath);
  const userWorkspace = workspaces.find((workspace) => workspace.path === canonicalUserPath);
  assert.equal(userWorkspace.title, 'Alice');
  assert.deepEqual(userWorkspace.sessionIds, ['lark-user']);
  assert.equal(workspaces.some((workspace) => workspace.path.startsWith('lark://')), false);
  assert.deepEqual(ordinary.sessionIds, ['session-web']);
  const appWorkspace = workspaces.find((workspace) => workspace.path === result.path);
  assert.equal(appWorkspace.title, 'Bot');
  const canonicalDirectory = await realpath(directory);
  const parentWorkspace = workspaces.find((workspace) => workspace.path === canonicalDirectory);
  assert.equal(parentWorkspace.title, '飞书应用');
  assert.deepEqual(parentWorkspace.sessionIds, []);

  appWorkspace.title = 'My custom name';
  const count = workspaces.length;
  await syncRegistries(ctx, [registryPath]);
  assert.equal(appWorkspace.title, 'My custom name');
  assert.equal(workspaces.length, count);
});
