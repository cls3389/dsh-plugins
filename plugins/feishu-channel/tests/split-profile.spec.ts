import { describe, expect, it } from 'vitest';
import { resolveBots } from '../src/config.js';
describe('profile split shards', () => {
  it('companion shard resolves goutoujunshi only', () => {
    process.env.DSH_HOME = '/data/dsh';
    try {
      const bots = resolveBots({ workspaceRoot: '/data/dsh/home/agents', botsFile: '/data/dsh/lark/bots-companion.json' } as never);
      const file = bots.filter((b) => b.accountId !== 'default');
      expect(file.map((b) => b.accountId)).toEqual(['goutoujunshi']);
      expect(file[0]?.agentId).toBe('goutoujunshi');
      expect(file[0]?.manifest?.proto).toBe('companion');
    } finally { delete process.env.DSH_HOME; }
  });
  it('guests shard resolves eleven stock-assistant bots', () => {
    process.env.DSH_HOME = '/data/dsh';
    try {
      const bots = resolveBots({ workspaceRoot: '/data/dsh/home/agents', botsFile: '/data/dsh/lark/bots-guests.json' } as never);
      const file = bots.filter((b) => b.accountId !== 'default');
      expect(file).toHaveLength(11);
      expect(new Set(file.map((b) => b.agentId))).toEqual(new Set(['guests']));
    } finally { delete process.env.DSH_HOME; }
  });
});
