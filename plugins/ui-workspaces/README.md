# @dsh-friends/ui-workspaces

读取飞书 workspace 注册表（v2 格式），按真实数据目录在 Web 侧栏呈现 **DSH Claw → 用户 → 身份 → 聊天**。身份中心的 `home/users/<userId>/<agentId>/workspace` 是聊天归属依据；同步仅创建目录分组、更新自动名称和附加已列出的同目录会话，不搬动聊天文件。

用户层优先采用已知显示名，未知名称显示完整稳定 userId；身份层采用 appName。已有自定义名称保留。迁移后仅移除旧 agents 树中没有聊天且仍使用默认名称的分组注册项，保留实际目录和所有聊天。旧式非身份中心注册表继续兼容应用分组。

## 注册表格式

默认读取 `$DSH_HOME/lark/workspace.json`（可用 config `registryFiles` 覆盖，数组或单路径）：

```json
{ "version": 2, "appId": "cli_xxx", "appName": "我的应用", "path": "/绝对路径/工作区目录", "sessionIds": ["session-id-1"] }
```

注册表由 dsh-lark 侧维护时无需手工编辑；文件变化实时热同步（3s 轮询 + watch）。
