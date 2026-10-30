import { defineConfig } from 'vitest/config';

export default defineConfig({
  // setup 文件把 DSH_HOME 重定向到临时目录:bindUserIdentity → userKey 会写
  // $DSH_HOME/identities.json,测试严禁触碰生产环境。
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['tests/dsh-home-setup.ts'],
  },
});
