# 插件发布性标准（写插件时即遵守，发布零改造）

> 原则：**每个新插件生来可发布**。写代码时按本标准执行，上架只是 `cp + gen-index + push`。

## 命名与结构

- 包名：`@dsh-friends/<name>`（市场 scope，不再用 `@local`）
- 目录：源码写在 `plugins/<name>/`（本仓库就是唯一源；本机 profile 用 `link:` 指进来吃狗粮）
- 必备文件：
  - `package.json`：`dsh.bundle.patch` 声明 + `exports` 含 `./package.json` + `files` 覆盖全部安装内容（含 `cordis.patch.yml`、`locale/*.json`）
  - `cordis.patch.yml`：**只声明挂载**（id + name），不放 config——机器相关配置一律进 profile patch
  - `locale/zh.json` + `locale/en.json`：`meta.title/description`（市场卡片显示名，en 必填）
  - `README.md`：功能一句话 + **朋友侧前置条件** + 配置示例

## 代码红线（可移植性）

- ❌ 硬编码绝对路径 → ✅ `join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), ...)`
- ❌ 凭据/密钥字面量 → ✅ config 引用（`apiTokenRef` → credentials 库）或 `$DSH_HOME/.secrets/` 文件，env 可覆盖
- ❌ 内网 IP / 容器名写死 → ✅ config 带合理默认（如 docker 网名），README 说明覆盖方式
- ❌ 依赖本机其它插件的数据却不声明 → ✅ `peerDependencies` + `peerDependenciesMeta.optional: true`（非 `@deepseek-ai` 的 peer 不会被 dsh 兼容性检查拦截，实测安全）

## 依赖声明约定

| 依赖类型 | 表达方式 |
|---|---|
| 数据级软依赖（如 group-reader 用 dsh-lark 的 UAT 存储） | optional peerDependencies + README 前置条件 |
| 外部服务（如 browser-tools → browser-gateway） | config baseUrl/token + README 部署说明 |
| dsh 运行时（agent/session/tools 等） | 不声明，由宿主注入（inject 数组） |

## 质量门槛

- `node --check` 过；有逻辑就配 `test-*.mjs`（`node --test`），发布前跑绿
- 发布流程：升 version → 测试 → commit → `node scripts/gen-index.mjs --repo-url https://github.com/cls3389/dsh-plugins` → `node scripts/validate.mjs` → commit 索引 → push（Pages 自动重建，朋友侧刷新即见）
- **tarball 内容变更必须 bump 版本号**（pnpm HTTP 缓存按版本缓存）

## 本机配置层（不入市场）

机器特定值（真实凭据、本机路径、业务参数）全部放 **profile 的 cordis.patch.yml**，插件默认值保持通用。参考 web profile 的 `.pre-market-migration` 备份与现行 config 段。
