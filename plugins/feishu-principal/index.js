import crypto from 'node:crypto';
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'feishu-principal';
const userKeyCache = new Map();

export function assertOpenId(openId) {
  if (typeof openId !== 'string' || !/^ou_[a-f0-9]{32}$/i.test(openId)) {
    throw new Error('缺少可信飞书用户身份，已拒绝访问用户数据');
  }
  return openId;
}

/** Stable pseudonymous directory key; never a session id or a prompt-provided identity. */
export function userKey(openId) {
  assertOpenId(openId);
  if (!userKeyCache.has(openId)) userKeyCache.set(openId, crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32));
  return userKeyCache.get(openId);
}

export function principalKey(openId, appId, defaultAppId) {
  if (appId) {
    if (!defaultAppId || !/^cli_[a-z0-9]+$/i.test(appId) || !/^cli_[a-z0-9]+$/i.test(defaultAppId)) throw new Error('飞书应用身份无效');
  }
  return appId && appId !== defaultAppId
    ? crypto.createHash('sha256').update(`${appId}:${openId}`).digest('hex').slice(0, 32)
    : userKey(openId);
}

export function workspaceFor(appRoot, openId) {
  const root = path.resolve(appRoot);
  const directory = path.join(root, 'users', userKey(openId).slice(0, 24));
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error('用户工作区路径越界');
  return directory;
}

export function stateForKey(root, key, category) {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('非法用户登录态键');
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
  ctx.logger.info('[feishu-principal] active: Feishu user identity/configuration/workspace service');
  return () => {};
}
