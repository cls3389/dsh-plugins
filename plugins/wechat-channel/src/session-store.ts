import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { workspaceForIdentity } from '@dsh-friends/feishu-principal';

export interface SessionBinding {
  readonly sessionId: string;
  readonly cwd: string;
  readonly subjectId: string;
  readonly userId: string;
  readonly displayName?: string;
}

export interface WorkspaceRegistry {
  readonly version: 2;
  readonly agentId: string;
  readonly appId: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
  readonly users: Readonly<Record<string, { displayName: string; path: string; sessionIds: readonly string[] }>>;
  readonly updatedAt: string;
}

/** Resolves a trusted (channel, appId, subjectId) triple to the archive userId. */
export type UserIdResolver = (input: { appId: string; subjectId: string }) => string;

export class SessionStore {
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly path: string;
  private readonly workspacePath: string;
  private loaded = false;
  private identity?: { agentId: string; appId: string; root: string };

  constructor(
    private readonly dataDir: string,
    private readonly defaultCwd: string,
    private readonly agentsRoot: string,
    private readonly resolveUserId: UserIdResolver,
  ) {
    this.path = join(dataDir, 'sessions.json');
    this.workspacePath = join(dataDir, 'workspace.json');
  }

  setIdentity(agentId: string, appId: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) throw new Error('invalid Weixin agentId');
    this.identity = { agentId, appId, root: resolve(this.agentsRoot, agentId) };
    this.rebindToIdentity();
  }

  /**
   * Post-bind remap: the identity cluster changed (wechat identity merged into
   * a Feishu user), so every stored binding's cwd/userId is re-resolved to the
   * merged archive. Called from the wechat_bind completion path.
   */
  rebindToIdentity(): void {
    for (const [chatId, binding] of this.bindings) {
      const userId = this.userIdFor(binding.subjectId);
      const cwd = this.cwdFor(userId);
      if (cwd !== binding.cwd || userId !== binding.userId) {
        this.bindings.set(chatId, { ...binding, cwd, userId });
      }
    }
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Partial<SessionBinding>>;
      for (const [chatId, value] of Object.entries(parsed)) {
        if (typeof value.sessionId !== 'string' || typeof value.cwd !== 'string' || typeof value.subjectId !== 'string') continue;
        const userId = typeof value.userId === 'string' ? value.userId : this.userIdFor(value.subjectId);
        this.bindings.set(chatId, {
          sessionId: value.sessionId,
          cwd: value.cwd,
          subjectId: value.subjectId,
          userId,
          ...(value.displayName ? { displayName: value.displayName } : {}),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Disk bindings are historical hints; trusted identity owns both fields.
    this.rebindToIdentity();
    this.loaded = true;
  }

  get(conversationId: string, subjectId: string, displayName?: string): SessionBinding {
    if (!subjectId) throw new Error('trusted Weixin subjectId is required');
    const existing = this.bindings.get(conversationId);
    const userId = this.userIdFor(subjectId);
    const cwd = this.cwdFor(userId);
    const displayNameValue = displayName ?? existing?.displayName;
    const binding: SessionBinding = {
      sessionId: existing?.sessionId ?? `wechat-${Date.now()}-${randomUUID().slice(0, 8)}`,
      cwd,
      subjectId,
      userId,
      ...(displayNameValue ? { displayName: displayNameValue } : {}),
    };
    this.bindings.set(conversationId, binding);
    return binding;
  }

  reset(conversationId: string, subjectId: string, displayName?: string): SessionBinding {
    if (!subjectId) throw new Error('trusted Weixin subjectId is required');
    const userId = this.userIdFor(subjectId);
    const binding: SessionBinding = {
      sessionId: `wechat-${Date.now()}-${randomUUID().slice(0, 8)}`,
      cwd: this.cwdFor(userId),
      subjectId,
      userId,
      ...(displayName ? { displayName } : {}),
    };
    this.bindings.set(conversationId, binding);
    return binding;
  }

  sessionIds(): readonly string[] {
    return [...this.bindings.values()].map((binding) => binding.sessionId);
  }

  /** All live bindings (startup registry self-heal iterates them). */
  listBindings(): readonly SessionBinding[] {
    return [...this.bindings.values()];
  }

  bindingForSession(sessionId: string): SessionBinding | undefined {
    for (const binding of this.bindings.values()) if (binding.sessionId === sessionId) return binding;
    return undefined;
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(Object.fromEntries(this.bindings), null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
    if (!this.identity) return;
    await mkdir(this.identity.root, { recursive: true, mode: 0o700 });
    const users: Record<string, { displayName: string; path: string; sessionIds: readonly string[] }> = {};
    for (const binding of this.bindings.values()) {
      const current = users[binding.userId] ?? {
        displayName: binding.displayName ?? `用户 ${binding.userId.slice(0, 10)}`,
        path: binding.cwd,
        sessionIds: [],
      };
      users[binding.userId] = { ...current, sessionIds: [...current.sessionIds, binding.sessionId] };
    }
    const registry: WorkspaceRegistry = {
      version: 2,
      agentId: this.identity.agentId,
      appId: this.identity.appId,
      path: this.identity.root,
      sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === this.identity?.root).map((binding) => binding.sessionId),
      users,
      updatedAt: new Date().toISOString(),
    };
    const workspaceTemp = `${this.workspacePath}.${process.pid}.tmp`;
    await writeFile(workspaceTemp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await rename(workspaceTemp, this.workspacePath);
  }

  private cwdFor(userId: string): string {
    if (!this.identity) return this.defaultCwd;
    return workspaceForIdentity(this.identity.root, { userId, agentId: this.identity.agentId });
  }

  private userIdFor(subjectId: string): string {
    if (!this.identity) throw new Error('SessionStore.setIdentity must run before resolving user archives');
    return this.resolveUserId({ appId: this.identity.appId, subjectId });
  }
}
