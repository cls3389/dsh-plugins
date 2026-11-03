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

群聊同一 Agent 换发言人时按新的 `open_id` 重算工具白名单。用户配置热读。工具可见不代表获得私有账户：OAuth、交易、AI 分时交易、Cookie 与其他个人凭据仍必须单独配置，未配置时拒绝回退到管理员账户。

工具入口不预判用户所属企业或 App Owner；实际权限由飞书决定。失败时保留飞书原始错误（包括未在应用所在企业/可用范围），不反复授权、不猜测原因，也不借用其他用户的 OAuth。

## 身份注册表事务

`resolveIdentity`、`bindIdentity` 保持同步接口。已有身份且无需补录 union 的读取直接读取最新文件；写入操作在独占锁内重新读取和校验最新注册表，只执行本次操作，不合并进程里的旧快照。提交顺序为同目录 `0600` 临时文件 → 文件 `fsync` → 原子 `rename` → 父目录 `fsync`。`userKey` 不缓存归属，其他进程绑定后下次查询即可更新。

锁要求 Linux 本机文件系统和 `/proc`。准备好的非空 owner 目录通过原子 rename 发布到 `<identitiesFile>.lock`，owner 记录 PID、进程启动时间及 boot ID；活进程不会因锁龄被抢占。默认最多同步等待 2000ms，`lockTimeoutMs` 可在 0..30000ms 内调整；冲突超时抛出 `IDENTITY_LOCK_TIMEOUT`，不执行无锁写入。确认 owner 已退出或 PID 被重用后，只删除观察到的唯一 owner token，再尝试删除空目录，避免并发回收删除新持有者的锁。无法核验或损坏的 owner 保留并报超时。崩溃遗留的 stage 或临时文件不会被当作有效锁；实现不扫描或删除其他操作的遗留文件。

`listIdentities` 和 `readonly: true` 只读，不创建锁、目录或文件。readonly resolve/bind 允许在临时内存快照计算结果，不会保留到下一次调用。损坏 JSON、无效结构或重复身份三元组均拒绝继续，不自动修复。未知顶层字段会在正常事务中保留，绑定回调在提交成功且释放锁后触发。

并发安全要求所有写入方使用此协议；手工直接覆盖文件或仍运行旧版写入代码不受锁保护。`fsync` 在 rename 后失败时可能出现“提交已可见但返回错误”，调用方应重新读取核对。测试全程使用临时 `DSH_HOME`：

```sh
node --test test.mjs test-multiprocess.mjs
```

回归覆盖真实多子进程首次解析、不同身份并发、长期进程归属刷新、崩溃锁恢复、活锁超时、损坏注册表拒写、readonly 零写入以及 npm 打包后的隔离导入。
