# idle-compaction

闲置会话自动压缩。闲置超过阈值的会话由后台巡检自动 `compaction`，下一条消息直接以紧凑上下文开始，避免在对话中途付压缩的账。

## 行为

- **事件驱动闲置判定**：监听 `session/event`、`agent/assistant-stream`、`agent/created` 刷新各会话的 lastActivity——对进程内**所有**会话宿主（飞书 bot、Web GUI…）一视同仁，不依赖任何 channel 内部状态。
- **巡检**（默认每 5 分钟）：对闲置超过 `idleMinutes`（默认 60）且仍常驻的会话调用 `ctx.compaction.compactNow`。巡检处理过的会话重置闲置时钟，不会连续多轮反复尝试。
- 历史不足时 `compactNow` 返回 null（安全空操作）；非常驻的会话仅清理计时记录。
- 单次压缩有超时保护（默认 3 分钟）；对话中的会话不会被打断（流事件持续刷新计时）。
- `dryRun: true` 观察模式：只记日志不真压，适合接入初期评估。

## 前置条件

无外部依赖。需要宿主提供 cordis 服务 `compaction`（dsh 自带）与 `agents`；任一缺失时巡检自动空转。

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: idle-compaction
  name: '@dsh-friends/idle-compaction'
  config:
    idleMinutes: 60          # 闲置阈值，<=0 关闭
    sweepIntervalMinutes: 5  # 巡检周期（分钟，最小 1）
    timeoutMs: 180000        # 单次压缩超时
    # dryRun: true           # 观察模式
```

## 启用步骤（新 profile）

1. `ln -sfn <本目录> <profile>/node_modules/@dsh-friends/idle-compaction`
2. profile `package.json`：`dependencies` 加 `"@dsh-friends/idle-compaction": "link:<本目录>"`；
   `dsh.profile.bundles` 加 `"@dsh-friends/idle-compaction"`
3. profile patch 加上述配置块；重启进程（无 HMR）

（从插件市场安装则跳过以上手工步骤，市场自动完成安装与登记。）

## 日志

走 `console.error`（部分 profile 的 `ctx.logger.info` 不落 journalctl）：

```
journalctl -u <unit> | grep idle-compaction
# enabled: idle>60min sweep=5min
# <sessionId> shadowed N items (~M tokens)
```

## 阈值参考

官方缓存 TTL：DeepSeek 几小时~天（best-effort，~4× 折扣）、GLM 未公开（50%）、Kimi 5m/1h。
压缩收缩比（~10×）天然大于全部缓存折扣，统一 60min 即全局最优，无需按模型分阈值。

## 测试

```
node --test test-idle-compaction.mjs
```
