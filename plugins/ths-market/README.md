# ths-market：行情与盯盘客户端

本插件负责 DSH 工具注册、可信会话身份解析和向数据中心转发。行情取数、公共缓存、共享采样和盯盘规则评估在 `dsh-data-hub`；飞书后台回复由 `feishu-channel` 负责。

## 助手与业务范围

- **投资助手**：`guests` profile，身份 `investment-assistant`；本轮验证自选、问财、行情和盯盘提醒。自选、问财分别由 `ths-favorites`、`ths-wencai` 提供。
- **自用投资助手**：`personal-investment` profile；AI 分时交易和同花顺交易是独立业务域。本次盯盘回复修复不涉及下单、撤单或信号执行。

行情工具逐次解析当前用户连接，调用中心 `POST /api/tools/market/<tool>`。公共行情和缓存跨用户共享；私有自选和问财登录态不能借用其他用户。当前非飞书身份兼容和新旧身份优先级问题仍需单独修复，不能将已通过的飞书主流程测试扩大解释为所有渠道都已通过。

## 盯盘规则与通知

- 添加：`POST /v1/rules`。
- 查询：`GET /v1/status`。
- 原位更新：`PATCH /v1/rules/:id`（工具 `ths_watch_update`），可改阈值/锚点/备注/期限/确认/冷却/oneShot，保留ID与历史，禁止改归属和标的。仅阈值/锚点变化重置拐点进度，冷却记录保留。
- 删除：`DELETE /v1/rules/:id`。
- 可选 `expiresAt` 为未来RFC3339，到期保留可查但不评估/占用watch采样。
- 状态区分 `connected`（共享源最近成功）与 `samplingReady`（全量目标新鲜）；返回计数口径、`ruleStates`（最后触发及锚点进度）和持久 `triggerHistory`（默认最近10，`history_limit` 1–200）。
- 中心还保留 `/v1/watch/*` 别名。

规则保存创建时的 `ownerOpenId`、`ownerAppId` 和 `sessionId`。查询/删除目前按 Open ID 过滤，尚未统一到身份簇或完整 app+owner 联合键。通知发送另有应用、用户、会话和聊天的联合校验。

```text
中心共享采样 → 规则命中 → 中心持久化 outbox
  → 按 ownerAppId 选择本机 /wake
  → feishuNotifications.deliver → bot 持久化通知队列
  → 聊天内串行执行 → AI 回复 → 飞书 CardKit 最终更新
```

本插件的 `watch-wake.js` 只调用正式渠道通知服务。缺少规则 ID、owner、app、session、稳定 eventId 或正文时拒绝；外层 sessionId 与规则 sessionId 冲突时也拒绝。服务未就绪会返回错误，中心保留事件重试，不直接调用任意 Agent、不覆写会话身份、不寻找其他用户的活跃会话代发。

渠道必须确认目标 app 对应唯一 bot，持久化绑定中的用户匹配 owner，且排队执行时仍属于原聊天。`/new` 后仅允许沿原聊天的 `previousSessionIds` 找到当前会话；不允许转到另一聊天。普通规则提醒不执行交易，中心拒绝 `action`；工具 schema 已移除 action，客户端也提前拒绝该字段。

## 唤醒桥配置与接口

投资助手当前使用：

```yaml
watchServiceBaseUrl: http://127.0.0.1:17896
watchServiceTokenFile: /data/dsh/.secrets/ths_data_hub_token
watchWakeBridgeEnabled: true
watchWakeBridgePort: 17922
```

桥仅监听 loopback，所有请求都检查 `Authorization: Bearer <token>`。不要公开 token 或把它当作终端用户身份凭证。

- `POST /wake`：接收 `{rule, text, sessionId, eventId}`。`200` 表示渠道已持久化接收，不表示 AI 已结束或用户已阅读。
- `POST /session-alias`：可信宿主迁移方法，接收 `{sessionId, previousSessionId, ownerOpenId, ownerAppId}`，不接受 chatId。仅在有明确历史归属证据时使用；校验目标 owner、应用和别名唯一性，并通过运行中渠道保存，避免直接改文件被旧进程覆盖。

渠道通知队列按 bot 的 dataDirectory 保存 `notifications.json`。投资助手本人 bot 对应 `/data/dsh/lark/bots/owner-investment/notifications.json`。排查读取 `records[].input.eventId`、`status`、`attempts`、`lastError`、`currentSessionId`、`card.cardMessageId`、`result`，不要在公开日志输出用户消息、会话 ID、cookie 或 token。

## 验收与部署事实

2026-11-03 已构建并仅重启 `dsh-guests`。临时 one-shot 规则真实命中，完成 AI 生成回复、目标私聊消息创建和 CardKit 最终更新 `code=0`；重复同一 eventId 未新增模型执行次数或卡片。测试规则已删除。其他身份服务本次未重启，不应据共享源码声称已加载新通知链路。

客户端测试 12 项、渠道全量 77 项、通知专项 7 项通过，构建与类型检查通过。真实结果见 [验收记录](/home/lin/workspace/market-tools/watch-reply-acceptance-result-20261103.json)。飞书 IM GET 对 CardKit 可能返回兼容占位内容，应结合消息目标、模型结果与最终 CardKit API 回执验证；API 成功不代表用户已阅读。

后台通知要求 CardKit 权限。队列支持失败退避、重启恢复和长期事件去重；本地日志与飞书并非同一原子事务，不承诺任意断电下严格 exactly-once。更完整的持久化、回执和 OAuth 限制见 [渠道文档](../feishu-channel/README.md#durable-background-notifications)，数据中心评估与 outbox 说明见 [数据中心文档](/home/lin/workspace/market-tools/ths-data-hub/README.md#盯盘触发后的飞书回复)。

## 本地回归

测试包含虚构身份解析，运行时必须使用隔离的 DSH_HOME，防止污染生产身份注册表：

```sh
DSH_HOME=$(mktemp -d /tmp/ths-market-test-XXXXXX) npm test
```

仅修改本文档无需重启服务。
