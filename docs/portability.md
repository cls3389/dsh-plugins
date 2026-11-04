# 插件跨平台可移植性清单

> 2026-11-05 由 yoga27（Windows 桌面版）装机实测沉淀。每一条都是当晚真实踩到的坑，不是理论推演。
> 背景：市场插件在 baiying（Linux 宿主）开发运行，桌面版（Windows + npm 全局 + link: 挂载）是第二个运行平台。

## 1. import 禁止绝对路径（最高优先级）

`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/...` 在 Windows 被 Node 解析成 `C:\usr\lib\...` → 启动即 ERR_MODULE_NOT_FOUND。stale-process-pruner v1.1.0/1.1.1 就这么炸的（v1.1.2 修复）。

正解（v1.1.2 模式，已验证双平台）：

```js
async function importDshInternal(sub) {
  const spec = `@deepseek-ai/${sub}`;
  try { return await import(spec); } catch { /* dsh-app-boot 加载器解析裸说明符 */ }
  const roots = [
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules',            // Linux 全局（baiying）
    `${process.env.APPDATA ?? ''}\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules`, // Windows npm 全局
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',      // macOS/Linux 常规
  ];
  for (const root of roots) {
    if (!root) continue;
    try { return await import(pathToFileURL(join(root, '@deepseek-ai', sub, 'lib', 'index.js')).href); } catch {}
  }
  throw new Error(`cannot import ${spec}`);
}
```

两条路径都要验证：裸 node（跑测试）走 fallback；dsh boot 内走加载器裸说明符。

## 2. link: 挂载不安装依赖

`dsh plugin add link:<dir>`（pnpm link:）**只挂本体，不装它的 dependencies**。插件 import 自己的依赖包时：

- baiying 上可能碰巧能解析（profile 层 node_modules 有同名包、或加载器 interception 命中 entries）——这是巧合不是机制，换个 profile/机器就断。
- **跨平台稳妥解**：依赖包以实体文件放在插件目录自己的 `node_modules/` 里（dsh-memory wrapper 的 @jipika/dsh-memory 就该这样；baiying 仓库里那个 `node_modules/@jipika/` 目录是**空的**——空 @scope 目录不提供任何解析，纯粹误导排查）。
- 或在 README 明写「装完须在 profile 目录 `pnpm add <dep>`」。

## 3. pnpm 链接形态因平台而异

Linux symlink / Windows junction / hoisted 实拷，解析行为不同。别假设 `node_modules/@scope/pkg` 的形态；依赖判断用 `existsSync(join(dir,'package.json'))` 这类文件级检查。

## 4. 目标机网络不可假设

- github.com 可能 TCP 黑洞（yoga27 实测，直连 git 永远挂起且孵化僵尸 git.exe）；分发/更新备好 `tar+scp 内网直送` 通道（`--exclude=.git --exclude=node_modules`）。
- npm 官方源可能 0.1MB/s；npmmirror 实测快 24 倍（`--registry=https://registry.npmmirror.com`）。
- 自建服务跨机暴露优先用已有 0.0.0.0 监听端口（如 baiying 搜索代理 18787/18788），不要为单机需求新开暴露面。

## 5. 目标机工具链不可假设（Windows 特别篇）

- `git.exe` 可能被 AV 全系统吊死（连 `--version` 都不返回；Defender/火绒嫌疑）——部署脚本别硬依赖 git。
- cmd 陷阱：`if not exist X mkdir X & echo Y` 的 `&` 并入 if 体（X 存在时 Y 不执行）——条件块必须加括号；`echo xxx ^> file` 的 `>` 要转义；GBK 控制台输出配 `iconv -f GBK -t UTF-8`；`wsl` 输出是 UTF-16。
- ssh 恒读 **passwd 家目录**的 `~/.ssh/config`（不是 `$HOME`）；config 里 IdentityFile 用绝对路径。
- Windows 管理员用户公钥要写 `C:\ProgramData\ssh\administrators_authorized_keys` 并修 ACL（`/grant *S-1-5-32-544:F SYSTEM:F`），光写 `~/.ssh/authorized_keys` 不生效。
- 常驻服务用计划任务 onlogon + boot cmd 重定向日志；`schtasks /run` 对运行中任务无效，先 `/end`。

## 6. 配置整对象替换（重申）

profile 层覆盖插件 config 是**整体替换**：覆盖任何一个字段都要把全部必填字段抄全（session-title 的 timeoutMs、web-providers 的全部 16 个键都是这么踩的）。覆盖前先 dump 或读自带 cordis.patch.yml 拿全量。

## 7. 路径白名单要平台派生（2026-11-05 全仓扫出）

`allowedPathPrefixes: ['/tmp/', ..., '/home/']` 这类写死 POSIX 前缀的文件访问白名单，在 Windows 上会拒掉一切用户路径（C:\Users\... 不匹配任何前缀）——pdf-tools / anydoc / image-tools / officecli-tools 四件同病（f3b008c 已修）。正解：白名单加入 `tmpdir()` / `homedir()` 派生项，匹配器侧做斜杠归一（image-tools 的 `replace(/\\/g,'/')` 双侧归一是范本）。正面教材：@jipika/dsh-memory 的 shell 选择（`process.platform === 'win32'` → `%ComSpec%`，POSIX 才 zsh→$SHELL→/bin/sh 链）。

## 检查单（新插件上架前过一遍）

- [ ] index.js 零绝对路径 import（grep `^import .* from '/`）
- [ ] 依赖自持或 README 写明安装要求
- [ ] package.json 带 `dsh.bundle.patch` + locale 三件套（见 naming.md）
- [ ] 在第二平台（至少一台 Windows 或另台 Linux）真实 boot 过一次
