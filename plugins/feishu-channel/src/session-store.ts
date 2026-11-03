import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { listIdentities, readUsers, userKey, workspaceForIdentity } from '@dsh-friends/feishu-principal';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatModelSelection } from './model-selection.js';

export interface SessionBinding {
  readonly sessionId: string;
  readonly previousSessionIds?: readonly string[];
  readonly chatType?: 'p2p' | 'group';
  readonly cwd: string;
  /** Chat-pinned model override; absent means follow sticky/default routing. */
  readonly model?: ChatModelSelection;
  readonly openId?: string;
  /** 飞书 union_id：跨应用人标识，用于身份簇归并（同一人换 bot 不换身份）。 */
  readonly unionId?: string;
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
  /** openId → union_id：注册表/恢复会话时按人（而非按应用）解析身份簇。 */
  private readonly userUnionIds = new Map<string, string>();
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
      const cwd = this.cwdFor(binding.openId, binding.unionId);
      if (cwd !== binding.cwd) this.bindings.set(chatId, { ...binding, cwd });
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, SessionBinding & { openId?: string; displayName?: string }>;
      for (const [chatId, binding] of Object.entries(data)) {
        if (typeof binding.sessionId === 'string' && typeof binding.cwd === 'string') {
          const openId = binding.openId;
          if (openId) {
            if (binding.unionId) this.userUnionIds.set(openId, binding.unionId);
            const configured = this.configuredDisplayName(openId);
            // Loading history is read-only even before application identity initialization.
            this.userNames.set(openId, configured || binding.displayName?.trim() || `用户 ${(this.existingUserId(openId) ?? openId).slice(0, 12)}`);
          }
          else {
            // 用户中心布局: users/<u_xxx>/<agentId>/workspace(取 userId 段)。
            const match = /\/users\/(u_[a-z0-9_-]{1,63})\/[a-z0-9][a-z0-9-]{0,63}\/workspace$/.exec(binding.cwd);
            if (match) this.recoveredUsers.set(match[1]!, binding.cwd);
          }
          this.bindings.set(chatId, {
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            ...(validModel(binding.model) ? { model: binding.model } : {}),
            ...(binding.openId ? { openId: binding.openId } : {}),
            ...(binding.unionId ? { unionId: binding.unionId } : {}),
            ...(binding.chatType ? { chatType: binding.chatType } : {}),
            ...(Array.isArray(binding.previousSessionIds) ? { previousSessionIds: binding.previousSessionIds.filter((id): id is string => typeof id === 'string') } : {}),
            ...(binding.displayName ? { displayName: binding.displayName } : {}),
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  /** Existing scoped identity lookup; display-name reads must never enroll a user. */
  private existingUserId(openId: string): string | undefined {
    const appId = this.identity?.appId;
    if (!appId) return undefined;
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return Object.entries(listIdentities({ identitiesFile: join(dshHome, 'identities.json') }))
      .find(([, user]) => user.identities.some((identity) => identity.channel === 'feishu' && identity.appId === appId && identity.openId === openId))?.[0];
  }

  /** Admin-configured name: current users.<userId>, with legacy app/openId fallbacks. */
  private configuredDisplayName(openId?: string): string | undefined {
    if (!openId) return undefined;
    const appId = this.identity?.appId;
    type UserEntry = { displayName?: string };
    type UsersFile = Record<string, UserEntry> & { users?: Record<string, UserEntry>; applications?: Record<string, Record<string, UserEntry>> };
    // usersFile 标准位置=$DSH_HOME/lark/user-connections.json(与 principal 一致;dataDir 下无此文件)。
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const users = readUsers(join(dshHome, 'lark', 'user-connections.json')) as UsersFile;
    const appIdUsers = appId ? users.applications?.[appId] : undefined;
    const userId = this.existingUserId(openId);
    return (userId ? users.users?.[userId]?.displayName?.trim() || users[userId]?.displayName?.trim() : undefined)
      || appIdUsers?.[openId]?.displayName?.trim() || users[openId]?.displayName?.trim();
  }

  private cwdFor(openId?: string, unionId?: string): string {
    if (!openId || !this.identity) return this.cwd;
    // 身份簇以 union_id 归并：同一个人在不同 bot(不同 appId)下 open_id 不同，
    // 但 union_id 相同 → 解析到同一个 userId，档案与登录态跟随这个人而不是某个应用。
    // 用户中心布局(2026-11-02):身份簇 userId + agentId → users/<userId>/<agentId>/workspace;
    // 旧布局 agents/<agentId>/users/<userId> 由 workspaceForIdentity 兜底兼容(存在才回退)。
    const userId = userKey(openId, this.identity.appId, unionId);
    return workspaceForIdentity(this.identity.path, { userId, agentId: this.identity.agentId, appId: this.identity.appId });
  }

  get(chatId: string, openId?: string, displayName?: string, unionId?: string): SessionBinding {
    // 显示名优先级:管理员配置(usersFile) > 渠道实时名(如飞书昵称) > 历史记录 > hash 兜底。
    // 兜底名必须带 appId:缺省会以 appId='unscoped' 在 identities.json 里建出孤儿身份簇。
    const resolvedName = this.configuredDisplayName(openId)?.trim() || displayName?.trim() || this.userNames.get(openId ?? '') || (openId ? `用户 ${userKey(openId, this.identity?.appId, unionId).slice(0, 8)}` : undefined);
    if (openId) this.userNames.set(openId, resolvedName!);
    if (openId && unionId) this.userUnionIds.set(openId, unionId);
    const cwd = this.cwdFor(openId, unionId);
    const existing = this.bindings.get(chatId);
    if (existing) {
      if (openId && (existing.cwd !== cwd || existing.openId !== openId)) {
        const { unionId: _union, previousSessionIds: _aliases, ...sameChat } = existing;
        const base = existing.openId === openId ? existing : sameChat;
        const moved = { ...base, cwd, openId, ...(unionId ? { unionId } : {}), displayName: resolvedName };
        this.bindings.set(chatId, moved);
        return moved;
      }
      if (openId && (!existing.openId || (unionId && !existing.unionId))) {
        this.bindings.set(chatId, { ...existing, ...(openId ? { openId, displayName: resolvedName } : {}), ...(unionId ? { unionId } : {}) });
      }
      return this.bindings.get(chatId)!;
    }
    const created = { sessionId: this.freshId(), cwd, ...(openId ? { openId, ...(unionId ? { unionId } : {}), displayName: resolvedName } : {}) };
    this.bindings.set(chatId, created);
    return created;
  }

  reset(chatId: string, openId?: string): SessionBinding {
    const previous = this.bindings.get(chatId);
    const owner = openId ?? previous?.openId;
    const sameOwner = !openId || openId === previous?.openId;
    const { unionId: _union, previousSessionIds: _aliases, ...preserved } = previous ?? {};
    const created = {
      ...preserved,
      ...(sameOwner && previous?.unionId ? { unionId: previous.unionId } : {}),
      sessionId: this.freshId(),
      cwd: sameOwner && previous ? previous.cwd : this.cwdFor(owner),
      ...(sameOwner && previous ? { previousSessionIds: [...(previous.previousSessionIds ?? []), previous.sessionId] } : {}),
      ...(owner ? { openId: owner, displayName: this.userNames.get(owner) } : {}),

    };
    this.bindings.set(chatId, created);
    return created;
  }

  /** Read-only lookup: never creates a binding or resolves a new identity. */
  notificationTarget(sessionId: string): { chatId: string; binding: SessionBinding } | undefined {
    const matches = [...this.bindings].filter(([, binding]) => binding.sessionId === sessionId || binding.previousSessionIds?.includes(sessionId));
    if (matches.length !== 1) return undefined;
    return { chatId: matches[0]![0], binding: { ...matches[0]![1] } };
  }

  setChatType(chatId: string, chatType: 'p2p' | 'group'): void {
    const binding = this.bindings.get(chatId);
    if (binding) this.bindings.set(chatId, { ...binding, chatType });
  }

  addPreviousSession(sessionId: string, previousSessionId: string, openId: string): void {
    if (!/^lark-[a-zA-Z0-9-]{1,160}$/.test(previousSessionId)) throw new Error('Invalid previous session id');
    const target = this.notificationTarget(sessionId);
    if (!target || target.binding.sessionId !== sessionId || target.binding.openId !== openId) throw new Error('Session owner mismatch');
    for (const [chatId, binding] of this.bindings) {
      if (chatId !== target.chatId && (binding.sessionId === previousSessionId || binding.previousSessionIds?.includes(previousSessionId))) throw new Error('Previous session belongs to another chat');
    }
    if (previousSessionId === sessionId) throw new Error('Previous session must differ');
    this.bindings.set(target.chatId, { ...target.binding, previousSessionIds: [...new Set([...(target.binding.previousSessionIds ?? []), previousSessionId])] });
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
    const { model: _model, ...binding } = existing;
    this.bindings.set(chatId, binding);
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
            // 用户中心布局:注册表展示路径与实际 cwd 同源(workspaceForIdentity 新锚点)。
            const path = workspaceForIdentity(this.identity!.path, { userId: userKey(openId, this.identity!.appId, this.userUnionIds.get(openId)), agentId: this.identity!.agentId, appId: this.identity!.appId });
            // 保存注册表时重新读取管理员配置名，覆盖历史昵称并跟随配置更新。
            const effective = this.configuredDisplayName(openId) || displayName;
            // 聚合身份(user 条目名不带 bot 语境)时补 bot 后缀,GUI 树可辨「哪个 cli 在服务」。
            const suffix = this.identity!.botName && !effective?.includes(this.identity!.botName) ? ` · ${this.identity!.botName}` : '';
            return [userKey(openId, this.identity!.appId, this.userUnionIds.get(openId)), { displayName: `${effective}${suffix}`, path, sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId) }];
          }),
          ...[...this.recoveredUsers].map(([hash, path]) => {
            // 注意:这里不能调 userKey(openId) —— 缺 appId 会在 identities.json 里建出 appId='unscoped' 的孤儿簇。
            // 旧 hash 目录属于历史残留(2026-10-30 全量核查:agents/ 下已无 24hex 目录),只做通用兜底名。
            return [hash, { displayName: `用户 ${hash.slice(0, 8)}`, path, sessionIds: [...this.bindings.values()].filter((binding) => binding.cwd === path).map((binding) => binding.sessionId) }];
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
