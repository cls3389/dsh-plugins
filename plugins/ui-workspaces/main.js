import { watch } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const inject = ['workspaceRegistry', 'sessionPersistence'];

const DEFAULT_INTERVAL_MS = 3_000;

/** Read and validate one secret-free Lark workspace registry file. */
export async function readRegistry(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (
    value?.version !== 2 ||
    typeof value.path !== 'string' ||
    !isAbsolute(value.path) ||
    !Array.isArray(value.sessionIds) ||
    value.sessionIds.some((id) => typeof id !== 'string')
  ) {
    throw new Error(`invalid Lark workspace registry: ${path}`);
  }
  // 身份中心(2026-10-30):agentId 为主键,appId 变兼容展示字段;users 键兼容簇 userId(u_xxx)与旧 hex。
  const appId = typeof value.appId === 'string' && value.appId.trim() ? value.appId.trim() : '';
  const agentId = typeof value.agentId === 'string' && value.agentId.trim() ? value.agentId.trim() : appId;
  return {
    appId: agentId,
    botName: typeof value.botName === 'string' ? value.botName.trim() : '',
    appName: typeof value.appName === 'string' && value.appName.trim() ? value.appName.trim() : (agentId || '飞书应用'),
    path: value.path,
    sessionIds: [...new Set(value.sessionIds)],
    users: Object.fromEntries(Object.entries(value.users ?? {}).filter(([key, user]) => (/^[a-f0-9]{24}(?:[a-f0-9]{8})?$/.test(key) || /^u_[a-z0-9][a-z0-9_-]{1,63}$/.test(key)) && typeof user?.path === 'string' && isAbsolute(user.path) && Array.isArray(user.sessionIds)).map(([key, user]) => [key, {
      displayName: typeof user.displayName === 'string' && user.displayName.trim() ? user.displayName.trim() : `用户 ${key.slice(0, 8)}`,
      path: user.path,
      sessionIds: [...new Set(user.sessionIds.filter((id) => typeof id === 'string'))],
    }])),
  };
}

/** Return every known persisted or live session and its working directory. */
async function knownSessions(ctx) {
  const sessions = new Map();
  const persisted = await ctx.sessionPersistence.list();
  for (const snapshot of persisted) {
    sessions.set(String(snapshot.header.id), snapshot.header.cwd);
  }
  const live = ctx.get('sessions');
  for (const session of live?.list() ?? []) {
    sessions.set(String(session.id), session.header.cwd);
  }
  return sessions;
}

/** Recognize the identity center's users/<uid>/<identity>/workspace layout. */
export function userTreeLocation(path, agentId) {
  if (path.split('/').at(-1) !== 'workspace') return undefined;
  const identityPath = dirname(path);
  const userPath = dirname(identityPath);
  const rootPath = dirname(userPath);
  if (identityPath.split('/').at(-1) !== agentId || rootPath.split('/').at(-1) !== 'users' || !/^u_[a-z0-9][a-z0-9_-]{1,63}$/.test(userPath.split('/').at(-1))) return undefined;
  return { rootPath, userPath };
}

function userLabel(userId, entries) {
  for (const { registry, user } of entries) {
    const suffix = ` · ${registry.botName || registry.appName}`;
    const name = user.displayName.endsWith(suffix) ? user.displayName.slice(0, -suffix.length) : user.displayName;
    if (name && !/^用户\s+/.test(name)) return name;
  }
  for (const { registry } of entries) {
    if (registry.botName && registry.botName !== registry.appName) return registry.botName;
  }
  return `用户 ${userId}`;
}

/** Create the app workspace and attach its listed sessions, including per-user child directories. */
export async function syncRegistries(ctx, files) {
  const paths = [];
  for (const file of files) {
    const wildcard = file.lastIndexOf('/*/');
    if (wildcard < 0) { paths.push(file); continue; }
    const directory = file.slice(0, wildcard);
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(join(directory, entry.name, file.slice(wildcard + 3)));
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const registries = (await Promise.all(paths.map(async (path) => {
    try { return await readRegistry(path); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  }))).filter(Boolean);
  if (!registries.length) return [];
  const known = await knownSessions(ctx);

  // Retire legacy virtual groups as before. Ordinary project registrations,
  // including temporarily unavailable directories, are outside this plugin.
  for (const workspace of [...ctx.workspaceRegistry.list()]) {
    if (workspace.path.startsWith('lark://')) await ctx.workspaceRegistry.delete(workspace.id);
  }

  // Register real ancestors of the user directories. The Web tree uses path
  // ancestry, so no UI-only mapping or session/file migration is necessary.
  const treeEntries = new Map();
  for (const registry of registries) {
    for (const [userId, user] of Object.entries(registry.users)) {
      const location = userTreeLocation(user.path, registry.appId);
      if (!location) continue;
      const entries = treeEntries.get(location.userPath) ?? [];
      entries.push({ registry, user, userId, ...location });
      treeEntries.set(location.userPath, entries);
    }
  }
  for (const entries of treeEntries.values()) {
    const { rootPath, userPath, userId, registry } = entries[0];
    await mkdir(userPath, { recursive: true });
    const canonicalRoot = await realpath(rootPath);
    const canonicalUser = await realpath(userPath);
    const canonicalOldRoot = await realpath(dirname(registry.path)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    const oldRoot = ctx.workspaceRegistry.list().find((workspace) => workspace.path === canonicalOldRoot);
    if (!ctx.workspaceRegistry.list().some((workspace) => workspace.path === canonicalRoot)) {
      await ctx.workspaceRegistry.create(canonicalRoot, oldRoot?.title ?? 'DSH Claw');
    }
    let userWorkspace = ctx.workspaceRegistry.list().find((workspace) => workspace.path === canonicalUser);
    const label = userLabel(userId, entries);
    if (!userWorkspace) userWorkspace = await ctx.workspaceRegistry.create(canonicalUser, label);
    else if (userWorkspace.title === `用户 ${userId}` && userWorkspace.title !== label) await userWorkspace.setTitle(label);
  }

  const owned = new Set(ctx.workspaceRegistry.list().flatMap((workspace) => workspace.sessionIds.map(String)));
  // One umbrella for every Feishu cli application: 飞书应用 → cli → user → session.
  let parentPath;
  for (const registry of registries) {
    const candidate = dirname(registry.path);
    if (!parentPath) parentPath = candidate;
    while (candidate !== parentPath && !candidate.startsWith(`${parentPath}/`)) parentPath = dirname(parentPath);
  }
  const hasLegacyContent = registries.some((registry) => registry.sessionIds.length || Object.values(registry.users).some((user) => !userTreeLocation(user.path, registry.appId)));
  if (!treeEntries.size && hasLegacyContent && parentPath && parentPath !== '/') {
    await mkdir(parentPath, { recursive: true });
    const canonicalParent = await realpath(parentPath);
    if (!ctx.workspaceRegistry.list().some((workspace) => workspace.path === canonicalParent)) {
      await ctx.workspaceRegistry.create(canonicalParent, '飞书应用');
    }
  }
  const results = [];
  for (const registry of registries) {
    // Empty identity template directories belong outside the user chat tree.
    if (registry.sessionIds.length === 0 && Object.keys(registry.users).length === 0) continue;
    await mkdir(registry.path, { recursive: true });
    const canonical = await realpath(registry.path);
    const usesUserTree = Object.values(registry.users).some((user) => userTreeLocation(user.path, registry.appId));
    const userSessionIds = new Set(Object.values(registry.users).flatMap((user) => user.sessionIds));
    const rootSessions = [];
    for (const id of registry.sessionIds) {
      if (userSessionIds.has(id) || !known.get(id)) continue;
      const cwd = await realpath(known.get(id)).catch(() => undefined);
      if (cwd === canonical || cwd?.startsWith(`${canonical}/users/`)) rootSessions.push(id);
    }
    const hasRootSessions = rootSessions.length > 0;
    let workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.path === canonical);
    if (!workspace && (!usesUserTree || hasRootSessions)) {
      workspace = await ctx.workspaceRegistry.create(canonical, registry.appName);
    } else if (workspace && (workspace.title === registry.appId || workspace.title === `${registry.appName} · ${registry.appId}`)) {
      // Migrate the original generated title once; preserve later custom names.
      await workspace.setTitle(registry.appName);
    }

    for (const id of registry.sessionIds) {
      const cwd = known.get(id);
      if (!cwd || owned.has(id) || userSessionIds.has(id)) continue;
      let sessionPath;
      try {
        sessionPath = await realpath(cwd);
      } catch {
        continue;
      }
      if (sessionPath !== canonical && !sessionPath.startsWith(`${canonical}/users/`)) continue;
      await workspace.attachSession(id);
      owned.add(id);
    }
    for (const user of Object.values(registry.users)) {
      await mkdir(user.path, { recursive: true });
      const userPath = await realpath(user.path);
      // 身份中心 2026-11-03:用户工作区目录已从 agents/<agentId>/users/<uid> 迁至
      // home/users/<uid>/<agentId>/workspace,不再位于 canonical 之下。
      // bot registry 的 user.path 是身份中心写的权威绑定,信任其存在性即可;
      // 旧的「必须是 canonical 或 canonical/users/ 子目录」前缀守卫会把全部
      // 用户工作区 continue 掉,导致 DSH Claw 树下聊天记录消失。
      try {
        await access(user.path);
      } catch {
        continue;
      }
      const inUserTree = userTreeLocation(user.path, registry.appId);
      const title = inUserTree ? registry.appName : user.displayName;
      let userWorkspace = ctx.workspaceRegistry.list().find((candidate) => candidate.path === userPath);
      if (!userWorkspace) userWorkspace = await ctx.workspaceRegistry.create(userPath, title);
      else if ((userWorkspace.title === user.displayName || /^用户 [a-f0-9]{8}$/.test(userWorkspace.title)) && userWorkspace.title !== title) await userWorkspace.setTitle(title);
      for (const id of user.sessionIds) {
        const cwd = known.get(id);
        if (!cwd) continue;
        try {
          if (await realpath(cwd) !== userPath) continue;
        } catch { continue; }
        if (workspace?.sessionIds.includes(id)) {
          await workspace.detachSession(id);
          owned.delete(id);
        }
        if (owned.has(id)) continue;
        await userWorkspace.attachSession(id);
        owned.add(id);
      }
    }
    results.push({
      appId: registry.appId,
      path: canonical,
      workspaceId: workspace ? String(workspace.id) : undefined,
      sessionIds: workspace?.sessionIds ?? [],
    });
  }
  // Retire only empty legacy grouping entries, never their directories or chats.
  if (treeEntries.size) {
    const legacyPaths = new Map();
    for (const registry of registries) {
      for (const [path, titles] of [[registry.path, [registry.appName, registry.appId, `${registry.appName} · ${registry.appId}`]], [dirname(registry.path), ['DSH Claw', '飞书应用']]]) {
        const canonical = await realpath(path).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
        if (canonical) legacyPaths.set(canonical, new Set([...(legacyPaths.get(canonical) ?? []), ...titles]));
      }
    }
    for (const workspace of [...ctx.workspaceRegistry.list()]) {
      if (legacyPaths.get(workspace.path)?.has(workspace.title) && workspace.sessionIds.length === 0) await ctx.workspaceRegistry.delete(workspace.id);
    }
  }
  return results;
}

/** Mount live synchronization between Lark registry files and Web workspaces. */
export function apply(ctx, config) {
  // 默认注册表在 DSH_HOME(缺省 ~/.dsh)下;registryFiles 配置可覆盖(数组或单字符串)。
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const configured = config?.registryFiles ?? [join(dshHome, 'lark', 'workspace.json'), join(dshHome, 'lark', 'bots', '*', 'workspace.json')];
  const files = Array.isArray(configured) ? configured : [configured];
  const intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let running = false;
  let queued = false;
  const watchers = [];

  async function synchronize() {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        const results = await syncRegistries(ctx, files);
        ctx.logger.info(
          `[ui-workspaces] synchronized ${results.map((item) => `${item.appId}:${item.sessionIds.length}`).join(', ')}`,
        );
      } while (queued && !stopped);
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx.logger.warn(`[ui-workspaces] sync failed: ${String(error)}`);
    } finally {
      running = false;
    }
  }

  for (const path of files) {
    try {
      const watcher = watch(path, { persistent: false }, synchronize);
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // The polling fallback covers a registry that has not been created yet.
    }
  }
  const timer = setInterval(synchronize, intervalMs);
  timer.unref?.();
  void synchronize();

  return () => {
    stopped = true;
    clearInterval(timer);
    for (const watcher of watchers) watcher.close();
  };
}
