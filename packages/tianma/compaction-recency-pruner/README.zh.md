---
description: "toolResultPruner seam 上的近因保全工具结果清理：活跃窗口字节级不变，较早的超限结果整体清空，替换头/中/尾裁剪。"
kind: "package-reference"
---

# @tianma/dsh-compaction-recency-pruner

[English](README.md) | 中文

## 摘要

`dsh-compaction-recency-pruner` 注册与上游裁剪器相同的 `ctx.toolResultPruner` seam，语义取自 ZCode microcompact：最近 `keepRecentResults` 条工具结果无论多大都不动；更早的、来自白名单大流量工具（`read`、`grep`、`bash` 等）的超限结果整体清空为一行 `[Old tool result content cleared]` 标记。退化形状是"新上下文完好、旧上下文归零"——绝不是"全部部分截断"，后者正是上游方案在代码任务上的失效模式（目标区域恰在新读取内容的中段）。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)

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
