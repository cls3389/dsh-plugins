import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 渠道身份 → userId 解析(identity cluster)。
 * userId 不是先验自然人,而是身份簇的稳定引用:
 *  - 首个 (channel, appId, openId) 首次出现自动建 userId 并登记;
 *  - 同一人更多渠道身份通过显式 bind 并入(管理员 CLI 或用户自证,起步仅 CLI);
 *  - 簇之间默认互不相认,系统不做任何猜测。
 * 文件 $DSH_HOME/identities.json(0600):
 *   { users: { u_x: { displayName, identities: [{channel, appId, openId, boundAt}] } } }
 */

const cache = new WeakMap();

function identitiesPath() {
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'identities.json');
}

function load(state) {
  if (state.data) return state.data;
  try {
    const parsed = JSON.parse(fs.readFileSync(state.path, 'utf8'));
    state.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { users: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') state.data = { users: {} };
    else throw new Error(`identities.json 读取失败: ${error.message}`);
  }
  if (!state.data.users || typeof state.data.users !== 'object') state.data.users = {};
  if (state.index === undefined) buildIndex(state);
  return state.data;
}

function buildIndex(state) {
  state.index = new Map();
  for (const [userId, user] of Object.entries(state.data.users)) {
    for (const identity of user.identities ?? []) {
      state.index.set(indexKey(identity), userId);
    }
  }
}

function indexKey({ channel, appId, openId }) {
  return crypto.createHash('sha256').update(`${channel}:${appId}:${openId}`).digest('hex').slice(0, 40);
}

function save(state) {
  fs.mkdirSync(path.dirname(state.path), { recursive: true });
  const tmp = `${state.path}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state.data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, state.path);
}

function stateFor_(config) {
  const pathValue = config?.identitiesFile ?? identitiesPath();
  let state = cache.get(config ?? {});
  if (!state || state.path !== pathValue) {
    state = { path: pathValue, data: undefined, index: undefined };
    cache.set(config ?? {}, state);
  }
  return state;
}

function newUserId(state) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  let candidate = `u_${ts}${rand}`;
  while (state.data.users[candidate]) candidate = `u_${ts}${crypto.randomBytes(4).toString('hex')}`;
  return candidate;
}

/**
 * 解析渠道身份为 userId;未登记时自动建档登记。
 * @returns {{ userId: string, created: boolean, displayName?: string }}
 */
export function resolveIdentity(identity, options = {}) {
  if (!identity?.channel || !identity?.appId || !identity?.openId) {
    throw new Error('身份三元组不完整:需要 channel/appId/openId');
  }
  const state = stateFor_(options);
  load(state);
  const key = indexKey(identity);
  const existing = state.index.get(key);
  if (existing) return { userId: existing, created: false };
  const userId = newUserId(state);
  state.data.users[userId] = {
    displayName: identity.displayName,
    identities: [{ ...identity, boundAt: new Date().toISOString() }],
  };
  state.index.set(key, userId);
  if (options.readonly !== true) save(state);
  return { userId, created: true };
}

/**
 * 把一个渠道身份显式并入目标 userId(管理员绑定)。
 * 身份若已属于其他 userId,先解绑再并入;返回被并入前的旧 userId(供调用方迁移档案)。
 */
export function bindIdentity(userId, identity, options = {}) {
  const state = stateFor_(options);
  load(state);
  const target = state.data.users[userId];
  if (!target) throw new Error(`目标 userId 不存在: ${userId}`);
  const key = indexKey(identity);
  const previousUserId = state.index.get(key);
  if (previousUserId === userId) return { previousUserId: undefined };
  if (previousUserId) {
    const previous = state.data.users[previousUserId];
    previous.identities = (previous.identities ?? []).filter((entry) => indexKey(entry) !== key);
    if ((previous.identities ?? []).length === 0) delete state.data.users[previousUserId];
  }
  target.identities = [...(target.identities ?? []), { ...identity, boundAt: new Date().toISOString() }];
  state.index.set(key, userId);
  if (options.readonly !== true) save(state);
  // 合并后消费方缓存必须失效(principal 的 userKeyCache 按约定回调清理)。
  if (typeof options.onBound === 'function') options.onBound({ userId, previousUserId });
  return { previousUserId };
}

/** 列出全部身份簇(审计/CLI 展示)。 */
export function listIdentities(options = {}) {
  const state = stateFor_(options);
  load(state);
  return state.data.users;
}
