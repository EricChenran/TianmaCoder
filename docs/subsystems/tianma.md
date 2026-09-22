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
- **Token-meter calibration** (`@tianma/dsh-token-meter-calibration`) ships the CJK-aware split-density estimator and rolling usage factor cores; wiring lands separately. See the [package README](../../packages/tianma/token-meter-calibration).

## Composition and verification

The [bundle](../../packages/tianma/bundle) applies row overrides after `dsh-base`: two retuned defaults (`retainRatio` 0.35, AGENTS.md budget 256KB) and two row swaps. The static patch verifier asserts every overridden id exists exactly once in the base layer, so upstream drift fails closed. The roadmap and verification protocol live in [`docs-integration-pr-roadmap.md`](../../docs-integration-pr-roadmap.md).
