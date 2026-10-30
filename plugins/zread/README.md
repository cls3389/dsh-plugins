# @dsh-friends/zread

把智谱 Zread 的公开 GitHub 仓库阅读能力接入 DSH。插件直接通过 HTTP JSON-RPC 调用 Zread，**不依赖 MCP SDK，也不加载 `dsh-mcp-client`**。

## 工具

- `zread_search_doc`：搜索仓库文档、Issue 和 Commit。
- `zread_get_repo_structure`：查看仓库目录结构和文件列表。
- `zread_read_file`：读取指定文件的源码。

仅适用于 GitHub **公开仓库**。本地项目、私有代码、未提交修改和测试仍使用 DSH 本地工具。

## 前置条件

1. 智谱 GLM Coding Plan 套餐及可用的 Coding Plan API Key。
2. 将 Key 保存到 `$DSH_HOME/.credentials.yaml` 的 `refs` 段，不要写进插件配置：

```yaml
refs:
  Z_AI_API_KEY: your_coding_plan_api_key
```

也可通过 DSH credentials 服务设置同名引用，或使用 `Z_AI_API_KEY` 环境变量。解析顺序为 credentials 服务、本地凭据文件、环境变量。凭据在每次调用时重新解析，轮换后无需重启。

## 配置

默认配置即可使用国内智谱服务：

```yaml
- id: zread
  name: '@dsh-friends/zread'
  config:
    url: https://open.bigmodel.cn/api/mcp/zread/mcp
    apiKeyRef: Z_AI_API_KEY
    requestTimeoutMs: 120000
    maxResponseBytes: 4194304
    cacheTtlMs: 300000
    cacheMaxEntries: 100
```

国际站可将 `url` 改为 `https://api.z.ai/api/mcp/zread/mcp`。额度与计费遵循智谱 Coding Plan。

## 实现说明

- 原生注册三个 DSH 工具，无运行时 npm 依赖。
- 支持 Streamable HTTP 的 JSON/SSE 响应、MCP 会话复用、会话过期重建、调用超时和响应大小限制。
- 自动解码上游 JSON 字符串并清理 `structure`、`file_content`、`excerpt` 包装，返回可读文本。
- 成功结果默认缓存 5 分钟（LRU 最多 100 条），并发相同请求只调用一次；`cacheTtlMs: 0` 可关闭缓存。
- 不把 API Key 写入日志、工具参数或插件包。
