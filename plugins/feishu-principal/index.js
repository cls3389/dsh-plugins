import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { bindIdentity, listIdentities, resolveIdentity } from './identities.js';

export { bindIdentity, listIdentities, resolveIdentity };

export const name = 'feishu-principal';

export function assertOpenId(openId) {
  if (typeof openId !== 'string' || !/^ou_[a-f0-9]{32}$/i.test(openId)) {
    throw new Error('缺少可信飞书用户身份，已拒绝访问用户数据');
  }
  return openId;
}

/**
 * 身份簇解析:渠道身份 → userId(identity cluster)。
 * userId 不是先验自然人;首个渠道身份自动建档,更多身份靠显式 bind 并入。
 * userKey 保留旧名(目录键),语义升级为 identity-cluster 键。
 * 每次读取注册表最新快照，其他进程 bind 后目录键立即跟随，不保留进程级归属缓存。
 */
// Kept for callers using the previous cache-invalidation API.
export function invalidateUserKeyCache() {}

export function userKey(openId, appId, unionId) {
  assertOpenId(openId);
  return resolveIdentity({ channel: 'feishu', appId: appId ?? 'unscoped', openId, ...(unionId ? { unionId } : {}) }).userId;
}

/** bindIdentity + 缓存失效的统一入口(管理员绑定身份簇)。 */
export function bindIdentityWithCache(userId, identity, options = {}) {
  const result = bindIdentity(userId, identity, {
    ...options,
    onBound: ({ userId: bound, previousUserId }) => {
      invalidateUserKeyCache();
      if (typeof options.onBound === 'function') options.onBound({ userId: bound, previousUserId });
    },
  });
  invalidateUserKeyCache();
  return result;
}

export function principalKey(openId, appId, defaultAppId, unionId) {
  if (appId) {
    if (!defaultAppId || !/^cli_[a-z0-9]+$/i.test(appId) || !/^cli_[a-z0-9]+$/i.test(defaultAppId)) throw new Error('飞书应用身份无效');
  }
  // 登录态键跟随身份簇 userId:同簇身份共享登录态,不同簇天然隔离。
  // union_id 让同一自然人跨 bot 归并到同一簇 → 一个飞书账号一个身份。
  return userKey(openId, appId ?? defaultAppId, unionId);
}

/**
 * Channel-neutral identity resolver. Unlike userKey(), this accepts arbitrary
 * provider subject IDs (for example Weixin ilink_user_id) and never applies
 * Feishu's ou_<hex> validation.
 */
export function resolveAgentIdentity({ channel, appId, subjectId, displayName }, options = {}) {
  if (typeof channel !== 'string' || !channel || typeof appId !== 'string' || !appId || typeof subjectId !== 'string' || !subjectId) {
    throw new Error('身份三元组不完整:需要 channel/appId/subjectId');
  }
  return resolveIdentity({ channel, appId, openId: subjectId, ...(displayName !== undefined ? { displayName } : {}) }, options);
}

/**
 * 用户中心根目录(2026-11-02 迁移): /data/dsh/home/users/<u_xxx>
 * 每用户档案: config/ + <agentId>/{workspace,memory};身份注册表、渠道绑定与运行日志另存。
 */
export const USER_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'home', 'users');

/** 新布局: users/<userId>/<agentId>/workspace */
function workspaceNewLayout(userId, agentId) {
  const safeAgent = /^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId ?? '') ? agentId : null;
  if (!safeAgent) return null;
  const directory = path.join(USER_ROOT, userId, safeAgent, 'workspace');
  if (!directory.startsWith(`${USER_ROOT}${path.sep}`)) return null;
  return directory;
}

/**
 * 旧签名的用户档案路径解析(agents/<agentId>/users/<userId>)。
 * 新代码优先 workspaceForIdentity(用户中心布局);此函数留给兼容期调用方
 * 与身份簇一致性测试——同一身份簇必须落到同一路径,换 bot 不换档案。
 */
export function workspaceFor(appRoot, openId, appId, unionId) {
  assertOpenId(openId);
  const userId = userKey(openId, appId, unionId);
  return path.join(path.resolve(appRoot), 'users', userId);
}

/** Resolve a user archive from a previously trusted channel-neutral identity. */
export function workspaceForIdentity(appRoot, identity) {
  const root = path.resolve(appRoot);
  const userId = identity?.userId;
  if (typeof userId !== 'string' || !/^u_[a-z0-9_-]{1,63}$/.test(userId)) throw new Error('用户身份 userId 无效');
  // 用户中心唯一布局(2026-11-02 定稿): users/<userId>/<agentId>/workspace。无 agentId 视为配置错误。
  const agentId = identity?.agentId ?? (typeof appRoot === 'string' ? path.basename(root) : undefined);
  const fresh = workspaceNewLayout(userId, agentId);
  if (fresh) return fresh;
  throw new Error(`用户 ${userId} 缺少有效 agentId,无法定位用户中心工作区`);
}

/** 记忆目录(新布局): users/<userId>/<agentId>/memory — 在 workspace 围栏外,钩子强制。 */
export function memoryForIdentity(identity) {
  const userId = identity?.userId;
  const agentId = identity?.agentId;
  if (typeof userId !== 'string' || !/^u_[a-z0-9_-]{1,63}$/.test(userId)) throw new Error('用户身份 userId 无效');
  if (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) throw new Error('身份目录名无效');
  const directory = path.join(USER_ROOT, userId, agentId, 'memory');
  if (!directory.startsWith(`${USER_ROOT}${path.sep}`)) throw new Error('记忆路径越界');
  return directory;
}

export function stateForKey(root, key, category) {
  const validKey = /^[u_][a-z0-9_-]{1,63}$/.test(key) || /^[a-f0-9]{32}$/.test(key);
  if (!validKey) throw new Error('非法用户登录态键');
  if (typeof category !== 'string' || !category || path.isAbsolute(category) || category.split(/[\\/]/).includes('..')) {
    throw new Error('非法用户登录态分类');
  }
  const base = path.resolve(root);
  const directory = path.join(base, `user-${key}`, category);
  if (!directory.startsWith(`${base}${path.sep}`)) throw new Error('用户登录态路径越界');
  return directory;
}

export function stateFor(root, openId, category) {
  return stateForKey(root, userKey(openId), category);
}

export function readUsers(filePath) {
  if (!filePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`用户连接配置读取失败: ${error.message}`);
  }
}

function validUrl(value) {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

/**
 * 唯一查找:身份 → usersFile users.<u_xxx> 段(2026-11-02 收敛,应用域/ou_ 顶层键已废弃)。
 * 字符串入参(ou_ openId,飞书)内部经 resolveIdentity 归一 userId;身份对象直接用。
 */
function userForIdentity(users, identity, cfg) {
  let userId = typeof identity === 'string' ? undefined : identity?.userId;
  if (typeof userId !== 'string' || !/^u_/.test(userId)) {
    const subject = typeof identity === 'string' ? identity : identity?.subjectId ?? identity?.openId;
    if (typeof subject === 'string' && subject) {
      const channel = typeof identity === 'string' ? 'feishu' : identity?.channel ?? 'feishu';
      const appId = (typeof identity === 'string' ? cfg?.defaultAppId : identity?.appId ?? cfg?.defaultAppId) ?? 'unscoped';
      try {
        userId = resolveAgentIdentity({ channel, appId, subjectId: subject }).userId;
      } catch { return undefined; }
    }
  }
  if (typeof userId !== 'string' || !/^u_/.test(userId)) return undefined;
  return users[userId];
}

/**
 * 按渠道身份取 users 段条目。
 * 支持三种登记形态：
 *  1. `applications[appId][openId]`：应用域显式配置（配置用到该段时，非默认应用只看它，
 *     查不到即无权限——应用之间不互相继承，避免一个 bot 的授权串到另一个）；
 *  2. `users[openId]`：按渠道身份登记（旧格式）；
 *  3. 身份簇 userId（现行生产格式，user-connections.json）。
 */
function userForApp(users, openId, appId, defaultAppId) {
  if (typeof openId !== 'string' || !openId) return undefined;
  const apps = users.applications;
  const hasAppScoping = apps && typeof apps === 'object' && !Array.isArray(apps);
  if (hasAppScoping && appId && appId !== defaultAppId) {
    return apps[appId]?.[openId]; // 非默认应用：只认该应用域配置
  }
  if (users[openId]) return users[openId];
  return userForIdentity(users, { channel: 'feishu', appId: appId ?? defaultAppId ?? 'unscoped', subjectId: openId }, { defaultAppId });
}

export function connectionForUser(openId, cfg, kind, appId) {
  // 渠道身份对象({channel,appId,subjectId,userId})或飞书 ou_ openId 字符串;统一归一 userId 查 users 段。
  const isIdentityObject = openId && typeof openId === 'object';
  if (!isIdentityObject) assertOpenId(openId);
  const users = readUsers(cfg.usersFile);
  const directUser = typeof openId === 'string' ? userForApp(users, openId, appId, cfg.defaultAppId) : undefined;
  const user = directUser
    ?? userForIdentity(users, openId, { ...cfg, ...(appId !== undefined ? { defaultAppId: cfg.defaultAppId } : {}) });
  // Public market data remains available before enrollment; private services never do.
  if (kind === 'market' && !user) return cfg;
  if (!user || user.enabled === false) {
    const guidance = kind === 'trading' ? '请联系管理员开通并配置独立的 xiadan 交易连接；同花顺自选扫码登录不能开通交易功能'
      : kind === 'aiSignal' ? '请联系管理员开通并配置独立的 AI 分时交易连接' : '请联系管理员开通并配置该业务连接';
    throw new Error(`当前用户尚未配置或启用该业务连接；${guidance}`);
  }
  if (kind === 'market') {
    if (user.features?.market === false) throw new Error('当前用户未启用公共行情功能');
    const market = user.market ?? {};
    if (market.fqgateBaseUrl !== undefined && !validUrl(market.fqgateBaseUrl)) throw new Error('用户行情地址无效');
    if (market.dataCenterBaseUrl !== undefined && !validUrl(market.dataCenterBaseUrl)) throw new Error('用户数据中心地址无效');
    return { ...cfg, ...market };
  }
  if (kind === 'trading') {
    const connection = user.trading;
    if (user.features?.trading === false || !connection || !validUrl(connection.baseUrl) || !connection.apiKey) {
      throw new Error('当前用户未开通或未完整配置独立的 xiadan 交易连接；请联系管理员配置，同花顺自选扫码登录不能开通交易功能');
    }
    return {
      ...cfg,
      xiadanBaseUrl: connection.baseUrl,
      xiadanApiKey: connection.apiKey,
      ...(Number.isFinite(user.limits?.maxOrderValue) ? { autoTradeMaxOrderValue: user.limits.maxOrderValue } : {}),
      ...(Number.isFinite(user.limits?.dailyMaxValue) ? { autoTradeDailyMaxValue: user.limits.dailyMaxValue } : {}),
      ...(Number.isFinite(user.limits?.maxDeviationPercent) ? { autoTradeMaxDeviationPercent: user.limits.maxDeviationPercent } : {}),
    };
  }
  if (kind === 'aiSignal') {
    const connection = user.aiSignal;
    if (user.features?.aiSignal === false || !connection || !validUrl(connection.baseUrl)) {
      throw new Error('当前用户未配置 AI 分时交易项目连接');
    }
    return {
      ...cfg,
      signalTraderBaseUrl: connection.baseUrl,
      signalTraderWebuiToken: connection.webuiToken ?? '',
      signalTraderWebhookToken: connection.webhookToken ?? '',
    };
  }
  throw new Error(`未知用户连接类型: ${kind}`);
}

export function currentOpenId(agent) {
  return agent?.larkUser?.openId;
}

/**
 * 基座身份服务:把渠道绑定的身份(宿主级数据字段 agent.identity,或兼容期
 * feishu-channel 的 agent.larkUser)规整为统一 identity 形态:
 *   { channel, agentId?, appId?, subjectId, userId, context: { chatId?, accountId?, chatType? } }
 * - identity 优先(channel 新契约,subjectId=渠道内主体 id,openId 即飞书主体 id);
 * - 无 identity 时从 larkUser 合成(channel:'feishu',userId 走 userKey 身份簇);
 * - 两者皆无 → undefined(调用方按"无身份"分支处理)。
 * @param {import('openclaw/plugin-sdk').Agent | { identity?: object, larkUser?: object } | undefined} agent
 */
export function identityOf(agent) {
  const identity = agent?.identity;
  if (identity && typeof identity === 'object' && typeof identity.subjectId === 'string') {
    return identity;
  }
  const larkUser = agent?.larkUser;
  if (!larkUser || typeof larkUser.openId !== 'string') return undefined;
  return {
    channel: 'feishu',
    ...(larkUser.agentId !== undefined ? { agentId: larkUser.agentId } : {}),
    ...(larkUser.appId !== undefined ? { appId: larkUser.appId } : {}),
    subjectId: larkUser.openId,
    userId: userKey(larkUser.openId, larkUser.appId, larkUser.unionId),
    context: {
      ...(larkUser.chatId !== undefined ? { chatId: larkUser.chatId } : {}),
      ...(larkUser.accountId !== undefined ? { accountId: larkUser.accountId } : {}),
    },
  };
}

/**
 * @deprecated 过渡期兼容:业务插件从 larkUser 迁往 identityOf 时,可先用本函数
 * 提取旧形态 {openId, appId, agentId}(openId=identity.subjectId)。
 */
export function principalOf(agent) {
  const identity = identityOf(agent);
  if (!identity) return undefined;
  return {
    openId: identity.subjectId,
    ...(identity.appId !== undefined ? { appId: identity.appId } : {}),
    ...(identity.agentId !== undefined ? { agentId: identity.agentId } : {}),
  };
}

/** Shared tool defaults plus optional per-user additions, never private credentials. */
export function toolAllowFor(openId, defaults, usersFile, appId, defaultAppId) {
  const base = Array.isArray(defaults) ? defaults : [];
  const user = openId ? userForApp(readUsers(usersFile), openId, appId, defaultAppId) : undefined;
  const extra = user?.tools?.extra ?? [];
  if (!Array.isArray(extra) || extra.some((pattern) => typeof pattern !== 'string' || !pattern)) {
    throw new Error('用户 tools.extra 必须是工具名称或通配符数组');
  }
  return [...new Set([...base, ...extra])];
}

export function apply(ctx, config) {
  // usersFile 未配置时走 $DSH_HOME/lark/user-connections.json(可移植默认,profile 可覆盖)
  const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
  const cfg = {
    usersFile: path.join(dshHome, 'lark', 'user-connections.json'),
    ...config,
  };
  ctx.provide('feishuPrincipal', {
    userKey,
    workspaceFor,
    stateFor,
    currentOpenId,
    toolsFor(openId, defaults = [], appId) {
      assertOpenId(openId);
      return toolAllowFor(openId, defaults, cfg.usersFile, appId, cfg.defaultAppId);
    },
    user(openId, appId) {
      assertOpenId(openId);
      return userForApp(readUsers(cfg.usersFile), openId, appId, cfg.defaultAppId);
    },
    connection(openId, kind, defaults = {}, appId) {
      return connectionForUser(openId, { ...defaults, usersFile: cfg.usersFile, defaultAppId: cfg.defaultAppId }, kind, appId);
    },
    forAgent(agent, kind, defaults = {}) {
      const openId = currentOpenId(agent);
      if (!openId && cfg.usersFile) throw new Error('当前执行上下文缺少用户身份，已拒绝使用默认配置');
      return openId ? connectionForUser(openId, { ...defaults, usersFile: cfg.usersFile, defaultAppId: cfg.defaultAppId }, kind, agent?.larkUser?.appId) : defaults;
    },
  });
  // 基座身份服务(渠道无关):业务插件不再感知 larkUser,统一经 identityOf 双读。
  ctx.provide('agentIdentity', {
    resolve({ channel, appId, subjectId, displayName }) {
      return resolveAgentIdentity({ channel, appId, subjectId, displayName });
    },
    workspaceForIdentity,
    identityOf,
    userIdOf(agentOrExec) {
      return identityOf(agentOrExec?.agent ?? agentOrExec)?.userId;
    },
    connection(agentOrExec, kind, defaults = {}) {
      const identity = identityOf(agentOrExec?.agent ?? agentOrExec);
      if (!identity) {
        if (cfg.usersFile) throw new Error('当前执行上下文缺少用户身份，已拒绝使用默认配置');
        return defaults; // 无身份且无 usersFile(web profile):legacy cfg 回退
      }
      return connectionForUser(identity.subjectId, { ...defaults, usersFile: cfg.usersFile, defaultAppId: cfg.defaultAppId }, kind, identity.appId);
    },
    toolsFor(agentOrExec, defaults = []) {
      const identity = identityOf(agentOrExec?.agent ?? agentOrExec);
      if (!identity) return defaults;
      return toolAllowFor(identity.subjectId, defaults, cfg.usersFile, identity.appId, cfg.defaultAppId);
    },
  });
  ctx.logger.info('[feishu-principal] active: Feishu user identity/configuration/workspace service');
  return () => {};
}
