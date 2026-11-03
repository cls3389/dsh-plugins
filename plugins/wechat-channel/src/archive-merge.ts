import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

/** Only the two content trees for explicitly identified owners in one agent. */
export interface ArchiveMergeScope {
  readonly usersRoot: string;
  readonly agentId: string;
  readonly oldUserId: string;
  readonly targetUserId: string;
}

export interface ArchiveMergeResult {
  status: 'merged' | 'partial' | 'source_missing' | 'same_root' | 'skipped' | 'failed';
  copiedFiles: number;
  conflicts: string[];
  skipped: string[];
}

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Check every existing ancestor, including the declared root itself. */
async function assertDirectoryPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const entry = await info(current);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`unsafe directory: ${current}`);
  }
}

/** Copies content, never deletes the old archive or copies owner config/ACLs. */
export async function mergeArchive(scope?: ArchiveMergeScope): Promise<ArchiveMergeResult> {
  const result: ArchiveMergeResult = { status: 'skipped', copiedFiles: 0, conflicts: [], skipped: [] };
  if (!scope) {
    result.skipped.push('owner/agent archive scope unavailable');
    return result;
  }
  if (!/^u_[a-z0-9_-]{1,63}$/.test(scope.oldUserId) || !/^u_[a-z0-9_-]{1,63}$/.test(scope.targetUserId)
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope.agentId)) {
    result.skipped.push('invalid owner/agent archive scope');
    return result;
  }
  if (scope.oldUserId === scope.targetUserId) return { ...result, status: 'same_root' };
  let foundSource = false;
  try {
    // The trusted users root may use a host alias (/data/dsh -> /home/lin/dsh).
    // Resolve that anchor first; links inside owner/agent trees remain forbidden.
    let usersRoot: string;
    try { usersRoot = await realpath(scope.usersRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...result, status: 'source_missing' };
      throw error;
    }
    const oldRoot = join(usersRoot, scope.oldUserId, scope.agentId);
    const targetRoot = join(usersRoot, scope.targetUserId, scope.agentId);
    await assertDirectoryPath(oldRoot);
    await assertDirectoryPath(targetRoot);
    const walk = async (from: string, to: string): Promise<void> => {
      await assertDirectoryPath(from);
      await assertDirectoryPath(to);
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const destination = join(to, entry.name);
        if (entry.isDirectory()) {
          const target = await info(destination);
          if (target && (!target.isDirectory() || target.isSymbolicLink())) {
            result.skipped.push(destination);
            continue;
          }
          await walk(source, destination);
        } else if (entry.isFile()) {
          // O_NOFOLLOW also rejects a source replaced by a symlink after readdir.
          const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            let suffix = 0;
            for (;;) {
              const candidate = suffix === 0 ? destination : `${destination}.wechat-side${suffix === 1 ? '' : `.${suffix}`}`;
              await assertDirectoryPath(dirname(candidate));
              let output;
              try { output = await open(candidate, 'wx', 0o600); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                suffix += 1;
                continue;
              }
              try {
                if (!(await input.stat()).isFile()) throw new Error(`non-regular source: ${source}`);
                const buffer = Buffer.allocUnsafe(64 * 1024);
                for (;;) {
                  const { bytesRead } = await input.read(buffer);
                  if (!bytesRead) break;
                  let offset = 0;
                  while (offset < bytesRead) {
                    const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
                    if (!bytesWritten) throw new Error(`short write: ${candidate}`);
                    offset += bytesWritten;
                  }
                }
              } finally { await output.close(); }
              if (suffix > 0) result.conflicts.push(candidate);
              result.copiedFiles += 1;
              break;
            }
          } finally { await input.close(); }
        } else {
          result.skipped.push(source); // links and non-regular files are never followed
        }
      }
    };
    for (const tree of ['workspace', 'memory']) {
      const source = join(oldRoot, tree);
      const entry = await info(source);
      if (!entry) continue;
      foundSource = true;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        result.skipped.push(source);
        continue;
      }
      await walk(source, join(targetRoot, tree));
    }
    result.status = result.skipped.length ? 'partial' : foundSource ? 'merged' : 'source_missing';
  } catch (error) {
    result.status = result.copiedFiles > 0 ? 'partial' : 'failed';
    result.skipped.push(String(error));
  }
  return result;
}
