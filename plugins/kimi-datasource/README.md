# kimi-datasource（dsh 移植版）

Kimi 专业数据库精选面，源自 openclaw 扩展同名插件（`lib/` 原样复用，CJS 经 `createRequire` 加载）。

## 工具（3 个，刻意精选防上下文淹没）

- `kimi_datasource_query_stock` — 实时股价（A股/港股/美股），多代码逗号分隔自动分批
- `kimi_tyc_search` — 天眼查企业搜索（不知道全称时的兜底）
- `kimi_tyc_company` — 天眼查工商信息（固定调已验证接口）

openclaw 版其余工具族（`kimi_stock_*` 财务 12 件套、`tyc_apis`/`tyc_query` 动态接口）按需再开。

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: kimi-datasource
  name: '@dsh-friends/kimi-datasource'
  config:
    endpoints:
      - apiUrl: https://agent-gw.kimi.com/coding/v1/tools
        apiKeyRef: KIMI_DS_KEY_PRIMARY   # credentials 库或环境变量
      - apiUrl: https://api.kimi.com/coding/v1/tools
        apiKeyRef: KIMI_DS_KEY_SECONDARY
    # timeoutSeconds: 30
```

- 最多 2 个端点自动 failover（带冷却）；**内网地址（10.3.1.x）一律过滤**
- `apiKeyRef` 优先走宿主 credentials 库，退环境变量；也接受明文 `apiKey`（不推荐）
- 文件缓存放 `$DSH_HOME/cache/kimi-datasource/`（可移植，无硬编码绝对路径）
