---
description: "移植自 ZCode 的行为提示词节，以一个具名 system-prompt contribution 注册，供希望在任意 persona 下保持稳定沟通与自主推进纪律的部署方使用。"
kind: "package-reference"
---

# @tianma/dsh-behavioral-guidelines

[English](README.md) | 中文

## 摘要

`dsh-behavioral-guidelines` 注册一个具名 system-prompt 节——`tianma:behavioral-guidelines`，排在部署 persona 前缀之后——承载移植自 ZCode 手工调优 `dynamic-sections.ts` 的行为文案：如何与用户沟通（最终消息承载结论、可读性优先于压缩）、如何管理上下文与自主推进（信息足够即行动、只在真正的范围变更前停下、绝不在承诺上结束回合）、以及代码注释纪律。文案刻意保持静态：部署方通过改行来调整位置，而不是改文字；快照测试钉住文案防止漂移。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)

-----

<a id="use-this-package"></a>
## 使用本包

在运行 agent 且希望行为纪律穿越 persona 变更的位置挂载本插件。Tianma bundle 以 `tianma-behavioral-guidelines` 行插入本插件；部署方可按 profile 用 `disabled: true` 禁用，或通过改行重排。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本插件不持有状态：`apply` 注入 `systemPrompt` 服务并通过 `ctx.systemPrompt.section()` 注册一个静态节，效果随插件卸载而回退。节序 `100` 位于 `DEPLOYMENT_PERSONA_PREFIX`（0）与 `PLAN_POLICY`（500）之间，因此任何 persona 都保住同一套行为底线。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 节文案与单效果插件 |
| [`tests/behavioral-guidelines.spec.ts`](tests/behavioral-guidelines.spec.ts) | seam 注册、相对 persona 前缀的排序、逐字内容、快照钉定 |
| — | No runtime invariant companion is published; 本插件通过 system-prompt seam 注册一个静态提示节，不暴露任何可供独立 companion 观察的事件、服务或状态。 |

### 不变式归属

No invariant companion is published because 本插件无可变关系：节要么已注册（由测试断言），要么插件已卸载。

</details>
