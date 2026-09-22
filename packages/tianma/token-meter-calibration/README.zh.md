---
description: "中文感知密度计价与滚动 usage 校准因子，已接入 token meter，让中文为主会话不再被低估 2–3 倍。"
kind: "package-reference"
---

# @tianma/dsh-token-meter-calibration

[English](README.md) | 中文

## 概述

上游 token meter 对所有文本按固定 4 字符/token 计价，中文为主的会话被低估 2–3 倍，压力读数偏低、压缩触发过晚。本包把该修正挂到 meter 自身：分密度估算器（`estimateTextTokensCalibrated`，CJK 段按 1.5 字符/token、其余按 4）给出按会话的密度比值，`CalibrationFactor`（报告/估算比值的中位数滚动乘子，钳制在 [0.25, 4]）补齐与 provider usage 之间的残差。插件以两者之积改写 meter 的测量结果，同时保留 provider usage 基线不动，因此非 CJK 且无样本的表面与未校准的 meter 逐位一致。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

以 Cordis 插件挂载本包：它注入 `tokenMeter`、注册 `ctx.tianmaTokenCalibration`，并为正在测量的会话修正 meter 产出的每一次测量。每次 provider 上报的调用记录一个样本，插件卸载时把因子写入 `<harness home>/tianma-calibration.json`。

```yaml
- id: tianma-token-calibration
  name: '@tianma/dsh-token-meter-calibration'
  config:
    window: 256
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `statePath` | `<harness home>/tianma-calibration.json` | 校准状态文件。 |
| `window` | `256` | 报告/估算样本的滚动窗口。 |

`ctx.tianmaTokenCalibration` 暴露 `factorValue`（残差乘子，无样本时为 1）、`sampleCount`、`estimateSession(session)`（会话模型可见表面的两种密度计价）、`sessionMultiplier(session)`（密度比值乘残差）、`record(estimated, reported)` 与 `persist()`。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

两个彼此独立的修正相乘。**密度比值**是 `session.deriveMessages()` 上的 `calibrated ÷ flat`：两项以相同的结构开销为同一批消息计价，因此开销相互抵消，只剩文本密度差异。**残差因子**是 256 样本窗口内钳制后的 `报告 ÷ 估算` 比值中位数，种子快照按一个聚合样本回放，保证窗口约束跨重启成立。

以两者之积改写时，只缩放测量中的启发式量：节点价格、表面总量、带符号的表面增量，以及 `estimated` 基线；而 `usage` 基线是 provider 真值，原样透传。`surfaceTokens` 始终等于节点价格之和，`totalTokens` 始终等于 `baseline + surfaceDeltaTokens` 并下限截零，因此文档声明的每条测量不变式都得以保留。乘子恰为 1 时直接返回 meter 自己的对象。

样本来自携带 `usage` 的 `assistant/message` 事件；与之配对的估算是该时点会话表面的校准后价格，因此残差追踪的是密度拆分之后剩下的差距。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/density.ts`](src/density.ts) | CJK 计数与分密度文本估算 |
| [`src/estimate.ts`](src/estimate.ts) | 可选密度下的消息计价 |
| [`src/surface.ts`](src/surface.ts) | 会话表面的两种密度价格与比值 |
| [`src/factor.ts`](src/factor.ts) | 中位数滚动校准因子与带版本快照 |
| [`src/measure.ts`](src/measure.ts) | 保持测量不变式的测量改写 |
| [`src/service.ts`](src/service.ts) | `UsageCalibrator` 状态容器、usage 扫描与持久化 |
| [`src/index.ts`](src/index.ts) | 插件：命名空间导出、meter 修正、usage 采样 |
| [`tests/token-meter-calibration.spec.ts`](tests/token-meter-calibration.spec.ts) | ASCII 逐位一致、CJK 计数、10% 偏差基准、因子鲁棒性 |
| [`tests/wiring.spec.ts`](tests/wiring.spec.ts) | 真实 meter 组合：ASCII 一致、CJK 修正、采样、卸载 |
| [`tests/coverage.spec.ts`](tests/coverage.spec.ts) | 计价分支、默认状态路径、不可用持久化状态 |
| — | 不发布运行时不变式 companion；本包不拥有跨插件关系，其两处可变关系（因子窗口与测量改写）均由测试断言。 |

### 不变式归属

不发布 invariant companion，因为本包不改动共享日志或注册表状态：因子窗口约束局部于每个 `CalibrationFactor`，而 meter 改写由单个 effect 安装与移除，其复原由接线测试断言。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [token-meter](../../llm/token-meter/README.zh.md) — 被本插件修正的测量
- [compaction-basic](../../compaction/compaction-basic/README.zh.md) — 读取该测量的压力决策
- [tianma bundle](../bundle/README.zh.md) — 挂载本行的补丁列表

-----

<a id="model-experience"></a>
## 模型体验

间接经由 token meter：本插件改写 compaction 读取的压力测量，因此压缩触发的时机跟随中文感知计价，而提示词、工具 schema 与会话事件均不变。

#### KV 缓存影响

本插件不新增自己的请求面。被修正的压力测量可能提前或推迟压缩，而压缩检查点会替换下一步发送的请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限定义本包边界。它们是当前约束，不是任务清单。

- **修正以替换 `tokenMeter.measure` 实现** — meter 未公开计价扩展点，因此插件在其生命周期内包装服务实例上的这一个方法，并在卸载时复原。原生测量 seam 到位后即可移除该替换。
- **密度是全局常量** — 1.5/4 字符/token 与模型无关；按模型的分词器需要 adapter seam。
- **因子是单一全局乘子** — 请求信封相似度分组已推迟；一个因子服务所有请求。
- **工具 schema 沿用消息比值** — 工具 schema 按表面的消息密度计价而非自身密度，在中文重度会话上会略微过度修正其以 ASCII 为主的 JSON。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

10% 基准用偏移后的真值密度（1.6/3.8）钉住拆分，常量无法静默回退到平坦 4。接线测试钉住契约的另一半：非 CJK 表面必须与未校准的 meter 测得完全相同，且卸载必须同时复原 meter 方法与服务注册。

</details>
