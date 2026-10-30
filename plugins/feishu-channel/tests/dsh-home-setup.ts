import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 进程级 DSH_HOME 隔离:身份服务基座化后 bindUserIdentity 会经
 * feishu-principal userKey 读写 $DSH_HOME/identities.json;测试绝不能
 * 碰真实环境。在所有 spec 收集/运行前重定向到临时目录,退出时清理。
 */
const previousHome = process.env.DSH_HOME;
const testHome = mkdtempSync(join(tmpdir(), 'dsh-lark-channel-home-'));
process.env.DSH_HOME = testHome;
process.on('exit', () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});
