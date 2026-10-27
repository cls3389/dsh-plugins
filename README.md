# dsh-plugins — DSH Friends 插件市场

朋友间共享的 DSH 插件集合。本仓库既是插件源码 monorepo，也托管 **format-1 插件市场索引**，
任何人都能在 DSH Web GUI 的「插件 → 发现」页一键安装。

## 目录结构

```
dsh-plugins/
├── plugins/                  # 插件源码（每个子目录一个可安装插件）
│   ├── interrupted-turn-resumer/   # 中断任务自动续接
│   └── session-title-keeper/       # 会话标题增量维护
├── scripts/gen-index.mjs     # 索引生成脚本
├── docs/index.json           # 生成的市场索引（GitHub Pages 托管根）
└── package.json
```

## 插件清单

| 插件 | 作用 |
|---|---|
| `@dsh-friends/interrupted-turn-resumer` | DSH 进程中断恢复后自动续接未完成任务，每个轮次最多补发一次继续消息 |
| `@dsh-friends/session-title-keeper` | 定时扫描会话，把停留在 fallback 截断版或漏更新的标题用 LLM 重算写回 |

两个插件的运行时状态默认写入 `$DSH_HOME`（未设则 `~/.dsh`），无需改配置即可在
任何机器使用；如需自定义可参考各插件 README。

## 朋友如何使用（一行接入）

在 DSH Web GUI 打开 **插件 → 发现 → 管理索引源**，添加：

```
https://<github用户名>.github.io/dsh-plugins/index.json
```

之后即可浏览、搜索、点「安装」。dsh 会自动从本仓库拉取对应 commit 的插件目录、
做版本兼容检查并激活。索引更新后朋友那边会显示「有新版本」。

命令行等价方式（任选其一）：

```bash
dsh plugin --profile <name> add git+https://github.com/<github用户名>/dsh-plugins.git#<commit>&path:/plugins/<插件目录>
```

## 维护流程（发布新版本）

1. 改插件代码，**跑测试**：`npm test`（在仓库根）
2. 升 `plugins/<name>/package.json` 的 `version`
3. `git add -A && git commit -m "release: <name>@<新版本>"`
4. `node scripts/gen-index.mjs`（重新生成 docs/index.json，自动 pin 新 commit）
5. 校验 + 提交推送：
   ```bash
   node -e "…"   # 见 scripts/validate.mjs
   git add docs/index.json && git commit -m "index: <新版本>" && git push
   ```
6. GitHub Pages 自动更新（Settings → Pages → Branch: main /docs）

### 上架新插件清单

- `plugins/<name>/package.json` 必须有 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`
- `cordis.patch.yml` 只声明挂载（id + name），不放 config，避免与 profile 层冲突
- `locale/zh.json` + `locale/en.json` 必须有 `meta.title/description`（市场卡片显示名）
- `files` 字段必须包含 cordis.patch.yml（patched 安装路径解析依赖它）
- **严禁硬编码**密钥、token、内网 IP、绝对路径 —— 用 env / 配置 / 家目录回退

## 安全须知

市场索引由第三方提供（也就是本仓库）。插件安装后以你的权限运行：
安装前请确认信任来源，也欢迎先读插件源码（就在 plugins/ 下，代码即文档）。
