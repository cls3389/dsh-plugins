/**
 * feishu_oauth 按「能力域」授权的回归测试。
 *
 * 背景（2026-11-03）：用户诉求是「我需要多维表格 = 多维表格所有权限」。
 * 历次实现踩过的坑，本文件逐条锁定：
 *   ① 硬编码 4 个 im scope → 其它能力域永远补不上；
 *   ② 把应用全部 user scope 一次性塞给用户 → 过度授权；
 *   ③ 逐条补缺 → 反复弹卡片；
 *   ④ 手写静态 scope 清单写错名字（im:chat:readonly 飞书侧根本不存在）
 *      且漏项（base:field:delete / base:record:delete）。
 *
 * 现在的语义：能力域按前缀从「应用实际已开通的 user scope」动态展开，
 * 再减去用户已授权的，一次补齐。
 */

import { describe, expect, it } from 'vitest';
import { capabilityLabel, expandCapability } from '../vendor/openclaw-lark/dist/tools/oauth.js';

// 取自 cli_aa6e3dcae8f8dc11（投资助手）的真实 user scope 清单
const APP_USER_SCOPES = [
  'base:app:create',
  'base:app:update',
  'base:field:create',
  'base:field:delete',
  'base:field:read',
  'base:field:update',
  'base:record:create',
  'base:record:delete',
  'base:record:retrieve',
  'base:record:update',
  'base:table:create',
  'base:table:read',
  'base:table:update',
  'base:view:read',
  'base:view:write_only',
  'bitable:app',
  'bitable:app:readonly',
  'docx:document:create',
  'docx:document:readonly',
  'docx:document:write_only',
  'docs:document.media:upload',
  'im:chat:read',
  'im:message',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:message.send_as_user',
  'im:message:readonly',
  'offline_access',
  'sheets:spreadsheet:create',
  'sheets:spreadsheet.meta:read',
  'sheets:spreadsheet:read',
  'sheets:spreadsheet:write_only',
  'wiki:node:create',
  'wiki:node:read',
];

// 断言展开结果一定存在，失败时给出可读信息（替代非空断言）
function mustExpand(cap: string, appScopes: string[] = APP_USER_SCOPES): string[] {
  const got = expandCapability(cap, appScopes);
  expect(got, `capability=${cap} 应当被识别`).toBeDefined();
  return got as string[];
}

describe('expandCapability — 能力域动态展开', () => {
  it('bitable 展开为应用已开通的全部 base:/bitable: scope', () => {
    const got = mustExpand('bitable');

    expect(got).toHaveLength(17);
    expect(got.every((s) => s.startsWith('base:') || s.startsWith('bitable:'))).toBe(true);
    // 旧静态清单漏掉的写权限，必须包含
    expect(got).toContain('base:field:delete');
    expect(got).toContain('base:record:delete');
    expect(got).toContain('base:view:write_only');
  });

  it('绝不产出应用没开通的 scope', () => {
    const got = mustExpand('bitable');

    // 飞书侧不存在 im:chat:readonly，旧静态清单曾把它塞进请求
    expect(got).not.toContain('im:chat:readonly');
    expect(got.some((s) => s.startsWith('im:'))).toBe(false);
  });

  it('im 只取读消息相关的 im scope', () => {
    const got = mustExpand('im');

    expect(got).toEqual(
      expect.arrayContaining([
        'im:chat:read',
        'im:message:readonly',
        'im:message.group_msg:get_as_user',
      ]),
    );
    expect(got).not.toContain('im:chat:readonly');
  });

  it('all 等于应用全部 user scope', () => {
    expect(expandCapability('all', APP_USER_SCOPES)).toHaveLength(APP_USER_SCOPES.length);
    expect(new Set(expandCapability('all', APP_USER_SCOPES))).toEqual(new Set(APP_USER_SCOPES));
  });

  it('查不到应用 scope 时退回静态兜底清单', () => {
    const got = mustExpand('bitable', []);

    expect(got.length).toBeGreaterThan(10);
    expect(got).toContain('bitable:app');
    expect(got).toContain('base:record:delete');
  });

  it('未知能力返回 undefined（由调用方报错）', () => {
    expect(expandCapability('nonsense', APP_USER_SCOPES)).toBeUndefined();
  });

  it('能力名大小写与空白容错', () => {
    expect(expandCapability('  Bitable ', APP_USER_SCOPES)).toHaveLength(17);
  });
});

describe('能力域差集 — 只补缺的，且一次补齐', () => {
  it('已授权 3 项时只申请剩余 14 项', () => {
    const domain = mustExpand('bitable');
    const granted = new Set(['bitable:app', 'bitable:app:readonly', 'base:app:create']);
    const missing = domain.filter((s) => !granted.has(s));

    expect(missing).toHaveLength(14);
    expect(missing).not.toContain('bitable:app');
    // 关键：不是一条一条补，而是一次把 14 条都申请掉
    expect(missing).toContain('base:record:create');
    expect(missing).toContain('base:field:delete');
  });

  it('全部已授权时差集为空 → 不弹卡片', () => {
    const domain = mustExpand('bitable');
    const granted = new Set(domain);

    expect(domain.filter((s) => !granted.has(s))).toHaveLength(0);
  });
});

describe('capabilityLabel — 面向用户的中文名', () => {
  it('已知能力返回中文名', () => {
    expect(capabilityLabel('bitable')).toBe('多维表格');
    expect(capabilityLabel('sheet')).toBe('电子表格');
    expect(capabilityLabel('doc')).toBe('文档');
    expect(capabilityLabel('im')).toBe('群聊消息');
    expect(capabilityLabel('drive')).toBe('云盘');
    expect(capabilityLabel('wiki')).toBe('知识库');
    expect(capabilityLabel('all')).toBe('全部能力');
  });

  it('未知能力原样返回，不吞掉用户输入', () => {
    expect(capabilityLabel('whatever')).toBe('whatever');
  });
});
