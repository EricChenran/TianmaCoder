---
description: "中文感知密度估算与滚动 usage 校准因子：在接入 token meter 之前，先修复中文为主会话 2–3 倍低估的计量核心。"
kind: "package-reference"
---

# @tianma/dsh-token-meter-calibration

[English](README.md) | 中文

## 概述

上游 token meter 对所有文本按固定 4 字符/token 计价，中文为主的会话被低估 2–3 倍，压力读数偏低、压缩触发过晚。本包携带修复该问题的两个计量核心：分密度估算器（`estimateTextTokensCalibrated`，CJK 段按 1.5 字符/token、其余按 4——纯 ASCII 计价与上游逐位一致）和 `CalibrationFactor`（报告/估算比值的中位数滚动乘子，钳制在 [0.25, 4]，快照带版本字段可持久化）。CI 钉死的基准测试在混合语料上将偏差压在 10% 以内（对照具代表性的分词器真值），而平坦 4 基线在中文重度文本上偏差超过一半。

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

v1 只交付核心——纯函数与状态容器，无 Cordis 装配。接入步骤（监听请求 usage、包装 `tokenMeter` 测量、经 storage seam 持久化因子）是独立的后续变更，让核心先以可评审、CI 钉死的形式落地；尚无 bundle 行挂载本包。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

密度拆分对每段文本统计一次 CJK 码点（汉字、假名、谚文、全角形式、CJK 标点），按各自密度分别计价；校准因子维护一个有界的钳制后报告/估算比值窗口并取中位数，单次病态请求无法大幅移动定价，种子快照按一个聚合样本回放，保证窗口约束跨重启成立。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/density.ts`](src/density.ts) | CJK 计数与分密度估算 |
| [`src/factor.ts`](src/factor.ts) | 中位数滚动校准因子与带版本快照 |
| [`src/index.ts`](src/index.ts) | 公开导出 |
| [`tests/token-meter-calibration.spec.ts`](tests/token-meter-calibration.spec.ts) | ASCII 逐位一致、CJK 计数、10% 偏差基准、因子鲁棒性与往返 |
| — | No runtime invariant companion is published; 本包导出纯函数与状态容器，无可供独立 companion 观察的服务、事件或 session 变更。 |

### 不变式归属

No invariant companion is published because 除每个 `CalibrationFactor` 实例外本包无可变关系，窗口约束由测试断言。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [token-meter](../../llm/token-meter/README.zh.md) — 被这些核心校准的测量
- [compaction-basic](../../compaction/compaction-basic/README.zh.md) — 当下会误触发的压力决策
- [spill 家族](../../spill/README.zh.md) — 压力测准之后的按大小卸载

-----

<a id="model-experience"></a>
## 模型体验

无：v1 仅交付纯计量核心且不挂载任何东西。

#### KV 缓存影响

不存在可影响的请求面；这些核心从不接触请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限定义 v1 边界。它们是当前的包约束，不是任务清单。

- **仅核心、无装配** — 没有监听器记录 usage、没有 `tokenMeter` 包装、没有持久化；接入是独立的后续变更。
- **密度是全局常量** — 1.5/4 字符/token 与模型无关；按模型的分词器需要 adapter seam。
- **因子是单一全局乘子** — 请求信封相似度分组已推迟；一个因子服务所有请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

10% 基准用偏移后的真值密度（1.6/3.8）钉住拆分，常量无法静默回退到平坦 4。

</details>
