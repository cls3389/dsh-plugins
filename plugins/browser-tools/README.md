# @dsh-friends/browser-tools

共享浏览器工具集（12 个工具）：抓取渲染页、截图、执行 JS、长期页面管理等。所有工具代理到一个 [browser-gateway](https://github.com/) 服务实例（Playwright 池化浏览器）。

## 前置条件：自备 browser-gateway

本插件只是网关客户端。朋友侧需要先跑起一个 browser-gateway 服务（Python/FastAPI + Playwright，Docker 部署），然后配置地址与 token：

```yaml
- id: browser-tools
  name: '@dsh-friends/browser-tools'
  config:
    baseUrl: http://browser-gateway:8088   # 你的网关地址(docker 网名或 IP)
    apiTokenRef: BROWSER_GATEWAY_TOKEN    # 凭据库里的 token 引用名
```

## token 解析顺序

1. config `apiToken`（明文，不推荐）
2. credentials 服务 `apiTokenRef` → `$DSH_HOME/.credentials.yaml` refs 段
3. `$DSH_BROWSER_TOKEN_FILE` 环境变量指到的文件
4. `$DSH_HOME/.secrets/browser_gateway_token` 覆盖文件

## 工具清单

browser_scrape / browser_run_js / browser_screenshot / browser_page_open / browser_page_goto / browser_page_click / browser_page_fill / browser_page_evaluate / browser_page_close / browser_profiles / browser_health / browser_profile_save
