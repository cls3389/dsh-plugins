import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Identity-manifest fields loaded from agents/<agentId>/manifest.yml. */
export interface AgentManifest {
  readonly proto?: 'guest' | 'companion' | 'owner';
  readonly displayName?: string;
  readonly model?: { readonly provider?: string; readonly name?: string; readonly reasoningEffort?: string };
}

/** Clean DSH configuration for the official Lark channel. */
export interface Config {
  readonly appId?: string;
  /** Optional display-name override; the bot name is discovered by default. */
  readonly appName?: string;
  readonly appSecret?: string;
  /** 环境变量名,从中读取 appSecret(密钥不落 patch 明文)。 */
  readonly appSecretEnv?: string;
  readonly domain?: 'feishu' | 'lark';
  readonly defaultCwd?: string;
  /** Identity root directory (agents/<agentId> tier); derived from DSH_HOME when omitted. */
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
  /** Identity directory name under the agents root: the config host for tools/persona/model. */
  readonly agentId?: string;
  /** Resolved identity manifest (proto/model) loaded during resolveBots. */
  readonly manifest?: AgentManifest;
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
  appSecretEnv: z.string().required(false),
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
  agentId: z.string().required(false),
  botsFile: z.string().required(false),
  bots: z.array(z.object({
    accountId: z.string(),
    appId: z.string(),
    appSecret: z.string(),
    appName: z.string().required(false),
    agentId: z.string().required(false),
    workspaceRoot: z.string().required(false),
    dataDir: z.string().required(false),
    defaultCwd: z.string().required(false),
    domain: z.union([z.const('feishu'), z.const('lark')]).required(false),
  })).required(false),
});

/**
 * Minimal manifest.yml reader: proto plus an optional three-key model block.
 * No YAML dependency — the identity manifest format is deliberately tiny.
 */
export function readAgentManifest(agentsRoot: string, agentId: string): AgentManifest | undefined {
  let text: string;
  try {
    text = readFileSync(join(agentsRoot, agentId, 'manifest.yml'), 'utf8');
  } catch {
    return undefined;
  }
  const manifest: { proto?: 'guest' | 'companion' | 'owner'; displayName?: string; model?: Record<string, string> } = {};
  let inModel = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+#.*$/, '').trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^model:\s*$/.test(trimmed)) { inModel = true; continue; }
    if (/^\S/.test(trimmed)) inModel = false;
    if (inModel) {
      const kv = /^\s+(provider|name|reasoningEffort):\s*(\S+)\s*$/.exec(trimmed);
      if (kv) {
        manifest.model ??= {};
        manifest.model[kv[1] as 'provider' | 'name' | 'reasoningEffort'] = kv[2]!;
        continue;
      }
    }
    const proto = /^proto:\s*(guest|companion|owner)\s*$/.exec(trimmed);
    if (proto) manifest.proto = proto[1] as 'guest' | 'companion' | 'owner';
    else {
      const name = /^displayName:\s*(\S.*?)\s*$/.exec(trimmed);
      if (name) manifest.displayName = name[1]!;
    }
  }
  return manifest.proto === undefined && manifest.model === undefined && manifest.displayName === undefined ? undefined : manifest;
}

/** Resolve independent account/storage/workspace settings without sharing session registries. */
export function resolveBots(config: Config): Config[] {
  const primary = resolveCredentials(config);
  const { bots: _additional, botsFile, ...base } = config;
  const agentsRoot = base.workspaceRoot ?? agentsRootDefault();
  const resolveOne = (entry: BotConfig | Config, accountId: string, primaryBot: boolean): Config => {
    const agentId = entry.agentId;
    if (!primaryBot && !agentId) {
      throw new Error(`Feishu bot ${accountId} requires agentId (identity directory under the agents root)`);
    }
    const manifest = agentId ? readAgentManifest(agentsRoot, agentId) : undefined;
    const dataDir = entry.dataDir ?? (primaryBot ? undefined : join(larkBotsRoot(), accountId));
    const workspaceRoot = agentId ? (entry.workspaceRoot ?? join(agentsRoot, agentId)) : entry.workspaceRoot;
    return { ...base, ...entry, ...(manifest ? { manifest } : {}), ...(dataDir ? { dataDir } : {}), ...(workspaceRoot ? { workspaceRoot } : {}), accountId };
  };
  const bots: Config[] = primary ? [resolveOne({ ...base, ...primary }, 'default', true)] : [];
  const seen = new Set(bots.map((bot) => bot.accountId));
  const appIds = new Set(bots.map((bot) => bot.appId));
  const dataDirs = new Set(bots.map((bot) => bot.dataDir !== undefined ? resolve(dataDirectory(bot)) : '').filter(Boolean));
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
    if (!bot.appId || !bot.appSecret) {
      throw new Error(`Feishu bot ${accountId} requires appId/appSecret`);
    }
    if (bot.agentId !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(bot.agentId)) {
      throw new Error(`Feishu bot ${accountId} has invalid agentId: ${String(bot.agentId)}`);
    }
    const resolved = resolveOne(bot, accountId, false);
    if (resolved.dataDir === undefined) throw new Error(`Feishu bot ${accountId} requires dataDir`);
    if (appIds.has(bot.appId) || dataDirs.has(resolve(resolved.dataDir))) throw new Error(`duplicate Feishu bot appId/dataDir: ${accountId}`);
    seen.add(accountId);
    appIds.add(bot.appId);
    dataDirs.add(resolve(resolved.dataDir));
    bots.push(resolved);
  }
  return bots;
}

/** Default per-account storage root: $DSH_HOME/lark/bots/<accountId>. */
function larkBotsRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lark', 'bots');
}

/** Default identity root: $DSH_HOME/home/agents (agents/<agentId>/ tiers). */
export function agentsRootDefault(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'home', 'agents');
}

export interface Credentials {
  readonly appId: string;
  readonly appSecret: string;
}

export function resolveCredentials(config: Config): Credentials | undefined {
  const appId = config.appId ?? process.env.FEISHU_APP_ID;
  const appSecret = config.appSecret
    ?? (config.appSecretEnv ? resolveSecretRef(config.appSecretEnv) : undefined)
    ?? process.env.FEISHU_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : undefined;
}

/**
 * appSecretEnv 解析:先环境变量,再 $DSH_HOME/.credentials.yaml 的 refs: 段直读
 * (feishu profile 下 credentials 服务未挂载;与 media-tools 同款兜底,只匹配 refs 段内缩进行)。
 */
function resolveSecretRef(ref: string): string | undefined {
  const fromEnv = process.env[ref];
  if (fromEnv) return fromEnv;
  try {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (!inRefs) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`));
      if (match?.[1] && !match[1].startsWith('"')) return match[1];
    }
  } catch { /* credentials 文件缺失时静默 */ }
  return undefined;
}

export function dataDirectory(config: Config): string {
  return config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lark');
}
