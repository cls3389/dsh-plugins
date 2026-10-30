import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { LarkClient } from '../vendor/openclaw-lark/dist/core/lark-client.js';
import { registerSessionController, resolveAgent } from './agent-resolver.js';
import { LarkChannel } from './channel.js';
import { type Config, dataDirectory, resolveBots, resolveCredentials } from './config.js';
import { consoleExporter } from './console-exporter.js';
import {
  ModelCommands,
  ModelSelectionRegistry,
  type ModelsDefaultModel,
  type ModelsLlm,
} from './model-selection.js';
import { SessionStore } from './session-store.js';
import { OfficialToolContexts, officialConfig, registerOfficialTools } from './tools.js';

export { LarkChannel } from './channel.js';
export { Config } from './config.js';
export { OfficialTurnStream } from './streaming.js';

export const name = 'feishu';

/** One Agent runtime, one WebSocket per Feishu application, isolated session stores. */
export function apply(ctx: Context, config: Config): void {
  ctx.logger.exporter(consoleExporter());
  const bots = resolveBots(config);
  const credentials = resolveCredentials(config);
  if (!credentials) {
    ctx.logger.warn('[lark] appId/appSecret are required; channel not started');
    return;
  }
  const upstream = officialConfig({ ...config, bots: bots.filter((bot) => bot.accountId !== 'default') } as unknown as Record<string, unknown>, credentials);
  const runtime = {
    config: { loadConfig: () => upstream },
    logging: { getChildLogger: () => ctx.logger },
  } as unknown as PluginRuntime;
  LarkClient.setRuntime(runtime);
  LarkClient.setGlobalConfig(upstream);

  const toolContexts = new OfficialToolContexts();
  const disposeTools = registerOfficialTools(
    ctx,
    config as unknown as Record<string, unknown>,
    credentials,
    toolContexts,
    upstream,
  );
  const selections = new ModelSelectionRegistry();
  const appForAccount = new Map(bots.map((bot) => [bot.accountId ?? 'default', bot.appId]));
  const userForSession = (sessionId: string) => {
    const ticket = toolContexts.get(sessionId);
    return ticket?.senderOpenId ? {
      openId: ticket.senderOpenId,
      chatId: ticket.chatId,
      accountId: ticket.accountId,
      appId: appForAccount.get(ticket.accountId),
    } : undefined;
  };
  const channels: LarkChannel[] = [];
  for (const bot of bots) {
    const sessions = new SessionStore(
      dataDirectory(bot),
      bot.defaultCwd ?? process.cwd(),
      bot.workspaceRoot,
    );
    const extras = {
      selections,
      modelOverride: (sessionId: string) => sessions.overrideFor(sessionId),
      userForSession,
    };
    const resolveBound = (sessionId: string, cwd: string) =>
      resolveAgent(ctx, bot, sessionId, cwd, extras);
    if (bot.accountId === 'default') {
      registerSessionController(ctx, bot, bot.defaultCwd ?? process.cwd(), extras);
    }
    const models = new ModelCommands({
      getLlm: () => ctx.get('llm') as ModelsLlm | undefined,
      getDefaultModel: () => ctx.get('agentDefaultModel') as ModelsDefaultModel | undefined,
      getLiveAgent: (sessionId) => ctx.get('agents')?.get(sessionId as SessionId),
      resolveAgent: resolveBound,
      registry: selections,
      sessions,
      logger: ctx.logger,
    });
    channels.push(new LarkChannel({
      config: bot,
      officialConfig: upstream,
      sessions,
      toolContexts,
      logger: ctx.logger,
      resolveAgent: resolveBound,
      models,
    }));
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    for (const channel of channels) channel.assistantFrame(agent.session.id, frame);
  });
  ctx.on('agent/created', async ({ agent }) => {
    const tools = ctx.get('tools');
    const names = tools?.schemas(agent).map((tool) => tool.name).sort() ?? [];
    ctx.logger.info(`[lark] ${names.length} tools enabled for session ${agent.session.id}: ${names.join(', ')}`);
    for (const name of ['web_search', 'web_fetch', 'browser_health', 'ths_quote']) {
      if (tools?.get(name, agent) === undefined) {
        ctx.logger.warn(`[lark] ${name} is not visible to session ${agent.session.id}`);
      } else {
        ctx.logger.info(`[lark] ${name} enabled for session ${agent.session.id}`);
      }
    }
  });
  ctx.on('session/event', (session, event) => {
    for (const channel of channels) {
      void channel.sessionEvent(session.id, event).catch((error) => {
        ctx.logger.warn(`[lark] session event failed: ${String(error)}`);
      });
    }
  });
  // 闲置自动压缩已抽到独立插件 @dsh-friends/idle-compaction（2026-10-30），
  // 事件驱动判定闲置，对进程内所有会话宿主生效；本插件不再内嵌巡检。
  ctx.effect(() => async () => {
    disposeTools();
    toolContexts.clear();
    await Promise.all(channels.map((channel) => channel.stop()));
  });
  for (const channel of channels) {
    void channel.start().catch((error) => ctx.logger.error(`[lark] official WebSocket failed: ${String(error)}`));
  }
  ctx.logger.info(`[lark] official channel and CardKit streaming configured for ${channels.length} bot(s)`);
}
