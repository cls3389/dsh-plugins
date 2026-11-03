import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Synchronous local-host registry transactions. Every mutation starts from disk under the lock. */
const pause = new Int32Array(new SharedArrayBuffer(4));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function identitiesPath() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'identities.json');
}

function hasUserData(userId) {
  return fs.existsSync(path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'home', 'users', userId));
}

function assertIdentity(identity) {
  if (!object(identity) || !['channel', 'appId', 'openId'].every((key) => typeof identity[key] === 'string' && identity[key])) {
    throw new Error('身份三元组不完整:需要 channel/appId/openId');
  }
}

function indexKey({ channel, appId, openId }) {
  return JSON.stringify([channel, appId, openId]);
}

/** Reject corruption and duplicate ownership; never silently repair an existing registry. */
function readState(file) {
  let data;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('注册表必须为普通文件');
      data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code === 'ENOENT') data = { users: {} };
    else throw new Error(`identities.json 读取失败: ${error.message}`);
  }
  if (!object(data) || !object(data.users)) throw new Error('identities.json 格式错误: users 必须为对象');
  const state = { path: file, data, index: new Map(), unionIndex: new Map(), dirty: false };
  for (const [userId, user] of Object.entries(data.users)) {
    if (!object(user) || !Array.isArray(user.identities)) throw new Error(`identities.json 格式错误: ${userId}.identities 必须为数组`);
    for (const identity of user.identities) {
      assertIdentity(identity);
      const key = indexKey(identity);
      if (state.index.has(key)) throw new Error(`identities.json 重复身份归属: ${key} (${state.index.get(key)}, ${userId})`);
      state.index.set(key, userId);
      if (identity.unionId) state.unionIndex.set(identity.unionId, userId);
    }
  }
  return state;
}

function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { start: fields[19], dead: fields[0] === 'Z' || fields[0] === 'X' };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return { dead: true };
    throw error; // Unknown liveness is not permission to steal a lock.
  }
}

function ownerDead(owner) {
  if (!object(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.start !== 'string' || !/^\d+$/.test(owner.start) || typeof owner.boot !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.boot)) return false;
  try {
    if (fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.boot) return true;
    const info = processInfo(owner.pid);
    return info.dead || info.start !== owner.start;
  } catch {
    return false;
  }
}

/** Only unlink the observed unique token. Never recursively remove a shared lock path. */
function removeToken(lock, token) {
  try { fs.unlinkSync(path.join(lock, token)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.rmdirSync(lock); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function reapDeadOwner(lock) {
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('身份锁路径必须为真实目录');
    const entries = fs.readdirSync(lock);
    if (entries.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(entries[0])) return;
    const token = entries[0];
    const fd = fs.openSync(path.join(lock, token), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let owner;
    try { owner = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
    if (ownerDead(owner)) removeToken(lock, token);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function acquireLock(file, options) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const token = `owner-${crypto.randomUUID()}.json`;
  const stage = `${file}.lock-stage-${crypto.randomUUID()}`;
  const lock = `${file}.lock`;
  const info = processInfo(process.pid);
  const owner = { pid: process.pid, start: info.start, boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  if (!owner.start || info.dead) throw new Error('身份锁无法核验当前进程');
  const timeout = options.lockTimeoutMs ?? 2000;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000) throw new Error('lockTimeoutMs 必须为 0..30000');
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    const fd = fs.openSync(path.join(stage, token), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectory(stage);
    const deadline = performance.now() + timeout;
    while (true) {
      try {
        // A prepared nonempty directory publishes owner and acquisition atomically.
        // rename can replace an empty release/crash window, never another nonempty lock.
        fs.renameSync(stage, lock);
        return () => removeToken(lock, token);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      reapDeadOwner(lock);
      if (performance.now() >= deadline) {
        const error = new Error(`identities.json 锁等待超时 (${timeout}ms)`);
        error.code = 'IDENTITY_LOCK_TIMEOUT';
        throw error;
      }
      Atomics.wait(pause, 0, 0, Math.min(10, Math.max(1, deadline - performance.now())));
    }
  } finally {
    // This exact stage belongs to this invocation; a successful rename leaves it absent.
    removeToken(stage, token);
  }
}

function save(state) {
  const tmp = `${state.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state.data, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, state.path);
    try { fsyncDirectory(path.dirname(state.path)); } catch (cause) {
      const error = new Error('identities.json 已原子替换，但目录 fsync 失败；提交可能已可见，请重新读取核对', { cause });
      error.code = 'IDENTITY_COMMIT_UNCERTAIN';
      throw error;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function transaction(options, operation) {
  const file = options.identitiesFile ?? identitiesPath();
  if (options.readonly === true) return operation(readState(file));
  const release = acquireLock(file, options);
  try {
    const state = readState(file);
    const result = operation(state);
    if (state.dirty) save(state);
    return result;
  } finally { release(); }
}

function newUserId(state) {
  let userId;
  do { userId = `u_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; } while (Object.hasOwn(state.data.users, userId));
  return userId;
}

/** Existing union policy: exact tuple, then union match; conflicts keep the side with user data. */
function resolveInState(state, identity) {
  const key = indexKey(identity);
  const existing = state.index.get(key);
  if (existing) {
    if (identity.unionId) {
      const owner = state.unionIndex.get(identity.unionId);
      const entry = state.data.users[existing].identities.find((it) => indexKey(it) === key);
      if (!entry.unionId) {
        entry.unionId = identity.unionId;
        state.unionIndex.set(identity.unionId, existing);
        state.dirty = true;
      }
      if (owner && owner !== existing) {
        const keep = hasUserData(existing) && !hasUserData(owner) ? existing : owner;
        const drop = keep === existing ? owner : existing;
        state.data.users[keep].identities.push(...state.data.users[drop].identities);
        delete state.data.users[drop];
        state.dirty = true;
        return { userId: keep, created: false, merged: true };
      }
    }
    return { userId: existing, created: false };
  }
  if (identity.unionId) {
    const owner = state.unionIndex.get(identity.unionId);
    if (owner) {
      state.data.users[owner].identities.push({ ...identity, boundAt: new Date().toISOString() });
      state.dirty = true;
      return { userId: owner, created: false, merged: true };
    }
  }
  const userId = newUserId(state);
  state.data.users[userId] = { displayName: identity.displayName, identities: [{ ...identity, boundAt: new Date().toISOString() }] };
  state.dirty = true;
  return { userId, created: true };
}

export function resolveIdentity(identity, options = {}) {
  assertIdentity(identity);
  // Most calls only read an existing tuple. A possible mutation is always re-evaluated under the lock.
  const snapshot = readState(options.identitiesFile ?? identitiesPath());
  const existing = snapshot.index.get(indexKey(identity));
  if (existing) {
    const entry = snapshot.data.users[existing].identities.find((it) => indexKey(it) === indexKey(identity));
    const owner = identity.unionId && snapshot.unionIndex.get(identity.unionId);
    if (!identity.unionId || (entry.unionId && (!owner || owner === existing))) return { userId: existing, created: false };
  }
  return transaction(options, (state) => resolveInState(state, identity));
}

export function bindIdentity(userId, identity, options = {}) {
  assertIdentity(identity);
  const result = transaction(options, (state) => {
    const target = Object.hasOwn(state.data.users, userId) && state.data.users[userId];
    if (!target) throw new Error(`目标 userId 不存在: ${userId}`);
    const key = indexKey(identity);
    const previousUserId = state.index.get(key);
    if (previousUserId === userId) return { previousUserId: undefined };
    if (previousUserId) {
      const previous = state.data.users[previousUserId];
      previous.identities = previous.identities.filter((entry) => indexKey(entry) !== key);
      if (!previous.identities.length) delete state.data.users[previousUserId];
    }
    target.identities.push({ ...identity, boundAt: new Date().toISOString() });
    state.dirty = true;
    return { previousUserId };
  });
  // External callbacks may re-enter the registry; invoke only after commit and release.
  if (options.readonly !== true && typeof options.onBound === 'function') options.onBound({ userId, ...result });
  return result;
}

/** Fresh atomic snapshot; no locks, directory creation, cache mutation or repair. */
export function listIdentities(options = {}) {
  return readState(options.identitiesFile ?? identitiesPath()).data.users;
}
