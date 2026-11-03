/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_oauth tool — User OAuth authorisation management.
 *
 * Actions:
 *   - authorize : Initiate Device Flow, send auth card, poll for token.
 *   - status    : Check whether the current user has a valid UAT.
 *   - revoke    : Remove the current user's stored UAT.
 *
 * Security:
 *   - **Does not** accept a `user_open_id` parameter.  The target user is
 *     always the message sender, obtained from the LarkTicket.
 *   - Token values are never included in the return payload (AI cannot see
 *     them).
 */

import type { ClawdbotConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import type { ConfiguredLarkAccount } from '../core/types';
import { getLarkAccount } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import { getAppGrantedScopes } from '../core/app-scope-checker';
import { filterSensitiveScopes } from '../core/tool-scopes';
import { appPermissionAuthUrl } from '../core/app-auth-url';
import type { LarkTicket } from '../core/lark-ticket';
import { getTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('tools/oauth');
import { formatLarkError } from '../core/api-error';
import { pollDeviceToken, requestDeviceAuthorization } from '../core/device-flow';
import { type StoredUAToken, getStoredToken, setStoredToken, tokenStatus } from '../core/token-store';
import { revokeUAT } from '../core/uat-client';
import { createCardEntity, sendCardByCardId, updateCardKitCardForAuth } from '../card/cardkit';
import { dispatchSyntheticTextMessage } from '../messaging/inbound/synthetic-message';
import { buildAuthCard, buildAuthFailedCard, buildAuthIdentityMismatchCard, buildAuthSuccessCard } from './oauth-cards';
import { formatToolResult, registerTool } from './helpers';

const json = formatToolResult;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuOAuthSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal('authorize'),
        Type.Literal('revoke'),
      ],
      {
        description: 'authorize: 为当前用户发送授权卡片；revoke: 撤销当前用户已保存的授权凭据',
      },
    ),
    // DSH-PATCH: 支持按「能力」授权，而不是零散 scope。
    // 用户口语上说的是"我需要多维表格"，此时要的是多维表格那一整套权限，
    // 不是其中某一条。传 capability 即可一次拿全该能力的全部 scope。
    capability: Type.Optional(
      Type.String({
        description:
          '按能力一次性授权该能力的全部 scope（推荐）。可选值：' +
          'bitable=多维表格, sheet=电子表格, doc=文档, im=群聊消息, drive=云盘, wiki=知识库, all=全部。' +
          '传入后无需再列 scope：会从应用已开通的用户权限里展开该能力域的完整集合，' +
          '再减去当前已授权的，一次补齐剩余部分。',
      }),
    ),
    scope: Type.Optional(
      Type.String({
        description:
          '需要用户授权的空格分隔 scope 列表。仅在需要精确补单个权限时使用；' +
          '一般场景请用 capability，一次补全整个能力域。',
      }),
    ),
  },
  {
    description:
      '飞书用户授权工具。当消息/文档/多维表格等工具提示缺少用户权限或未授权时使用。' +
      '优先用 capability 参数按能力授权（如 capability="bitable" 即授予多维表格全套权限），' +
      '会一次性补齐该能力下所有缺失 scope，无需逐个授权；返回 awaiting_authorization 时' +
      '把卡片里的权限数量与能力名原样告知用户即可，不要重复发起。' +
      '仅在用户明确说"撤销授权"、"取消授权"、"退出登录"、"清除授权"时调用 revoke。',
  },
);

interface FeishuOAuthParams {
  action: 'authorize' | 'revoke';
  capability?: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// DSH-PATCH: 能力 → scope 映射
// ---------------------------------------------------------------------------
/**
 * 按能力分组的 scope 清单。
 *
 * 设计意图：用户表达的是"我需要用多维表格"，那就应该一次拿到多维表格所需的
 * 全部权限，而不是每次报错后再补一个。分组按飞书官方权限前缀归类，
 * 只列「支持 user 身份」的 scope（tenant-only 的塞进去会让整批请求 400）。
 */
// 能力域 → scope 前缀。动态展开时按前缀从「应用实际已开通的 user scope」里挑，
// 保证「要多维表格 = 多维表格全套」对任意应用都成立，也不会写错不存在的 scope 名
// （历史上手写过 im:chat:readonly，飞书侧根本没有这条）。
const CAPABILITY_PREFIXES: Record<string, string[]> = {
  bitable: ['base:', 'bitable:'],
  sheet: ['sheets:'],
  doc: ['docx:', 'docs:document'],
  im: ['im:'],
  drive: ['drive:', 'space:document'],
  wiki: ['wiki:'],
};

/** 能力域的中文名，用于日志/返回/授权卡片文案。 */
const CAPABILITY_LABELS: Record<string, string> = {
  bitable: '多维表格',
  sheet: '电子表格',
  doc: '文档',
  im: '群聊消息',
  drive: '云盘',
  wiki: '知识库',
  all: '全部能力',
};

/**
 * 静态兜底清单：仅在「查不到应用已开通 scope」（缺 self_manage 等）时使用。
 * 正常路径永远走前缀动态展开，所以这里的清单不必也不该追求齐全。
 */
const CAPABILITY_SCOPES_FALLBACK: Record<string, string[]> = {
  bitable: [
    'base:app:create',
    'base:app:update',
    'base:table:create',
    'base:table:read',
    'base:table:update',
    'base:field:create',
    'base:field:delete',
    'base:field:read',
    'base:field:update',
    'base:view:read',
    'base:record:create',
    'base:record:delete',
    'base:record:retrieve',
    'base:record:update',
    'bitable:app',
    'bitable:app:readonly',
  ],
  sheet: [
    'sheets:spreadsheet.meta:read',
    'sheets:spreadsheet:read',
    'sheets:spreadsheet:create',
    'sheets:spreadsheet:write_only',
  ],
  doc: [
    'docx:document:create',
    'docx:document:readonly',
    'docx:document:write_only',
    'docs:document.media:upload',
  ],
  im: [
    'im:chat:read',
    'im:message:readonly',
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
  ],
  drive: ['drive:drive', 'drive:drive.metadata:readonly', 'space:document:retrieve'],
  wiki: ['wiki:node:read', 'wiki:node:create'],
};

/** 能力域中文名（未知能力原样返回）。 */
export function capabilityLabel(capability: string): string {
  const key = capability.trim().toLowerCase();
  return CAPABILITY_LABELS[key] ?? capability;
}

/**
 * 展开 capability 为该能力域的全部 scope。
 *
 * @param capability 能力名
 * @param appGranted 应用已开通的 user scope；非空时按前缀动态展开，空则用静态兜底
 * @returns 未识别的能力返回 undefined
 */
export function expandCapability(capability: string, appGranted: string[] = []): string[] | undefined {
  const key = capability.trim().toLowerCase();

  if (key === 'all') {
    return appGranted.length > 0 ? [...appGranted] : Object.values(CAPABILITY_SCOPES_FALLBACK).flat();
  }

  const prefixes = CAPABILITY_PREFIXES[key];
  if (prefixes === undefined) return undefined;

  if (appGranted.length > 0) {
    // 动态展开：应用开了哪几条就申请哪几条，天然对齐每个 bot 的真实配置。
    return appGranted.filter((s) => prefixes.some((p) => s.startsWith(p)));
  }

  const fallback = CAPABILITY_SCOPES_FALLBACK[key];
  return fallback === undefined ? [] : [...fallback];
}

/** 已识别的能力名列表（用于错误提示）。 */
function capabilityNames(): string[] {
  return Object.keys(CAPABILITY_PREFIXES);
}

// ---------------------------------------------------------------------------
// In-flight authorize guard (prevent duplicate device-flows per user)
// ---------------------------------------------------------------------------

interface PendingFlow {
  controller: AbortController;
  cardId: string;
  sequence: number;
  messageId: string;
  /** 被新流替换后标记为 true，旧轮询回调检测到后跳过卡片更新 */
  superseded: boolean;
  /** 当前 flow 请求的 scope（空格分隔），用于后续 scope 合并 */
  scope?: string;
}

const pendingFlows = new Map<string, PendingFlow>();

// ---------------------------------------------------------------------------
// Identity verification after Device Flow
// ---------------------------------------------------------------------------

/**
 * 使用刚获取的 UAT 调用 /authen/v1/user_info，
 * 验证实际完成 OAuth 授权的用户 open_id 是否与预期的 senderOpenId 一致。
 *
 * 防止群聊中其他用户点击授权链接后，错误的 UAT 被绑定到 owner 的身份。
 */
async function verifyTokenIdentity(
  brand: string,
  accessToken: string,
  expectedOpenId: string,
): Promise<{ valid: boolean; actualOpenId?: string }> {
  const domain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${domain}/open-apis/authen/v1/user_info`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { open_id?: string };
    };
    if (data.code !== 0) {
      log.warn(`user_info API error: code=${data.code}, msg=${data.msg}`);
      return { valid: false };
    }
    const actualOpenId = data.data?.open_id;
    if (!actualOpenId) {
      log.warn('user_info API returned no open_id');
      return { valid: false };
    }
    return {
      valid: actualOpenId === expectedOpenId,
      actualOpenId,
    };
  } catch (err) {
    log.warn(`identity verification request failed: ${err}`);
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuOAuthTool(api: OpenClawPluginApi): void {
  if (!api.config) return;

  const cfg = api.config;

  registerTool(
    api,
    {
      name: 'feishu_oauth',
      label: 'Feishu OAuth',
      description:
        '飞书用户授权工具。当消息/文档工具明确提示缺少权限或未授权时，最多调用一次 authorize 向当前用户发送授权卡片。若飞书返回未在应用所在企业/可用范围或其他失败原因，原样展示并停止，不要重试、不要猜测原因、不要改用其他人的令牌。' +
        '仅在用户明确说"撤销授权"、"取消授权"、"退出登录"、"清除授权"时调用 revoke。' +
        '不需要传入 user_open_id，系统自动从消息上下文获取当前用户。',
      parameters: FeishuOAuthSchema,

      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuOAuthParams;

        // Resolve identity from trace context (set in monitor.ts).
        const ticket = getTicket();
        const senderOpenId = ticket?.senderOpenId;
        if (!senderOpenId) {
          return json({
            error: '无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。',
          });
        }

        // Use the accountId from LarkTicket to resolve the correct account
        // (important for multi-account setups like prod + boe).
        const acct = getLarkAccount(cfg, ticket.accountId);
        if (!acct.configured) {
          return json({
            error: `账号 ${ticket.accountId} 缺少 appId 或 appSecret 配置`,
          });
        }
        const account = acct; // Now we know it's ConfiguredLarkAccount

        try {
          switch (p.action) {
            // DSH-PATCH(2026-11-03, 三次修正): 按「能力域」授权，不是逐条补。
            //
            // 演进过程（三次都在同一处）：
            //  ① 原实现硬编码 4 个 im scope → docs/sheets/bitable 缺口永远补不上，
            //     且"已覆盖"判定会误判假成功（4ms 返回、根本不弹卡片）。
            //  ② 第一版补丁把「应用已开通全部 user scope」一次性塞给用户 →
            //     只缺多维表却被要求授权通讯录/白板/知识库，过度授权。
            //  ③ 第二版改成只补缺失的个别 scope → 用户缺多维表时只拿到 1 条权限，
            //     接着又报错再补下一条，仍需反复点，体验差。
            //
            // 最终语义（本版）：用户要的是"能用多维表格"，那就一次授予多维表格
            // 这一能力域的全部权限。因此：
            //   capability 指定能力 → 从应用已开通 user scope 里按前缀展开该能力域全部
            //                        → 减去已授权 → 一次申请
            //   scope 指定零散权限 → 按字面处理（也做差集）
            //   都不指定         → 只补 im 读消息基线
            case 'authorize': {
              const capabilityKey = String(p.capability ?? '').trim();
              const capabilityName = capabilityKey ? capabilityLabel(capabilityKey) : '';
              const requested = String(p.scope ?? '')
                .split(/\s+/)
                .filter(Boolean);

              // 1) 先取「应用已开通的 user scope」——它既用于能力域动态展开，
              //    也用于后面过滤掉未开通的 scope（避免飞书整批 400）。
              let appGranted: string[] = [];
              try {
                appGranted = await getAppGrantedScopes(
                  LarkClient.fromAccount(account).sdk,
                  account.appId,
                  'user',
                );
              } catch (e) {
                log.warn(`authorize: failed to list app user scopes: ${e}`);
              }

              // 2) 确定"目标 scope 集合"：能力域展开 > 显式 scope > im 基线
              let targetScopes: string[];
              let unknownCapability: string | undefined;
              if (capabilityKey) {
                const expanded = expandCapability(capabilityKey, appGranted);
                if (expanded === undefined) {
                  unknownCapability = capabilityKey;
                  targetScopes = [];
                } else {
                  targetScopes = expanded;
                }
              } else if (requested.length > 0) {
                targetScopes = requested;
              } else {
                targetScopes = expandCapability('im', appGranted) ?? [];
              }

              if (unknownCapability !== undefined) {
                return json({
                  error:
                    `未知能力 "${unknownCapability}"。可选值：${capabilityNames().join('、')}、all。`,
                  available: capabilityNames(),
                });
              }

              if (targetScopes.length === 0) {
                return json({
                  error: capabilityKey
                    ? `应用侧未开通「${capabilityName}」(${capabilityKey}) 的任何用户权限，无法发起授权。`
                    : '应用侧未开通任何用户权限，无法发起授权。',
                  capability: capabilityKey || undefined,
                  app_id: account.appId,
                });
              }

              // 3) 算差集：已授权的不重复索要
              const existingToken = await getStoredToken(account.appId, senderOpenId).catch(() => null);
              const grantedScopes = new Set(
                String(existingToken?.scope ?? '')
                  .split(/\s+/)
                  .filter(Boolean),
              );
              const missingScopes = targetScopes.filter((s) => !grantedScopes.has(s));

              // 全部已覆盖 → 不弹卡片，直接告知（这是真正的"无需授权"，不是假成功）。
              if (missingScopes.length === 0) {
                log.info(
                  `authorize: capability=${capabilityKey || '(im baseline)'} ` +
                    `all ${targetScopes.length} scope(s) already granted, skip`,
                );
                return json({
                  success: true,
                  message: capabilityKey
                    ? `「${capabilityName}」能力的 ${targetScopes.length} 项权限已全部授权，无需重复授权。`
                    : '所需权限已全部授权，无需重复授权。',
                  authorized: true,
                  capability: capabilityKey || undefined,
                  capability_label: capabilityName || undefined,
                  granted_count: targetScopes.length,
                  scope: existingToken?.scope,
                });
              }

              // 4) 只对「应用确实开通且支持 user 身份」的 scope 发起授权。
              //    这里要把两种"被跳过"分开说清楚，否则会把高敏感拦截误报成"应用未开通"：
              //      · appNotOpened —— 应用侧压根没开这条权限（需管理员去开放平台）
              //      · sensitiveSkipped —— 应用开了、但属于高敏感，按策略不主动索要
              const appGrantedSet = new Set(filterSensitiveScopes(appGranted));
              const requestable =
                appGranted.length > 0
                  ? missingScopes.filter((s) => appGrantedSet.has(s))
                  : missingScopes; // 查不到应用权限时不预筛，交给服务端判定
              const appNotOpened = missingScopes.filter((s) => !appGranted.includes(s));
              const sensitiveSkipped = missingScopes.filter(
                (s) => appGranted.includes(s) && !appGrantedSet.has(s),
              );
              if (appNotOpened.length > 0) {
                log.warn(
                  `authorize: capability=${capabilityKey || '(im baseline)'} ` +
                    `app has not opened these scopes, skipped: [${appNotOpened.join(', ')}]`,
                );
              }
              if (sensitiveSkipped.length > 0) {
                log.info(
                  `authorize: capability=${capabilityKey || '(im baseline)'} ` +
                    `high-sensitive scopes not requested automatically: [${sensitiveSkipped.join(', ')}]`,
                );
              }

              const scope = requestable.join(' ');
              log.info(
                `authorize: capability=${capabilityKey || '(im baseline)'}` +
                  (capabilityName ? `(${capabilityName})` : '') +
                  ` domain=${targetScopes.length} granted=${targetScopes.length - missingScopes.length}` +
                  ` missing=${missingScopes.length} requesting=${requestable.length}` +
                  (sensitiveSkipped.length > 0 ? ` sensitive_skipped=${sensitiveSkipped.length}` : ''),
              );
              if (requestable.length === 0) {
                const reasons: string[] = [];
                if (appNotOpened.length > 0) {
                  reasons.push(`应用侧未开通：${appNotOpened.join('、')}（需管理员在开放平台开通并发布版本）`);
                }
                if (sensitiveSkipped.length > 0) {
                  reasons.push(
                    `属高敏感权限、不主动索要：${sensitiveSkipped.join('、')}（如确需，请明确告知要单独授权）`,
                  );
                }
                return json({
                  error: `「${capabilityName || '目标'}」没有可发起的用户授权：\n- ${reasons.join('\n- ')}`,
                  capability: capabilityKey || undefined,
                  app_not_opened: appNotOpened.length > 0 ? appNotOpened : undefined,
                  sensitive_skipped: sensitiveSkipped.length > 0 ? sensitiveSkipped : undefined,
                  app_id: account.appId,
                });
              }
              return await executeAuthorize({
                account,
                senderOpenId,
                scope,
                isBatchAuth: false,
                capability: capabilityKey || undefined,
                cfg,
                ticket,
              });
            }

            // ---------------------------------------------------------------
            // STATUS
            // ---------------------------------------------------------------
            // case "status": {
            //   const status = await getUATStatus(account.appId, senderOpenId);
            //   return json({
            //     authorized: status.authorized,
            //     scope: status.scope,
            //     token_status: status.tokenStatus,
            //     granted_at: status.grantedAt
            //       ? new Date(status.grantedAt).toISOString()
            //       : undefined,
            //     expires_at: status.expiresAt
            //       ? new Date(status.expiresAt).toISOString()
            //       : undefined,
            //   });
            // }

            // ---------------------------------------------------------------
            // REVOKE
            // ---------------------------------------------------------------
            case 'revoke': {
              await revokeUAT(account.appId, senderOpenId);
              return json({ success: true, message: '用户授权已撤销。' });
            }

            default:
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return json({ error: `未知操作: ${(p as any).action}` });
          }
        } catch (err) {
          log.error(`${p.action} failed: ${err}`);
          return json({ error: formatLarkError(err) });
        }
      },
    },
    { name: 'feishu_oauth' },
  );

  api.logger.debug?.('feishu_oauth: Registered feishu_oauth tool');
}

// ---------------------------------------------------------------------------
// Shared authorize logic (used by both feishu_oauth and feishu_oauth_batch_auth)
// ---------------------------------------------------------------------------

export interface ExecuteAuthorizeParams {
  account: ConfiguredLarkAccount;
  senderOpenId: string;
  scope: string;
  // DSH-PATCH(2026-11-03): 能力域名（bitable/sheet/...）。卡片与返回结果据此
  // 说明"这次授的是哪个能力域"，避免用户看到一长串 scope 名不知所云。
  capability?: string;
  isBatchAuth?: boolean;
  totalAppScopes?: number;
  alreadyGranted?: number;
  batchInfo?: string; // 分批授权提示信息
  skipSyntheticMessage?: boolean; // true 时跳过合成消息发送（onboarding 场景）
  showBatchAuthHint?: boolean; // true 时在授权卡片底部展示"授予所有用户权限"提示（仅 auto-auth 流程）
  forceAuth?: boolean; // true 时跳过本地 token 缓存检查，强制发起新 Device Flow（AppScopeMissing 场景专用）
  onAuthComplete?: () => void | Promise<void>; // 授权完成回调（用于批量授权链式触发）
  cfg: ClawdbotConfig;
  ticket: LarkTicket | undefined;
}

/**
 * 执行 OAuth 授权流程（Device Flow）
 * 可被 feishu_oauth 和 feishu_oauth_batch_auth 共享调用
 */
export async function executeAuthorize(
  params: ExecuteAuthorizeParams,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
  const {
    account,
    senderOpenId,
    scope,
    capability,
    isBatchAuth,
    totalAppScopes,
    alreadyGranted,
    batchInfo,
    skipSyntheticMessage,
    showBatchAuthHint,
    forceAuth,
    onAuthComplete,
    cfg,
    ticket,
  } = params;
  const { appId, appSecret, brand, accountId } = account;

  // Tool exposure is not a claim of tenant eligibility. Feishu decides whether
  // this sender can authorize; tokens remain bound to that exact sender.

  // effectiveScope：可变 scope 变量，后续可能因 pendingFlow 合并而扩大
  let effectiveScope = scope;

  // 1. Check if user already authorised + scope coverage.
  // forceAuth=true 时跳过缓存检查，直接发起新 Device Flow。
  // 用于 AppScopeMissing 场景：应用权限刚被移除再补回，本地 UAT 缓存的 scope 状态不可信。
  const existing = forceAuth ? null : await getStoredToken(appId, senderOpenId);
  if (existing && tokenStatus(existing) !== 'expired') {
    // 如果请求了特定 scope，检查是否已覆盖
    if (effectiveScope) {
      const requestedScopes = effectiveScope.split(/\s+/).filter(Boolean);
      const grantedScopes = new Set((existing.scope ?? '').split(/\s+/).filter(Boolean));
      const missingScopes = requestedScopes.filter((s) => !grantedScopes.has(s));

      if (missingScopes.length > 0) {
        // scope 不足 → 继续走 Device Flow（飞书 OAuth 是增量授权）
        log.info(`existing token missing scopes [${missingScopes.join(', ')}], starting incremental auth`);
        // 不 revoke 旧 token，直接用缺失的 scope 发起新 Device Flow
        // 飞书会累积授权，新 token 包含旧 + 新 scope
        // 继续执行下面的 Device Flow 逻辑
      } else {
        if (onAuthComplete) {
          try {
            await onAuthComplete();
          } catch (e) {
            log.warn(`onAuthComplete failed: ${e}`);
          }
        }
        return json({
          success: true,
          message: '用户已授权，scope 已覆盖。',
          authorized: true,
          scope: existing.scope,
        });
      }
    } else {
      if (onAuthComplete) {
        try {
          await onAuthComplete();
        } catch (e) {
          log.warn(`onAuthComplete failed: ${e}`);
        }
      }
      return json({
        success: true,
        message: '用户已授权，无需重复授权。',
        authorized: true,
        scope: existing!.scope,
      });
    }
  }

  // 2. Guard against duplicate in-flight flows for this user.
  const flowKey = `${appId}:${senderOpenId}`;
  let reuseCardId: string | undefined;
  let reuseSeq = 0;

  if (pendingFlows.has(flowKey)) {
    const oldFlow = pendingFlows.get(flowKey)!;
    const currentMessageId = ticket?.messageId ?? '';

    if (oldFlow.messageId === currentMessageId) {
      // 同一轮工具调用（messageId 相同）→ 复用旧卡片
      oldFlow.superseded = true;
      oldFlow.controller.abort();
      reuseCardId = oldFlow.cardId;
      reuseSeq = oldFlow.sequence;
      pendingFlows.delete(flowKey);

      // scope 合并：将旧 flow 的 scope 与新请求合并
      if (oldFlow.scope) {
        const oldScopes = oldFlow.scope.split(/\s+/).filter(Boolean);
        const newScopes = effectiveScope?.split(/\s+/).filter(Boolean) ?? [];
        const merged = new Set([...oldScopes, ...newScopes]);
        effectiveScope = [...merged].join(' ');
        log.info(`scope merge on reuse: [${[...merged].join(', ')}]`);
      }

      log.info(`same message, replacing flow for user=${senderOpenId}, app=${appId}, reusing cardId=${reuseCardId}`);
    } else {
      // 新对话（messageId 不同）→ 取消旧流 + 旧卡片标记"授权未完成" + 创建新卡片
      oldFlow.superseded = true;
      oldFlow.controller.abort();
      pendingFlows.delete(flowKey);
      log.info(`new message, cancelling old flow for user=${senderOpenId}, app=${appId}, old cardId=${oldFlow.cardId}`);
      // 标记旧卡片为"授权未完成"
      try {
        await updateCardKitCardForAuth({
          cfg,
          cardId: oldFlow.cardId,
          card: buildAuthFailedCard('新的授权请求已发起'),
          sequence: oldFlow.sequence + 1,
          accountId,
        });
      } catch (e) {
        log.warn(`failed to update old card to expired: ${e}`);
      }
      // reuseCardId 保持 undefined，后续会创建新卡片
    }
  }

  // 2.5 应用 scope 预检：过滤掉应用未开通的 scope
  let filteredScope = effectiveScope;
  let unavailableScopes: string[] = [];

  if (effectiveScope) {
    try {
      const sdk = LarkClient.fromAccount(account).sdk;
      const requestedScopes = effectiveScope.split(/\s+/).filter(Boolean);
      const appScopes = await getAppGrantedScopes(sdk, appId, 'user');

      const availableScopes = requestedScopes.filter((s) => appScopes.includes(s));
      unavailableScopes = requestedScopes.filter((s) => !appScopes.includes(s));

      if (unavailableScopes.length > 0) {
        log.info(`app has not granted scopes [${unavailableScopes.join(', ')}], filtering them out`);

        if (availableScopes.length === 0) {
          // 所有 scope 都未开通，直接返回错误
          const permissionUrl = appPermissionAuthUrl(appId, unavailableScopes, brand);
          return json({
            error: 'app_scopes_not_granted',
            message: `应用未开通任何请求的用户权限，无法发起授权。请先点击一键申请链接开通以下权限并发布版本：\n${unavailableScopes.map((s) => `- ${s}`).join('\n')}\n\n一键申请地址：${permissionUrl}`,
            unavailable_scopes: unavailableScopes,
            app_permission_url: permissionUrl,
          });
        }

        // 部分 scope 未开通，只授权已开通的 scope
        filteredScope = availableScopes.join(' ');
        log.info(`proceeding with available scopes [${availableScopes.join(', ')}]`);
      }
    } catch (err) {
      // 如果 scope 检查失败，记录日志但继续执行（降级处理）
      log.warn(`failed to check app scopes, proceeding anyway: ${err}`);
    }
  }

  // 3. Request device authorisation.
  const deviceAuth = await requestDeviceAuthorization({
    appId,
    appSecret,
    brand,
    scope: filteredScope,
  });

  // 4. Build and send authorisation card.
  const authCard = buildAuthCard({
    verificationUriComplete: deviceAuth.verificationUriComplete,
    expiresMin: Math.round(deviceAuth.expiresIn / 60),
    scope: filteredScope, // 使用过滤后的 scope
    capabilityLabel: capability ? capabilityLabel(capability) : undefined,
    isBatchAuth,
    totalAppScopes,
    alreadyGranted,
    batchInfo,
    filteredScopes: unavailableScopes.length > 0 ? unavailableScopes : undefined,
    appId,
    showBatchAuthHint,
    brand,
  });

  let cardId: string;
  let seq: number;
  const chatId = ticket?.chatId;
  if (!chatId || !ticket) {
    return json({ error: '无法确定发送目标' });
  }

  if (reuseCardId) {
    // 复用旧卡片：原地更新内容（scope + 授权链接），不创建新卡片
    const newSeq = reuseSeq + 1;
    try {
      await updateCardKitCardForAuth({
        cfg,
        cardId: reuseCardId,
        card: authCard,
        sequence: newSeq,
        accountId,
      });
      log.info(`updated existing card ${reuseCardId} with merged scopes, seq=${newSeq}`);
    } catch (err) {
      log.warn(`failed to update existing card, creating new one: ${err}`);
      // 降级：创建新卡片
      const newCardId = await createCardEntity({ cfg, card: authCard, accountId });
      if (!newCardId) return json({ error: '创建授权卡片失败' });
      if (chatId) {
        await sendCardByCardId({
          cfg,
          to: chatId,
          cardId: newCardId,
          replyToMessageId: ticket?.messageId?.startsWith('om_') ? ticket.messageId : undefined,
          replyInThread: Boolean(ticket?.threadId),
          accountId,
        });
      }
      cardId = newCardId;
      seq = 1;
      reuseCardId = undefined;
    }
    if (reuseCardId) {
      cardId = reuseCardId;
      seq = newSeq;
    } else {
      cardId = cardId!;
      seq = seq!;
    }
  } else {
    // 首次创建卡片
    const newCardId = await createCardEntity({ cfg, card: authCard, accountId });
    if (!newCardId) {
      return json({ error: '创建授权卡片失败' });
    }

    await sendCardByCardId({
      cfg,
      to: chatId,
      cardId: newCardId,
      replyToMessageId: ticket?.messageId?.startsWith('om_') ? ticket.messageId : undefined,
      replyInThread: Boolean(ticket?.threadId),
      accountId,
    });

    cardId = newCardId;
    seq = 1;
  }

  // 7. Start background polling.
  const abortController = new AbortController();

  const currentFlow: PendingFlow = {
    controller: abortController,
    cardId,
    sequence: seq,
    messageId: ticket?.messageId ?? '',
    superseded: false,
    scope: effectiveScope,
  };
  pendingFlows.set(flowKey, currentFlow);
  let pendingFlowDelete = false;
  // Fire-and-forget – polling happens asynchronously.
  pollDeviceToken({
    appId,
    appSecret,
    brand,
    deviceCode: deviceAuth.deviceCode,
    interval: deviceAuth.interval,
    expiresIn: deviceAuth.expiresIn,
    signal: abortController.signal,
  })
    .then(async (result) => {
      // 被新流替换后，跳过所有卡片更新，避免覆盖新流的卡片内容
      if (currentFlow.superseded) {
        log.info(`flow superseded, skipping card update for cardId=${cardId}`);
        return;
      }
      if (result.ok) {
        // ===== 身份校验：验证实际授权用户与发起人一致 =====
        const identity = await verifyTokenIdentity(brand, result.token.accessToken, senderOpenId);
        if (!identity.valid) {
          log.warn(
            `identity mismatch! expected=${senderOpenId}, ` +
              `actual=${identity.actualOpenId ?? 'unknown'}, cardId=${cardId}`,
          );
          try {
            await updateCardKitCardForAuth({
              cfg,
              cardId,
              card: buildAuthIdentityMismatchCard(brand),
              sequence: ++seq,
              accountId,
            });
          } catch (e) {
            log.warn(`failed to update card for identity mismatch: ${e}`);
          }
          pendingFlows.delete(flowKey);
          pendingFlowDelete = true;
          return;
        }
        // ===== 身份校验通过，继续保存 token =====

        // Save token to Keychain.
        const now = Date.now();
        const storedToken: StoredUAToken = {
          userOpenId: senderOpenId,
          appId,
          accessToken: result.token.accessToken,
          refreshToken: result.token.refreshToken,
          expiresAt: now + result.token.expiresIn * 1000,
          refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
          scope: result.token.scope,
          grantedAt: now,
        };
        await setStoredToken(storedToken);

        // 1. Update card → success immediately so user sees
        //    visual confirmation right away.
        try {
          await updateCardKitCardForAuth({
            cfg,
            cardId,
            card: buildAuthSuccessCard(brand),
            sequence: ++seq,
            accountId,
          });
        } catch (e) {
          log.warn(`failed to update card to success: ${e}`);
        }
        // 删除 pending flow
        pendingFlows.delete(flowKey);
        pendingFlowDelete = true;

        // 2. Send synthetic message to notify AI that auth is
        //    complete, so it can automatically retry the operation.
        //    Skip when called from onboarding (no AI context to retry).
        // 调用 onAuthComplete 回调（用于 onboarding 批量授权链式触发）
        if (onAuthComplete) {
          try {
            await onAuthComplete();
          } catch (e) {
            log.warn(`onAuthComplete failed: ${e}`);
          }
        }

        if (skipSyntheticMessage) {
          log.info('skipSyntheticMessage=true, skipping synthetic message');
        } else
          try {
            const syntheticMsgId = `${ticket.messageId}:auth-complete`;

            // Provide a minimal runtime so reply-dispatcher
            // does not crash on `params.runtime.log?.()`.
            const syntheticRuntime = {
              log: (msg: string) => log.info(msg),
              error: (msg: string) => log.error(msg),
            };

            const status = await dispatchSyntheticTextMessage({
              cfg,
              accountId,
              chatId,
              senderOpenId,
              text: '我已完成飞书账号授权，请继续执行之前的操作。',
              syntheticMessageId: syntheticMsgId,
              replyToMessageId: ticket.messageId,
              chatType: ticket.chatType,
              threadId: ticket.threadId,
              runtime: syntheticRuntime,
            });
            log.info(`synthetic message queued (${status})`);
            log.info('synthetic message dispatched after successful auth');
          } catch (e) {
            log.warn(`failed to send synthetic message after auth: ${e}`);
          }
      } else {
        // Update card → failure.
        try {
          await updateCardKitCardForAuth({
            cfg,
            cardId,
            card: buildAuthFailedCard(result.message),
            sequence: ++seq,
            accountId,
          });
        } catch (e) {
          log.warn(`failed to update card to failure: ${e}`);
        }
        // 删除 pending flow
        pendingFlows.delete(flowKey);
        pendingFlowDelete = true;
      }
    })
    .catch((err) => {
      log.error(`polling error: ${err}`);
    })
    .finally(() => {
      if (!pendingFlowDelete) {
        // 只在当前 flow 仍是注册的那个时才删除，避免旧流误删新流的 entry
        if (pendingFlows.get(flowKey) === currentFlow) {
          pendingFlows.delete(flowKey);
        }
      }
    });

  const scopeCount = filteredScope.split(/\s+/).filter(Boolean).length;
  const capabilityName = capability ? capabilityLabel(capability) : '';
  let message = isBatchAuth
    ? `已发送批量授权请求卡片，共需授权 ${scopeCount} 个权限。请在卡片中完成授权。`
    : capability
      ? `已发送「${capabilityName}」授权卡片，共 ${scopeCount} 项权限，一次补齐。请在卡片中点击链接完成授权，之后重新执行之前的操作即可。`
      : '已发送授权请求卡片，请用户在卡片中点击链接完成授权。授权完成后请重新执行之前的操作。';

  if (batchInfo) {
    message += batchInfo;
  }

  // 如果有被过滤的 scope，添加提示信息
  if (unavailableScopes.length > 0) {
    const permissionUrl = appPermissionAuthUrl(appId, unavailableScopes, brand);
    message += `\n\n⚠️ **注意**：以下权限因应用未开通而被跳过。请先点击一键申请链接开通并发布版本：\n${unavailableScopes.map((s) => `- ${s}`).join('\n')}\n\n一键申请地址：${permissionUrl}`;
  }

  return json({
    success: true,
    message,
    awaiting_authorization: true,
    capability: capability || undefined,
    capability_label: capabilityName || undefined,
    scope_count: scopeCount,
    scopes: filteredScope.split(/\s+/).filter(Boolean),
    filtered_scopes: unavailableScopes.length > 0 ? unavailableScopes : undefined,
    app_permission_url: unavailableScopes.length > 0 ? appPermissionAuthUrl(appId, unavailableScopes, brand) : undefined,
  });
}
