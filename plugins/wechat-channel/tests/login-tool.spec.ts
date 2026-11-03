import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeixinChannel } from '../src/channel.js';
import type { ResolvedBot } from '../src/config.js';
import { registerWechatLoginTool, type WechatLoginDeps } from '../src/login-tool.js';
import { WeixinStateStore } from '../src/protocol/state.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Executed = (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;

interface Fixture {
  execute: Executed;
  deps: WechatLoginDeps;
  fetchImpl: ReturnType<typeof vi.fn>;
  starts: Record<string, ReturnType<typeof vi.fn>>;
}

async function fixture(statusScript: Array<Record<string, unknown>>): Promise<Fixture> {
  const responses = [
    { body: { qrcode: 'QRID', qrcode_img_content: 'https://weixin.qq.com/x/ABC' } },
    ...statusScript.map((body) => ({ body })),
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const next = responses.shift() ?? { body: { ret: 0, status: 'wait' } };
    return new Response(JSON.stringify(next.body), { status: 200 });
  });
  const mkBot = async (accountId: string, agentId: string) => {
    const dir = await mkdtemp(join(tmpdir(), `wechat-login-${accountId}-`));
    dirs.push(dir);
    return {
      bot: {
        accountId,
        agentId,
        dataDir: dir,
        agentsRoot: dir,
        workspaceRoot: join(dir, agentId),
      } as unknown as ResolvedBot,
      state: new WeixinStateStore(dir, accountId),
    };
  };
  const a = await mkBot('gtjs', 'goutoujunshi');
  const b = await mkBot('inv', 'personal-investment');
  const starts: Fixture['starts'] = {
    gtjs: vi.fn(async () => {}),
    inv: vi.fn(async () => {}),
  };
  const deps: WechatLoginDeps = {
    bots: [a.bot, b.bot],
    states: new Map([
      ['gtjs', a.state],
      ['inv', b.state],
    ]),
    channels: new Map([
      ['gtjs', { start: starts.gtjs } as unknown as WeixinChannel],
      ['inv', { start: starts.inv } as unknown as WeixinChannel],
    ]),
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: fetchImpl as unknown as typeof fetch,
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
  registerWechatLoginTool(ctx as never, deps);
  return { execute: execute!, deps, fetchImpl, starts };
}

const EXEC_GTJS = { agent: { identity: { agentId: 'goutoujunshi', channel: 'feishu', userId: 'u_123' } } };

describe('wechat_login tool', () => {
  it('binds by identity agentId and renders a scannable QR image', async () => {
    const f = await fixture([{ status: 'wait' }]);
    const result = await f.execute({ action: 'qr' }, EXEC_GTJS);
    expect(result.status).toBe('qr_ready');
    expect(result.account).toBe('gtjs');
    expect(result.agent_id).toBe('goutoujunshi');
    expect(result.link).toBe('https://weixin.qq.com/x/ABC');
    const png = await stat(result.image_path as string);
    expect(png.size).toBeGreaterThan(500);
    const header = await readFile(result.image_path as string);
    expect(header.subarray(1, 4).toString()).toBe('PNG');
    // QR 落在发起登录的飞书用户工作区（feishu_send_image 工作区白名单天然放行）。
    expect(result.image_path).toContain(join('goutoujunshi', 'users', 'u_123', 'wechat-login-qr.png'));
  });

  it('persists credentials, allowlists the scanner, and starts the channel', async () => {
    const f = await fixture([
      { status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'wxbot-9', ilink_user_id: 'owner@im', baseurl: 'https://api.wechat.test' },
    ]);
    await f.execute({ action: 'qr' }, EXEC_GTJS);
    const result = await f.execute({ action: 'wait' }, EXEC_GTJS);
    expect(result.status).toBe('confirmed');
    expect(result.ilink_user_id).toBe('owner@im');
    const state = f.deps.states.get('gtjs')!;
    expect(await state.loadAccount()).toMatchObject({ token: 'tok-1', botId: 'wxbot-9', baseUrl: 'https://api.wechat.test' });
    expect(await state.loadAllowlist()).toContain('owner@im');
    expect(f.starts.gtjs).toHaveBeenCalledTimes(1);
    expect(f.starts.inv).not.toHaveBeenCalled();
  });

  it('hands the verify-code challenge back and submits it on the next call', async () => {
    const f = await fixture([
      { status: 'need_verifycode' },
      { status: 'confirmed', bot_token: 'tok-2', ilink_bot_id: 'wxbot-8', ilink_user_id: 'owner2@im' },
    ]);
    await f.execute({ action: 'qr' }, EXEC_GTJS);
    const challenge = await f.execute({ action: 'wait' }, EXEC_GTJS);
    expect(challenge.status).toBe('need_verifycode');
    const done = await f.execute({ action: 'code', verify_code: '4242' }, EXEC_GTJS);
    expect(done.status).toBe('confirmed');
    const verifyCall = f.fetchImpl.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('verify_code='));
    expect(verifyCall).toContain('verify_code=4242');
  });

  it('rejects ambiguous accounts without an identity binding', async () => {
    const f = await fixture([]);
    await expect(f.execute({ action: 'qr' }, {})).rejects.toThrow(/请显式指定 account/);
    const explicit = await f.execute({ action: 'qr', account: 'inv' }, { agent: { identity: { agentId: 'personal-investment', channel: 'feishu', userId: 'u_inv' } } });
    expect(explicit.account).toBe('inv');
  });

  it('restricts login to loginAllowUsers on shared bots', async () => {
    const f = await fixture([]);
    (f.deps.bots[0] as { loginAllowUsers?: string[] }).loginAllowUsers = ['ou_owner0000000000000000000000000'];
    const execOwner = { agent: { identity: { agentId: 'goutoujunshi', channel: 'feishu', subjectId: 'ou_owner0000000000000000000000000', userId: 'u_owner' } } };
    const execGuest = { agent: { identity: { agentId: 'goutoujunshi', channel: 'feishu', subjectId: 'ou_guest0000000000000000000000000000', userId: 'u_guest' } } };
    await expect(f.execute({ action: 'qr' }, execGuest)).rejects.toThrow(/loginAllowUsers/);
    const allowed = await f.execute({ action: 'qr' }, execOwner);
    expect(allowed.status).toBe('qr_ready');
  });

  it('refuses rebinding an already-bound account without force, and resets the allowlist with force', async () => {
    const f = await fixture([
      { status: 'confirmed', bot_token: 'tok-new', ilink_bot_id: 'wxbot-2', ilink_user_id: 'new@im' },
    ]);
    const state = f.deps.states.get('gtjs')!;
    await state.saveAccount({ accountId: 'gtjs', botId: 'wxbot-1', token: 'tok-old', baseUrl: 'https://x' });
    await state.allowSubject('old@im');
    const blocked = await f.execute({ action: 'qr' }, EXEC_GTJS);
    expect(blocked.status).toBe('already_bound');
    expect((await state.loadAccount())?.token).toBe('tok-old'); // 未动原绑定
    await f.execute({ action: 'qr', force: true }, EXEC_GTJS);
    const done = await f.execute({ action: 'wait' }, EXEC_GTJS);
    expect(done.status).toBe('confirmed');
    expect(await state.loadAccount()).toMatchObject({ token: 'tok-new', botId: 'wxbot-2' });
    expect(await state.loadAllowlist()).toEqual(['new@im']); // 旧主人被移出白名单
  });
});
