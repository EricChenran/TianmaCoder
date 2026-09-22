---
description: "高保真压缩总结器，子类化文档声明的 summarize() 钩子：ZCode 的九段式逐字保留提示词与 NO_TOOLS 护栏，KV 前缀对齐的请求信封保持不变。"
kind: "package-reference"
---

# @tianma/dsh-compaction-summarize

[English](README.md) | 中文

## 概述

`dsh-compaction-summarize` 是只覆盖一个点的 `BasicCompactionEngine`：文档声明的 `summarize()` 定制钩子。辅助调用的请求信封与上游完全一致——回放前缀、同一组工具 schema、指令作为最后一条 user message——因此 provider 的 KV 前缀缓存照常复用。改变的是指令本身，移植自 ZCode 手工调优的压缩提示词：九个固定段落、**全部用户消息忠实列出且安全约束逐字保留**（每代压缩都从原文重锚定意图，抑制链式衰减）、强制 `<analysis>` 先于 `<summary>` 的输出形状、以及守护纯文本回合的 NO_TOOLS 前后缀。`<analysis>` 草稿被丢弃；只有提取出的 `<summary>` 落为检查点，未打标签的输出按容错回退原样通过。

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

挂载本插件**以替代** `dsh-compaction-basic`（Tianma bundle 直接替换 `compaction-basic` 行；配置沿用同一 `BasicCompactionConfig` schema）。v1 范围说明：`summarize()` 目标解析中的按模型策略覆盖不在范围内（配置目标 → 路由目标 → agent 选项），重试/熔断行为继承上游引擎的 `compactionRetries`/`maxOverflowRetries` 而非重复实现。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`summarize()` 解析目标，回放 `input.messages` 并追加一条携带 `FIDELITY_INSTRUCTION` 的最终 user message，经 `ctx.llm.stream()` 以 `purpose: 'compaction'` 流式消费，将终止原因映射为上游的 fail-closed 错误，并从纯文本输出中提取 `<summary>` 区段。富媒体输出的拒绝逻辑与上游一致。指令位于 [`src/instruction.ts`](src/instruction.ts)，提取位于 [`src/extract.ts`](src/extract.ts)，均导出以供直接测试。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 引擎子类：目标解析、信封组装、流消费 |
| [`src/instruction.ts`](src/instruction.ts) | 高保真指令与九个段落标题 |
| [`src/extract.ts`](src/extract.ts) | `<summary>` 提取，带容错回退与 fail-closed 护栏 |
| [`tests/compaction-summarize.spec.ts`](tests/compaction-summarize.spec.ts) | 指令结构、提取单元用例、脚本化适配器端到端压缩 |
| — | No runtime invariant companion is published; 本引擎继承上游压缩不变式，不新增可变关系。 |

### 不变式归属

No invariant companion is published because 子类不新增任何 session 变更：所有持久化效果都流经继承的上游事务。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [compaction-basic](../../compaction/compaction-basic/README.zh.md) — 本子类扩展的引擎
- [compaction 契约](../../compaction/compaction/README.zh.md) — 本包落库所用的检查点框架
- [上游 pruner](../../compaction/compaction-tool-result-pruner/README.zh.md) — 总结之前的第一级缓解

-----

<a id="model-experience"></a>
## 模型体验

### 压缩指令

#### 模型看到什么

总结器收到回放的对话加一条携带 `FIDELITY_INSTRUCTION` 的最终 user message：NO_TOOLS 前后缀包住九个固定段落，全部用户消息列出、安全约束逐字保留。落库的检查点只保留标准 `<compacted-summary>` 框架内提取出的 `<summary>` 文本；`<analysis>` 草稿绝不进入模型可见历史。

#### Token 影响

指令是辅助调用上的一次性最终消息；落库检查点受 `maxTokens` 约束。

#### KV 缓存影响

请求信封与最后一次路由请求一致（相同前缀、相同工具 schema），辅助调用复用 provider 的热前缀缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限定义高保真引擎尚未覆盖的部分。它们是当前的包约束，不是任务清单。

- **无按模型策略覆盖** — `summarize()` 目标解析为配置 → 路由 → agent 选项；`modelPolicies` 条目在 v1 不会到达高保真调用。
- **重试行为是继承的，非 ZCode 的** — 溢出重试来自上游引擎；ZCode 的连续失败熔断没有重复实现。
- **未打标签的输出原样通过** — 忽略标签形状的 provider 仍会落库检查点，但缺九段结构。
- **指令为英文** — 提示词工艺没有本地化变体。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

提示词移植自 ZCode 的 `prompt.ts`；PR-5（文件再水合）将消费本包的检查点语义。

</details>
