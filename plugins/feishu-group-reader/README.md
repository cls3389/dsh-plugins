# @dsh-friends/feishu-group-reader

以**用户身份**读取飞书群聊/单聊消息（bot 不在群里也能读）。复用 openclaw-lark 官方 UAT 授权存储，与 dsh-lark 共享登录态，自动 refresh。

## 前置条件

1. 已安装并跑通 `@larksuite/dsh-lark`（或 `@dsh-friends/dsh-lark`）飞书渠道，完成过一次扫码授权（UAT 存储在 `~/.local/share/openclaw-feishu-uat/`）
2. 一个飞书开放平台应用的凭据（与渠道同一应用即可）

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: feishu-group-reader
  name: '@dsh-friends/feishu-group-reader'
  config:
    appId: cli_xxxx        # 飞书应用 ID
    appSecret: xxxx        # 飞书应用 Secret
    defaultChatId: oc_xxx  # 可选:默认群 chat_id
```

## 工具

`feishu_group_messages`：按群名/chat_id/open_id + 时间范围读消息；配合时间线任务（定时提醒）可以做到"每天早上汇总昨天的群消息"。
