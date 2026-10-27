# @dsh-friends/feishu-workspaces

把飞书(Lark)会话按**应用**归组到只读工作区目录：读取 workspace 注册表文件（v2 格式），在 Web 工作区列表里呈现"每个飞书应用一个工作区"。

## 注册表格式

默认读取 `$DSH_HOME/lark/workspace.json`（可用 config `registryFiles` 覆盖，数组或单路径）：

```json
{ "version": 2, "appId": "cli_xxx", "appName": "我的应用", "path": "/绝对路径/工作区目录", "sessionIds": ["session-id-1"] }
```

注册表由 dsh-lark 侧维护时无需手工编辑；文件变化实时热同步（3s 轮询 + watch）。
