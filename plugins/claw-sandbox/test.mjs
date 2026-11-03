import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { sandboxCreateArgs, DockerSandboxProvider, apply } from './index.js';
const run = promisify(execFile);

const args = sandboxCreateArgs('test-sandbox', '/workspace/user', {});
assert(args.includes('--read-only'));
assert(args.includes('--network'));
assert(!args.some((arg) => arg.includes('/var/run/docker.sock')));
assert(!args.includes('--privileged'));
assert(!args.some((arg) => /ALL_PROXY|HTTP_PROXY|SOCKS/i.test(arg)));
// Default wall-clock timezone is Asia/Shanghai; timeZone: null opts out.
assert(args.some((arg) => arg === 'TZ=Asia/Shanghai'));
const tzOff = sandboxCreateArgs('test-sandbox', '/workspace/user', { timeZone: null });
assert(!tzOff.some((arg) => /^TZ=/.test(arg)));

const directory = mkdtempSync(join(tmpdir(), 'dsh-claw-sandbox-'));
const config = { image: 'dsh-user-sandbox:bookworm', workspaceRoots: [directory] };
const ctx = new Context();
new LocalSubprocessRuntime(ctx, {});
ctx.provide('workingDirectory', { get: () => directory, ensure: async () => directory });
let provider;
try {
  apply(ctx, config);
  provider = ctx.sandbox;
  const policy = { mode: 'workspace-write', workspaceRoot: directory, sessionId: 'test-user' };
  const wrapped = await provider.confine(['bash', '-c', "python3 - <<'PY'\nfrom pathlib import Path\nPath('calculation.json').write_text('{\"answer\": 42}')\nprint('workspace write ok')\ntry:\n open('/data/dsh/.credentials.yaml')\n raise Exception('host credential must not be mounted')\nexcept FileNotFoundError:\n print('host files isolated')\nPY\nnode -e \"console.log('node', process.version)\"\nhostname\ncurl --connect-timeout 2 -s -o /dev/null -w 'http=%{http_code}\\n' https://example.com; printf 'curl_exit=%s\\n' \"$?\""], policy);
  assert.equal(wrapped.argv[0], 'docker');
  assert(wrapped.argv.includes('exec'));
  const [program, ...argv] = wrapped.argv;
  let result;
  try {
    result = await run(program, argv, { cwd: directory, timeout: 30000, maxBuffer: 128000 });
  } catch (error) {
    result = error;
  }
  const stdout = result.stdout ?? '';
  assert.equal(result.code ?? 0, 0, JSON.stringify(result));
  assert.match(stdout, /workspace write ok/);
  assert.match(stdout, /host files isolated/);
  assert.match(stdout, /node v22\./);
  assert.match(stdout, /http=000/);
  assert.match(stdout, /curl_exit=6/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'calculation.json'), 'utf8')).answer, 42);
  const analysis = await provider.confine(['python3', '-c', `import os
import numpy as np
import pandas as pd
assert os.environ['OPENBLAS_NUM_THREADS'] == '1'
prices = pd.DataFrame({
    'A': pd.Series([100.0, 100.0, 110.0, 110.0], index=pd.to_datetime(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'])),
    'B': pd.Series([100.0, 110.0, 110.0], index=pd.to_datetime(['2024-01-01', '2024-01-03', '2024-01-04'])),
})
prices = prices.reindex(pd.date_range('2024-01-01', '2024-01-04', freq='D')).ffill()
correlation = prices.pct_change(fill_method=None).corr().loc['A', 'B']
assert abs(correlation - 1.0) < 1e-12, correlation
assert np.array_equal(np.array([1, 2]) + np.array([3, 4]), np.array([4, 6]))
print('scientific packages and date alignment ok', np.__version__, pd.__version__)`
  ], policy);
  result = await run(analysis.argv[0], analysis.argv.slice(1), { cwd: directory, timeout: 30000, maxBuffer: 128000 });
  assert.match(result.stdout, /scientific packages and date alignment ok/);
  const bars = Array.from({ length: 65 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(), open: 100 + index, high: 103 + index, low: 98 + index, close: 101 + index, volume: 1000000 + index, amount: (1000000 + index) * (101 + index) }));
  writeFileSync(join(directory, 'bars.json'), JSON.stringify({ source: 'fqgate-v2', adjust: 'forward', rows: bars }));
  const argsForTools = sandboxCreateArgs('test-sandbox', directory, {});
  const mountIndex = argsForTools.findIndex((arg) => arg.endsWith(':/opt/dsh-tools:ro'));
  assert(mountIndex > 0 && argsForTools[mountIndex - 1] === '--volume');
  assert(argsForTools[mountIndex].startsWith('/'));
  const analysisCli = await provider.confine(['bash', '-c', `if echo denied > /opt/dsh-tools/should-not-write; then exit 91; fi; test -w . && test ! -w /opt/dsh-tools; market-analysis bars.json --chart analysis.png --title '测试股票 · 前复权' --csv indicators.csv > analysis.json && python3 -c "import json; d=json.load(open('analysis.json')); assert d['bars']==65 and d['adjust']=='forward'; print('market-analysis CLI, indicators and chart ok', d['latest']['ma5'])" && fc-list :lang=zh | head -1`], policy);
  result = await run(analysisCli.argv[0], analysisCli.argv.slice(1), { cwd: directory, timeout: 30000, maxBuffer: 128000 });
  assert.match(result.stdout, /market-analysis CLI, indicators and chart ok/);
  assert(existsSync(join(directory, 'analysis.png')));
  assert(existsSync(join(directory, 'indicators.csv')));
  await assert.rejects(() => provider.confine(['bash', '-c', 'pwd'], { mode: 'workspace-write', workspaceRoot: tmpdir(), sessionId: 'test-user' }), /outside configured Docker sandbox roots/);
  console.log('PASS: Docker sandbox provider, workspace write, host isolation, no network, cross-workspace rejection');
} finally {
  if (provider) await provider.dispose();
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
}
