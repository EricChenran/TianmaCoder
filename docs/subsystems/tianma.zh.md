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
- **部门规则**（`@tianma/dsh-department-prompts`）支撑随发行版交付的技术部与商务部模式：每个部门一条字面 system-prompt 节，外加发布到私有目录、模型只以 `DSH_DEPARTMENT_TOOLS` 变量触达的商务部文档工具箱。见[包 README](../../packages/tianma/department-prompts)。
- **token 计量校准**（`@tianma/dsh-token-meter-calibration`）修正 compaction 读取的压力测量：会话表面的 CJK 密度比值乘以持久化的报告/估算滚动因子，作用在 meter 自身的测量结果上。见[包 README](../../packages/tianma/token-meter-calibration)。

## 组合与校验

[bundle](../../packages/tianma/bundle) 在 `dsh-base` 之后应用行覆盖：两个调优默认值（`retainRatio` 0.35、AGENTS.md 预算 256KB）与两个行替换。静态补丁校验器断言每个被覆盖 id 在基础层恰好出现一次，上游漂移按 fail-closed 处理。路线图与验证协议见 [`docs-integration-pr-roadmap.md`](../../docs-integration-pr-roadmap.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtianmahooktrust--tianmahooktrust"></a>

### `ctx.tianmaHookTrust` — `TianmaHookTrust`

The Cordis service registered under `ctx.tianmaHookTrust`.

Source: [`packages/tianma/hooks-trust/src/index.ts`](../../packages/tianma/hooks-trust/src/index.ts)

<a id="ctxtianmatokencalibration--usagecalibrator"></a>

### `ctx.tianmaTokenCalibration` — `UsageCalibrator`

The calibration service: rolling factor plus file persistence. Pure state container + explicit I/O — no hidden timers, no background work.

```ts cordis-catalog
/**
 * Both density prices over one session's current model-visible surface.
 * @param session - session whose derived history to price.
 * @returns the CJK-split and fixed-density totals.
 */
estimateSession(session: Session): DensityPrices

/**
 * The correction the token meter applies to one session's measurement: the
 * session's own density ratio times the rolling residual factor.
 * @param session - session whose surface is being measured.
 * @returns 1 when the surface is non-CJK and no sample has been recorded.
 */
sessionMultiplier(session: Session): number

/**
 * Record one heuristic-vs-reported pair from a routed request.
 * @param estimatedTokens - the heuristic estimate for the request surface.
 * @param reportedTokens - the provider-reported total for the same request.
 */
record(estimatedTokens: number, reportedTokens: number): void

/**
 * Scan one session for reported usage samples and record each against the
 * given heuristic estimate of the same request surface.
 * @param session - the session whose log to scan.
 * @param estimateTokens - heuristic estimate per sampled request.
 * @returns how many samples were recorded.
 */
recordSession(session: Session, estimateTokens: (index: number) => number): number

/** Write the current factor snapshot to the state file. */
persist(): void
```

Types: [Session](session.zh.md)

Source: [`packages/tianma/token-meter-calibration/src/service.ts`](../../packages/tianma/token-meter-calibration/src/service.ts)
<!-- END GENERATED cordis-surface -->
