import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

export interface AgentManifest {
  readonly proto?: 'guest' | 'companion' | 'owner';
  readonly displayName?: string;
  readonly model?: { readonly provider?: string; readonly name?: string; readonly reasoningEffort?: string };
}

export interface Config {
  readonly accountId?: string;
  readonly botId?: string;
  readonly token?: string;
  readonly tokenEnv?: string;
  readonly baseUrl?: string;
  readonly dataDir?: string;
  readonly workspaceRoot?: string;
  readonly agentsRoot?: string;
  readonly agentId?: string;
  readonly appName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly allowedUsers?: string[];
  /** Feishu subjectIds (open_id) allowed to run wechat_login for this bot. */
  readonly loginAllowUsers?: string[];
  readonly agentToolAllow?: string[];
  readonly botsFile?: string;
  readonly bots?: BotConfig[];
  readonly manifest?: AgentManifest;
}

export type BotConfig = Omit<Config, 'bots'> & {
  readonly accountId: string;
  readonly agentId: string;
};

export const Config: z<Config> = z.object({
  accountId: z.string().required(false),
  botId: z.string().required(false),
  token: z.string().required(false),
  tokenEnv: z.string().required(false),
  baseUrl: z.string().required(false),
  dataDir: z.string().required(false),
  workspaceRoot: z.string().required(false),
  agentsRoot: z.string().required(false),
  agentId: z.string().required(false),
  appName: z.string().required(false),
  provider: z.string().required(false),
  model: z.string().required(false),
  reasoningEffort: z.string().required(false),
  allowedUsers: z.array(z.string()).required(false),
  loginAllowUsers: z.array(z.string()).required(false),
  agentToolAllow: z.array(z.string()).required(false),
  botsFile: z.string().required(false),
  bots: z.array(z.object({
    accountId: z.string(),
    agentId: z.string(),
    botId: z.string().required(false),
    token: z.string().required(false),
    tokenEnv: z.string().required(false),
    baseUrl: z.string().required(false),
    dataDir: z.string().required(false),
    workspaceRoot: z.string().required(false),
    agentsRoot: z.string().required(false),
    appName: z.string().required(false),
    provider: z.string().required(false),
    model: z.string().required(false),
    reasoningEffort: z.string().required(false),
    allowedUsers: z.array(z.string()).required(false),
    loginAllowUsers: z.array(z.string()).required(false),
    agentToolAllow: z.array(z.string()).required(false),
  })).required(false),
});

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function agentsRootDefault(): string {
  return join(dshHome(), 'home', 'agents');
}

export function dataDirectory(config: Config): string {
  return config.dataDir ?? join(dshHome(), 'wechat');
}

function secretFromRef(ref?: string): string | undefined {
  if (!ref) return undefined;
  const env = process.env[ref];
  if (env) return env;
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8');
    const pattern = new RegExp(`^\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)\\s*$`);
    let refs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { refs = true; continue; }
      if (refs && /^\S/.test(line)) break;
      if (!refs) continue;
      const match = pattern.exec(line);
      if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* optional credentials file */ }
  return undefined;
}

export function resolveToken(config: Config): string | undefined {
  return config.token ?? secretFromRef(config.tokenEnv);
}

export function readAgentManifest(root: string, agentId: string): AgentManifest | undefined {
  try {
    const text = readFileSync(join(root, agentId, 'manifest.yml'), 'utf8');
    const manifest: { proto?: AgentManifest['proto']; displayName?: string; model?: Record<string, string> } = {};
    let model = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '').trimEnd();
      if (!line || line.startsWith('#')) continue;
      if (line === 'model:') { model = true; continue; }
      if (/^\S/.test(line)) model = false;
      if (model) {
        const entry = /^\s+(provider|name|reasoningEffort):\s*(\S+)$/.exec(line);
        if (entry?.[1] && entry[2]) (manifest.model ??= {})[entry[1]] = entry[2];
      }
      const proto = /^proto:\s*(guest|companion|owner)$/.exec(line);
      if (proto) manifest.proto = proto[1] as AgentManifest['proto'];
      const display = /^displayName:\s*(.+)$/.exec(line);
      if (display?.[1]) manifest.displayName = display[1].trim();
    }
    const modelBlock = manifest.model as AgentManifest['model'] | undefined;
    const resolved: AgentManifest = {
      ...(manifest.proto ? { proto: manifest.proto } : {}),
      ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
      ...(modelBlock ? { model: modelBlock } : {}),
    };
    return resolved.proto || resolved.displayName || resolved.model ? resolved : undefined;
  } catch { return undefined; }
}

/** A bot entry after resolveBots: account, identity, and storage are all pinned. */
export type ResolvedBot = Config & {
  readonly accountId: string;
  readonly agentId: string;
  readonly agentsRoot: string;
  readonly workspaceRoot: string;
  readonly dataDir: string;
};

export function resolveBots(config: Config): ResolvedBot[] {
  const agentsRoot = config.agentsRoot ?? config.workspaceRoot ?? agentsRootDefault();
  const raw: BotConfig[] = [];
  if (config.accountId || config.agentId) {
    raw.push({ ...config, accountId: config.accountId ?? 'default', agentId: config.agentId ?? 'default' } as BotConfig);
  }
  if (config.botsFile) {
    const parsed = JSON.parse(readFileSync(config.botsFile, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Weixin botsFile must contain an array');
    raw.push(...parsed as BotConfig[]);
  }
  raw.push(...config.bots ?? []);
  if (raw.length === 0) return [];
  const seen = new Set<string>();
  return raw.map((bot): ResolvedBot => {
    const accountId = bot.accountId.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId) || seen.has(accountId)) throw new Error(`invalid or duplicate Weixin accountId: ${accountId}`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(bot.agentId)) throw new Error(`invalid Weixin agentId: ${bot.agentId}`);
    seen.add(accountId);
    const manifest = readAgentManifest(agentsRoot, bot.agentId);
    return {
      ...config,
      ...bot,
      accountId,
      agentId: bot.agentId,
      agentsRoot,
      workspaceRoot: bot.workspaceRoot ?? join(agentsRoot, bot.agentId),
      dataDir: bot.dataDir ?? join(dataDirectory(config), 'bots', accountId),
      ...(manifest ? { manifest } : {}),
    };
  });
}
