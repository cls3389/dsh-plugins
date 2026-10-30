# Feishu Memory（飞书用户级长期记忆）

沿用 `@jipika/dsh-memory` 的中文 bigram/英文词法检索、条目行号和凭据扫描；不调用额外模型，不读取 Web 管理员记忆。

## 数据边界

每个可信飞书 `senderOpenId` 对应：

```text
<用户工作区>/.dsh/memory/
├─ topics/<topic>.md
└─ audit.log
```

不继承管理员记忆，不跨用户搜索。群聊按当前发言人隔离；同一聊天切换用户时，工具和提示词都使用新的发言人身份。

## 工具

- `memory_search(query, limit?)`：只检索当前用户，返回主题、路径、行号和相关度。
- `memory_read(path, offset?, limit?)`：只读 `topics/<topic>.md`，按行读取，拒绝绝对路径与目录穿越。
- `memory_write({ topic, keywords, entry, mode?, line? })`：追加或就地修正当前用户的一条记忆。

条目格式：`- [YYYY-MM-DD] 可复用事实`。只记偏好、结论、坑，不记过程叙述、凭据或token。文件权限目录 `0700`、文件 `0600`，写入采用同目录临时文件原子替换，审计不复制记忆正文。

## 配置

在飞书 profile 挂载 `@dsh-friends/feishu-memory`，`workspaceRoot` 必须与飞书应用用户工作区根一致；全局 `agentToolAllow` 加 `memory_*`。

```yaml
- id: feishu-memory
  name: '@dsh-friends/feishu-memory'
  config:
    workspaceRoot: /data/dsh/home/feishu-apps/<appId>
```
