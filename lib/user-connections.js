import { connectionForUser, identityOf, readUsers } from '../plugins/feishu-principal/index.js';

/** @deprecated Use @dsh-friends/feishu-principal directly in new plugins. */
export const readUserConnections = readUsers;
export const connectionForOpenId = connectionForUser;

/**
 * Interactive Web calls may retain legacy config; Feishu users always require their own.
 * 内部统一走基座 identityOf 双读(agent.identity 优先,larkUser 合成回退):
 * - 有身份:按 subjectId(appId 域)解析用户专属连接;
 * - 无身份:usersFile 已配置时拒绝默认账户,未配置时保留 legacy cfg(web 复盘会话回退)。
 * 签名不变,ths-market/ths-trade 等既有调用方无感。
 */
export function connectionForExecution(exec, cfg, kind) {
  const identity = identityOf(exec?.agent);
  if (identity) return connectionForOpenId(identity.subjectId, cfg, kind, identity.appId);
  if (cfg.usersFile) throw new Error('当前执行上下文缺少用户身份，已拒绝使用任何默认账户');
  return cfg;
}
