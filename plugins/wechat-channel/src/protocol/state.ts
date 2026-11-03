import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { WeixinAccount } from './types.js';

function safeAccountId(accountId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(accountId)) throw new Error('invalid Weixin accountId');
  return accountId.toLowerCase();
}

async function atomicJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as T;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    return fallback;
  }
}

export class WeixinStateStore {
  readonly root: string;
  private readonly accountPath: string;
  private readonly cursorPath: string;
  private readonly contextPath: string;
  private readonly dedupPath: string;
  private readonly allowlistPath: string;

  constructor(dataDir: string, accountId: string) {
    safeAccountId(accountId);
    this.root = resolve(dataDir);
    this.accountPath = join(this.root, 'credentials.json');
    this.cursorPath = join(this.root, 'get_updates_buf.json');
    this.contextPath = join(this.root, 'context-tokens.json');
    this.dedupPath = join(this.root, 'inbox-dedup.json');
    this.allowlistPath = join(this.root, 'allowlist.json');
  }

  async loadAccount(): Promise<WeixinAccount | undefined> {
    const value = await readJson<Partial<WeixinAccount> | null>(this.accountPath, null);
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value.accountId !== 'string' || typeof value.botId !== 'string' || typeof value.token !== 'string' || typeof value.baseUrl !== 'string') return undefined;
    return {
      accountId: value.accountId,
      botId: value.botId,
      token: value.token,
      baseUrl: value.baseUrl,
      ...(value.userId ? { userId: value.userId } : {}),
    };
  }

  /**
   * Synchronous credential read for identity-domain resolution
   * (SessionStore's userId callback is sync; called per subject, cheap JSON read).
   * Returns undefined when not logged in — callers fall back to config botId/accountId.
   */
  readAccountSync(): WeixinAccount | undefined {
    try {
      const raw = readFileSync(this.accountPath, 'utf8');
      const value = JSON.parse(raw) as Partial<WeixinAccount> | null;
      if (!value || typeof value !== 'object') return undefined;
      if (typeof value.accountId !== 'string' || typeof value.botId !== 'string' || typeof value.token !== 'string' || typeof value.baseUrl !== 'string') return undefined;
      return {
        accountId: value.accountId,
        botId: value.botId,
        token: value.token,
        baseUrl: value.baseUrl,
        ...(value.userId ? { userId: value.userId } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async saveAccount(account: WeixinAccount): Promise<void> {
    await atomicJson(this.accountPath, account);
  }

  async loadCursor(): Promise<string> {
    const value = await readJson<{ cursor?: unknown }>(this.cursorPath, {});
    return typeof value.cursor === 'string' ? value.cursor : '';
  }

  async commitCursor(cursor: string): Promise<void> {
    if (typeof cursor !== 'string') throw new TypeError('cursor must be a string');
    await atomicJson(this.cursorPath, { cursor });
  }

  async loadContextTokens(): Promise<Record<string, string>> {
    const value = await readJson<Record<string, unknown>>(this.contextPath, {});
    return Object.fromEntries(Object.entries(value).filter(([, token]) => typeof token === 'string' && token.length > 0)) as Record<string, string>;
  }

  async getContextToken(subjectId: string): Promise<string | undefined> {
    return (await this.loadContextTokens())[subjectId];
  }

  async setContextToken(subjectId: string, token: string): Promise<void> {
    if (!subjectId || !token) return;
    const tokens = await this.loadContextTokens();
    tokens[subjectId] = token;
    await atomicJson(this.contextPath, tokens);
  }

  async loadDedup(): Promise<Record<string, number>> {
    const value = await readJson<Record<string, unknown>>(this.dedupPath, {});
    return Object.fromEntries(Object.entries(value).filter(([, timestamp]) => typeof timestamp === 'number' && Number.isFinite(timestamp))) as Record<string, number>;
  }

  async rememberMessage(messageId: string, now = Date.now(), ttlMs = 12 * 60 * 60 * 1000, maxEntries = 5000): Promise<boolean> {
    if (!messageId) return false;
    const values = await this.loadDedup();
    const cutoff = now - ttlMs;
    for (const [id, timestamp] of Object.entries(values)) if (timestamp < cutoff) delete values[id];
    if (values[messageId] !== undefined) return false;
    values[messageId] = now;
    const entries = Object.entries(values).sort((a, b) => a[1] - b[1]).slice(-maxEntries);
    await atomicJson(this.dedupPath, Object.fromEntries(entries));
    return true;
  }

  /** Subjects bound by QR login: the scanner becomes this account's trusted user. */
  async loadAllowlist(): Promise<string[]> {
    const value = await readJson<{ subjects?: unknown }>(this.allowlistPath, {});
    if (!Array.isArray(value.subjects)) return [];
    return value.subjects.filter((subject): subject is string => typeof subject === 'string' && subject.length > 0);
  }

  async allowSubject(subjectId: string): Promise<void> {
    if (!subjectId) return;
    const subjects = new Set(await this.loadAllowlist());
    if (subjects.has(subjectId)) return;
    subjects.add(subjectId);
    await atomicJson(this.allowlistPath, { subjects: [...subjects] });
  }

  /** Replace the whole allowlist (force rebind resets it to the new scanner). */
  async setAllowlist(subjects: readonly string[]): Promise<void> {
    const unique = [...new Set(subjects.filter((subject) => typeof subject === 'string' && subject.length > 0))];
    await atomicJson(this.allowlistPath, { subjects: unique });
  }
}
