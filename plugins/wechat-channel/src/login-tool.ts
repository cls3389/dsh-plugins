import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import type { Context } from '@deepseek-ai/cordis';
import { fetchQrCode, pollQrStatus } from './protocol/client.js';
import { WeixinStateStore } from './protocol/state.js';
import type { ResolvedBot } from './config.js';
import type { WeixinChannel } from './channel.js';

interface ToolLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface WechatLoginDeps {
  readonly bots: readonly ResolvedBot[];
  readonly states: ReadonlyMap<string, WeixinStateStore>;
  readonly channels: ReadonlyMap<string, WeixinChannel>;
  readonly logger: ToolLogger;
  readonly fetchImpl?: typeof fetch;
}

interface ActiveLogin {
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  baseUrl?: string;
  pendingVerifyCode?: string;
  /** Set when the caller explicitly accepted replacing an existing binding. */
  forceRebind?: boolean;
}

interface ExecContext {
  readonly agent?: {
    readonly identity?: {
      readonly agentId?: string;
      readonly channel?: string;
      readonly subjectId?: string;
      readonly userId?: string;
    };
  };
}

const LOGIN_TTL_MS = 5 * 60_000;
const WAIT_DEFAULT_SECONDS = 90;
const WAIT_MAX_SECONDS = 300;

const activeLogins = new Map<string, ActiveLogin>();

function purgeExpired(): void {
  for (const [id, login] of activeLogins) {
    if (Date.now() - login.startedAt >= LOGIN_TTL_MS) activeLogins.delete(id);
  }
}

function resolveAccount(deps: WechatLoginDeps, account: unknown, exec: ExecContext): ResolvedBot {
  if (typeof account === 'string' && account) {
    const exact = deps.bots.find((bot) => bot.accountId === account.toLowerCase());
    if (!exact) throw new Error(`未配置的微信账号: ${account}（可用: ${deps.bots.map((bot) => bot.accountId).join(', ')}）`);
    return exact;
  }
  // 身份绑定：在哪个 agentId 的会话里发起，就绑定该身份下的微信账号。
  const agentId = exec.agent?.identity?.agentId;
  if (agentId) {
    const matched = deps.bots.find((bot) => bot.agentId === agentId);
    if (matched) return matched;
  }
  if (deps.bots.length === 1) return deps.bots[0]!;
  throw new Error(`当前身份未绑定微信账号，请显式指定 account（可用: ${deps.bots.map((bot) => `${bot.accountId}(agentId=${bot.agentId})`).join('、')}）`);
}

/**
 * Caller guard: agentToolAllow is bot-granular, so any user who can talk to the
 * bot sees wechat_login. loginAllowUsers narrows execution to listed Feishu
 * subjectIds (open_id); configure it whenever the bot serves more than you.
 */
function guardLoginAllow(bot: ResolvedBot, exec: ExecContext): void {
  const allow = bot.loginAllowUsers;
  if (!allow?.length) return;
  const caller = exec.agent?.identity?.subjectId;
  if (!caller || !allow.includes(caller)) {
    throw new Error('当前用户无权管理微信登录（不在 loginAllowUsers）');
  }
}

async function renderQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: 'png', width: 480, margin: 2 });
}

async function waitForConfirmation(deps: WechatLoginDeps, bot: ResolvedBot, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const state = deps.states.get(bot.accountId);
  const login = activeLogins.get(bot.accountId);
  if (!state) throw new Error(`微信账号 ${bot.accountId} 状态存储不可用`);
  if (!login) return { status: 'no_qr', message: '还没有二维码，请先用 action=qr 生成。' };
  if (Date.now() - login.startedAt >= LOGIN_TTL_MS) {
    activeLogins.delete(bot.accountId);
    return { status: 'expired', message: '二维码已过期，请重新 action=qr 生成。' };
  }
  const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 5), WAIT_MAX_SECONDS) * 1000;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await pollQrStatus({
        qrcode: login.qrcode,
        ...(login.baseUrl ? { baseUrl: login.baseUrl } : {}),
        ...(login.pendingVerifyCode ? { verifyCode: login.pendingVerifyCode } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (error) {
      deps.logger.warn(`[wechat-login] 状态轮询失败，稍后重试: ${String(error)}`);
      await sleep(1500);
      continue;
    }
    if (status.redirect_host) login.baseUrl = `https://${status.redirect_host}`;
    switch (status.status) {
      case 'confirmed': {
        if (!status.bot_token || !status.ilink_bot_id) {
          return { status: 'error', message: `服务端确认但缺少凭证: ${status.errmsg ?? '未知错误'}` };
        }
        await state.saveAccount({
          accountId: bot.accountId,
          botId: status.ilink_bot_id,
          token: status.bot_token,
          baseUrl: status.baseurl ?? login.baseUrl ?? 'https://ilinkai.weixin.qq.com',
          ...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
        });
        if (status.ilink_user_id) {
          // force 换绑 = 白名单整体重置为新扫码人；普通首绑 = 追加。
          if (login.forceRebind) await state.setAllowlist([status.ilink_user_id]);
          else await state.allowSubject(status.ilink_user_id);
        }
        activeLogins.delete(bot.accountId);
        const channel = deps.channels.get(bot.accountId);
        if (channel) void channel.start().catch((error) => deps.logger.error(`[wechat-login] 登录后拉起通道失败: ${String(error)}`));
        return {
          status: 'confirmed',
          message: `微信账号 ${bot.accountId} 登录成功，已绑定身份 ${bot.agentId} 并自动加入白名单。`,
          ...(status.ilink_user_id ? { ilink_user_id: status.ilink_user_id } : {}),
        };
      }
      case 'expired':
        activeLogins.delete(bot.accountId);
        return { status: 'expired', message: '二维码已过期，请重新 action=qr 生成。' };
      case 'need_verifycode':
        return { status: 'need_verifycode', message: '请向用户询问手机微信上显示的数字，再用 action=code 提交。' };
      case 'scaned':
      case 'scaned_but_redirect':
        continue;
      default:
        await sleep(1500);
    }
  }
  return { status: 'waiting', message: '等待扫码确认中超时，可继续 action=wait。' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Conversational Weixin QR login. Which Feishu identity issues the login
 * decides which Weixin account gets bound (identity.agentId → bots[].agentId).
 */
export function registerWechatLoginTool(ctx: Context, deps: WechatLoginDeps): void {
  const tools = (ctx as unknown as { tools?: { register(tool: unknown): void } }).tools
    ?? (ctx.get('tools') as { register(tool: unknown): void } | undefined);
  if (!tools) {
    deps.logger.warn('[wechat] tools service unavailable; wechat_login not registered');
    return;
  }
  tools.register({
    name: 'wechat_login',
    description:
      '微信扫码登录（仅管理员身份开放）。流程：1) action=qr 生成二维码，把返回的 image_path 用 feishu_send_image 发给用户（无法发图时给 link 让用户自行转二维码）；2) action=wait 等待扫码结果；3) 返回 need_verifycode 时询问用户手机上的数字并 action=code 提交；4) confirmed 即完成，凭证与白名单自动落盘。在哪个身份的会话发起，就绑定该身份(agentId)下的微信账号。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['qr', 'wait', 'code'], description: 'qr=生成二维码 wait=等待扫码 code=提交验证数字' },
        account: { type: 'string', description: '可选，显式指定微信账号；缺省按当前身份 agentId 绑定' },
        force: { type: 'boolean', description: '仅在已绑定需要换绑时使用；确认后旧凭证与白名单替换为新扫码人' },
        verify_code: { type: 'string', description: 'action=code 时必填，手机微信显示的数字' },
        timeout_seconds: { type: 'integer', description: 'action=wait 的等待秒数，默认 90，最大 300' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args: Record<string, unknown>, exec: ExecContext) => {
      const bot = resolveAccount(deps, args.account, exec);
      guardLoginAllow(bot, exec);
      const state = deps.states.get(bot.accountId);
      if (!state) throw new Error(`微信账号 ${bot.accountId} 状态存储不可用`);
      purgeExpired();
      const action = String(args.action);
      if (action === 'qr') {
        // 换绑保护：已有有效凭证时默认拒绝，防止共享 bot 上他人扫码抢绑。
        const bound = await state.loadAccount();
        if (bound?.token && args.force !== true) {
          return {
            status: 'already_bound',
            account: bot.accountId,
            message: `账号 ${bot.accountId} 已绑定微信（botId=${bound.botId}）。确认要换绑时携带 force=true 重新扫码；确认后凭证与白名单将替换为新扫码人。`,
          };
        }
        const qr = await fetchQrCode({ ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
        if (!qr.qrcode || !qr.qrcode_img_content) throw new Error(`获取二维码失败: ${JSON.stringify({ ...qr, qrcode: undefined })}`);
        activeLogins.set(bot.accountId, {
          qrcode: qr.qrcode,
          qrcodeUrl: qr.qrcode_img_content,
          startedAt: Date.now(),
          ...(args.force === true ? { forceRebind: true } : {}),
        });
        const png = await renderQrPng(qr.qrcode_img_content);
        // QR 落发起登录的用户工作区（agents/<agentId>/users/<userId>/）：
        // feishu_send_image 的工作区白名单天然放行，无需额外开洞；文件随会话留在本人档案里。
        const agentsRoot = bot.agentsRoot ?? process.cwd();
        const userId = exec.agent?.identity?.userId;
        if (!userId) throw new Error('当前会话缺少可信用户身份，无法生成登录二维码');
        const imagePath = join(agentsRoot, bot.agentId, 'users', userId, 'wechat-login-qr.png');
        await mkdir(dirname(imagePath), { recursive: true, mode: 0o700 });
        await writeFile(imagePath, png, { mode: 0o600 });
        return {
          status: 'qr_ready',
          account: bot.accountId,
          agent_id: bot.agentId,
          image_path: imagePath,
          link: qr.qrcode_img_content,
          message: `二维码已生成（5 分钟内有效），请用微信扫码后 action=wait。图片: ${imagePath}`,
        };
      }
      if (action === 'code') {
        const code = String(args.verify_code ?? '').trim();
        if (!code) throw new Error('verify_code 必填：手机微信上显示的数字');
        const login = activeLogins.get(bot.accountId);
        if (!login) return { status: 'no_qr', message: '登录已过期，请重新 action=qr。' };
        login.pendingVerifyCode = code;
        return waitForConfirmation(deps, bot, 30);
      }
      if (action === 'wait') {
        const seconds = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : WAIT_DEFAULT_SECONDS;
        return waitForConfirmation(deps, bot, seconds);
      }
      throw new Error(`未知 action: ${action}`);
    },
  });
  console.log('[wechat] active: wechat_login tool registered');
  deps.logger.info('[wechat] wechat_login tool registered');
}
