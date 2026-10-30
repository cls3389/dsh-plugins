import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Clean DSH configuration for the official Lark channel. */
export interface Config {
  readonly appId?: string;
  /** Optional display-name override; the bot name is discovered by default. */
  readonly appName?: string;
  readonly appSecret?: string;
  readonly domain?: 'feishu' | 'lark';
  readonly defaultCwd?: string;
  /** Parent directory for per-application working directories. */
  readonly workspaceRoot?: string;
  readonly dataDir?: string;
  readonly provider?: string;
  readonly model?: string;
  /** Adapter-owned reasoning effort pinned for this account's agents (e.g. "max"). */
  readonly reasoningEffort?: string;
  readonly allowedChats?: string[];
  readonly allowedUsers?: string[];
  readonly groupMentionMode?: 'always' | 'never' | 'ambient';
  readonly replyMode?: 'streaming';
  readonly tools?: { readonly deny?: string[] };
  /** Allowlist for the complete DSH tool catalog exposed through this channel. */
  readonly agentToolAllow?: string[];
  readonly mcpEndpoint?: string;
  /** Additional Feishu applications sharing this DSH runtime; default remains the primary bot. */
  readonly bots?: BotConfig[];
  /** Local secret-bearing JSON array used instead of embedding all bot credentials in YAML. */
  readonly botsFile?: string;
  /** Account used by this channel instance; the primary bot uses "default". */
  readonly accountId?: string;
}

export type BotConfig = Omit<Config, 'bots'> & {
  readonly accountId: string;
  readonly appId: string;
  readonly appSecret: string;
};

export const Config: z<Config> = z.object({
  appId: z.string().required(false),
  appName: z.string().required(false),
  appSecret: z.string().required(false),
  domain: z.union([z.const('feishu'), z.const('lark')]).required(false),
  defaultCwd: z.string().required(false),
  workspaceRoot: z.string().required(false),
  dataDir: z.string().required(false),
  provider: z.string().required(false),
  model: z.string().required(false),
  reasoningEffort: z.string().required(false),
  allowedChats: z.array(z.string()).required(false),
  allowedUsers: z.array(z.string()).required(false),
  groupMentionMode: z
    .union([z.const('always'), z.const('never'), z.const('ambient')])
    .required(false),
  replyMode: z.const('streaming').required(false),
  tools: z.object({ deny: z.array(z.string()).required(false) }).required(false),
  agentToolAllow: z.array(z.string()).required(false),
  mcpEndpoint: z.string().required(false),
  accountId: z.string().required(false),
  botsFile: z.string().required(false),
  bots: z.array(z.object({
    accountId: z.string(),
    appId: z.string(),
    appSecret: z.string(),
    appName: z.string().required(false),
    workspaceRoot: z.string().required(false),
    dataDir: z.string().required(false),
    defaultCwd: z.string().required(false),
    domain: z.union([z.const('feishu'), z.const('lark')]).required(false),
  })).required(false),
});

/** Resolve independent account/storage/workspace settings without sharing session registries. */
export function resolveBots(config: Config): Config[] {
  const primary = resolveCredentials(config);
  const { bots: _additional, botsFile, ...base } = config;
  const bots: Config[] = primary ? [{ ...base, ...primary, accountId: 'default' }] : [];
  const seen = new Set(bots.map((bot) => bot.accountId));
  const appIds = new Set(bots.map((bot) => bot.appId));
  const dataDirs = new Set(bots.map((bot) => resolve(dataDirectory(bot))));
  let fileBots: BotConfig[] = [];
  if (botsFile) {
    const parsed: unknown = JSON.parse(readFileSync(botsFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Feishu botsFile must contain a JSON array');
    fileBots = parsed as BotConfig[];
  }
  for (const bot of [...fileBots, ...config.bots ?? []]) {
    const accountId = bot.accountId.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId) || accountId === 'default' || seen.has(accountId)) {
      throw new Error(`invalid or duplicate Feishu bot accountId: ${bot.accountId}`);
    }
    if (!bot.appId || !bot.appSecret || !bot.workspaceRoot || !bot.dataDir) {
      throw new Error(`Feishu bot ${accountId} requires appId/appSecret/workspaceRoot/dataDir`);
    }
    if (appIds.has(bot.appId) || dataDirs.has(resolve(bot.dataDir))) throw new Error(`duplicate Feishu bot appId/dataDir: ${accountId}`);
    seen.add(accountId);
    appIds.add(bot.appId);
    dataDirs.add(resolve(bot.dataDir));
    bots.push({ ...base, ...bot, accountId });
  }
  return bots;
}

export interface Credentials {
  readonly appId: string;
  readonly appSecret: string;
}

export function resolveCredentials(config: Config): Credentials | undefined {
  const appId = config.appId ?? process.env.FEISHU_APP_ID;
  const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : undefined;
}

export function dataDirectory(config: Config): string {
  return config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lark');
}
