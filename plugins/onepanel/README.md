# @dsh-friends/onepanel

以 1Panel v2 **API 接口密钥**管理面板:计划任务、Docker 容器、应用商店应用、宿主状态,以及通用 API 调用兜底。适合"让 Agent 直接看面板状态/重启容器/改定时任务"的场景,替代裸 curl 或 SSH。

## 前置条件

1. 1Panel v2(面板设置 → API 接口):开启接口,创建 API 密钥
2. **IP 白名单**:把 DSH 宿主出口 IP/网段加进密钥白名单。注意多段用**换行**分隔,逗号无效(v2 实测)
3. DSH 宿主能访问面板端口(默认 `http://<宿主IP>:8090`)

## 配置(home 层 `~/.dsh/cordis.patch.yml` 或 profile 层)

**单服务器(向后兼容)**:

```yaml
- id: onepanel
  name: '@dsh-friends/onepanel'
  config:
    baseUrl: http://172.18.0.1:8090   # 1Panel core 地址
    apiKey: 294dxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # API 密钥(明文)
    requestTimeoutMs: 15000           # 可选,默认 15s
```

**多服务器**(推荐,所有工具带可选 `server` 参数,默认第一台):

```yaml
- id: onepanel
  name: '@dsh-friends/onepanel'
  config:
    servers:
      - name: home                   # 服务器名,工具里 server 参数用它
        baseUrl: http://192.168.1.10:8090     # 内网直连
        apiKey: xxxxx
      - name: cloud-a                # 1Panel v2,公网直连端口或 HTTPS 域名均可
        baseUrl: https://panel-a.example.com  # 域名走 HTTPS,key 不明文过公网
        apiKey: yyyyy
      - name: legacy                 # 1Panel v1 老面板
        baseUrl: http://203.0.113.10:890      # TEST-NET 示例地址
        apiBase: /api/v1             # v1 必填;v1 仅 onepanel_api 透传可用
        apiKey: zzzzz
```

配置放 home 层则 web/feishu 双 profile 共用一份。密钥不要写进本插件包的 cordis.patch.yml(发布包不带密钥)。

**serversFile 热读(免重启加服务器)**:config 里设 `serversFile: /path/servers.json`(格式 `{"servers":[{name,baseUrl,apiKey,apiBase?}]}`),插件按 mtime 缓存热读——增删服务器改文件即可,无需重启宿主。密钥文件权限建议 600,且不要放进 npm 发布(files 清单不含它)。

**多服务器注意**:
- 地址用直连 `http://IP:端口`,不要走域名安全入口/ask 门(API 不走那层)
- 每台面板各自建 API key,并把 DSH 宿主**出口 IP** 加进该 key 的白名单(多段换行分隔);家宽出口 IP 变了要同步改
- 1Panel v1(apiBase=/api/v1)仅 `onepanel_api` 透传,专用工具会明确报错;认证公式 v1/v2 不同,插件自动探测

## 工具

| 工具 | 用途 |
|---|---|
| `onepanel_status` | 宿主机实时状态:CPU/内存/负载/IO/运行时长 |
| `onepanel_containers` | 容器列表/搜索(名称/状态/镜像/端口/所属应用) |
| `onepanel_container` | 容器操作(start/stop/restart/kill/pause/unpause/remove)+ 日志(tail) |
| `onepanel_apps` | 已安装应用列表(版本/状态/可升级/端口/路径) |
| `onepanel_app` | 应用操作(start/stop/restart/sync/rebuild/reload/upgrade/delete) |
| `onepanel_cronjobs` | 计划任务列表(周期/状态/上次执行) |
| `onepanel_cronjob` | 计划任务:手动执行/启停/修改/执行记录(含失败 stderr) |
| `onepanel_api` | 通用 POST/GET 兜底(任何 `/api/v2/*`,参考面板 swagger) |

## 认证与坑(v2 实测)

- Header `1Panel-Token: md5("1panel" + apiKey + timestamp)` + `1Panel-Timestamp`(秒)
- v2 密钥有**独立** IP 白名单(不走全局设置),多段换行分隔
- cronjobs:search 必带 `orderBy`+`order`;update 的 DTO 要求 `timeout>=1`(插件自动把 0 抬 3600);改 spec 必须同时 `specCustom=true` 否则面板显示错位;records 时间参数用 RFC3339
- 容器日志走 `POST /containers/download/log`,返回纯文本非 JSON 信封
- API 修改计划任务后 agent 自动重注册,无需重启 agent

## 安全

- remove/delete/upgrade 等破坏性操作在工具描述中已标注谨慎;调用方(用户/Agent)自行把关
- 密钥明文存于 home/profile 层 patch,注意文件权限
