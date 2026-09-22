# Tianma integration family

English | [中文](tianma.zh.md)

The [Tianma packages](../../packages/tianma) port ZCode's context-compaction quality mechanisms into dsh through composition only: independent plugins plus one profile patch bundle, with upstream `@deepseek-ai/dsh-*` packages untouched. Every capability mounts as one `@tianma/dsh-bundle` row, so each is independently revertible and `scripts/verify-profile-patches.ts` fails CI when an upstream row-id drift would leave an override stale.

Source: [`packages/tianma/`](../../packages/tianma)

## Why these packages exist

The upstream harness trades model-visible context quality for token cost in three places: the head/middle/tail pruner truncates every over-budget tool result including the one in hand; the default compaction retention keeps only 16% verbatim; and the flat 4-chars/token meter under-prices CJK-heavy sessions by 2–3×, so pressure triggers late. The Tianma family re-shapes those trade-offs toward long-task output quality, one seam at a time.

## The capability set

- **Recency-preserving clearing** (`@tianma/dsh-compaction-recency-pruner`) registers the same `ctx.toolResultPruner` seam with ZCode microcompact semantics: the most recent results stay byte-identical; older oversized whitelisted results clear wholesale to one marker line. See the [package README](../../packages/tianma/compaction-recency-pruner).
- **Fidelity summarization** (`@tianma/dsh-compaction-summarize`) subclasses the documented `summarize()` hook, keeping the KV-prefix-preserving envelope while replacing the instruction with ZCode's nine-section prompt: all user messages listed, security constraints verbatim, analysis-then-summary output. See the [package README](../../packages/tianma/compaction-summarize).
- **Behavioral guidelines** (`@tianma/dsh-behavioral-guidelines`) registers one static system-prompt section carrying ZCode's communication and autonomy discipline. See the [package README](../../packages/tianma/behavioral-guidelines).
- **Token-meter calibration** (`@tianma/dsh-token-meter-calibration`) corrects the pressure measurement compaction reads: the session surface's CJK density ratio times a persisted rolling reported/estimated factor, applied to the meter's own measurement. See the [package README](../../packages/tianma/token-meter-calibration).

## Composition and verification

The [bundle](../../packages/tianma/bundle) applies row overrides after `dsh-base`: two retuned defaults (`retainRatio` 0.35, AGENTS.md budget 256KB) and two row swaps. The static patch verifier asserts every overridden id exists exactly once in the base layer, so upstream drift fails closed. The roadmap and verification protocol live in [`docs-integration-pr-roadmap.md`](../../docs-integration-pr-roadmap.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.md)

Source: [`packages/tianma/token-meter-calibration/src/service.ts`](../../packages/tianma/token-meter-calibration/src/service.ts)
<!-- END GENERATED cordis-surface -->
