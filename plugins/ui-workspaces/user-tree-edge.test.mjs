import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncRegistries } from './main.js';

async function fixture({ empty = false, staleClaim = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-tree-edge-'));
  const agent = join(dir, 'agents', 'investment');
  const user = join(dir, 'users', 'u_alice', 'investment', 'workspace');
  await mkdir(agent, { recursive: true });
  await mkdir(user, { recursive: true });
  const registry = join(dir, 'registry.json');
  await writeFile(registry, JSON.stringify({ version: 2, agentId: 'investment', appName: '投资助手', path: agent,
    sessionIds: empty ? [] : ['missing'],
    users: empty ? {} : { u_alice: { displayName: 'Alice · 投资助手', path: user, sessionIds: staleClaim ? ['original'] : [] } },
  }));
  const operations = [];
  function entity(path, title, sessionIds = []) {
    return { id: path, path, title, sessionIds,
      async setTitle(title) { this.title = title; },
      async attachSession(id) { operations.push(['attach', id]); this.sessionIds.push(id); },
      async detachSession(id) { operations.push(['detach', id]); this.sessionIds = this.sessionIds.filter(value => value !== id); },
    };
  }
  const items = [entity(join(dir, 'offline-project'), 'Offline project'), entity(user, '用户 研究项目')];
  if (staleClaim) items.push(entity(agent, '投资助手', ['original']));
  const ctx = { workspaceRegistry: {
    list: () => items,
    async create(path, title) { operations.push(['create', path]); const value = entity(path, title); items.push(value); return value; },
    async delete(id) { operations.push(['delete', id]); const index = items.findIndex(value => value.id === id); if (index >= 0) items.splice(index, 1); },
  }, sessionPersistence: { list: async () => staleClaim ? [{ header: { id: 'original', cwd: agent } }] : [] }, get: () => undefined };
  return { ctx, items, operations, registry, user, agent };
}

test('all-empty registries create no template groups and preserve unavailable custom projects', async () => {
  const f = await fixture({ empty: true });
  await syncRegistries(f.ctx, [f.registry]);
  assert.deepEqual(f.operations, []);
  assert.equal(f.items[0].title, 'Offline project');
});

test('stale root ids do not churn and custom identity titles survive', async () => {
  const f = await fixture();
  await syncRegistries(f.ctx, [f.registry]);
  f.operations.length = 0;
  await syncRegistries(f.ctx, [f.registry]);
  assert.deepEqual(f.operations, []);
  assert.equal(f.items.find(item => item.path === f.user).title, '用户 研究项目');
});

test('a stale user claim cannot detach a chat whose actual cwd belongs to the original group', async () => {
  const f = await fixture({ staleClaim: true });
  await syncRegistries(f.ctx, [f.registry]);
  assert.deepEqual(f.items.find(item => item.path === f.agent).sessionIds, ['original']);
  assert.equal(f.operations.some(([operation]) => operation === 'detach'), false);
});
