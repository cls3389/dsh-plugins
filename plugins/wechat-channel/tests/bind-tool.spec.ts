import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentIdentity } from '@dsh-friends/feishu-principal';
import type { ResolvedBot } from '../src/config.js';
import { clearAllPairings, handlePairingReply, registerWechatBindTool, type WechatBindDeps } from '../src/bind-tool.js';
import type { WeixinInboundEvent } from '../src/protocol/types.js';

const dirs: string[] = [];
const savedHome = process.env.DSH_HOME;
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-bind-home-'));
  dirs.push(home);
  process.env.DSH_HOME = home;
  clearAllPairings(); // 模块级 pendingBinds 跨用例隔离
});
afterEach(async () => {
  clearAllPairings();
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Executed = (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;

interface Fixture {
  execute: Executed;
  deps: WechatBindDeps;
  rebinds: string[];
  agentsRoot: string;
  appId: string;
}

async function fixture(subjectsByAccount: Record<string, string[]> = { main: ['friend@im'] }): Promise<Fixture> {
  const agentsRoot = await mkdtemp(join(tmpdir(), 'wechat-bind-'));
  dirs.push(agentsRoot);
  const bots: ResolvedBot[] = Object.keys(subjectsByAccount).map((accountId) => ({
    accountId,
    agentId: 'gtjs',
    dataDir: join(agentsRoot, 'wechat', accountId),
    agentsRoot,
    workspaceRoot: join(agentsRoot, 'gtjs'),
  }) as unknown as ResolvedBot);
  const rebinds: string[] = [];
  const deps: WechatBindDeps = {
    bots,
    logger: { info() {}, warn() {}, error() {} },
    appIdForAccount: (accountId) => `account:${accountId}`,
    async subjectsFor(accountId) {
      return subjectsByAccount[accountId] ?? [];
    },
    rebind(accountId) {
      rebinds.push(accountId);
    },
  };
  let execute: Executed | undefined;
  const ctx = {
    get(name: string) {
      if (name !== 'tools') return undefined;
      return {
        register(tool: { execute: Executed }) {
          execute = tool.execute;
        },
      };
    },
  };
  registerWechatBindTool(ctx as never, deps);
  return { execute: execute!, deps, rebinds, agentsRoot, appId: 'account:main' };
}

function inbound(accountId: string, subjectId: string, text: string): WeixinInboundEvent {
  return {
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    accountId,
    subjectId,
    conversationId: subjectId,
    text,
    raw: {},
  };
}

const EXEC_F = { agent: { identity: { channel: 'feishu', agentId: 'gtjs', subjectId: 'ou_aaa', userId: 'u_feishu_1' } } };

describe('wechat_bind tool', () => {
  it('issues a 6-digit code shown on the Feishu side (no Weixin delivery)', async () => {
    const f = await fixture();
    const result = await f.execute({ action: 'start' }, EXEC_F);
    expect(result.status).toBe('code_sent');
    expect(result.account).toBe('main');
    expect(String(result.code)).toMatch(/^\d{6}$/);
    expect(result.message).toContain(String(result.code));
  });

  it('binds on the correct Weixin-side reply and merges archives', async () => {
    const f = await fixture();
    // 飞书身份先建档（真实场景中飞书渠道一直在用，身份已存在）。
    resolveAgentIdentity({ channel: 'feishu', appId: 'cli_test', subjectId: 'ou_aaa' });
    // 确保飞书 userId 与 resolveIdentity 建档结果一致。
    const feishu = resolveAgentIdentity({ channel: 'feishu', appId: 'cli_test', subjectId: 'ou_aaa' });
    // 微信侧用户 friend@im 已有独立档案（bind 前首见建档）。
    const wxUserId = resolveAgentIdentity({ channel: 'wechat', appId: f.appId, subjectId: 'friend@im' }).userId;
    const oldRoot = join(f.agentsRoot, wxUserId, 'gtjs', 'memory');
    await mkdir(join(oldRoot, 'topics'), { recursive: true });
    await writeFile(join(oldRoot, 'topics', 'preferences.md'), `<!-- preferences · 关键词: 偏好 -->\n- [2026-11-01] 微信侧记忆一条\n`, 'utf8');
    const targetRoot = join(f.agentsRoot, feishu.userId, 'gtjs', 'memory');

    const started = await f.execute({ action: 'start' }, { agent: { identity: { channel: 'feishu', agentId: 'gtjs', subjectId: 'ou_aaa', userId: feishu.userId } } });
    const code = String(started.code);
    const reply = await handlePairingReply(f.deps, inbound('main', 'friend@im', `/bind ${code}`), (pending) => {
      const oldUserId = resolveAgentIdentity({ channel: 'wechat', appId: pending.appId, subjectId: 'friend@im' }).userId;
      expect(oldUserId).toBe(wxUserId); // callback must precede binding
      return { usersRoot: f.agentsRoot, oldUserId, targetUserId: pending.feishuUserId, agentId: pending.agentId };
    });
    expect(reply.handled).toBe(true);
    expect(reply.reply).toContain('关联完成');
    // 记忆并入飞书身份档案。
    const merged = await readFile(join(targetRoot, 'topics', 'preferences.md'), 'utf8');
    expect(merged).toContain('微信侧记忆一条');
    // 身份簇：同一 subjectId 现在解析出飞书 userId。
    expect(resolveAgentIdentity({ channel: 'wechat', appId: f.appId, subjectId: 'friend@im' }).userId).toBe(feishu.userId);
    expect(f.rebinds).toEqual(['main']);
  });

  it('uses the dynamic trusted login domain and rejects domain changes before reply', async () => {
    const f = await fixture();
    const feishu = resolveAgentIdentity({ channel: 'feishu', appId: 'cli_test', subjectId: 'ou_domain' });
    let domain = 'logged-bot-id';
    Object.assign(f.deps, { appIdForAccount: () => domain });
    const exec = { agent: { identity: { channel: 'feishu', agentId: 'gtjs', subjectId: 'ou_domain', userId: feishu.userId } } };
    const started = await f.execute({ action: 'start' }, exec);
    let capturedDomain = '';
    const reply = await handlePairingReply(f.deps, inbound('main', 'domain@im', `/bind ${started.code}`), (pending) => {
      capturedDomain = pending.appId;
      return undefined;
    });
    expect(capturedDomain).toBe('logged-bot-id');
    expect(reply.merge?.status).toBe('skipped');
    expect(resolveAgentIdentity({ channel: 'wechat', appId: domain, subjectId: 'domain@im' }).userId).toBe(feishu.userId);
    const again = await f.execute({ action: 'start' }, exec);
    domain = 'other-bot-id';
    const roots = vi.fn();
    const rejected = await handlePairingReply(f.deps, inbound('main', 'other@im', `/bind ${again.code}`), roots);
    expect(rejected.reply).toContain('登录身份已变化');
    expect(roots).not.toHaveBeenCalled();
  });

  it('rejects wrong codes and leaves identity untouched', async () => {
    const f = await fixture();
    await f.execute({ action: 'start' }, EXEC_F);
    const before = resolveAgentIdentity({ channel: 'wechat', appId: f.appId, subjectId: 'friend@im' }).userId;
    const reply = await handlePairingReply(f.deps, inbound('main', 'friend@im', '/bind 000000'), () => undefined);
    expect(reply.handled).toBe(true);
    expect(reply.reply).toContain('不正确');
    expect(resolveAgentIdentity({ channel: 'wechat', appId: f.appId, subjectId: 'friend@im' }).userId).toBe(before);
  });

  it('does not treat ordinary 6-digit or non-code messages as pairing', async () => {
    const f = await fixture();
    // 裸 6 位数字（无 /bind 前缀）不当配对处理。
    const stray = await handlePairingReply(f.deps, inbound('main', 'friend@im', '123456'), () => undefined);
    expect(stray.handled).toBe(false); // no pending bind started
    await f.execute({ action: 'start' }, EXEC_F);
    const notDigits = await handlePairingReply(f.deps, inbound('main', 'friend@im', 'hello'), () => undefined);
    expect(notDigits.handled).toBe(false);
    // 有进行中的配对时，裸数字仍不当配对（必须带 /bind 前缀）。
    const bareDuring = await handlePairingReply(f.deps, inbound('main', 'friend@im', '654321'), () => undefined);
    expect(bareDuring.handled).toBe(false);
  });

  it('asks for the account when several are logged in', async () => {
    const f = await fixture({ main: ['friend@im'], inv: ['colleague@im'] });
    const result = await f.execute({ action: 'start' }, EXEC_F);
    expect(result.status).toBe('ambiguous');
    expect(result.accounts).toContain('main');
    expect(result.accounts).toContain('inv');
    const pinned = await f.execute({ action: 'start', account: 'inv' }, EXEC_F);
    expect(pinned.status).toBe('code_sent');
    expect(pinned.account).toBe('inv');
  });

  it('fails closed without a trusted Feishu identity', async () => {
    const f = await fixture();
    await expect(f.execute({ action: 'start' }, {})).rejects.toThrow(/可信飞书身份/);
  });
});
