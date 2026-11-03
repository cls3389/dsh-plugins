import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 全局工作区注册表（$DSH_HOME/storages/workspace.json）同步。
 *
 * Web GUI 的工作区会话列表以该注册表为权威源：飞书会话由宿主链路自动入表，
 * 微信会话（自研通道，不经 openclaw session host）由本模块在会话创建后主动
 * merge 进对应用户条目，使微信聊天记录在 Web 工作区可见。
 *
 * 写协议与 dsh-storage-json 同款：随机名 tmp + rename 原子替换；读改写整文件，
 * 只 append 单个 sessionId（最小 diff），失败静默降级（展示缺失不致命）。
 */

interface GlobalWorkspaceRecord {
  path?: string;
  title?: string;
  sessionIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface GlobalWorkspaceRegistry {
  unit?: { name?: string; version?: number };
  global?: { initialized?: boolean; workspaceIds?: string[]; [key: string]: unknown };
  tables?: { workspaces?: Record<string, GlobalWorkspaceRecord>; [key: string]: unknown };
  [key: string]: unknown;
}

function storagesPath(): string {
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '/home/lin', '.dsh');
  return resolve(dshHome, 'storages', 'workspace.json');
}

async function readRegistry(path: string): Promise<GlobalWorkspaceRegistry | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as GlobalWorkspaceRegistry;
  } catch {
    return undefined; // 文件缺失/损坏：交回调用方决定（首次可安全跳过）
  }
}

async function writeRegistry(path: string, registry: GlobalWorkspaceRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** realpath 规范化（符号链接折叠——/data/dsh 与 /home/lin/dsh 是同一目录）；失败回退字面 resolve。 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Merge one session into the global workspace registry under the workspace
 * owning `userPath`. Creates the user-workspace entry when absent (with the
 * agent/bot title used by the Web tree), else appends the sessionId to the
 * existing record. Idempotent: an already-listed session is a no-op.
 */
export async function attachSessionToGlobalRegistry(options: {
  userPath: string;
  sessionId: string;
  title: string;
}): Promise<void> {
  const path = storagesPath();
  const registry = await readRegistry(path);
  const workspaces = registry?.tables?.workspaces;
  if (!registry || !workspaces) return; // 注册表尚不存在：web 从未初始化,不代建
  const userPath = await canonical(options.userPath);
  // 路径比较前先 canonical 化全部条目（/data/dsh 与 /home/lin/dsh 软链同目录）。
  const entry = (await Promise.all(
    Object.entries(workspaces).map(async ([id, record]) => [id, record, await canonical(String(record.path))] as const),
  )).find(([, , canonicalPath]) => canonicalPath === userPath);
  const now = new Date().toISOString();
  if (!entry) {
    // 用户工作区条目不存在：按 web 树的命名约定创建（「用户 u_xxx · 身份名」）。
    const id = randomUUID();
    workspaces[id] = {
      path: userPath,
      title: options.title,
      sessionIds: [options.sessionId],
      createdAt: now,
      updatedAt: now,
    };
    registry.global?.workspaceIds?.push(id);
    await writeRegistry(path, registry);
    return;
  }
  const record = entry[1];
  const sessionIds = record.sessionIds ?? [];
  if (sessionIds.includes(options.sessionId)) return; // 已在表：幂等
  record.sessionIds = [options.sessionId, ...sessionIds];
  record.updatedAt = now;
  await writeRegistry(path, registry);
}
