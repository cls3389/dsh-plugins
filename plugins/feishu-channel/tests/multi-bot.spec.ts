import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveBots, type BotConfig } from '../src/config.js';
import { officialConfig } from '../src/tools.js';

const base: { appId: string; appSecret: string; dataDir: string; workspaceRoot: string; bots: [BotConfig] } = {
  appId: 'cli_primary', appSecret: 'primary-secret', dataDir: '/state/default', workspaceRoot: '/workspaces',
  bots: [{ accountId: 'SalesBot', appId: 'cli_sales', appSecret: 'sales-secret', appName: 'Sales', agentId: 'guests', dataDir: '/state/sales', workspaceRoot: '/workspaces' }],
};

describe('multi-bot accounts', () => {
  it('keeps independent stores and publishes a complete canonical account map', () => {
    const bots = resolveBots(base);
    expect(bots.map((bot) => bot.accountId)).toEqual(['default', 'salesbot']);
    expect(bots.map((bot) => bot.dataDir)).toEqual(['/state/default', '/state/sales']);
    const config = officialConfig({ ...base }, { appId: base.appId, appSecret: base.appSecret });
    const feishu = config.channels.feishu as { accounts: Record<string, { appId: string }> };
    expect(feishu.accounts.salesbot?.appId).toBe('cli_sales');
    expect(feishu.accounts.salesbot?.appId).not.toBe(config.channels.feishu.appId);
  });

  it('rejects duplicate app or state roots instead of sharing identities', () => {
    expect(() => resolveBots({ ...base, bots: [{ ...base.bots[0], appId: base.appId }] })).toThrow(/duplicate/);
    expect(() => resolveBots({ ...base, bots: [{ ...base.bots[0], dataDir: base.dataDir }] })).toThrow(/duplicate/);
    expect(() => resolveBots({ ...base, bots: [{ ...base.bots[0], accountId: 'DEFAULT' }] })).toThrow(/duplicate/);
  });
});

describe('identity agents', () => {
  it('derives dataDir/workspaceRoot from agentId and loads manifest.yml', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const agentsRoot = await mkdtemp(join(tmpdir(), 'dsh-agents-'));
    await mkdir(join(agentsRoot, 'goutoujunshi'), { recursive: true });
    await writeFile(join(agentsRoot, 'goutoujunshi', 'manifest.yml'),
      '# identity manifest\nproto: companion\nmodel:\n  provider: cpa\n  name: deepseek-v4-flash\n  reasoningEffort: max\n');
    try {
      const bots = resolveBots({
        appId: 'cli_primary', appSecret: 'primary-secret', dataDir: '/state/default', workspaceRoot: agentsRoot,
        bots: [
          { accountId: 'friend1', appId: 'cli_friend1', appSecret: 's1', agentId: 'guests' },
          { accountId: 'goutou', appId: 'cli_goutou', appSecret: 's2', agentId: 'goutoujunshi' },
        ],
      });
      const tier = bots.filter((bot) => bot.accountId !== 'default') as Array<{ agentId?: string; manifest?: { proto?: string; model?: Record<string, string> }; dataDir?: string; workspaceRoot?: string }>;
      const friend = tier[0]!;
      const companion = tier[1]!;
      expect(friend.agentId).toBe('guests');
      expect(friend.dataDir?.endsWith('/lark/bots/friend1')).toBe(true);
      expect(friend.workspaceRoot).toBe(join(agentsRoot, 'guests'));
      expect(friend.manifest).toBeUndefined();
      expect(companion.workspaceRoot).toBe(join(agentsRoot, 'goutoujunshi'));
      expect(companion.manifest?.proto).toBe('companion');
      expect(companion.manifest?.model?.provider).toBe('cpa');
      expect(companion.manifest?.model?.name).toBe('deepseek-v4-flash');
      expect(companion.manifest?.model?.reasoningEffort).toBe('max');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });

  it('explicit dataDir/workspaceRoot still win over derivation', () => {
    const bots = resolveBots({
      appId: 'cli_primary', appSecret: 'primary-secret', dataDir: '/state/default', workspaceRoot: '/workspaces',
      bots: [{ accountId: 'custom', appId: 'cli_custom', appSecret: 's', agentId: 'guests', dataDir: '/state/x', workspaceRoot: '/ws/x' }],
    });
    const custom = bots.find((bot) => bot.accountId === 'custom');
    expect(custom?.dataDir).toBe('/state/x');
    expect(custom?.workspaceRoot).toBe('/ws/x');
  });

  it('rejects file bots without agentId', () => {
    expect(() => resolveBots({
      appId: 'cli_primary', appSecret: 'primary-secret', dataDir: '/state/default', workspaceRoot: '/workspaces',
      bots: [{ accountId: 'bad', appId: 'cli_bad', appSecret: 's' }],
    })).toThrow(/requires agentId/);
  });

  it('rejects malformed agentId', () => {
    expect(() => resolveBots({
      appId: 'cli_primary', appSecret: 'primary-secret', dataDir: '/state/default', workspaceRoot: '/workspaces',
      bots: [{ accountId: 'bad', appId: 'cli_bad', appSecret: 's', agentId: 'Bad_Id' }],
    })).toThrow(/invalid agentId/);
  });
});
