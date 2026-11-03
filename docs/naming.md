# 插件命名规范与整理方案

> 2026-11-04 起草。现状盘点基于 29 个自研插件（`plugins/` 全量）+ 各 profile 实际挂载。
> **执行状态：第 1/2 批已于 2026-11-04 落地**（10 个目录/包改名 + 通道件自 id 对齐，六 profile dump 全绿，五服务已重启核验）。第 0 批文档部分随本批完成；第 3 批缓行，zread 待定。
> 备份：仓库 tarball `/data/dsh/backups/dsh-plugins-pre-rename-20261104-0055.tar.gz`；各 profile patch/package.json 留有 `.bak-rename-20261104`。

## 一、现状：一个插件最多三个名字

| 层 | 位置 | 例 |
|---|---|---|
| 源码目录名 | `plugins/<dir>/` | `feishu-group-reader` |
| 包名 | package.json `name` | `@dsh-friends/feishu-messages` |
| 挂载 id | profile 挂载声明（patch `- id:` 或 plugin-manager 安装态） | `feishu-messages` |

三层名应一致，现状存在漂移（见问题清单 1）。

## 二、全量盘点（按层分类）

### L1 基础设施（Claw 基座）

| 目录 | 包名 | 挂载 id | 角色 | 问题 |
|---|---|---|---|---|
| model-catalog | @dsh-friends/model-catalog | model-catalog | 模型目录+自动发现 | — |
| model-config | @dsh-friends/model-config | （未挂载，skill 驱动） | 模型路由审计与提案引擎（只读、提案经用户确认后落盘；由 skill dsh-openrouter-model-config 调用）；model-catalog 接管路由后已边缘化 | — |
| dsh-memory | @dsh-friends/dsh-memory | dsh-memory | 长期记忆 | ⚠️ dsh- 前缀撞官方 |
| execution-sandbox | @dsh-friends/execution-sandbox | guests（ctx.sandbox provider） | Docker ctx.sandbox provider（OpenClaw 模式：持久会话容器 + docker exec，官方 bash-sandbox 之外的执行底座） | → claw-sandbox（claw- 产品域前缀） |

### L2 渠道基础设施（通道运行时）

| 目录 | 包名 | 挂载 id | 角色 | 问题 |
|---|---|---|---|---|
| feishu-channel | @dsh-friends/feishu-channel | **feishu** | 飞书通道 | ❌ id ≠ 包名 |
| feishu-principal | @dsh-friends/feishu-principal | feishu-principal | 飞书用户基座（open_id/配置/工作区/登录态/业务权限） | — |
| feishu-group-reader | @dsh-friends/feishu-messages | feishu-messages | 消息批量读取 | ❌ 目录 ≠ 包名 |
| wechat-channel | @dsh-friends/wechat-channel | **wechat** | 微信通道 | ❌ id ≠ 包名 |

> 注意：`feishu-workspaces`（Web 管理面）与 `feishu-bitable-sync`（业务应用）不属于本层，见 L6/L7。

### L3 上游域

| 目录 | 包名 | 挂载 id | 角色 | 问题 |
|---|---|---|---|---|
| ths-market | @dsh-friends/ths-market | ths-market | 同花顺·行情 | ✅ 范本 |
| ths-favorites | @dsh-friends/ths-favorites | ths-favorites | 同花顺·自选股 | ✅ |
| ths-wencai | @dsh-friends/ths-wencai | ths-wencai | 同花顺·问财 | ✅ |
| ths-signal | @dsh-friends/ths-signal | ths-signal | 同花顺·AI分时交易 | ✅ |
| ths-trade | @dsh-friends/ths-trade | ths-trade | 同花顺·交易 | ✅ |
| kimi-datasource | @dsh-friends/kimi-datasource | kimi-datasource | Kimi 数据源 | — |
| onepanel | @dsh-friends/onepanel | onepanel | 1Panel 面板运维（薄封装 1Panel API） | 引擎命名 ✓；仅挂 web=受众决策（运维只给管理员），非运行形态绑定，**不加 ui-**（见附录矩阵） |

### L4 通用工具

| 目录 | 包名 | 角色 | 问题 |
|---|---|---|---|
| asr-tools | @dsh-friends/asr-tools | 语音转写（薄封装 asr-mcp/SenseVoice） | 功能名 ✓（asr=语音识别，即功能） |
| media-tools | @dsh-friends/media-tools | 腾讯混元文生图/图生图（via CPA） | ❌ 名不副实：与 asr/音视频无关 → image-tools |
| browser-tools | @dsh-friends/browser-tools | 共享浏览器 | 功能名 ✓ |
| document-tools | @dsh-friends/document-tools | Office/EPUB/CSV 转 Markdown（薄封装 @firecrawl/anydoc） | → anydoc（引擎名即功能名：any+doc，规则 6 过线） |
| pdf-tools | @dsh-friends/pdf-tools | PDF 阅读（薄封装 clawpdf/PDFium） | 功能名 ✓；与 anydoc 按格式分立（PDF vs 其他文档）；→ clawpdf-tools 两可，见第 3 批 |
| officecli-tools | @dsh-friends/officecli-tools | Office 创建/编辑/校验 | 功能名 ✓（OfficeCLI 本身即功能） |
| zread | @dsh-friends/zread | GitHub 免克隆阅读 | ❌ 品牌名不自解释（"找 GitHub 阅读件"扫不到）→ github-reader（已发布市场，见第 3 批待定） |

> **源码核验**（2026-11-04，取自各插件入口注册名）：asr-tools=`asr_transcribe/asr_health`；
> media-tools=**仅** `image_generate/image_edit`（→image-tools 实锤）；browser-tools=12× `browser_*`；
> document-tools=**仅** `doc_to_markdown`（单工具纯壳 →anydoc 实锤）；pdf-tools=**仅** `pdf_read`；
> officecli-tools=`office_create/edit/validate/view`；zread=`get_repo_structure/read_file/search_doc`（注册加 `zread_` 前缀）。

### L5 运行治理（守护家族）

| 目录 | 包名 | 角色 | 问题 |
|---|---|---|---|
| dsh-keeper | @dsh-friends/dsh-keeper | 进程/服务自恢复守护 | ⚠️ dsh- 前缀撞官方；keeper 一词两用 |
| interrupted-turn-resumer | @dsh-friends/interrupted-turn-resumer | 中断回合续接 | 长句命名 |
| session-title-keeper | @dsh-friends/session-title-keeper | 会话标题增量维护 | keeper 一词两用（与 dsh-keeper） |
| idle-compaction | @dsh-friends/idle-compaction | 空闲上下文压缩 | 尾段与 compactor 家族不一致 |
| tokenjuice-compactor | @dsh-friends/tokenjuice-compactor | 命令输出压缩（tokenjuice 智能压缩） | ⚠️ 技术名不自解释 → output-compactor |

### L6 Web 管理面（运行形态绑定 Web GUI）

| 目录 | 包名 | 挂载 id | 角色 | 问题 |
|---|---|---|---|---|
| feishu-workspaces | @dsh-friends/feishu-workspaces | feishu-workspaces | Web 侧栏工作区树呈现（DSH Claw → 用户 → 身份 → 聊天），只读注册表、不参与渠道运行时 | ❌ 名有歧义：workspaces 撞 principal 的职责词，看不出 web 专用 → ui-workspaces |

> **「web 专用」两分法**：① 运行形态绑定 Web GUI 的 UI 件（本层，产出就是界面组件，名字带 `ui-`）；
> ② 只是**挂载受众**限定 web 的工具件（如 onepanel、守护家族——agent 工具，headless 可跑，
> 换个 profile 挂就能用）。②不加 `ui-` 前缀，受众记录在挂载矩阵（附录），不焊进名字。

### L7 业务应用（跨域编排）

| 目录 | 包名 | 挂载 id | 角色 | 问题 |
|---|---|---|---|---|
| feishu-bitable-sync | @dsh-friends/feishu-bitable-sync | feishu-bitable-sync | 行情→多维表同步（FQGate+同花顺数据中心 → Bitable tenant 凭据），与渠道层零依赖 | — |

## 三、问题清单（按严重度）

1. **三层名漂移**：`feishu`（id）≠ `feishu-channel`（包）；`feishu-group-reader`（目录）≠ `feishu-messages`（包）；`wechat`（id）≠ `wechat-channel`（包）。按 id 找包、按目录猜包都会踩空。
2. **dsh- 前缀撞官方**：`dsh-keeper`、`dsh-memory` 是自研件，却与官方 `@deepseek-ai/dsh-*` 系列视觉同构，新人无法从名字区分基座与自研。
3. **守护家族无词表**：`keeper` 一词两用（进程守护 vs 标题维护）；`compaction`/`compactor` 混用；`interrupted-turn-resumer` 是完整句子而非「域-角色」结构。
4. **品牌名两例两个去向**：`onepanel` 引擎名即功能名，判合规保留；`zread` 不自解释，`github-reader` 方案待定（见第 3 批）。
5. **media-tools 名不副实**：实际职责是腾讯混元文生图/图生图，与 asr-tools（语音转写）毫无重叠；"media" 让人误以为覆盖 asr/音视频处理（评审时确实被看错）→ 改名 image-tools。
6. **模型三件套语义梯度不可见**：catalog（目录+发现）/ config（策略）/ datasource（数据源）的差异只在文档里。

## 四、命名规范（新增插件立即生效）

**规则 1 · 一名制**：源码目录名 = 包名尾段 = 挂载 id。三者出现漂移时，向语义最强的那层对齐。

**规则 2 · 前缀 = 域**：`ths-`（同花顺）、`feishu-`、`wechat-`、`kimi-`。一个外部系统一个前缀；`claw-` = Claw 产品自有件/OpenClaw 移植组件（claw-sandbox）。无上游域的通用工具不加域前缀。**Web 专用 UI 件例外**：用 `ui-` 前缀，与官方 `ui-*` 家族（ui-chat/ui-theme/ui-settings-general）对齐——前缀表达的是"挂在哪"，不是数据从哪来。

**规则 3 · 尾段 = 角色**，固定词表（新增角色先登记再使用）：

| 尾段 | 含义 | 例 |
|---|---|---|
| `-channel` | IM/平台通道连接器 | feishu-channel |
| `-principal` | 身份与授权 | feishu-principal |
| `-reader` | 只读取数 | （预留；feishu-messages 现名保留，仅目录对齐） |
| `-tools` | 无状态通用工具集 | pdf-tools |
| `-datasource` | 外部数据源接入 | kimi-datasource |
| `-catalog` / `-config` | 目录/策略 | model-catalog |
| `-guard` | 进程级守护（拉活、自恢复） | ops-guard（见改名表） |
| `-keeper` | 常驻状态维护（非进程守护） | title-keeper |
| `-resumer` | 断点续接 | turn-resumer |
| `-compactor` | 上下文/输出压缩 | tokenjuice-compactor |

**规则 4 · `dsh-` 前缀专属官方**：`@deepseek-ai/dsh-*` 是 DSH 官方件命名空间，自研插件不再新增 `dsh-` 前缀。

**规则 5 · 工具名不改**：`ths_*`、`feishu_*`、`zread_*`、`memory_*`、`asr_*` 已带域前缀，是 agent 提示词、AGENTS 文档、长期记忆共同依赖的稳定接口，任何改名只到包/id 层，不穿透工具名。

**规则 6 · 名字首先是功能名**：目录/包/挂载共用的那一个名字必须功能自解释——`ls plugins/` 一眼可找（"生图的在哪"→ image-tools）。上游引擎名只有在其本身就近似功能名时才直接采用（anydoc、onepanel、asr-tools、officecli-tools）；不自解释的品牌/技术名用功能名替代（zread、tokenjuice-compactor 见对应条目）。

## 五、分批迁移方案

### 第 0 批 · 文档对齐（零风险，立即可做）

1. 本表合入 `docs/naming.md`（本文档）。
2. README.md「插件清单」按 L1–L7 分层重排、补全 29 项（当前只列了 5 项且含已退役条目）。
3. AGENTS.md 五域边界表扩展为「域 → 插件 → 工具前缀」三列。

### 第 1 批 · 挂载 id 对齐（✅ 2026-11-04 已执行）

| 改动 | profile patch | 附带 |
|---|---|---|
| `feishu` → `feishu-channel` | investment-assistant（时名 guests）/personal-investment/goutoujunshi/interview-assistant | 插件自 id 已同步改 + lib 重建 |
| `wechat` → `wechat-channel` | goutoujunshi | 同上 |

⚠️ 前置验证：确认插件运行时状态不按 mount id 存路径（若 `$DSH_HOME` 下有按 id 命名的状态目录需同步迁移）。验证通过后逐 profile 改、dump 确认、重启对应身份服务。

### 第 2 批 · 目录/包对齐 + 守护家族语义化（✅ 2026-11-04 已执行）

| 现名 | 新名 | 理由 |
|---|---|---|
| feishu-group-reader（目录） | feishu-messages（目录） | 目录对齐包名 |
| dsh-keeper | ops-guard | 去 dsh- 前缀；guard=进程守护 |
| interrupted-turn-resumer | turn-resumer | 长句 → 域-角色 |
| session-title-keeper | title-keeper | keeper 专属状态维护 |
| idle-compaction | idle-compactor | 统一 -compactor 尾段 |
| document-tools | anydoc | 引擎名即功能名（规则 6：any+doc）；⚠️ 牵动 5 profile（全员挂载） |
| media-tools | image-tools | 名不副实：实为混元文生图/图生图；⚠️ 牵动 web/guests/PI/headless 4 profile |
| feishu-workspaces | ui-workspaces | web 专用 UI 件归队官方 ui-* 家族（规则 2 例外） |
| tokenjuice-compactor | output-compactor | 功能名优先（规则 6）；仅挂 web，改名牵 web 挂载 |
| execution-sandbox | claw-sandbox | claw- 产品域前缀（规则 2）；挂载于 investment-assistant（时名 guests） |

操作模板：`git mv` 目录 → 改 package.json name → 重建 profile symlink → patch 引用更新 → AGENTS/记忆更正 → `--dump-config` 验证 → 重启受影响身份服务。

**执行实录补充（比模板多出的坑）**：①插件自带 patch 的 id 行在 `- insert:` 块内有缩进，`^- id:` 行首锚定的 sed 匹配不到，要用行尾锚定；②profile 根 `package.json` 的 `dsh.profile.bundles`+`dependencies link:` 是 bundle 清单源，必须同步改并跑 `pnpm install` 落 .pnpm 注册（手工建顶层 symlink 不入册）；③通道件改自 id 后需 tsdown 重建 lib（wechat 的 `pnpm run build` 会因 verify-deps 检查挂掉，直调 `node_modules/.bin/tsdown`）；④改名期间 guests→investment-assistant 并行进行，其 patch 曾被覆盖回退，改完必须 dump 复验；⑤output-compactor 测试失败为预存在问题（测试桩缺 `workingDirectory.ensure` API），与改名无关。

### 第 3 批 · 明确缓行（高成本，仅大版本动）

- `dsh-memory` → `memory`：涉及所有 profile 安装、AGENTS 全文、记忆条目；当前收益不足以覆盖风险。
- `pdf-tools` → `clawpdf-tools`：同为薄封装（clawpdf/PDFium），按规则 6 可改；但 pdf 是格式名、受众更直观，两可，暂不动。
- `zread` → `github-reader`：功能名优先（规则 6）下唯一遗留品牌名；已发布插件市场 + 工具名 `zread_*` 依赖，成本高，**待定**——保留品牌或改功能名二选一。

## 六、执行红线

- 每批改动独立提交、独立验证，不顺带下一批。
- 涉及 profile patch 的改动用 `DSH_HOME=/data/dsh dsh --profile <p> --dump-config` 验证（退出码 0 且能 grep 到新 id）。
- 重启只动受影响身份服务，禁动 dsh-web（除非本批目标就是 web）。
- 官方件（`@deepseek-ai/*`、`dsh-relay`）一律不在整理范围。

## 七、显示名（locale）规范（2026-11-04 补，源自 ths-wencai/wechat-channel 裸包名事故）

GUI 插件列表与市场索引的标题/描述都来自 `locale/zh.json` + `locale/en.json` 的 `meta.title` / `meta.description`（en 必填，是 `readPluginMeta` 的解析入口；顶层写 `name` 无效）。缺 locale 时 GUI 与商店一起回退生硬的原始包名。三件套缺一不可：

1. `locale/zh.json`、`locale/en.json`：`{"meta":{"title":"…","description":"…"}}`，描述顺带写清与相邻插件的域边界；
2. `package.json` `exports` 必须暴露 `"./locale/*.json": "./locale/*.json"`——exports 封闭会把这个子路径解析挡成 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被 `optionalResourcePath` 静默吞掉、直接回退包名（本次事故根因，locale 文件齐了也白搭）；
3. `package.json` `files` 加 `"locale/*.json"`，保证 npm 打包分发不丢。

`listBundles` 每次调用实时重读 locale，改完刷新页面即生效，无需重启任何服务；市场侧要重跑 `scripts/gen-index.mjs` 才进 `docs/index.json`。

## 附录 · 挂载矩阵（2026-11-04 改名落地后快照；以 `--dump-config` 实测，patch+plugin-manager 双来源）

| 挂载模式 | 插件（新名） | 说明 |
|---|---|---|
| 全员（web+4 身份） | dsh-memory、model-catalog、anydoc、pdf-tools | 基座+通用工具全员 |
| 4 身份服务（无 web） | feishu-channel、feishu-principal、idle-compactor | 渠道运行时核心 |
| web + 按需身份 | asr-tools（+IA/PI）、feishu-messages（+IA/PI）、image-tools（+IA/PI/headless）、ths-market（+IA/PI/headless）、ths-favorites（+IA/PI/headless）、ths-wencai（+IA/PI）、ths-trade（+PI/headless）、ths-signal（+PI）、officecli-tools（+PI/interview） | 域件按身份裁剪（IA=investment-assistant，PI=personal-investment） |
| 身份按需（无 web） | kimi-datasource（IA/PI） | |
| 仅 web | browser-tools、zread、onepanel、ops-guard、turn-resumer、title-keeper、ui-workspaces、output-compactor | 管理员工具箱+UI+治理 |
| 单点 | claw-sandbox（investment-assistant）、wechat-channel（goutoujunshi）、feishu-bitable-sync（personal-investment） | |
| 未挂载 | model-config | skill/CLI 驱动，无需挂载 |

官方件（`@deepseek-ai/*`、`dsh-relay` 等）不在整理范围，未列入。矩阵以各 profile `--dump-config` 为准，此表是命名讨论快照。
