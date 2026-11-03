/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_oauth_batch_auth tool — 批量授权应用已开通的所有用户权限。
 *
 * 自动识别应用已开通但用户未授权的 scope，一次性发起授权请求。
 * 复用 oauth.ts 的 executeAuthorize() 函数。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { getAppGrantedScopes } from '../core/app-scope-checker';
import { appPermissionAuthUrl } from '../core/app-auth-url';
import { AppScopeCheckFailedError } from '../core/tool-client';
import { getStoredToken } from '../core/token-store';
import { getLarkAccount } from '../core/accounts';
import { getTicket } from '../core/lark-ticket';
import { LarkClient } from '../core/lark-client';
import { formatLarkError } from '../core/api-error';
import { filterSensitiveScopes } from '../core/tool-scopes';
import { larkLogger } from '../core/lark-logger';
import { json, registerTool } from './oapi/helpers';
import { executeAuthorize } from './oauth';

const log = larkLogger('tools/oauth-batch-auth');

const FeishuOAuthBatchAuthSchema = Type.Object(
  {},
  {
    // DSH-PATCH(2026-11-03): 原描述写"禁止主动推荐此工具，仅在用户明确要求时使用"，
    // 导致模型只在用户喊"授权所有权限"时才走批量入口，其余场景一律退回
    // feishu_oauth(action=authorize) 的固定 4 个 im scope → 表现为"每次只开一个权限、
    // 反复弹卡片"，体验极差。改为：缺权限时首选本工具，一次补全所有缺失 scope。
    description:
      '飞书批量授权工具。一次性授权应用已开通的所有用户权限（User Access Token scope）。' +
      '【首选场景】任何工具提示缺少用户权限/未授权时，优先用本工具一次性补全，' +
      "不要用 feishu_oauth 一个个补。用户说'授权所有权限'、'一次性授权完成'时也用它。",
  },
);

export function registerFeishuOAuthBatchAuthTool(api: OpenClawPluginApi): void {
  if (!api.config) return;

  const cfg = api.config;

  registerTool(
    api,
    {
      name: 'feishu_oauth_batch_auth',
      label: 'Feishu: OAuth Batch Authorization',
      description:
        '飞书批量授权工具，一次性授权应用已开通的所有用户权限。' +
        '缺少用户权限时的首选入口：一次补全全部缺失 scope，避免反复弹卡片逐个授权。' +
        "用户说'授权所有权限'、'一次性授权'时也用它。",
      parameters: FeishuOAuthBatchAuthSchema,

      async execute(_toolCallId: string, _params: unknown) {
        try {
          const ticket = getTicket();
          const senderOpenId = ticket?.senderOpenId;
          if (!senderOpenId) {
            return json({
              error: '无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。',
            });
          }

          const acct = getLarkAccount(cfg, ticket.accountId);
          if (!acct.configured) {
            return json({
              error: `账号 ${ticket.accountId} 缺少 appId 或 appSecret 配置`,
            });
          }
          const account = acct; // Now we know it's ConfiguredLarkAccount
          const { appId } = account;

          // 1. 查询应用已开通的 user scope
          const sdk = LarkClient.fromAccount(account).sdk;
          let appScopes: string[];
          try {
            appScopes = await getAppGrantedScopes(sdk, appId, 'user');
          } catch (err) {
            if (err instanceof AppScopeCheckFailedError) {
              return json({
                error: 'app_scope_check_failed',
                message:
                  `应用缺少核心权限 application:application:self_manage，无法查询可授权 scope 列表。\n\n` +
                  `请管理员在飞书开放平台开通此权限后重试。`,
                permission_link: appPermissionAuthUrl(appId, ['application:application:self_manage'], account.brand),
                app_id: appId,
              });
            }
            throw err;
          }

          // 2. 边界情况：应用无 user scope
          if (appScopes.length === 0) {
            return json({
              success: false,
              message:
                '当前应用未开通任何用户级权限（User Access Token scope），' +
                '无法使用用户身份调用 API。\n\n' +
                '如需使用用户级功能，请联系管理员在开放平台开通相关权限。',
              total_app_scopes: 0,
              app_id: appId,
            });
          }

          // 3. 过滤掉敏感 scope
          appScopes = filterSensitiveScopes(appScopes);

          // 4. 查询用户已授权的 scope
          const existing = await getStoredToken(appId, senderOpenId);
          const grantedScopes = new Set(existing?.scope?.split(/\s+/).filter(Boolean) ?? []);

          // 5. 计算差集（应用已开通但用户未授权）
          const missingScopes = appScopes.filter((s) => !grantedScopes.has(s));
          // 6. 边界情况：用户已授权所有 scope
          if (missingScopes.length === 0) {
            return json({
              success: true,
              message: `您已授权所有可用权限（共 ${appScopes.length} 个），无需重复授权。`,
              total_app_scopes: appScopes.length,
              already_granted: appScopes.length,
              missing: 0,
            });
          }

          // 7. 飞书限制：单次最多请求 100 个 scope
          const MAX_SCOPES_PER_BATCH = 100;
          let scopesToAuthorize = missingScopes;
          let batchInfo = '';

          if (missingScopes.length > MAX_SCOPES_PER_BATCH) {
            // 分批授权：取前 50 个
            scopesToAuthorize = missingScopes.slice(0, MAX_SCOPES_PER_BATCH);
            const remainingCount = missingScopes.length - MAX_SCOPES_PER_BATCH;
            batchInfo =
              `\n\n由于飞书限制（单次最多 ${MAX_SCOPES_PER_BATCH} 个 scope），` +
              `本次将授权前 ${MAX_SCOPES_PER_BATCH} 个权限。\n` +
              `授权完成后，还需授权剩余 ${remainingCount} 个权限`;
          }

          // 8. 调用共享的 executeAuthorize() 函数（复用 oauth.ts 逻辑）
          const alreadyGrantedScopes = appScopes.filter((s) => grantedScopes.has(s));
          log.info(
            `scope check: total=${appScopes.length}, granted=${alreadyGrantedScopes.length}, missing=${missingScopes.length}`,
          );
          const scope = scopesToAuthorize.join(' ');
          const result = await executeAuthorize({
            account,
            senderOpenId,
            scope,
            // DSH-PATCH(2026-11-03): 批量入口语义就是"全部能力"，
            // 传给 executeAuthorize 让授权卡片与返回结果也按能力说明。
            capability: 'all',
            isBatchAuth: true,
            totalAppScopes: appScopes.length,
            alreadyGranted: alreadyGrantedScopes.length,
            batchInfo,
            cfg,
            ticket,
          });

          // 9. 如果是分批授权，在返回结果中添加提示
          if (batchInfo && result.details) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = result.details as any;
            if (details.message) {
              details.message = details.message + batchInfo;
            }
          }

          return result;
        } catch (err) {
          api.logger.error?.(`feishu_oauth_batch_auth: ${err}`);
          return json({ error: formatLarkError(err) });
        }
      },
    },
    { name: 'feishu_oauth_batch_auth' },
  );

  api.logger.debug?.('feishu_oauth_batch_auth: Registered feishu_oauth_batch_auth tool');
}
