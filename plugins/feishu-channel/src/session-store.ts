import { homedir } from 'node:os';
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

/** Public, secret-free identity registry consumed by Web workspace grouping. */
export interface LarkWorkspaceRegistry {
  readonly version: 2;
  /** Identity directory name (agents/<agentId>); the config host. */
  readonly agentId?: string | undefined;
  /** Feishu application id kept for display/back-compat when known. */
  readonly appId?: string | undefined;
  /** Bot display name serving this registry (the cli tier under an aggregate identity). */
  readonly botName?: string | undefined;
  readonly appName?: string | undefined;
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
  private readonly agentsRoot: string;
  private cwd: string;
  private readonly userNames = new Map<string, string>();
  private readonly recoveredUsers = new Map<string, string>();
  private identity?: { readonly agentId?: string | undefined; readonly appId?: string | undefined; readonly appName?: string | undefined; readonly botName?: string | undefined; readonly path: string } | undefined;
  private loaded = false;

  constructor(dataDir: string, defaultCwd: string, agentsRoot = join(defaultCwd, 'agents')) {
    this.path = join(dataDir, 'sessions.json');
    this.workspacePath = join(dataDir, 'workspace.json');
    this.agentsRoot = agentsRoot;
    this.cwd = defaultCwd;
  }

  /** Set the identity (agent) tier; user archives live under agents/<agentId>/users/<userId>. */
  setAgentIdentity(agentId: string | undefined, displayName?: string, appId?: string, botName?: string): void {
    if (!agentId) {
      this.identity = undefined;
      return;
    }
    const path = join(this.agentsRoot, agentId);
    this.identity = { agentId, appId, appName: displayName?.trim() || agentId, ...(botName?.trim() ? { botName: botName.trim() } : {}), path };
    this.cwd = path;
  }


  /**
   * Identity-center rebind (2026-10-30): after setAgentIdentity, remap every
   * openId-bound session cwd to the current identity path — bindings loaded
   * from pre-migration files keep stale app-era paths otherwise, and save()
   * alone would just persist them back.
   */
  rebindCwd(): void {
    if (!this.identity) return;
    for (const [chatId, binding] of this.bindings) {
      if (!binding.openId) continue;
      const cwd = this.cwdFor(binding.openId);
      if (cwd !== binding.cwd) this.bindings.set(chatId, { ...binding, cwd });
    }
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, SessionBinding & { openId?: string; displayName?: string }>;
      for (const [chatId, binding] of Object.entries(data)) {
        if (typeof binding.sessionId === 'string' && typeof binding.cwd === 'string') {
          const openId = binding.openId;
          if (openId) {
            const configured = this.configuredDisplayName(openId);
            this.userNames.set(openId, configured || binding.displayName?.trim() || `用户 ${userKey(openId, this.identity?.appId).slice(0, 12)}`);
          }
          else {
            // 兼容两代目录名:旧 openId-hash(24 hex)与身份簇 userId(u_xxx)。
            const match = /\/users\/((?:[a-f0-9]{24})|(?:u_[a-z0-9_-]{1,63}))$/.exec(binding.cwd);
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

  /** Admin-configured display name: top-level domain, or the applications.<appId> tier. */
  private configuredDisplayName(openId?: string): string | undefined {
    if (!openId) return undefined;
    const appId = this.identity?.appId;
    type UserEntry = { displayName?: string };
    type UsersFile = Record<string, UserEntry> & { applications?: Record<string, Record<string, UserEntry>> };
    // usersFile 标准位置=$DSH_HOME/lark/user-connections.json(与 principal 一致;dataDir 下无此文件)。
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const users = readUsers(join(dshHome, 'lark', 'user-connections.json')) as UsersFile;
    const appIdUsers = appId ? users.applications?.[appId] : undefined;
    return appIdUsers?.[openId]?.displayName?.trim() || users[openId]?.displayName?.trim();
  }

  private cwdFor(openId?: string): string {
    if (!openId || !this.identity) return this.cwd;
    // 身份带 app 域:userId 解析按 (feishu, appId, openId) 查身份簇,bind 合并后档案跟随簇。
    return workspaceFor(this.identity.path, openId, this.identity.appId);
  }

  get(chatId: string, openId?: string, displayName?: string): SessionBinding {
    // 显示名优先级:管理员配置(usersFile) > 渠道实时名(如飞书昵称) > 历史记录 > hash 兜底。
    const resolvedName = this.configuredDisplayName(openId)?.trim() || displayName?.trim() || this.userNames.get(openId ?? '') || (openId ? `用户 ${userKey(openId).slice(0, 8)}` : undefined);
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
        // Web 注册表兼容字段:appId/appName 保留展示,path 指向身份目录。
        ...(this.identity.appId ? { appId: this.identity.appId } : {}),
        sessionIds: [...this.bindings.values()]
          .filter((binding) => binding.cwd === this.identity?.path)
          .map((binding) => binding.sessionId),
        users: Object.fromEntries([
          ...[...this.userNames].map(([openId, displayName]) => {
            const path = workspaceFor(this.identity!.path, openId, this.identity!.appId);
            // 管理员配置名在 save 时兜底校正(load 先于 setAppIdentity,applications 域当时不可见)。
            const effective = this.configuredDisplayName(openId) || displayName;
            // 聚合身份(user 条目名不带 bot 语境)时补 bot 后缀,GUI 树可辨「哪个 cli 在服务」。
            const suffix = this.identity!.botName && !effective?.includes(this.identity!.botName) ? ` · ${this.identity!.botName}` : '';
            return [userKey(openId, this.identity!.appId), { displayName: `${effective}${suffix}`, path, sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId) }];
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
