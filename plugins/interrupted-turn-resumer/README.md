# interrupted-turn-resumer

在 DSH 进程中断导致轮次被恢复为 `turn/end.reason.kind === "interrupted"` 后，自动向原会话发送一次“继续”消息。

## 工作方式

- 监听实时 `turn/end` 事件。
- 在 Agent 恢复时检查末尾事件，因为启动修复事件不一定重新广播。
- 默认启动 5 秒后补扫，之后每 30 秒补扫一次；使用持久化 revision 避免反复读取未变化的日志。
- 调用正式 `sessionController.resolveAgent()` 恢复会话，保留原 Agent preset 和模型路由，再调用 `agent.followup()`。
- 只处理 `interrupted`，不处理用户主动停止（`aborted`）或普通错误。
- 发送前要求 Agent 空闲、没有排队输入，并重新核对会话日志。
- 如果中断后已有新轮次或人工回复，不发送。
- 默认仅恢复过去 24 小时内的中断，避免启用插件时唤醒旧任务。
- 连续进程重启产生的多个相邻 `interrupted` 取最后一个，不再误判为异常日志。
- 已恢复的旧中断在后续正常轮次结束时清除，不会阻断第二次及以后的自动续接。
- 默认跳过 `lark-` / `feishu-` 会话；其他实例持有写锁时记为 `external / not-sent`，不重试轰炸。
- 发送前失败记为 `failed / not-sent`，每 60 秒最多重试一次、每个事件最多 3 次，绝不冒充 `sent`。

## 去重与崩溃边界

键为 `sessionId:interruptedEventSeq`。发送前后写入原子状态文件，同时以会话日志中的后续输入/新轮次作为最终去重依据。

如果进程在发送过程中再次退出，下次启动会核对日志：已接收则不重发，未接收才重试。由于进程可能恰好在日志提交与状态落盘之间退出，该机制尽量缩小但不能从数学上完全消除外部副作用重复的可能；恢复提示要求模型先检查工具实际结果。

## 配置

配置集中在 `/data/dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: interrupted-turn-resumer
  name: '@dsh-friends/interrupted-turn-resumer'
  config:
    enabled: true
    scanIntervalMs: 30000
    initialDelayMs: 5000
    maxEventAgeMs: 86400000
    maxScanSessions: 0 # 0 = 全量扫描，避免漏掉目录顺序在 100 名之后的活跃会话
    maxAttempts: 3
    retryDelayMs: 60000
    maxResumeChain: 1 # 自动续接链深达 1 即停：续接后的轮次再次中断不再自动续接
    ignoredSessionIdPrefixes:
      - lark-
      - feishu-
    stateFile: /data/dsh/home/workspace/.interrupted-turn-resumer-state.json
```

`prompt` 可覆盖默认恢复文本。`enabled: false` 可停止事件处理和定时扫描。`maxResumeChain: 0` 可完全禁用插件自动续接。

## 自循环守卫（v0.3.0）

若被打断的轮次本身就是由本插件的续接消息发起的（典型事故：续接的 agent 又执行了 `systemctl stop dsh-web`，把运行本插件的进程一起杀掉，用户手动 start 后插件又续接 → stop → start → …无限循环），`maxResumeChain`（默认 1）到达后不再自动续接：记 `external / resume-chain-limit:N` 台账并停手，需人工在会话里发消息后才会继续。续接提示同时已加固为"进程中断期间已完成重启/恢复，视为重启已生效，勿再执行 stop/start"。

## 长期 Goal

恢复消息要求模型恢复长期 Goal；这不绕过 Goal 的人工重新授权边界。若运行时仍要求人工授权，模型应明确提示并等待。

## 测试

```bash
npm test
```

覆盖：中断识别、人工停止排除、新输入排除、重复监听去重、第二次独立中断、忙/排队保护、已送达崩溃恢复、未送达重试、自循环守卫（续接后的再次中断不再续接 / sendOnce 拒绝重入并记台账）。
