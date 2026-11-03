import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WeixinStateStore } from '../src/protocol/state.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore(accountId = 'main'): Promise<{ store: WeixinStateStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-state-'));
  dirs.push(dir);
  return { store: new WeixinStateStore(dir, accountId), dir };
}

describe('WeixinStateStore', () => {
  it('round-trips account credentials with 0600 permissions', async () => {
    const { store } = await freshStore();
    await store.saveAccount({ accountId: 'main', botId: 'bot-1', token: 'secret-token', baseUrl: 'https://x' });
    expect(await store.loadAccount()).toEqual({ accountId: 'main', botId: 'bot-1', token: 'secret-token', baseUrl: 'https://x' });
    const mode = (await stat(join(store.root, 'credentials.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns undefined for missing or malformed credentials', async () => {
    const { store } = await freshStore();
    expect(await store.loadAccount()).toBeUndefined();
    await writeFile(join(store.root, 'credentials.json'), '{nope', 'utf8');
    expect(await store.loadAccount()).toBeUndefined();
  });

  it('commits and reloads the cursor atomically', async () => {
    const { store } = await freshStore();
    expect(await store.loadCursor()).toBe('');
    await store.commitCursor('buf-1');
    expect(await store.loadCursor()).toBe('buf-1');
    await store.commitCursor('buf-2');
    expect(await store.loadCursor()).toBe('buf-2');
  });

  it('ignores leftover temporary files after a simulated crash', async () => {
    const { store } = await freshStore();
    await store.commitCursor('committed');
    await writeFile(join(store.root, 'get_updates_buf.json.99999.tmp'), '{"cursor":"half"}', 'utf8');
    expect(await store.loadCursor()).toBe('committed');
  });

  it('treats a corrupted cursor file as an empty cursor', async () => {
    const { store } = await freshStore();
    await store.commitCursor('good');
    await writeFile(join(store.root, 'get_updates_buf.json'), '{not-json', 'utf8');
    expect(await store.loadCursor()).toBe('');
  });

  it('isolates and persists context tokens per subject', async () => {
    const { store } = await freshStore();
    await store.setContextToken('user-a', 'token-a1');
    await store.setContextToken('user-b', 'token-b1');
    await store.setContextToken('user-a', 'token-a2');
    expect(await store.getContextToken('user-a')).toBe('token-a2');
    expect(await store.getContextToken('user-b')).toBe('token-b1');
    const raw = JSON.parse(await readFile(join(store.root, 'context-tokens.json'), 'utf8')) as Record<string, string>;
    expect(raw['user-a']).toBe('token-a2');
    expect(raw['user-b']).toBe('token-b1');
  });

  it('deduplicates message IDs durably and sweeps expired entries', async () => {
    const { store } = await freshStore();
    expect(await store.rememberMessage('m-1', 1_000)).toBe(true);
    expect(await store.rememberMessage('m-1', 2_000)).toBe(false);
    expect(await store.rememberMessage('m-2', 2_000)).toBe(true);
    // m-1 crossed the TTL boundary: recording it again is legitimate.
    expect(await store.rememberMessage('m-1', 1_000 + 13 * 60 * 60 * 1000)).toBe(true);
  });

  it('rejects malformed account ids', () => {
    expect(() => new WeixinStateStore('/tmp/x', '../escape')).toThrow(/invalid/);
    expect(() => new WeixinStateStore('/tmp/x', 'ok')).not.toThrow();
  });
});
