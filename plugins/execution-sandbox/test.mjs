import assert from 'node:assert/strict';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { sandboxCreateArgs, DockerBashExecutor, apply } from './index.js';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { apply as applyBash } from '@deepseek-ai/dsh-tool-bash';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';

const args = sandboxCreateArgs('test-sandbox', '/workspace/user', {});
assert(args.includes('--read-only'));
assert(args.includes('--network'));
assert(!args.some((arg) => arg.includes('/var/run/docker.sock')));
assert(!args.includes('--privileged'));

const directory = mkdtempSync(join(tmpdir(), 'dsh-execution-sandbox-'));
const config = { image: 'dsh-user-sandbox:bookworm', workspaceRoots: [directory], timeoutMs: { get: () => 60000 }, maxTimeoutMs: { get: () => 60000 }, maxOutputBytes: { get: () => 64000 }, maxSpillBytes: { get: () => 67108864 }, graceMs: { get: () => 3000 } };
const ctx = new Context();
const subprocess = new LocalSubprocessRuntime(ctx, {});
const agent = { session: { id: 'test-user' }, ctx };
ctx.provide('workingDirectory', { get: () => directory, ensure: async () => directory });
let executor;
let scopedExecutor;
try {
  new SystemPrompt(ctx, {});
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write', workspaceRoot: directory }) });
  ctx.provide('shellEnv', { collect: () => ({}) });
  const tools = new ToolRuntime(ctx, {});
  executor = new DockerBashExecutor(ctx, config);
  async function run(command) {
    const spec = executor.resolve({ command, workdir: directory, agent, agent });
    const handle = await executor.execute(spec);
    const result = await handle.result();
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    return result;
  }
  const result = await run("python - <<'PY'\nfrom pathlib import Path\nimport os\nprint('uid', os.getuid())\nPath('calculation.json').write_text('{\"answer\": 42}')\nprint('workspace write ok')\ntry:\n    open('/data/dsh/.credentials.yaml')\n    raise Exception('host credential must not be mounted')\nexcept FileNotFoundError:\n    print('host files isolated')\nPY\nnode -e \"console.log('node', process.version)\"\nprintf 'PATH=%s\\n' \"$PATH\"");
  assert.match(result.stdout.text, /workspace write ok/);
  assert.match(result.stdout.text, /host files isolated/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'calculation.json'), 'utf8')).answer, 42);
  const networking = await executor.execute(executor.resolve({ command: 'curl --connect-timeout 2 https://example.com', workdir: directory, agent }));
  const networkResult = await networking.result();
  assert.notEqual(networkResult.exitCode, 0);
  const background = await executor.execute(executor.resolve({ command: 'echo background-ok', workdir: directory, agent }));
  assert.match((await background.result()).stdout.text, /background-ok/);
  const timeout = await executor.execute(executor.resolve({ command: 'sleep 30', workdir: directory, agent, timeoutMs: 1000 }));
  const timeoutResult = await timeout.result();
  assert.equal(timeoutResult.timedOut, true);
  assert.throws(() => executor.resolve({ command: 'pwd', workdir: tmpdir(), agent }), /不能切换到其他用户/);
  assert.throws(() => executor.resolve({ command: 'pwd', workdir: directory }), /缺少可信会话身份/);
  const failureCtx = new Context();
  const failureDispose = failureCtx.effect(() => () => Promise.resolve());
  new LocalSubprocessRuntime(failureCtx, {});
  failureCtx.provide('workingDirectory', { get: () => directory });
  const missing = new DockerBashExecutor(failureCtx, { ...config, image: 'dsh-user-sandbox:definitely-missing' });
  await assert.rejects(() => missing.execute(missing.resolve({ command: 'echo must-not-run-on-host', workdir: directory, agent })), /拒绝在宿主执行/);
  await failureDispose();
  const agentCtx = ctx.isolate('shell').isolate('workingDirectory');
  agentCtx.provide('workingDirectory', { get: () => directory, ensure: async () => directory });
  agentCtx.provide('session', agent.session);
  scopedExecutor = new DockerBashExecutor(agentCtx, config);
  applyBash(agentCtx, {});
  const native = await tools.execute({ name: 'bash', callId: 'native', arguments: { command: 'echo native-agent-ok', workdir: directory, description: 'test native sandbox' }, agent, signal: new AbortController().signal });
  assert.equal(native.isError, false, JSON.stringify(native));
  const scoped = await scopedExecutor.execute(scopedExecutor.resolve({ command: 'echo scoped-ok', workdir: directory }));
  assert.match((await scoped.result()).stdout.text, /scoped-ok/);
  console.log('PASS: DSH executor, native tool binding, shell/Python/Node, workspace write, host isolation, no network, timeout, fail closed');
} finally {
  await executor.disposeEffect();
  await scopedExecutor.disposeEffect();
  await assert.rejects(() => scopedExecutor.execute(scopedExecutor.resolve({ command: 'echo should-not-run', workdir: directory })), /已关闭/);
  const idleCtx = ctx.isolate('shell');
  const idle = new DockerBashExecutor(idleCtx, config);
  await idle.disposeEffect();
  rmSync(directory, { recursive: true, force: true });
}
