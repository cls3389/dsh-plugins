import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const name = 'execution-sandbox';
export const inject = ['workingDirectory'];

export function sandboxCreateArgs(name, workspace, config) {
  const uid = config.uid ?? userInfo().uid;
  const gid = config.gid ?? userInfo().gid;
  const tz = config.timeZone === null ? undefined : config.timeZone ?? 'Asia/Shanghai';
  return [
    'run', '--detach', '--name', name,
    '--network', config.network ?? 'none',
    '--read-only', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,size=64m,mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(config.pidsLimit ?? 128),
    '--memory', config.memory ?? '1g', '--memory-swap', config.memory ?? '1g',
    '--cpus', String(config.cpus ?? 1),
    '--env', `HOME=${workspace}`, '--env', `TMPDIR=${workspace}/.tmp`,
    // User-facing wall-clock answers (date, chart axes) must match the host's
    // Asia/Shanghai business timezone; the sandbox image ships zoneinfo.
    ...(tz ? ['--env', `TZ=${tz}`] : []),
    '--volume', `${workspace}:${workspace}`, '--workdir', workspace,
    // Host-maintained, read-only tool code; no credentials or other host paths.
    '--volume', `${config.toolsDir ?? join(dirname(fileURLToPath(import.meta.url)), 'tools')}:/opt/dsh-tools:ro`,
    config.image ?? 'dsh-user-sandbox:bookworm', 'bash', '-c', 'mkdir -p "$TMPDIR" && exec sleep infinity',
  ];
}

/** Docker-backed ctx.sandbox provider: wraps argv into an existing per-workspace container. */
export class DockerSandboxProvider extends SandboxProvider {
  constructor(ctx, config) {
    super(ctx);
    this.ctx = ctx;
    this.config = config;
    this.containers = new Map();
    this.roots = (config.workspaceRoots ?? []).map((path) => realpathSync(path));
    ctx.effect(() => () => this.dispose());
  }

  /** Keep one long-lived container per trusted workspace root; commands run via docker exec. */
  async ensureContainer(root) {
    if (this.disposed) throw new Error('用户命令沙箱已关闭，拒绝执行');
    const existing = this.containers.get(root);
    if (existing) return existing;
    const pending = (async () => {
      await mkdir(root, { recursive: true });
      const name = `dsh-user-${process.pid}-${randomBytes(8).toString('hex')}`;
      const docker = this.config.dockerBin ?? 'docker';
      try {
        await exec(docker, sandboxCreateArgs(name, root, this.config), { timeout: 30000 });
        return { name };
      } catch (error) {
        await exec(docker, ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
        throw new Error(`用户命令沙箱无法启动，已拒绝在宿主执行：${String(error)}`);
      }
    })();
    this.containers.set(root, pending);
    try { return await pending; } catch (error) { this.containers.delete(root); throw error; }
  }

  /**
   * Return enforcing argv for the official bash-sandbox executor.
   * The policy's workspaceRoot is trusted by the base session layer; refuse anything else.
   */
  async confine(argv, policy, signal) {
    signal?.throwIfAborted();
    if (policy.mode === 'danger-full-access') return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] };
    const root = realpathSync(canonicalPath(policy.workspaceRoot));
    if (!this.roots.some((base) => root === base || root.startsWith(base + sep))) {
      throw new SandboxUnavailableError(policy.mode, `workspace root ${root} is outside configured Docker sandbox roots`);
    }
    let container;
    try {
      container = await this.ensureContainer(root);
    } catch (error) {
      throw new SandboxUnavailableError(policy.mode, String(error));
    }
    const docker = this.config.dockerBin ?? 'docker';
    const wrapped = [
      docker,
      'exec', '--interactive', '--workdir', root,
      container.name,
      ...argv,
    ];
    return {
      argv: wrapped,
      enforcement: 'full',
      denialSignatures: ['permission denied', 'read-only file system'],
      runnerFailureRules: [{ fatalSignatures: ['docker: error', 'no such container', 'is not running'] }],
    };
  }

  async dispose() {
    this.disposed = true;
    const pending = [...this.containers.values()];
    this.containers.clear();
    const docker = this.config.dockerBin ?? 'docker';
    await Promise.allSettled(pending.map(async (promise) => {
      const sandbox = await promise;
      await exec(docker, ['rm', '-f', sandbox.name], { timeout: 15000 });
    }));
  }
}

export function apply(ctx, config) {
  new DockerSandboxProvider(ctx, config);
}
