import crypto from 'node:crypto';
import { homedir } from 'node:os';
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
 * 缓存会在 bindIdentity 合并身份后整体失效(跨模块约定:identities.js 调 invalidateUserKeyCache)。
 */
const userKeyCache = new Map();
export function invalidateUserKeyCache() {
  userKeyCache.clear();
}

export function userKey(openId, appId) {
  assertOpenId(openId);
  const cacheKey = appId ? `${appId}:${openId}` : openId;
  if (!userKeyCache.has(cacheKey)) {
    const resolved = resolveIdentity({ channel: 'feishu', appId: appId ?? 'unscoped', openId });
    userKeyCache.set(cacheKey, resolved.userId);
  }
  return userKeyCache.get(cacheKey);
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

export function principalKey(openId, appId, defaultAppId) {
  if (appId) {
    if (!defaultAppId || !/^cli_[a-z0-9]+$/i.test(appId) || !/^cli_[a-z0-9]+$/i.test(defaultAppId)) throw new Error('飞书应用身份无效');
  }
  // 登录态键跟随身份簇 userId(不再是 openId+appId 派生 hash):
  // 同簇身份共享登录态,不同簇天然隔离;bind 合并后旧簇登录态随档案目录迁移。
  return userKey(openId, appId ?? defaultAppId);
}

export function workspaceFor(appRoot, openId, appId) {
  const root = path.resolve(appRoot);
  const directory = path.join(root, 'users', userKey(openId, appId));
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error('用户工作区路径越界');
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

function userForApp(users, openId, appId, defaultAppId) {
  return appId && appId !== defaultAppId ? users.applications?.[appId]?.[openId] : users[openId];
}

export function connectionForUser(openId, cfg, kind, appId) {
  assertOpenId(openId);
  const user = userForApp(readUsers(cfg.usersFile), openId, appId, cfg.defaultAppId);
  // Public market data remains available before enrollment; private services never do.
  if (kind === 'market' && !user) return cfg;
  if (!user || user.enabled === false) {
    const guidance = kind === 'trading' ? '请联系管理员开通并配置独立的 xiadan 交易连接；同花顺自选扫码登录不能开通交易功能'
      : kind === 'aiSignal' ? '请联系管理员开通并配置独立的 AI 分时连接' : '请联系管理员开通并配置该业务连接';
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
      throw new Error('当前用户未配置 AI 分时项目连接');
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
    userId: userKey(larkUser.openId, larkUser.appId),
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
      return resolveIdentity({ channel, appId, openId: subjectId, ...(displayName !== undefined ? { displayName } : {}) });
    },
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
