export declare const name: string;
export declare function assertOpenId(openId: string): string;
export declare function userKey(openId: string, appId?: string): string;
export declare function invalidateUserKeyCache(): void;
export declare function workspaceFor(appRoot: string, openId: string, appId?: string): string;
export declare function stateForKey(root: string, key: string, category: string): string;
export declare function stateFor(root: string, openId: string, category: string): string;
export declare function principalKey(openId: string, appId?: string, defaultAppId?: string): string;
export declare function readUsers(filePath: string): Record<string, { displayName?: string; enabled?: boolean }>;
export declare function connectionForUser(openId: string, cfg: Record<string, unknown>, kind: string, appId?: string): Record<string, unknown>;
export declare function currentOpenId(agent: unknown): string | undefined;
export interface AgentIdentity {
  channel: string;
  agentId?: string;
  appId?: string;
  subjectId: string;
  userId?: string;
  context?: { chatId?: string; accountId?: string; chatType?: string };
}
/** 基座身份服务:identity 优先,larkUser 合成回退,双无 → undefined。 */
export declare function identityOf(agent: { identity?: AgentIdentity; larkUser?: { openId: string; chatId?: string; accountId?: string; appId?: string; agentId?: string } } | undefined): AgentIdentity | undefined;
/** @deprecated 过渡期兼容:从 identityOf 提取旧形态 {openId, appId, agentId}。 */
export declare function principalOf(agent: unknown): { openId: string; appId?: string; agentId?: string } | undefined;
export declare function toolAllowFor(openId: string | undefined, defaults: readonly string[] | undefined, usersFile?: string, appId?: string, defaultAppId?: string): string[];
export declare function apply(ctx: unknown, config: Record<string, unknown>): () => void;
export declare function resolveIdentity(identity: { channel: string; appId: string; openId: string; displayName?: string }, options?: Record<string, unknown>): { userId: string; created: boolean };
export declare function bindIdentityWithCache(userId: string, identity: { channel: string; appId: string; openId: string }, options?: Record<string, unknown>): { previousUserId?: string };
export declare function listIdentities(options?: Record<string, unknown>): Record<string, { displayName?: string; identities: Array<{ channel: string; appId: string; openId: string; boundAt?: string }> }>;
