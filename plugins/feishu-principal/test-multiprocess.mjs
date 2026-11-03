import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(path.join(root, 'index.js')).href;
const workers = new Set();
const directories = new Set();
const workerSource = `
import fs from 'node:fs';
const api = await import(${JSON.stringify(entry)});
const options = {};
process.on('message', ({ id, action, args = [], opts = {} }) => {
  try {
    if (action === 'hold') {
      const rename = fs.renameSync;
      fs.renameSync = function (from, to) {
        const result = rename(from, to);
        if (to.endsWith('.lock')) {
          process.send({ id, held: true });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
        }
        return result;
      };
      api.resolveIdentity(args[0]);
    } else {
      const result = action === 'userKey' ? api[action](...args) : api[action](...args, Object.assign(options, opts));
      process.send({ id, result });
    }
  } catch (error) { process.send({ id, error: error.message, code: error.code }); }
});
process.send({ ready: true });
`;

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-transaction-'));
  directories.add(dir);
  return dir;
}

async function worker(dir) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
    env: { ...process.env, DSH_HOME: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  workers.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const pending = new Map();
  let sequence = 0;
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message.ready) resolve();
      else {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(Object.assign(new Error(message.error), { code: message.code }));
        else request?.resolve(message.held ? { held: true } : message.result);
      }
    });
    child.on('exit', (code, signal) => {
      const error = new Error(`worker exited ${code}/${signal}: ${stderr}`);
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
  });
  await ready;
  return {
    child,
    call(action, args = [], opts = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, action, args, opts });
      });
    },
  };
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  workers.delete(child);
}

test.afterEach(async () => {
  await Promise.all([...workers].map(stop));
  for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
  directories.clear();
});

const identity = (number) => ({ channel: 'feishu', appId: 'cli_transactions', openId: `ou_${number.toString(16).padStart(32, '0')}` });
const disk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'identities.json'), 'utf8'));

test('simultaneous processes resolve the same new tuple to exactly one owner', async () => {
  const dir = home();
  const group = await Promise.all(Array.from({ length: 10 }, () => worker(dir)));
  const results = await Promise.all(group.map((process) => process.call('resolveIdentity', [identity(1)])));
  assert.equal(new Set(results.map((result) => result.userId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(Object.keys(disk(dir).users).length, 1);
  assert.equal(fs.statSync(path.join(dir, 'identities.json')).mode & 0o777, 0o600);
});

test('simultaneous processes preserve every different tuple', async () => {
  const dir = home();
  const group = await Promise.all(Array.from({ length: 10 }, () => worker(dir)));
  await Promise.all(group.map((process, index) => process.call('resolveIdentity', [identity(index + 1)])));
  assert.equal(Object.keys(disk(dir).users).length, group.length);
  assert.equal(new Set(Object.values(disk(dir).users).flatMap((user) => user.identities.map((it) => it.openId))).size, group.length);
});

test('long-lived readers and userKey observe another process bind; later writes cannot resurrect old ownership', async () => {
  const dir = home();
  const stale = await worker(dir);
  const writer = await worker(dir);
  const moving = identity(1);
  const first = await stale.call('userKey', [moving.openId, moving.appId]);
  const target = await writer.call('resolveIdentity', [identity(2)]);
  await stale.call('listIdentities');
  await writer.call('bindIdentity', [target.userId, moving]);
  assert.equal(await stale.call('userKey', [moving.openId, moving.appId]), target.userId);
  const latest = await stale.call('listIdentities');
  assert.equal(latest[first], undefined);
  await stale.call('resolveIdentity', [identity(3)]);
  const users = disk(dir).users;
  assert.equal(users[first], undefined);
  assert.equal(Object.keys(users).length, 2);
  assert.equal(Object.values(users).flatMap((user) => user.identities).filter((it) => it.openId === moving.openId).length, 1);
});

test('alive lock times out without writing; a killed owner is recoverable under competing waiters', async () => {
  const dir = home();
  const holder = await worker(dir);
  const contenders = await Promise.all(Array.from({ length: 5 }, () => worker(dir)));
  assert.deepEqual(await holder.call('hold', [identity(1)]), { held: true });
  const lock = path.join(dir, 'identities.json.lock');
  const token = fs.readdirSync(lock)[0];
  const before = fs.readFileSync(path.join(lock, token), 'utf8');
  await assert.rejects(contenders[0].call('resolveIdentity', [identity(2)], { lockTimeoutMs: 50 }), { code: 'IDENTITY_LOCK_TIMEOUT' });
  assert.equal(fs.existsSync(path.join(dir, 'identities.json')), false);
  assert.equal(fs.readFileSync(path.join(lock, token), 'utf8'), before);
  await stop(holder.child);
  await Promise.all(contenders.map((process, index) => process.call('resolveIdentity', [identity(index + 2)], { lockTimeoutMs: 2000 })));
  assert.equal(Object.keys(disk(dir).users).length, contenders.length);
  assert.equal(fs.existsSync(lock), false);
});

test('PID reuse is distinguished by proc start time and unidentifiable locks fail closed', async () => {
  const dir = home();
  const client = await worker(dir);
  const lock = path.join(dir, 'identities.json.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner-00000000.json'), JSON.stringify({ pid: process.pid, start: '0', boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }));
  await client.call('resolveIdentity', [identity(1)]);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner-11111111.json'), '{');
  const before = fs.readFileSync(path.join(dir, 'identities.json'), 'utf8');
  await assert.rejects(client.call('resolveIdentity', [identity(2)], { lockTimeoutMs: 25 }), { code: 'IDENTITY_LOCK_TIMEOUT' });
  assert.equal(fs.readFileSync(path.join(dir, 'identities.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(lock, 'owner-11111111.json'), 'utf8'), '{');
});

test('corrupt or duplicate registries fail closed, including after a process has read valid data', async () => {
  const dir = home();
  const client = await worker(dir);
  await client.call('resolveIdentity', [identity(1)]);
  const file = path.join(dir, 'identities.json');
  for (const content of ['{', '{}', '{"users":[]}', JSON.stringify({ users: { u_bad: { identities: {} } } }), JSON.stringify({ users: { u_a: { identities: [identity(1)] }, u_b: { identities: [identity(1)] } } })]) {
    fs.writeFileSync(file, content);
    await assert.rejects(client.call('resolveIdentity', [identity(2)]), /identities.json/);
    await assert.rejects(client.call('bindIdentity', ['u_a', identity(2)]), /identities.json/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
});

test('readonly unknown resolve/list and bind do not create directories, locks or files', async () => {
  const dir = home();
  const client = await worker(dir);
  const missing = path.join(dir, 'absent', 'identities.json');
  const options = { identitiesFile: missing, readonly: true };
  await client.call('resolveIdentity', [identity(1)], options);
  assert.deepEqual(await client.call('listIdentities', [], options), {});
  await assert.rejects(client.call('bindIdentity', ['u_missing', identity(1)], options), /目标 userId 不存在/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('unknown registry metadata survives and a post-commit callback can re-enter', async () => {
  const dir = home();
  const file = path.join(dir, 'identities.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, note: { kept: true }, users: {} }));
  const { resolveIdentity, bindIdentity, listIdentities } = await import(entry);
  const options = { identitiesFile: file };
  const a = resolveIdentity(identity(1), options);
  const b = resolveIdentity(identity(2), options);
  let called = false;
  bindIdentity(b.userId, identity(1), { ...options, onBound() {
    called = true;
    resolveIdentity(identity(3), options);
  } });
  assert.equal(called, true);
  assert.equal(listIdentities(options)[a.userId], undefined);
  assert.deepEqual(disk(dir).note, { kept: true });
  assert.equal(disk(dir).version, 2);
  assert.throws(() => bindIdentity(b.userId, { channel: 'feishu' }, options), /三元组不完整/);
});

test('a failed commit preserves the old registry, releases its lock and never calls onBound', async () => {
  const dir = home();
  const file = path.join(dir, 'identities.json');
  const { resolveIdentity, bindIdentity } = await import(entry);
  const options = { identitiesFile: file };
  resolveIdentity(identity(1), options);
  const target = resolveIdentity(identity(2), options);
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  let called = false;
  fs.renameSync = function (from, to) {
    if (to === file) throw Object.assign(new Error('injected commit failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    assert.throws(() => bindIdentity(target.userId, identity(1), { ...options, onBound() { called = true; } }), /injected commit failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(called, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['identities.json']);
  bindIdentity(target.userId, identity(1), options);
  assert.equal(Object.keys(disk(dir).users).length, 1);
});

test('an empty crash/release lock is safely replaced without touching abandoned stages', async () => {
  const dir = home();
  const file = path.join(dir, 'identities.json');
  fs.mkdirSync(`${file}.lock`);
  const abandoned = `${file}.lock-stage-abandoned`;
  fs.mkdirSync(abandoned);
  fs.writeFileSync(path.join(abandoned, 'do-not-touch'), 'old stage');
  const client = await worker(dir);
  await client.call('resolveIdentity', [identity(1)]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(fs.readFileSync(path.join(abandoned, 'do-not-touch'), 'utf8'), 'old stage');
});

test('registry and lock symlinks are rejected without following or modifying their targets', async () => {
  const dir = home();
  const client = await worker(dir);
  const file = path.join(dir, 'identities.json');
  const outside = path.join(dir, 'target.json');
  fs.writeFileSync(outside, JSON.stringify({ users: {} }));
  fs.symlinkSync(outside, file);
  await assert.rejects(client.call('resolveIdentity', [identity(1)]), /读取失败/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"users":{}}');
  fs.unlinkSync(file);
  const target = path.join(dir, 'external-lock');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'owner-00000000.json'), '{}');
  fs.symlinkSync(target, `${file}.lock`);
  await assert.rejects(client.call('resolveIdentity', [identity(1)]));
  assert.deepEqual(fs.readdirSync(target), ['owner-00000000.json']);
  assert.equal(fs.existsSync(file), false);
});

test('post-rename directory fsync failure reports uncertain commit and releases the lock', async () => {
  const dir = home();
  const file = path.join(dir, 'identities.json');
  const { resolveIdentity } = await import(entry);
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    if (fs.fstatSync(fd).isDirectory() && fs.existsSync(file)) throw new Error('injected directory fsync error');
    return original(fd);
  };
  try {
    assert.throws(() => resolveIdentity(identity(1), { identitiesFile: file }), { code: 'IDENTITY_COMMIT_UNCERTAIN' });
  } finally { fs.fsyncSync = original; }
  assert.equal(Object.keys(disk(dir).users).length, 1);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('packed package imports and resolves from an isolated temporary DSH_HOME', () => {
  const dir = home();
  const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }));
  const artifact = path.join(dir, pack[0].filename);
  execFileSync('tar', ['-xzf', artifact, '-C', dir]);
  const packedEntry = pathToFileURL(path.join(dir, 'package', 'index.js')).href;
  const isolated = path.join(dir, 'runtime');
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `const api = await import(${JSON.stringify(packedEntry)}); console.log(api.userKey(${JSON.stringify(identity(1).openId)}, 'cli_pack'));`], { env: { ...process.env, DSH_HOME: isolated }, encoding: 'utf8' });
  assert.match(result.trim(), /^u_[a-z0-9]+$/);
  assert.equal(Object.keys(disk(isolated).users).length, 1);
  assert.ok(pack[0].files.some((file) => file.path === 'identities.js'));
  assert.ok(pack[0].files.some((file) => file.path === 'index.d.ts'));
});
