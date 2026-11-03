import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { resolveAgentIdentity, workspaceForIdentity } from '@dsh-friends/feishu-principal';
import { WeixinChannel } from './channel.js';
import { type Config, dataDirectory, resolveBots, resolveToken } from './config.js';
import { resolveAgent, type TrustedUser } from './agent-resolver.js';
import { registerWechatLoginTool } from './login-tool.js';
import { handlePairingReply, registerWechatBindTool, type WechatBindDeps } from './bind-tool.js';
import { WeixinStateStore } from './protocol/state.js';
import { SessionStore } from './session-store.js';
import { attachSessionToGlobalRegistry } from './workspace-registry.js';
import type { WeixinInboundEvent } from './protocol/types.js';

export { WeixinChannel } from './channel.js';
export { Config } from './config.js';
export { handlePairingReply } from './bind-tool.js';
export { attachSessionToGlobalRegistry } from './workspace-registry.js';

export const name = 'wechat-channel';

/** Declarative service injection（dsh-memory 同款模式）：apply 前保证 tools 就绪。 */
export const inject = ['tools'];

/**
 * Weixin (iLink) channel for DSH: one poller per bot account, private-chat
 * text with Tencent's lightweight Markdown filter, channel-neutral identity
 * archives, durable cursor/dedup/context-token state. No OpenClaw runtime.
 */
export function apply(ctx: Context, config: Config): void {
  const bots = resolveBots(config);
  if (bots.length === 0) {
    ctx.logger.warn('[wechat] no accounts configured; channel not started');
    return;
  }
  const channels: WeixinChannel[] = [];
  const states = new Map<string, WeixinStateStore>();
  const sessionsByAccount = new Map<string, SessionStore>();
  const channelsByAccount = new Map<string, WeixinChannel>();
  const appIdForAccount = (accountId: string): string => {
    const bot = bots.find((candidate) => candidate.accountId === accountId);
    if (!bot) throw new Error(`Unknown Weixin account: ${accountId}`);
    return (states.get(accountId)?.readAccountSync()?.botId ?? bot.botId) || `account:${accountId}`;
  };
  for (const bot of bots) {
    const dataDir = dataDirectory(bot);
    const state = new WeixinStateStore(dataDir, bot.accountId);
    states.set(bot.accountId, state);
    const agentsRoot = bot.agentsRoot ?? process.cwd();
    // 身份域 appId 必须与运行时通道一致：优先凭证里的真实 botId（登录后落盘），
    // 未登录时才回退 account:<accountId>。启动时一次性取值会与登录后的动态
    // botId 脱节，导致同一微信首见两簇；历史孤儿簇须单独审计。
    const appIdFor = (): string => appIdForAccount(bot.accountId);
    const sessions = new SessionStore(
      dataDir,
      bot.workspaceRoot ?? process.cwd(),
      agentsRoot,
      ({ subjectId }) => resolveAgentIdentity({ channel: 'wechat', appId: appIdFor(), subjectId }).userId,
    );
    const userForSession = (sessionId: string): TrustedUser | undefined => {
      const binding = sessions.bindingForSession(sessionId);
      if (!binding) return undefined;
      return {
        subjectId: binding.subjectId,
        chatId: binding.subjectId,
        accountId: bot.accountId,
        appId: appIdFor(),
        agentId: bot.agentId,
        userId: binding.userId,
      };
    };
    const token = resolveToken(bot);
    const channel = new WeixinChannel({
      config: bot,
      state,
      sessions,
      resolveAgent: (sessionId, cwd) =>
        resolveAgent(ctx, bot, sessionId, cwd, { userForSession }),
      logger: ctx.logger,
      ...(token ? { tokenFallback: token } : {}),
      ...(bot.botId ? { botIdFallback: bot.botId } : {}),
      ...(bot.baseUrl ? { baseUrlFallback: bot.baseUrl } : {}),
    });
    channels.push(channel);
    sessionsByAccount.set(bot.accountId, sessions);
    channelsByAccount.set(bot.accountId, channel);
  }

  // 对话式扫码登录：在哪个身份的会话里发起，就绑定该身份的微信账号。
  registerWechatLoginTool(ctx, { bots, states, channels: channelsByAccount, logger: ctx.logger });

  // 对话式身份关联：飞书侧发起 → 配对码在飞书侧展示 → 微信侧回码自证 → bind 合并。
  const agentsRootFor = (agentId: string) => join(bots[0]?.agentsRoot ?? process.cwd(), agentId);
  const bindDeps: WechatBindDeps = {
    bots,
    logger: ctx.logger,
    appIdForAccount,
    async subjectsFor(accountId) {
      const state = states.get(accountId);
      return state ? await state.loadAllowlist() : [];
    },
    rebind(accountId) {
      // 身份簇合并后重算所有会话的 cwd，让进行中的绑定立即指向共享档案。
      sessionsByAccount.get(accountId)?.rebindToIdentity();
    },
  };
  registerWechatBindTool(ctx, bindDeps);
  const pairingReply = (message: WeixinInboundEvent) =>
    handlePairingReply(bindDeps, message, (pending) => {
      const bot = bots.find((candidate) => candidate.accountId === pending.accountId);
      if (!bot || bot.agentId !== pending.agentId) return undefined;
      const oldUserId = resolveAgentIdentity({ channel: 'wechat', appId: pending.appId, subjectId: message.subjectId }).userId;
      const targetWorkspace = workspaceForIdentity(agentsRootFor(pending.agentId), {
        userId: pending.feishuUserId, agentId: pending.agentId,
      });
      // users/<uid>/<agent>/workspace and its sibling memory only.
      return {
        usersRoot: dirname(dirname(dirname(targetWorkspace))),
        agentId: pending.agentId,
        oldUserId,
        targetUserId: pending.feishuUserId,
      };
    });

  // 微信侧 /bind（V1）：反向关联需要先明确"要关联哪个飞书用户"，这一步
  // 必须由飞书侧身份自证（防止冒领），因此引导到飞书侧发起。
  const onBindCommand = async () => ({
    ok: false,
    reply: '如需关联飞书与微信身份，请让飞书侧用户在该身份的飞书会话里发起「关联微信」，拿到配对码后在微信里向 bot 发「/bind + 6位数字」即可完成。',
  });

  // 把配对回复处理挂到每个通道（/bind + 6 位数字命中即关联，不进 Agent）。
  for (const channel of channels) {
    channel.setPairingReply(pairingReply);
    channel.setOnBindCommand(onBindCommand);
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    for (const channel of channels) channel.assistantFrame(agent.session.id, frame);
  });
  ctx.on('session/event', (session, event) => {
    for (const channel of channels) {
      void channel.sessionEvent(session.id, event).catch((error) => {
        ctx.logger.warn(`[wechat] session event failed: ${String(error)}`);
      });
    }
  });
  ctx.effect(() => async () => {
    await Promise.all(channels.map((channel) => channel.stop()));
  });
  // 启动自愈：把本插件已知账号的全部存量会话重挂进全局注册表（幂等）。
  // 背景：storage-json 是「进程内存权威 + last-write-wins」，web 进程的
  // 下一次 mutate 可能覆盖身份服务的文件级 append；web 与本服务每次重启
  // 各自 loadAll 后互相补齐，偶发丢失在重启/下一条消息时收敛。
  for (const [accountId, sessions] of sessionsByAccount) {
    const bot = bots.find((candidate) => candidate.accountId === accountId);
    if (!bot) continue;
    for (const binding of sessions.listBindings()) {
      void attachSessionToGlobalRegistry({
        userPath: binding.cwd,
        sessionId: binding.sessionId,
        title: `用户 ${binding.userId.slice(0, 10)} · ${bot.agentId}`,
      }).catch((error) => ctx.logger.warn(`[wechat] 注册表自愈失败(${binding.sessionId}): ${String(error)}`));
    }
  }
  for (const channel of channels) {
    void channel.start().catch((error) => ctx.logger.error(`[wechat] channel failed to start: ${String(error)}`));
  }
  ctx.logger.info(`[wechat] channel configured for ${channels.length} account(s)`);
}
