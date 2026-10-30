import { randomUUID } from 'node:crypto';
import { readUsers, userKey, workspaceFor } from '@dsh-friends/feishu-principal';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatModelSelection } from './model-selection.js';

interface SessionBinding {
  readonly sessionId: string;
  readonly cwd: string;
  /** Chat-pinned model override; absent means follow sticky/default routing. */
  readonly model?: ChatModelSelection;
  readonly openId?: string;
  readonly displayName?: string | undefined;
}

/** Public, secret-free application identity consumed by Web workspace grouping. */
export interface LarkWorkspaceRegistry {
  readonly version: 2;
  readonly appId: string;
  readonly appName: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
  readonly users?: Readonly<Record<string, { readonly displayName: string; readonly path: string; readonly sessionIds: readonly string[] }>>;
  readonly updatedAt: string;
}

/** Durable one-chat-to-one-DSH-session registry, independent of legacy state. */
export class SessionStore {
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly path: string;
  private readonly workspacePath: string;
  private readonly workspaceRoot: string;
  private cwd: string;
  private readonly userNames = new Map<string, string>();
  private readonly recoveredUsers = new Map<string, string>();
  private identity?: { readonly appId: string; readonly appName: string; readonly path: string };
  private loaded = false;

  constructor(dataDir: string, defaultCwd: string, workspaceRoot = join(defaultCwd, 'feishu')) {
    this.path = join(dataDir, 'sessions.json');
    this.workspacePath = join(dataDir, 'workspace.json');
    this.workspaceRoot = workspaceRoot;
    this.cwd = defaultCwd;
  }

  /** Set the application identity and working directory shared with Web. */
  setAppIdentity(appId: string, appName?: string): void {
    const path = join(this.workspaceRoot, appId);
    this.identity = { appId, appName: appName?.trim() || '飞书应用', path };
    this.cwd = path;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, SessionBinding & { openId?: string; displayName?: string }>;
      for (const [chatId, binding] of Object.entries(data)) {
        if (typeof binding.sessionId === 'string' && typeof binding.cwd === 'string') {
          const openId = binding.openId;
          if (openId) this.userNames.set(openId, binding.displayName?.trim() || `用户 ${userKey(openId).slice(0, 8)}`);
          else {
            const match = /\/users\/([a-f0-9]{24})$/.exec(binding.cwd);
            if (match) this.recoveredUsers.set(match[1]!, binding.cwd);
          }
          this.bindings.set(chatId, {
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            ...(validModel(binding.model) ? { model: binding.model } : {}),
            ...(binding.openId ? { openId: binding.openId } : {}),
            ...(binding.displayName ? { displayName: binding.displayName } : {}),
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  private cwdFor(openId?: string): string {
    if (!openId || !this.identity) return this.cwd;
    return workspaceFor(this.identity.path, openId);
  }

  get(chatId: string, openId?: string, displayName?: string): SessionBinding {
    const resolvedName = displayName?.trim() || this.userNames.get(openId ?? '') || (openId ? `用户 ${userKey(openId).slice(0, 8)}` : undefined);
    if (openId) this.userNames.set(openId, resolvedName!);
    const cwd = this.cwdFor(openId);
    const existing = this.bindings.get(chatId);
    if (existing) {
      if (openId && existing.cwd !== cwd) {
        const moved = { ...existing, cwd, ...(openId ? { openId, displayName: resolvedName } : {}) };
        this.bindings.set(chatId, moved);
        return moved;
      }
      if (openId && !existing.openId) this.bindings.set(chatId, { ...existing, openId, displayName: resolvedName });
      return this.bindings.get(chatId)!;
    }
    const created = { sessionId: this.freshId(), cwd, ...(openId ? { openId, displayName: resolvedName } : {}) };
    this.bindings.set(chatId, created);
    return created;
  }

  reset(chatId: string, openId?: string): SessionBinding {
    const previous = this.bindings.get(chatId);
    const created = {
      sessionId: this.freshId(),
      cwd: this.cwdFor(openId),
      ...(previous?.model ? { model: previous.model } : {}),
      ...(openId ? { openId, displayName: this.userNames.get(openId) } : {}),
    };
    this.bindings.set(chatId, created);
    return created;
  }

  /** Chat-pinned override for one DSH session, when stored. */
  overrideFor(sessionId: string): ChatModelSelection | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId && binding.model) return binding.model;
    }
    return undefined;
  }

  setModel(chatId: string, model: ChatModelSelection): void {
    const existing = this.get(chatId);
    this.bindings.set(chatId, { ...existing, model });
  }

  clearModel(chatId: string): void {
    const existing = this.bindings.get(chatId);
    if (!existing?.model) return;
    this.bindings.set(chatId, { sessionId: existing.sessionId, cwd: existing.cwd });
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const persisted = Object.fromEntries(this.bindings);
    await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
    if (this.identity) {
      await mkdir(this.identity.path, { recursive: true });
      const registry: LarkWorkspaceRegistry = {
        version: 2,
        ...this.identity,
        sessionIds: [...this.bindings.values()]
          .filter((binding) => binding.cwd === this.identity?.path)
          .map((binding) => binding.sessionId),
        users: Object.fromEntries([
          ...[...this.userNames].map(([openId, displayName]) => {
            const path = workspaceFor(this.identity!.path, openId);
            return [userKey(openId), { displayName, path, sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId) }];
          }),
          ...[...this.recoveredUsers].map(([hash, path]) => {
            const configuredName = Object.entries(readUsers(join(dirname(this.path), 'user-connections.json'))).find(([openId]) => userKey(openId).startsWith(hash))?.[1]?.displayName;
            return [hash, { displayName: configuredName || `用户 ${hash.slice(0, 8)}`, path, sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId) }];
          }),
        ]),
        updatedAt: new Date().toISOString(),
      };
      const workspaceTemporary = `${this.workspacePath}.${process.pid}.tmp`;
      await writeFile(workspaceTemporary, `${JSON.stringify(registry, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(workspaceTemporary, this.workspacePath);
    }
  }

  private freshId(): string {
    return `lark-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }
}

function validModel(value: unknown): value is ChatModelSelection {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.provider === 'string' &&
    typeof candidate.model === 'string' &&
    (candidate.reasoningEffort === undefined || typeof candidate.reasoningEffort === 'string')
  );
}
