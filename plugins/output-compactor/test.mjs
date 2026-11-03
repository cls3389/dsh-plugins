import assert from 'node:assert/strict';
import { apply } from './index.js';

let tool;
const calls = [];
const ctx = {
  tools: { register: (definition) => { tool = definition; } },
  logger: { info: () => {} },
  shell: {
    resolve(request) { calls.push(request); return { ...request, workdir: '/trusted/user/workspace' }; },
    async execute(spec) {
      assert.equal(spec.workdir, '/trusted/user/workspace');
      return { result: async () => ({ exitCode: 0, timedOut: false, aborted: false, stdout: { text: 'sandbox-ok\n' }, stderr: { text: '' } }) };
    },
  },
  workingDirectory: {},
};
apply(ctx);
const result = await tool.execute({ command: 'pwd', description: 'test default workspace' }, { agent: { session: { id: 'user' } }, signal: new AbortController().signal });
assert.equal(result.output, 'sandbox-ok\n');
assert.equal(result.cwd, '/trusted/user/workspace');
assert.equal(calls.length, 1);
assert.equal(calls[0].workdir, undefined);
assert.equal(calls[0].agent.session.id, 'user');
console.log('PASS: compact output delegates execution to ctx.shell without host bash');
