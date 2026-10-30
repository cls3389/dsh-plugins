import { describe, expect, it } from 'vitest';
import { resolveBots, type BotConfig } from '../src/config.js';
import { officialConfig } from '../src/tools.js';

const base: { appId: string; appSecret: string; dataDir: string; workspaceRoot: string; bots: [BotConfig] } = {
  appId: 'cli_primary', appSecret: 'primary-secret', dataDir: '/state/default', workspaceRoot: '/workspaces',
  bots: [{ accountId: 'SalesBot', appId: 'cli_sales', appSecret: 'sales-secret', appName: 'Sales', dataDir: '/state/sales', workspaceRoot: '/workspaces' }],
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
