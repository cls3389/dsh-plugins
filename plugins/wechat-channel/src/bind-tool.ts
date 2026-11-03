import { randomInt } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { bindIdentityWithCache, listIdentities } from '@dsh-friends/feishu-principal';
import { mergeArchive, type ArchiveMergeScope, type ArchiveMergeResult } from './archive-merge.js';
import type { ResolvedBot } from './config.js';
import type { WeixinInboundEvent } from './protocol/types.js';

interface ToolLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface WechatBindDeps {
  readonly bots: readonly ResolvedBot[];
  readonly logger: ToolLogger;
  /** Same dynamic trusted credentials domain as inbound identity resolution. */
  readonly appIdForAccount: (accountId: string) => string;
  /** List bound Weixin subjects per account (from allowlist/credentials). */
  readonly subjectsFor: (accountId: string) => Promise<readonly string[]>;
  /** Re-resolve bound sessions after a successful bind (cwd remap). */
  readonly rebind?: (accountId: string) => void;
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

interface PendingBind {
  code: string;
  /** 发起方：'feishu' = 飞书侧发起（微信档案并入飞书）；'wechat' = 微信侧发起（飞书档案并入微信）。 */
  origin: 'feishu' | 'wechat';
  feishuUserId: string;
  feishuSubjectId: string;
  agentId: string;
  accountId: string;
  appId: string;
  createdAt: number;
}

const CODE_TTL_MS = 10 * 60_000;
/** 配对回复格式：/bind + 空格(可选) + 6 位数字；与通道命令风格一致，普通数字消息不受影响。 */
const CODE_PATTERN = /^\/bind\s*(\d{6})$/i;

const pendingBinds = new Map<string, PendingBind>();

function purgeExpired(): void {
  for (const [key, pending] of pendingBinds) {
    if (Date.now() - pending.createdAt >= CODE_TTL_MS) pendingBinds.delete(key);
  }
}

/** Drop all in-flight pairings (test isolation; production only via restart). */
export function clearAllPairings(): void {
  pendingBinds.clear();
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function bindingAccounts(deps: WechatBindDeps, exec: ExecContext): ResolvedBot[] {
  const agentId = exec.agent?.identity?.agentId;
  const matched = agentId ? deps.bots.filter((bot) => bot.agentId === agentId) : [];
  return matched.length > 0 ? matched : [...deps.bots];
}

async function listBoundAccounts(deps: WechatBindDeps, exec: ExecContext): Promise<string> {
  const accounts = bindingAccounts(deps, exec);
  const lines: string[] = [];
  for (const bot of accounts) {
    const subjects = await deps.subjectsFor(bot.accountId);
    lines.push(subjects.length
      ? `${bot.accountId}（微信用户：${subjects.join('、')}）`
      : `${bot.accountId}（未登录）`);
  }
  return lines.join('\n');
}

/**
 * Conversational identity bind. "关联微信" from a Feishu identity issues a 6-digit
 * code through the Weixin channel; whoever replies the code in Weixin proves
 * control of that Weixin account and gets bound into the Feishu identity
 * cluster — no link tricks, one archive, channels share it afterwards.
 */
export function registerWechatBindTool(ctx: Context, deps: WechatBindDeps): void {
  const tools = (ctx as unknown as { tools?: { register(tool: unknown): void } }).tools
    ?? (ctx.get('tools') as { register(tool: unknown): void } | undefined);
  if (!tools) {
    deps.logger.warn('[wechat] tools service unavailable; wechat_bind not registered');
    return;
  }
  tools.register({
    name: 'wechat_bind',
    description:
      '微信-飞书身份关联（在飞书会话发起）。流程：1) action=start 生成配对码并直接展示在飞书回复里（不经微信通道）；2) 把配对码告知要关联的微信用户，让 TA 在微信里向这个 bot 发「/bind + 6位数字」（如 /bind 483921）；3) 谁回码，哪个微信就并入当前飞书身份——多个微信时用哪个微信回码就关联哪个。验证通过后会话使用飞书侧目标档案；仅在归属与 agent 范围明确时复制当前布局的 workspace/memory，历史复制状态另行返回，不能保证旧记忆全部迁移。未关联时两边各自独立，互不影响。多账号时用 account 指定。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status'], description: 'start=发起配对 status=查看待关联状态' },
        account: { type: 'string', description: '可选，多微信账号时指定；缺省在账号唯一时自动选择' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args: Record<string, unknown>, exec: ExecContext): Promise<Record<string, unknown>> => {
      purgeExpired();
      const identity = exec.agent?.identity;
      if (!identity?.userId || !identity.agentId) {
        throw new Error('当前会话缺少可信飞书身份，无法发起微信关联');
      }
      const action = String(args.action);
      if (action === 'status') {
        const open = [...pendingBinds.entries()]
          .filter(([, pending]) => pending.feishuUserId === identity.userId)
          .map(([, pending]) => ({ account: pending.accountId, origin: pending.origin, expires_at: new Date(pending.createdAt + CODE_TTL_MS).toISOString() }));
        // 当前身份簇实况：让 bot 能直接回答"我关联了哪些身份"，不再误读"队列为空"。
        const cluster = Object.entries(listIdentities()).find(([, user]) =>
          (user.identities ?? []).some((id) => id.channel === 'feishu' && id.openId === identity.subjectId),
        );
        const myIdentities = cluster
          ? (cluster[1].identities ?? []).map((id) => ({ channel: id.channel, app: id.appId, subject: id.openId }))
          : [];
        return {
          status: 'ok',
          pending: open,
          accounts: await listBoundAccounts(deps, exec),
          bound_identities: myIdentities,
          message: open.length
            ? `有 ${open.length} 个待验证的配对，10 分钟内有效。`
            : `当前没有进行中的配对。${myIdentities.length > 1 ? `注意：你的身份已关联 ${myIdentities.length} 个身份（${myIdentities.map((i) => i.channel).join('、')}），档案与记忆已共享，无需再次关联。` : '当前身份只含飞书身份，尚未关联微信。'}`,
        };
      }
      if (action !== 'start') throw new Error(`未知 action: ${action}`);

      // Target account: explicit > agentId-matched > error when ambiguous.
      let bots = bindingAccounts(deps, exec);
      if (typeof args.account === 'string' && args.account) {
        const exact = bots.find((bot) => bot.accountId === String(args.account).toLowerCase());
        if (!exact) throw new Error(`未配置的微信账号: ${args.account}`);
        bots = [exact];
      }
      const logged = [] as typeof bots;
      for (const bot of bots) if ((await deps.subjectsFor(bot.accountId)).length > 0) logged.push(bot);
      if (logged.length === 0) {
        return { status: 'no_login', message: '还没有已登录的微信账号，请先完成微信登录。', accounts: await listBoundAccounts(deps, exec) };
      }
      if (logged.length > 1) {
        return {
          status: 'ambiguous',
          message: '检测到多个已登录微信账号，请指定要关联哪个。',
          accounts: await listBoundAccounts(deps, exec),
        };
      }
      const bot = logged[0]!;
      const appId = deps.appIdForAccount(bot.accountId);
      const code = newCode();
      pendingBinds.set(`${bot.accountId}:${identity.userId}`, {
        code,
        origin: 'feishu',
        feishuUserId: identity.userId,
        feishuSubjectId: identity.subjectId ?? '',
        agentId: identity.agentId,
        accountId: bot.accountId,
        appId,
        createdAt: Date.now(),
      });
      // 码在飞书侧展示给发起人（不经微信通道——回码者是谁，哪个微信就是谁的）。
      return {
        status: 'code_sent',
        account: bot.accountId,
        code,
        message: `配对码：${code}（10 分钟内有效）。请在要关联的微信里向这个 bot 发送「/bind ${code}」。谁回码，哪个微信就并入你当前的飞书身份；多个微信时告诉对方用哪一个回码即可。`,
      };
    },
  });
  console.log('[wechat] active: wechat_bind tool registered');
  deps.logger.info('[wechat] wechat_bind tool registered');
}

/** Handle a Weixin-side reply: does it match an open pairing code (/bind 123456)? */
export async function handlePairingReply(
  deps: WechatBindDeps,
  message: WeixinInboundEvent,
  resolveArchiveScope: (pending: PendingBind) => ArchiveMergeScope | undefined,
): Promise<{ handled: boolean; reply?: string; merge?: ArchiveMergeResult }> {
  purgeExpired();
  const text = message.text.trim();
  const match = CODE_PATTERN.exec(text);
  if (!match) return { handled: false };
  const code = match[1]!;
  // 回码者是谁，哪个微信就被关联——不需要预先知道对方是谁。
  const candidates = [...pendingBinds.values()].filter((pending) => pending.accountId === message.accountId);
  if (!candidates.length) return { handled: false };
  const pending = candidates.find((candidate) => candidate.code === code);
  if (!pending) {
    return { handled: true, reply: '配对码不正确，请核对提示里的「/bind + 6位数字」后重试。' };
  }
  if (deps.appIdForAccount(message.accountId) !== pending.appId) {
    pendingBinds.delete(`${pending.accountId}:${pending.feishuUserId}`);
    return { handled: true, reply: '微信登录身份已变化，请在飞书侧重新发起关联。' };
  }
  // Resolve the old owner BEFORE bind removes the old identity cluster.
  const scope = resolveArchiveScope(pending);
  const bound = bindIdentityWithCache(pending.feishuUserId, {
    channel: 'wechat',
    appId: pending.appId,
    openId: message.subjectId,
  });
  pendingBinds.delete(`${pending.accountId}:${pending.feishuUserId}`);
  deps.rebind?.(pending.accountId);
  const merge = await mergeArchive(scope);
  deps.logger.info(
    `[wechat-bind] ${message.subjectId} bound into ${pending.feishuUserId} (previous: ${bound.previousUserId ?? 'none'}; archive ${merge.status}; copied ${merge.copiedFiles} files, ${merge.conflicts.length} conflicts)`,
  );
  const details = {
    merged: `已复制历史工作区和记忆文件 ${merge.copiedFiles} 个。`,
    partial: `历史档案仅部分复制（${merge.copiedFiles} 个文件），${merge.skipped.length} 项跳过或失败，需人工核查。`,
    source_missing: '未发现当前布局下的历史工作区或记忆目录；旧布局及孤儿档案未自动迁移。',
    same_root: '双方已使用同一档案目录，无需复制。',
    skipped: '缺少明确的档案归属范围，历史档案未复制，需人工核查。',
    failed: '历史档案复制失败，原档案保留，需人工核查。',
  }[merge.status];
  return {
    handled: true,
    merge,
    reply: `✅ 身份关联完成，后续对话使用目标身份档案。${details}${merge.conflicts.length ? `${merge.conflicts.length} 个同名冲突保存为 .wechat-side（或数字后缀）副本，未覆盖目标文件。` : ''}`,
  };
}
