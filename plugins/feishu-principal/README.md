# Feishu Principal（飞书用户基座）

只服务于飞书渠道，不是全渠道身份系统。

提供 Cordis `feishuPrincipal` 服务：可信 `open_id` 校验、用户哈希、个人工作区与登录态路径、完整用户配置及业务连接解析。纯公共能力无需依赖；涉及用户文件、凭据、交易或后台归属的插件必须使用本基座。

`@dsh-friends/feishu-channel` 继续负责官方飞书渠道、OAuth 与文档能力；`feishu-messages` 负责批量消息读取优化。

## 工具继承

全局 `agentToolAllow` 是所有飞书用户的默认工具清单。用户未配置时完整继承；用户记录的 `tools.extra` 只追加工具，不复制整份清单：

```json
{
  "ou_...": {
    "tools": { "extra": ["feishu_fetch_doc", "custom_business_*"] }
  }
}
```

群聊同一 Agent 换发言人时按新的 `open_id` 重算工具白名单。用户配置热读。工具可见不代表获得私有账户：OAuth、交易、AI 分时、Cookie 与其他个人凭据仍必须单独配置，未配置时拒绝回退到管理员账户。

工具入口不预判用户所属企业或 App Owner；实际权限由飞书决定。失败时保留飞书原始错误（包括未在应用所在企业/可用范围），不反复授权、不猜测原因，也不借用其他用户的 OAuth。
