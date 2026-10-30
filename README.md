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
| `@larksuite/dsh-lark` | 官方飞书渠道:飞书里对话 DSH,/model 切模型、卡片审批(需自备飞书应用凭据) |
| `@dsh-friends/onepanel` | 1Panel 面板工具：多服务器管理计划任务、容器、应用与宿主状态，servers.json 热读免重启 |
| `@dsh-friends/session-title-keeper` | 定时扫描会话，把停留在 fallback 截断版或漏更新的标题用 LLM 重算写回 |
| `@dsh-friends/zread` | 免克隆搜索 GitHub 公开仓库文档、Issue、Commit、目录结构与源码，原生 HTTP 无 MCP 中间层 |

需要保存运行时状态的插件默认写入 `$DSH_HOME`（未设则 `~/.dsh`）；各插件的前置条件与
自定义配置见对应 README。

## 朋友如何使用（一行接入）

在 DSH Web GUI 打开 **插件 → 发现 → 管理索引源**，添加：

```
https://cls3389.github.io/dsh-plugins/index.json
```

之后即可浏览、搜索、点「安装」。dsh 会自动从本仓库拉取对应 commit 的插件目录、
做版本兼容检查并激活。索引更新后朋友那边会显示「有新版本」。

命令行等价方式（任选其一）：

```bash
dsh plugin --profile <name> add git+https://github.com/cls3389/dsh-plugins.git#<commit>&path:/plugins/<插件目录>
```

## 配置分层（重要）

- **插件层**：`plugins/<name>/cordis.patch.yml` 同时声明挂载和完整、可见、可编辑的非私密配置；需要配置的插件不能把重要选项只藏在代码默认值里。安装后按本机环境修改端点、目录和功能开关。
- **用户层**：profile 的 `cordis.patch.yml` 保存本机覆盖，凭据使用 `.credentials.yaml` refs 或环境变量，公开仓库不保存真实密钥和私有用户连接。
- **覆盖语义**：DSH 后加载的用户层会**替换整个 `config` 对象，不会逐键深合并**。二选一维护：优先直接编辑插件目录内 patch；如用外层覆盖，必须复制插件层完整配置再修改，不能只写其中一个字段并期待其余字段从插件 patch 继承。

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
- `cordis.patch.yml` 声明挂载（id + name），并列出完整可见的非私密 config；不要把必要配置只藏在代码里
- `locale/zh.json` + `locale/en.json` 必须有 `meta.title/description`（市场卡片显示名）
- `files` 字段必须包含 cordis.patch.yml（patched 安装路径解析依赖它）
- **严禁硬编码**密钥、token、内网 IP、绝对路径 —— 用 env / 配置 / 家目录回退

## 安全须知

市场索引由第三方提供（也就是本仓库）。插件安装后以你的权限运行：
安装前请确认信任来源，也欢迎先读插件源码（就在 plugins/ 下，代码即文档）。
