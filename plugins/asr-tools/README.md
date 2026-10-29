# @dsh-friends/asr-tools — 本地音视频转写工具

薄封装插件：把 [asr-mcp](https://dsh.s.ipto.top) 服务（宿主机 `/home/lin/workspace/ai-tools/mcp/asr-mcp`，SenseVoice int8 本地引擎）接入 DSH 工具面。

## 工具

| 工具 | 说明 |
|---|---|
| `asr_transcribe(source, language?, retranscribe?)` | 抖音整段分享文案 / 任意音视频 URL / 本地绝对路径 → 文字。返回 `text` + 标题/作者；`cached:true` 表示缓存命中秒回 |
| `asr_health()` | 服务健康检查（引擎/缓存状态） |

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: asr-tools
  name: '@dsh-friends/asr-tools'
  config:
    baseUrl: http://172.18.0.1:8410   # DSH 容器 → 宿主网关发布端口
    requestTimeoutMs: 300000          # 下载+转写整体超时
```

## 背景

- 抖音 2026-10 起对 yt-dlp 接口加签名风控（a_bogus），asr-mcp 服务端已内置共享浏览器渲染兜底，插件侧无需关心。
- 转写结果缓存在服务端 sqlite（URL/抖音 video_id/内容哈希四级命中），本插件天然受益。
