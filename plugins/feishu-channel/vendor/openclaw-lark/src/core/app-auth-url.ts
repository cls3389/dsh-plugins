import type { LarkBrand } from './types';

/** Single source for one-click application permission requests. */
export function appPermissionAuthUrl(appId: string, scopes: string[], brand: LarkBrand = 'feishu', source = 'feishu-openclaw'): string {
  const openDomain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const unique = [...new Set(scopes.filter(Boolean))];
  return `${openDomain}/app/${appId}/auth?q=${encodeURIComponent(unique.join(','))}&op_from=${encodeURIComponent(source)}&token_type=user`;
}
