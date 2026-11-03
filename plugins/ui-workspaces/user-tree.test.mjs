import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncRegistries } from './main.js';

function workspace(path, title, sessionIds = []) {
  return {
    id: path, path, title, sessionIds,
    async setTitle(title) { this.title = title; },
    async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter(value => value !== id); },
  };
}

test('user tree groups shared users across identities, retains chats and custom names, and stays stable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-user-tree-'));
  const agents = join(directory, 'agents');
  const users = join(directory, 'users');
  const user = join(users, 'u_alice');
  const investing = join(user, 'investment', 'workspace');
  const interview = join(user, 'interview', 'workspace');
  const bob = join(users, 'u_bob', 'investment', 'workspace');
  for (const path of [investing, interview, bob, join(agents, 'investment'), join(agents, 'interview')]) await mkdir(path, { recursive: true });
  const files = [];
  for (const [agentId, appName, members] of [
    ['investment', '投资助手', { u_alice: { displayName: 'Alice · 投资助手', path: investing, sessionIds: ['a'] }, u_bob: { displayName: '用户 u_bob · 投资助手', path: bob, sessionIds: ['b'] } }],
    ['interview', '面试助手', { u_alice: { displayName: '用户 u_old · 面试助手', path: interview, sessionIds: ['c'] } }],
  ]) {
    const file = join(directory, agentId + '.json');
    files.push(file);
    await writeFile(file, JSON.stringify({ version: 2, agentId, appName, path: join(agents, agentId), sessionIds: [], users: members }));
  }
  const items = [workspace(agents, 'DSH Claw'), workspace(join(agents, 'investment'), '投资助手'), workspace(investing, 'Alice · 投资助手', ['a']), workspace('/ordinary-project', 'My project', ['ordinary'])];
  const headers = [{ id: 'a', cwd: investing }, { id: 'b', cwd: bob }, { id: 'c', cwd: interview }];
  const ctx = {
    workspaceRegistry: {
      list: () => items,
      async create(path, title) { const value = workspace(path, title); items.push(value); return value; },
      async delete(id) { const i = items.findIndex(value => value.id === id); if (i >= 0) items.splice(i, 1); },
    },
    sessionPersistence: { list: async () => headers.map(header => ({ header })) },
    get: () => undefined,
  };
  // The unrelated registered project must exist for the normal stale-path prune.
  items[3].path = directory;
  await syncRegistries(ctx, files);
  assert.equal(items.find(value => value.path === users).title, 'DSH Claw');
  assert.equal(items.find(value => value.path === user).title, 'Alice');
  assert.equal(items.find(value => value.path === investing).title, '投资助手');
  assert.deepEqual(items.find(value => value.path === investing).sessionIds, ['a']);
  assert.deepEqual(items.find(value => value.path === interview).sessionIds, ['c']);
  assert.deepEqual(items.find(value => value.path === bob).sessionIds, ['b']);
  assert.equal(items.some(value => value.path === agents || value.path === join(agents, 'investment')), false);
  assert.equal(items.find(value => value.path === directory).title, 'My project');
  assert.equal(items.filter(value => value.path === user).length, 1);
  const missing = join(directory, 'missing.json');
  await writeFile(missing, JSON.stringify({ version: 2, agentId: 'missing', appName: 'Missing', path: join(agents, 'missing'), sessionIds: [], users: {} }));
  files.push(missing);
  const customTemplate = workspace(join(agents, 'interview'), 'Custom templates');
  items.push(customTemplate);
  const count = items.length;
  items.find(value => value.path === users).title = 'My Claw';
  items.find(value => value.path === user).title = 'My Alice';
  items.find(value => value.path === interview).title = 'My interviews';
  await syncRegistries(ctx, files);
  assert.equal(items.length, count);
  assert.equal(items.includes(customTemplate), true);
  assert.equal(items.find(value => value.path === users).title, 'My Claw');
  assert.equal(items.find(value => value.path === user).title, 'My Alice');
  assert.equal(items.find(value => value.path === interview).title, 'My interviews');
  // A later chat from the channel is picked up without reparenting older chats.
  const data = JSON.parse(await readFile(files[1], 'utf8'));
  data.users.u_alice.sessionIds.push('new');
  headers.push({ id: 'new', cwd: interview });
  await writeFile(files[1], JSON.stringify(data));
  await syncRegistries(ctx, files);
  assert.deepEqual(items.find(value => value.path === interview).sessionIds, ['c', 'new']);
});
