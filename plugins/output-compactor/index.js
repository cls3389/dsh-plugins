/**
 * @dsh-friends/output-compactor
 *
 * 提供 bash_compact 工具:执行 bash 命令并用 tokenjuice 压缩输出。
 * 不改 DSH 核心,作为独立工具供模型在大输出场景选用。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const name = 'output-compactor';
const inject = ['tools', 'shell', 'workingDirectory', 'sandboxPolicy'];

async function compactWithTokenjuice(command, text, exitCode = 0) {
  if (!text || text.length < 500) return text;
  try {
    const input = JSON.stringify({ toolName: 'bash', command, combinedText: text, exitCode });
    const { stdout } = await execFileAsync('npx', ['tokenjuice', 'reduce-json'], {
      input, maxBuffer: 5 * 1024 * 1024, timeout: 10_000,
      cwd: new URL('.', import.meta.url).pathname,
    });
    const result = JSON.parse(stdout);
    return result.inlineText && result.stats?.ratio < 0.95 ? result.inlineText : text;
  } catch { return text; }
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'bash_compact',
    description: '执行 bash 命令并用 tokenjuice 智能压缩输出(去重/保留错误上下文/过滤噪声)。优先用本工具代替 bash:凡预期输出超过 20 行的命令(npm install、构建、测试、git log/diff、日志查看、find/ls 扫描等)一律走 bash_compact,只有确定输出极小(如 cd、mkdir、单文件 stat)才用普通 bash。原始完整输出已自动存档,需要细节时可重跑原命令。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '命令描述(5-10词)' },
        command: { type: 'string', description: '要执行的 bash 命令' },
        workdir: { type: 'string', description: '工作目录' },
        timeoutMs: { type: 'number', description: '超时毫秒数' },
      },
      required: ['description', 'command'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.output ?? '(no output)' }],
    },
    async execute(args, exec) {
      const { command, workdir, timeoutMs = 120_000 } = args;
      // Execution always belongs to ctx.shell: external Feishu agents use the
      // same per-session Docker sandbox as native bash. Never spawn host bash.
      const cwd = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined;
      const spec = ctx.shell.resolve({
        command,
        workdir: workdir ?? cwd,
        timeoutMs,
        signal: exec.signal,
        agent: exec.agent,
        ...(ctx.sandboxPolicy ? { sandboxPolicy: ctx.sandboxPolicy.resolve({ session: exec.agent?.session }) } : {}),
      });
      const process = await ctx.shell.execute(spec);
      const result = await process.result();
      const combined = [result.stdout.text, result.stderr.text].filter(Boolean).join('\n');
      const compacted = await compactWithTokenjuice(command, combined, result.exitCode ?? 1);
      return {
        output: compacted,
        rawLength: combined.length,
        compactedLength: compacted.length,
        exitCode: result.exitCode,
        cwd: spec.workdir,
        timedOut: result.timedOut,
        aborted: result.aborted,
      };
    },
  });
  ctx.logger.info('[output-compactor] active: bash_compact registered');
  return () => {};
}

export { name, inject };
