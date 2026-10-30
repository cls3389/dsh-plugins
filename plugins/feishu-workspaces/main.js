import { watch } from 'node:fs';
import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const inject = ['workspaceRegistry', 'sessionPersistence'];

const DEFAULT_INTERVAL_MS = 3_000;

/** Read and validate one secret-free Lark workspace registry file. */
export async function readRegistry(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (
    value?.version !== 2 ||
    typeof value.appId !== 'string' ||
    !value.appId.trim() ||
    typeof value.path !== 'string' ||
    !isAbsolute(value.path) ||
    !Array.isArray(value.sessionIds) ||
    value.sessionIds.some((id) => typeof id !== 'string')
  ) {
    throw new Error(`invalid Lark workspace registry: ${path}`);
  }
  return {
    appId: value.appId.trim(),
    appName: typeof value.appName === 'string' && value.appName.trim() ? value.appName.trim() : '飞书应用',
    path: value.path,
    sessionIds: [...new Set(value.sessionIds)],
    users: Object.fromEntries(Object.entries(value.users ?? {}).filter(([key, user]) => /^[a-f0-9]{24}(?:[a-f0-9]{8})?$/.test(key) && typeof user?.path === 'string' && isAbsolute(user.path) && Array.isArray(user.sessionIds)).map(([key, user]) => [key, {
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

  // URI groups were an interim presentation-only implementation. Deleting the
  // registration preserves every session; historical sessions stay ungrouped.
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (workspace.path.startsWith('lark://')) await ctx.workspaceRegistry.delete(workspace.id);
  }

  const owned = new Set(ctx.workspaceRegistry.list().flatMap((workspace) => workspace.sessionIds.map(String)));
  // One umbrella for every Feishu cli application: 飞书应用 → cli → user → session.
  let parentPath;
  for (const registry of registries) {
    const candidate = dirname(registry.path);
    if (!parentPath) parentPath = candidate;
    while (candidate !== parentPath && !candidate.startsWith(`${parentPath}/`)) parentPath = dirname(parentPath);
  }
  if (parentPath && parentPath !== '/') {
    await mkdir(parentPath, { recursive: true });
    const canonicalParent = await realpath(parentPath);
    if (!ctx.workspaceRegistry.list().some((workspace) => workspace.path === canonicalParent)) {
      await ctx.workspaceRegistry.create(canonicalParent, '飞书应用');
    }
  }
  const results = [];
  for (const registry of registries) {
    await mkdir(registry.path, { recursive: true });
    const canonical = await realpath(registry.path);
    let workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.path === canonical);
    if (!workspace) {
      workspace = await ctx.workspaceRegistry.create(canonical, registry.appName);
    } else if (workspace.title === registry.appId || workspace.title === `${registry.appName} · ${registry.appId}`) {
      // Migrate the original generated title once; preserve later custom names.
      await workspace.setTitle(registry.appName);
    }

    const userSessionIds = new Set(Object.values(registry.users).flatMap((user) => user.sessionIds));
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
      if (userPath !== canonical && !userPath.startsWith(`${canonical}/users/`)) continue;
      let userWorkspace = ctx.workspaceRegistry.list().find((candidate) => candidate.path === userPath);
      if (!userWorkspace) userWorkspace = await ctx.workspaceRegistry.create(userPath, user.displayName);
      else if (/^用户 [a-f0-9]{8}$/.test(userWorkspace.title) && user.displayName !== userWorkspace.title) await userWorkspace.setTitle(user.displayName);
      for (const id of user.sessionIds) {
        if (workspace.sessionIds.includes(id)) await workspace.detachSession(id);
      }
      for (const id of user.sessionIds) {
        const cwd = known.get(id);
        if (!cwd || owned.has(id)) continue;
        try {
          if (await realpath(cwd) !== userPath) continue;
        } catch { continue; }
        await userWorkspace.attachSession(id);
        owned.add(id);
      }
    }
    results.push({
      appId: registry.appId,
      path: canonical,
      workspaceId: String(workspace.id),
      sessionIds: workspace.sessionIds,
    });
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
          `[feishu-workspaces] synchronized ${results.map((item) => `${item.appId}:${item.sessionIds.length}`).join(', ')}`,
        );
      } while (queued && !stopped);
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx.logger.warn(`[feishu-workspaces] sync failed: ${String(error)}`);
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
