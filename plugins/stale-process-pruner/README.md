# stale-process-pruner

DSH（DeepSeek Harness）轮龄裁剪插件：**每一轮开始时，把上一轮的过程性内容（工具输出、工具调用参数、thinking/reasoning）折叠成一条精编 checkpoint**，让下一轮从干净底座开跑，而不是驮着上一轮几十 KB 的调试过程。

正文与用户消息永久钉住——跨轮要引用的关键信息必须写进回复正文（正文即长期记忆），工具输出原文需要时可读会话原始日志（replay-safe 不丢数据）。

## v1.4.3（2026-11-05）：工具状态如实标注（P1）+ token 收益门（P2c）+ 参数直截（P3）

- **P1**：checkpoint 头部不再无条件声称"均真实执行过"。按 `callId` 核对 `tool/result` 执行状态：DSH 恢复流程会为中断调用合成 `TOOL_NOT_STARTED`（未启动）/`TOOL_OUTCOME_UNKNOWN`（已启动结果未知），旧代码的笼统断言会让后续模型把未执行的写入/部署当已完成（审查实证）。现 ▸ 行按状态标注 `[未启动]`/`[结果未知]`/`[失败]`，存在未确认项时头部如实声明"未确认完成，正文相关结论须显式复核"；全部完成才保留原措辞。
- **P2c**：折叠前估算完整 checkpoint 的 token 成本，`checkpointTokens >= originalTokens` 则不折——实测纯正文段 18→35、短结果段 37→53 token 的反涨不再发生（v1.4.3 起 `pruneStaleProcess` 路径以 token 估算为准；`thresholdChars` 仅属父类单结果截断，此前 README 表述有误，已勘误）。
- **P3**：`ToolCallBlock.arguments` 本来就是原始 JSON string，不再二次 `JSON.stringify`（旧代码的引号转义挤占 80 字摘要额度，长路径/命令更早截断失真）；仅对象型 `input` 做序列化。
- 新增 case12（纯正文不折+零落盘）、case13（未启动标注+头部切换）、case14（失败/未知分标）、case15（全完成保留原措辞）、case16（参数无二次编码）。

## v1.4.2（2026-11-05）：checkpoint 永不改写真正落地 + 段尾切口 off-by-one（P2）

- **P2b**：checkpoint 从"段内透明节点"升格为**软边界**——段扫描时遇 checkpoint 即收尾折叠，它永不被 shadow/并入；旧的去头并入正则（`</checkpoint>` 残留根源）整体删除。v1.4.0 承诺的"永不改写"此前在混合段（checkpoint+raw 同 gap）中会被重折打破（实证：T2 折出 ckpt+raw 第二对 → T3 重折出 1 开标签 2 闭标签）。
- **P2a**：段尾平衡检查统一改用官方 `toolPairingBalancedAfter(nodes[end])`（与 compaction-basic `validateSurfaceRegion` 同款）。旧代码在 gap 无后继节点时错误退回 `before(last)`，把已平衡的 tool/result 尾对漏裁（前轮以结果收尾+新消息尚在 claimed 中时实测 `pruned=0`）。
- 新增 case10（混合段 checkpoint 零改写、无闭标签残留）、case11（段尾尾对折叠）。

## v1.4.1（2026-11-05）：修复无 turn 注入阻断整段折叠（P1）

线上实证：T4→T5 因一条 `model-selection` 注入（无 `turn`、旧白名单不认）让 `foldGap` 整段放弃，30+ 工具事件漏裁；T1 的 8 条 `agent-message` 更令 300 事件从 T2 起永久滞留。修法：`isPinned` 从白名单改为**默认钉住一切 `user/message`**（仅 `time-context` 与 checkpoint 除外）——所有承载信息的注入（`agent-message`/`subagent-settled`/`skill-catalog`/`skill-invocation`/`model-selection`/`dsh-memory`/`goal`/`schedule` 等）成为段边界，原文永留 surface，两侧过程段各自独立折叠。新增回归用例 case9。

## v1.3.1（2026-11-05）：checkpoint 携带机械过程记录

折叠时把该段的工具调用与输出头**机械摘录**进 checkpoint（`▸ 名称 参数≤80字`、`↳ 输出头≤160字`，上限 40 行），并附提示词锚（“以下调用均真实执行过……勿重述为未执行”）。与 CPA 侧 context-fold 的 digest 标记同构——执行史记忆不再依赖模型自觉写正文，证据直接在上下文（CPA 实测可防模型把已折叠的执行史重写为“未执行”）。v1.4.0 起 checkpoint **一经产生永不改写**（drop/archive/digest 出窗改写机器已整体移除，无模式无开关），与 CPA digest 标记同生命周期。

## 语义

- 折叠时机：`agent/pre-step` 且 `step === 1`（每次模型请求前、新轮第一步）。轮内全程保持原始保真，**只在轮与轮的边界折叠**。
- 折叠对象（过程段，两个钉住节点之间）：assistant 消息、tool_call 参数、tool 输出、thinking/reasoning、旧 checkpoint、临时注入（如 time-context 采样，v1.1.0 起随段折叠不再卡整段）。
- 永不折叠（钉住）：用户真实消息、AGENTS 指令注入（baseline + 更新）、runtime-context、system 消息。钉住节点字节稳定是前缀缓存命中的前提。
- 折叠产物：一条 `compact-checkpoint` 消息（仅保留用户与助手正文精编，含被折叠事件的原文定位），用引擎 checkpoint 协议整段替换，不产生 tool-call/result 失配。
- 官方水位压缩（如 compaction-basic 85%）不受影响，仍作窗口兜底。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `staleTurns` | `1` | 轮龄：**0 = 不保留任何既往轮**（上一轮在下一轮开轮即折叠，web/对话身份推荐值）；**1 = 保留上一轮原始输出**（修 bug 需回看时临时用）；**-1 = 禁用轮龄裁剪**。`0` 与 `-1` 是合法显式值 |
| `thresholdChars` | `8192` | 仅父类单工具结果截断阈值；轮龄折叠的收益判定走 token 估算（v1.4.3 起） |
| `headChars` | `4096` | 单个工具输出折叠时保留头部字符数（父类 ToolResultPruner 参数） |
| `tailChars` | `1024` | 单个工具输出折叠时保留尾部字符数 |

注意：profile/home 同 id 插件的 `config` 是**整对象替换**——覆盖任何一个键都要把其余键写全。

## 安装（DSH 桌面版）

插件收录在 [cls3389/dsh-plugins](https://github.com/cls3389/dsh-plugins) 市场（`plugins/stale-process-pruner`），市场索引已 pin 精确 commit；也可 git 源直装：

```bash
# 市场方式（推荐）
dsh plugin --profile <你的profile> add @dsh-friends/stale-process-pruner

# git 源直装
dsh plugin --profile <你的profile> add github:cls3389/dsh-plugins#plugins/stale-process-pruner
```

然后在 profile 的 `cordis.patch.yml` 挂载（或直接复制本包自带的 `cordis.patch.yml` 内容合并）：

```yaml
- insert:
    - id: stale-pruner
      name: '@dsh-friends/stale-process-pruner'
      config:
        staleTurns: 0
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
```

改挂载配置 HMR 生效；新装插件包首次加载需重启该 profile 的服务。

## 装完后建议加进 AGENTS.md 的一句话

DSH **不会**因为安装插件而自动更新任何 AGENTS.md（插件引导全部走工具描述/运行时注入，AGENTS.md 是手工文件）。折叠生效后，上一轮的工具输出在下一轮即不可见，建议在会话工作区的 AGENTS.md 里加：

> 跨轮需要引用的关键信息——报错关键行、根因结论、决策依据、关键文件路径与参数——必须写进回复正文，不要只留在工具输出里。正文即长期记忆；需要原始输出时读会话日志（replay-safe）。

## 实测参考（2026-11-04，v4-flash + CPA 网关）

- 正常边界折叠：轮内峰值 → 下一轮首输入下降 12-15k token（工具密集轮 52k 过程塌缩为 1-2k checkpoint）。
- 缓存配合：轮内 step 前缀命中 89-99%，折叠后新轮首 miss 仅数百~3k token。
- v1.1.0 修复：time-context 等临时注入不再因「无轮号」卡住整段折叠（曾致恰逢 10 分钟采样点的轮零折叠）。

## 测试

```bash
npm test   # 8 用例：折叠边界、time-context 临时节点、staleTurns -1 禁用、checkpoint 去头防嵌套等
```
