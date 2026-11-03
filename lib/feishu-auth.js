/** 统一生成飞书“一键申请应用权限”链接，业务插件不得各写一套。 */
export function appPermissionAuthUrl(appId, scopes, { brand = 'feishu', source = 'dsh', tokenType = 'user' } = {}) {
  const openDomain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const list = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean))];
  return `${openDomain}/app/${appId}/auth?q=${encodeURIComponent(list.join(','))}&op_from=${encodeURIComponent(source)}&token_type=${tokenType}`;
}

export function missingAppScopeError(appId, scopes, options = {}) {
  const list = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean))];
  const authUrl = appPermissionAuthUrl(appId, list, options);
  return new Error(`飞书应用权限未开通：${list.join('、')}。\n必须直接在回复中原样展示这个一键申请链接：${authUrl}\n先完成应用权限申请并发布版本，再调用 feishu_oauth(action=authorize) 做用户授权。不要只给通用 permission 页面。`);
}
