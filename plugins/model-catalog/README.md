# Model Catalog

DSH 模型目录插件。在 WebUI「设置 → 模型目录」填写服务商 ID、DSH 显示名称、服务地址、API Key 和请求格式，即可发现、同步和使用模型。

支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种请求格式。目录发现独立使用 Codex `models?client_version=0.166.0` 协议，并兼容普通 OpenAI `data` 列表。自定义目录 URL 会补上 client_version（已有值则保留）。

## 使用

1. 添加服务，选择一个未被现有模型配置使用的 ID，例如 `catalog-cpa`。
2. 填写显示名称（例如 CPA 自动同步）、服务地址（例如 `http://127.0.0.1:8317/v1`）、API Key 和请求格式。
3. 点击「保存并同步」。模型会进入 DSH 选择器；每 300 秒自动刷新，可修改间隔或填 0 关闭。
4. 在模型卡片左侧拖动手柄调整顺序，顺序自动保存并在再次同步后保留；键盘用户聚焦手柄后按上/下方向键调整。点击模型的「参数」展开卡片，修改名称、窗口、输出上限、图片输入、推理档位及兼容参数，点击「保存覆盖」生效。草稿不自动提交，支持取消；「重置」恢复该模型全部远端设置。服务的编辑面板在列表上方展开并自动聚焦。

远端隐藏模型不进入目录；远端删除的模型从选择器撤下，但其覆盖保留，重新出现时仍可恢复。断网/上游错误保留最近成功目录并显示错误。请求协议不会被远端目录覆盖，目录不会决定系统提示词或 WebSocket 传输。

目录未提供窗口时默认 262144，能力输出上限默认不超过 32768。每次请求默认输出预算 12288；在模型参数中设置输出上限后该模型按覆盖值调用。推理档位来自目录，仅支持 DSH 的 off/minimal/low/medium/high/xhigh/max，none 显示为 off。

## 存储和配置

目录和覆盖保存到 `$DSH_HOME/model-catalog/catalog.json`，0600、跨进程锁、原子写入及修订号校验。此文件是插件管理的模型路由唯一来源，不修改既有 home/profile 的 llm-pi-ai 配置。默认模型和已有路由均保持原值。

API Key 保存到 DSH 凭据服务，目录状态及浏览器存储不含密钥。密钥引用按版本生成，防止切换端点时在途请求使用新端点密钥；修改服务地址需重新输入密钥。历史密钥版本保留供在途调用完成，删除端点不自动删除凭据。

完整非私密插件配置见 cordis.patch.yml：stateFile 为空采用默认路径，pollIntervalMs 控制本地共享状态检测。WebUI API 使用 DSH connection 的 owner-only 认证路由。

## 安装和测试

```sh
DSH_HOME=/path/to/dsh dsh plugin --profile web add link:/path/to/plugins/model-catalog
node --test *.test.mjs
```

包自带预构建 React 客户端，不依赖外部页面或额外服务。首次安装后重新加载实际 Web 服务并刷新当前 GUI。
