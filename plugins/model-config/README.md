# @dsh-friends/model-config — 模型配置审计与提案

审计 DSH 模型列表（home 层 `cordis.patch.yml` 的 `llm-pi-ai` 段）与各端点真值源的一致性，
并生成**经用户确认后由 agent 落盘**的变更提案。插件本身**只读，永不写 YAML**。

## 工具

| 工具 | 作用 |
|---|---|
| `model_config_audit` | 按 provider 审计：cpa（OpenRouter 目录 + 策略映射）、kimi-coding 等（手工策略）；含 compat、路由默认档交集、压缩预算不变量 |
| `model_config_propose` | 对可修复项生成提案：current/proposed/理由 + 经唯一性校验的 `edit` 锚点（oldString/newString） |
| `model_config_policy` | 查看策略、约束、不变量自检 |
| `model_config_discover` | 新端点接入：拉 `{baseUrl}/models` 模型列表，匹配 OpenRouter 目录预填建议参数与路由默认档交集，供用户挑选（apiKey 仅本次请求使用，不落盘不回显） |

标准流程：`model_config_audit` → 有 mismatch 时 `model_config_propose` → 把提案展示给用户确认
→ agent 用 `edit` 工具按锚点落盘 → 复跑 `model_config_audit` + `dsh web --dump-config` 双验证。
profile 热加载，无需重启。

## 真值源

- `source: "openrouter"`：拉 `https://openrouter.ai/api/v1/models`，按 policy 的 `openrouter` 映射比对
  `contextWindow / maxTokens / input / reasoningEfforts`；目录无 `supported_efforts` 的模型标记
  `manual`（保留网关实测值，不猜等级）。
- `source: "manual"`：无机器可读目录（如 kimi-coding 官方文档），policy 记录期望值直接比对；
  增改期望值须先经用户确认并写明依据。

## 目录缓存

OpenRouter 目录带本地缓存：`$DSH_HOME/model-config/catalog-cache.json`（可用 config `catalogCachePath` 覆盖）。
TTL 默认 30 分钟（`catalogCacheTtlMs`），TTL 内所有工具直接用缓存不打网；拉取失败时自动回退旧缓存（结果里标注 `stale-cache`）；
audit/propose/discover 都支持 `forceRefresh: true` 强刷。catalogFile 离线路径不经过缓存。

## 策略文件（policy）

查找顺序：config `policyFile` → `$DSH_HOME/model-config/policy.json` → 包内 `policy.json`。
每次调用热读，改完即生效。内容包括逐模型期望值（本地窗口钳制、maxTokens 预留输出、别名映射、
视觉桥接覆盖）与全局约束。

## 前置条件

- 无密钥要求（OpenRouter models 端点公开；手工源不需要网络）。
- 被审计的 profile：默认 `$DSH_HOME/cordis.patch.yml`（home 层单一事实源），可用 config 覆盖。

## 配置示例（profile / home 层 cordis.patch.yml）

```yaml
- id: model-config
  name: '@dsh-friends/model-config'
  config:
    profilePath: /data/dsh/cordis.patch.yml   # 缺省 $DSH_HOME/cordis.patch.yml
    catalogUrl: https://openrouter.ai/api/v1/models
    policyFile: ''                             # 缺省按查找顺序
    requestTimeoutMs: 45000
```

## 护栏（代码强制）

- 只对模型块的 `contextWindow / maxTokens / input / reasoningEfforts` 生成提案；
  provider 级受保护键（`api / baseURL / apiKeyEnv / ...`）与模型集合增删**只报告不提案**。
- 拒绝提案后违反 `maxTokens + headroomTokens(65536) <= contextWindow` 的变更（防压力压缩静默失效）。
- 所有锚点经全文件唯一性校验；不唯一时明确告警，要求人工扩大上下文。
