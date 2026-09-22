---
description: "toolResultPruner seam 上的近因保全工具结果清理：活跃窗口字节级不变，较早的超限结果整体清空，替换头/中/尾裁剪。"
kind: "package-reference"
---

# @tianma/dsh-compaction-recency-pruner

[English](README.md) | 中文

## 概述

`dsh-compaction-recency-pruner` 注册与上游裁剪器相同的 `ctx.toolResultPruner` seam，语义取自 ZCode microcompact：最近 `keepRecentResults` 条工具结果无论多大都不动；更早的、来自白名单大流量工具（`read`、`grep`、`bash` 等）的超限结果整体清空为一行 `[Old tool result content cleared]` 标记。退化形状是"新上下文完好、旧上下文归零"——绝不是"全部部分截断"，后者正是上游方案在代码任务上的失效模式（目标区域恰在新读取内容的中段）。

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

挂载本插件**以替代** `dsh-compaction-tool-result-pruner`（Tianma bundle 直接替换 `tool-result-pruner` 行）。它由同一压缩触发管线调用——压力达标时 `dsh-compaction-basic` 调用 `pruneSession`——因此天然继承触发门控。ZCode microcompact 的空闲超时触发刻意不在本包范围：调度属于触发管线，不属于清理器。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `keepRecentResults` | `5` | 这么多条最近结果（按 surface 顺序）永不被清理 |
| `thresholdChars` | `8192` | 较早结果文本超过这么多码点才清理 |
| `minCharsSaved` | `1024` | 节省不足此值时跳过（ZCode 的 256 token 门槛按 4 字符/token 折算） |
| `compactableTools` | read/write/edit/glob/grep/bash/pwsh/web_search/web_fetch | 白名单；空列表表示所有工具 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`pruneSession` 从 `tool/call` 日志事件（非 surface 节点）解析工具名，收集 `tool/result` surface 候选，剔除活跃窗口尾部，然后为每个合格候选落一笔与上游裁剪器相同的回放安全事务：先经 `ctx.tokenMeter` 为被遮蔽节点定价的 `compaction/prune` 影子价格事件，再落一笔引用被遮蔽 seq 的 `tool/result` 替换。原文本块折叠为一行标记；富块（含已记录卸载选择的图片）按序保留。完整原文始终留在 append-only session log 中供精确回放。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | seam 服务：候选收集、活跃窗口保证、清理事务 |
| [`src/config.ts`](src/config.ts) | 策略解析与默认值；清理标记文案 |
| [`src/types.ts`](src/types.ts) | 配置与结果契约 |
| [`tests/recency-pruner.spec.ts`](tests/recency-pruner.spec.ts) | 活跃窗口字节同一性、阈值/白名单/节省门槛、替换形状、影子价格协议、插件加载 |
| — | No runtime invariant companion is published; 本服务通过 session 自带的校验 append 事务改写 surface 节点，不暴露可供独立 companion 观察的包级事件。 |

### 不变式归属

No invariant companion is published because 所有变更都流经 `Session.append` 的规范 surface 契约校验；本插件不拥有独立的可变关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [上游 tool-result pruner](../../compaction/compaction-tool-result-pruner/README.zh.md) — 被本包替换的头/中/尾行为
- [compaction-basic](../../compaction/compaction-basic/README.zh.md) — 调用本 seam 的触发管线
- [spill 家族](../../spill/README.zh.md) — 带检索的上下文外存储，超大输出的更严格替代

-----

<a id="model-experience"></a>
## 模型体验

### 被清理的旧工具结果

#### 模型看到什么

较早的超限白名单结果变成恰好一行文本：`[Old tool result content cleared]`。最近 `keepRecentResults` 条结果——以及所有低于阈值或非白名单的结果——保持逐字节一致，富块亦然。

#### Token 影响

每条被清理结果从完整文本大小降到 33 个码点；影子价格事件保证回放核算精确。

#### KV 缓存影响

surface 替换改写既有历史节点，从第一个被替换节点起使 KV 前缀失效——与上游裁剪器的替换影响相同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限说明何时应保留上游裁剪器。它们是当前的包约束，不是任务清单。

- **事件级近因，非回合分组** — 窗口按工具结果事件计数，而非 ZCode 的 assistant 回合组；交错回合可能比组等价物多保留一点。
- **无空闲触发** — ZCode 的 60 分钟空闲清理不在范围；清理只随压缩触发管线运行。
- **白名单按名字精确匹配** — 自定义或改名的工具需要显式 `compactableTools` 条目；空列表会清理所有工具的旧结果。
- **清理意味着可重读，而非上下文内可恢复** — 模型需要重新读取被清理的文件；append-only 日志仅为回放与审计保留原文。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

语义移植自 ZCode 的 `microcompact.ts`（保最近 5、256 token 节省门槛）；按 4 字符/token 的折算记录在配置表中。

</details>
