# Tianma 集成家族

[English](tianma.md) | 中文

[Tianma 包族](../../packages/tianma)以纯组合方式把 ZCode 的上下文压缩质量机制移植进 dsh：独立插件加一个 profile patch bundle，不触碰上游 `@deepseek-ai/dsh-*` 包。每个能力作为 `@tianma/dsh-bundle` 的一行挂载，因此可独立回退；上游行 id 漂移导致覆盖过期时，`scripts/verify-profile-patches.ts` 会让 CI 失败。

来源：[`packages/tianma/`](../../packages/tianma)

## 为什么有这些包

上游 harness 在三处用模型可见的上下文质量换 token 成本：头/中/尾裁剪器会截断每一条超限工具结果，包括手头正在用的那条；默认压缩保留率只有 16% 逐字尾部；平坦的 4 字符/token 计量把中文为主会话低估 2–3 倍，压力触发过晚。Tianma 家族逐 seam 地把这些权衡重新导向长任务产出质量。

## 能力集

- **近因保全清理**（`@tianma/dsh-compaction-recency-pruner`）以 ZCode microcompact 语义注册同一个 `ctx.toolResultPruner` seam：最近的结果逐字节不动；更早的超限白名单结果整体清空为一行标记。见[包 README](../../packages/tianma/compaction-recency-pruner)。
- **高保真总结**（`@tianma/dsh-compaction-summarize`）子类化文档声明的 `summarize()` 钩子，保持 KV 前缀对齐的信封，同时换入 ZCode 的九段式提示词：全部用户消息列出、安全约束逐字、analysis 先于 summary 输出。见[包 README](../../packages/tianma/compaction-summarize)。
- **行为准则**（`@tianma/dsh-behavioral-guidelines`）注册一个承载 ZCode 沟通与自主推进纪律的静态 system-prompt 节。见[包 README](../../packages/tianma/behavioral-guidelines)。
- **token 计量校准**（`@tianma/dsh-token-meter-calibration`）交付中文感知分密度估算器与滚动 usage 因子核心；装配另行落地。见[包 README](../../packages/tianma/token-meter-calibration)。

## 组合与校验

[bundle](../../packages/tianma/bundle) 在 `dsh-base` 之后应用行覆盖：两个调优默认值（`retainRatio` 0.35、AGENTS.md 预算 256KB）与两个行替换。静态补丁校验器断言每个被覆盖 id 在基础层恰好出现一次，上游漂移按 fail-closed 处理。路线图与验证协议见 [`docs-integration-pr-roadmap.md`](../../docs-integration-pr-roadmap.md)。
