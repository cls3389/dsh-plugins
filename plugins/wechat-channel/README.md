# @dsh-friends/wechat-channel

腾讯 iLink 微信消息通道（DSH 原生插件，不依赖 OpenClaw 运行时）。

上游来源：`@tencent-weixin/openclaw-weixin@2.4.10`（MIT），完整快照保留在
`vendor/openclaw-weixin/`，只作协议对照，不参与构建；`src/protocol/markdown.ts`
是其零依赖 Markdown 过滤器的逐字副本（见 `tests/markdown-port.spec.ts` 等价校验）。

## 范围（V1）

- 私聊文本收发 + 微信轻量 Markdown（保留代码块/行内代码/表格/粗体，剥离图片等不支持的语法）
- 扫码登录（显式 CLI）与凭证、cursor、context token、消息去重的原子持久化（0600）
- 身份走渠道中立三元组 `(channel='wechat', appId, subjectId)`，档案落
  `$DSH_HOME/home/users/<userId>/<agentId>/{workspace,memory}/`，复用 feishu-principal 的身份簇，不伪造飞书 open_id
- 每会话串行队列；`/new` `/stop` `/status`；工具白名单 + 文件围栏
- **不含**：媒体/引用缓存/工具进度/流式卡片/群聊（协议位已留，后续版本再加）

## 接线

```yaml
- id: wechat
  name: '@dsh-friends/wechat-channel'
  config:
    agentsRoot: /data/dsh/home/agents
    dataDir: /data/dsh/home/wechat
    bots:
      - accountId: main
        agentId: <agentId>
        # loginAllowUsers: [<管理员的飞书 openId>]   # 共享 bot 必配，限定谁能执行 wechat_login
    allowedUsers: []   # ilink_user_id 白名单，空=全部放行；扫码登录会自动追加
    agentToolAllow: [...]
```

## 登录（推荐：对话式，绑定身份）

插件注册 `wechat_login` 工具，**在哪个飞书身份的会话里发起，就把微信账号绑到该身份**
（`identity.agentId` → `bots[].agentId` 匹配）。对 bot 说"微信登录"即可：

1. `wechat_login(action=qr)` → 生成二维码 PNG，Agent 用 `feishu_send_image` 发给你
2. 微信扫码确认；期间 Agent 调 `wechat_login(action=wait)` 等待
3. 如返回 `need_verifycode`，把手机上的数字告诉 Agent → `action=code` 提交
4. `confirmed` 后自动完成：凭证落 `credentials.json`（0600）、扫码的
   `ilink_user_id` 写入 `allowlist.json`（扫码者即账号主人，白名单立即生效）、
   冷账号自动拉起长轮询，无需重启服务

二维码可以**转发给不用飞书的人扫**——登录操作者（飞书侧）和扫码者（微信侧）
是两回事：扫的人将成为这个微信账号的微信侧用户。

### 身份与工作区语义（重要）

飞书在这里只是**登录/管理渠道**。微信侧是全新且独立的身份空间：

- 微信用户按 `(wechat, appId, ilink_user_id)` 首见建档，落
  `$DSH_HOME/home/users/<新 userId>/<agentId>/{workspace,memory}/`，**全新工作区、全新记忆**，与发起登录的
  飞书用户档案毫无关联
- 同一自然人同时用飞书和微信 = **两个独立身份簇、两个独立档案**，系统不做任何
  自动合并；确需合并走下方的对话式「身份关联」

### 身份关联（可选：飞书 ↔ 微信档案共享）

不关联 = 两边独立档案（默认，互不影响）。要共享时，**发起方工作区为准**：

**飞书侧发起**（推荐入口）——对 bot 说"关联微信"：

1. `wechat_bind(action=start)` 生成 6 位码，**直接展示在飞书回复里**（不经微信通道）
2. 把码告诉要关联的微信用户，TA 在微信里向这个 bot 发 **`/bind 483921`**
   ——谁回码，哪个微信就被关联；多个微信时用哪个回就关联哪个
3. 验证通过后，微信身份关联到飞书身份，会话重新解析 userId 与工作区。
   仅在双方用户、同一 agent 和当前布局范围明确时，复制旧档案的 `workspace/` 与 `memory/`
   到目标档案，原档案保留。目标同名文件保留，来源保存为 `.wechat-side`（重复时加数字后缀），
   不复制用户配置、权限或其他 agent 的内容。目录缺失、同根、链接、复制失败或部分复制会明确回报，
   不能据身份关联成功推断历史记忆已全部合并。

**微信侧发起**：V1 先引导到飞书侧发起（反向关联需飞书身份自证，防止冒领）；
在微信里发 `/bind` 会收到引导提示。

安全：配对码 10 分钟过期；普通数字消息（无 `/bind` 前缀）不会误触发；
回码即自证——码只展示给发起的飞书用户，回码的微信就是被关联的微信。
配对与入站身份使用相同的动态 appId：优先可信登录凭证中的 botId，之后才用配置 botId、
`account:<accountId>`；配对期间登录域变化会要求重新发起。

历史 `agents/<agentId>/users/<userId>/` 布局及未知身份簇不自动扫描、迁移或按姓名重绑。
部署源码不会修复生产注册表中已有的孤儿 userId；需另外确认身份映射和档案归属后处理。
档案复制跳过链接并拒绝路径中的链接目录，以防越过上述 owner/agent 范围。

### 访问控制

`agentToolAllow` 是 bot 级的（加了才可见），两道执行锁针对共享 bot：

- **`loginAllowUsers`**（bot 配置，飞书 openId 列表）：限定哪些用户能执行
  `wechat_login`。只给你自己的身份用可以不配；任何多人共用的 bot 强烈建议配置
- **换绑保护**：账号已绑定微信时 `action=qr` 默认拒绝（`already_bound`），
  防止他人扫码抢绑；确认换绑需 `force=true`，成功后凭证与白名单整体替换为
  新扫码人（旧主人自动移出白名单）

## 登录（备选：CLI）

服务永不自动登录。也可用终端扫码：

```bash
npm run build
npm run login -- --account main --data-dir /data/dsh/home/wechat
```

扫码确认后凭证写入 `dataDir/credentials.json`（0600）。CLI 不写 allowlist，
需手动把扫码返回的 `ilink_user_id` 加入 `allowedUsers` 或 `allowlist.json`。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes）
npm test            # vitest：协议 wire 契约 / Markdown 逐字等价 / 状态原子恢复 / 通道语义
npm run build       # tsdown -> lib/
```

## 交付语义（P0）

- 每条入站消息先过**持久去重**（`inbox-dedup.json`，12h TTL / 5000 条）再进队列
- `get_updates_buf` 游标**整批投递成功后才提交**：崩溃重启后未处理消息会重放，
  已处理消息被去重拦下（at-least-once + 去重 = 用户视角恰好一次）
- 外发崩溃窗口（微信已收到、dedup 未写）理论存在，属协议固有限制
