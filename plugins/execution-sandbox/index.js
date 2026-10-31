import { apply as applyBashTool } from '@deepseek-ai/dsh-tool-bash';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { sep } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const name = 'execution-sandbox';
export const inject = ['tools', 'workingDirectory', 'agents'];

export function sandboxCreateArgs(name, workspace, config) {
  const uid = config.uid ?? userInfo().uid;
  const gid = config.gid ?? userInfo().gid;
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
    '--volume', `${workspace}:${workspace}`, '--workdir', workspace,
    config.image ?? 'dsh-user-sandbox:bookworm', 'bash', '-c', 'mkdir -p "$TMPDIR" && exec sleep infinity',
  ];
}

export class DockerBashExecutor extends LocalBashExecutor {
  constructor(ctx, config) {
    super(ctx, config);
    this.sandboxConfig = config;
    this.sandboxes = new Map();
    this.hostCtx = ctx;
    this.disposeEffect = ctx.effect(() => () => this.dispose());
  }
  get sandboxMode() { return 'workspace-write'; }
  resolve(request) {
    const session = request.agent?.session ?? this.hostCtx.session;
    if (!session) throw new Error('用户 shell 缺少可信会话身份，拒绝执行');
    const trusted = realpathSync(this.hostCtx.workingDirectory.get(session));
    const roots = (this.sandboxConfig.workspaceRoots ?? []).map((p) => realpathSync(p));
    if (!roots.some((base) => trusted === base || trusted.startsWith(base + sep))) {
      throw new Error('可信工作目录不在允许的用户工作区范围内');
    }
    const spec = super.resolve(request);
    const requested = realpathSync(spec.workdir);
    if (requested !== trusted && !requested.startsWith(trusted + sep)) throw new Error('不能切换到其他用户或宿主工作目录');
    return spec;
  }
  async ensureSandbox(root) {
    if (this.disposed) throw new Error('用户命令沙箱已关闭，拒绝执行');
    const existing = this.sandboxes.get(root);
    if (existing) return existing;
    const pending = (async () => {
      await mkdir(root, { recursive: true });
      const name = `dsh-user-${process.pid}-${randomBytes(8).toString('hex')}`;
      const docker = this.sandboxConfig.dockerBin ?? 'docker';
      try {
        await exec(docker, sandboxCreateArgs(name, root, this.sandboxConfig), { timeout: 30000 });
        const sandboxCtx = this.hostCtx.isolate('subprocess');
        // Preserve host services (workingDirectory, etc.), but isolate only
        // this Docker subprocess provider from the host's managed process tree.
        const runtime = new LocalSubprocessRuntime(sandboxCtx, {});
        return { name, runtime };
      } catch (error) {
        await exec(docker, ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
        throw new Error(`用户命令沙箱无法启动，已拒绝在宿主执行：${String(error)}`);
      }
    })();
    this.sandboxes.set(root, pending);
    try { return await pending; } catch (error) { this.sandboxes.delete(root); throw error; }
  }
  async execute(spec) {
    const root = realpathSync(spec.workdir);
    const sandbox = await this.ensureSandbox(root);
    const executionCtx = this.hostCtx.isolate('subprocess').isolate('shell');
    executionCtx.provide('subprocess', sandbox.runtime);
    const executor = new LocalBashExecutor(executionCtx, this.config);
    return executor.execute({
        ...spec,
        command: `exec docker exec --interactive --workdir ${shellQuote(root)} ${shellQuote(sandbox.name)} bash -c ${shellQuote(spec.command)}`,
    });
  }
  async dispose() {
    this.disposed = true;
    const pending = [...this.sandboxes.values()];
    this.sandboxes.clear();
    const docker = this.sandboxConfig.dockerBin ?? 'docker';
    await Promise.allSettled(pending.map(async (promise) => {
      const sandbox = await promise;
      await exec(docker, ['rm', '-f', sandbox.name], { timeout: 15000 });
    }));
  }
}
function shellQuote(text) { return `'${text.replaceAll("'", "'\\''")}'`; }

export function apply(ctx, config) {
  if (!ctx.tools || !ctx.workingDirectory) throw new Error('execution-sandbox requires tools and workingDirectory before loading');
  const install = (agent) => {
    if (agent.__executionSandboxInstalled) return;
    agent.__executionSandboxInstalled = true;
    const agentCtx = agent.ctx.isolate('shell').isolate('workingDirectory');
    const root = ctx.workingDirectory.get(agent.session);
    let current = root;
    const directory = {
      get: () => current,
      ensure: async () => current,
      set: async (_agent, path) => {
        const { resolve } = await import('node:path');
        const target = realpathSync(resolve(current, path));
        if (target !== root && !target.startsWith(root + sep)) throw new Error('不能切换到其他用户或宿主工作目录');
        current = target;
        return current;
      },
    };
    agentCtx.provide('workingDirectory', directory);
    new DockerBashExecutor(agentCtx, config);
    // Scoped native bash shadows the global tool without redefining it.
    applyBashTool(agentCtx, {});
  };
  for (const agent of ctx.agents?.list() ?? []) install(agent);
  ctx.on('agent/created', ({ agent }) => install(agent));
}
