---
description: "Fidelity compaction summarizer subclassing the documented summarize() hook: ZCode's nine-section verbatim-preservation prompt with NO_TOOLS bookends, KV-prefix-preserving envelope unchanged."
kind: "package-reference"
---

# @tianma/dsh-compaction-summarize

English | [中文](README.zh.md)

## Summary

`dsh-compaction-summarize` is `BasicCompactionEngine` with one override: the documented `summarize()` hook. The auxiliary call keeps the upstream envelope exactly — replayed prefix, same tool schemas, instruction as the final user message — so the provider's KV prefix cache is reused. What changes is the instruction, ported from ZCode's compaction prompt: nine fixed sections, **every user message listed with security constraints preserved verbatim** (re-anchoring intent each generation against chain-of-decay), forced `<analysis>`-then-`<summary>` output, and NO_TOOLS bookends. The scratchpad is discarded; only the extracted `<summary>` lands, and untagged output passes through.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin **instead of** `dsh-compaction-basic` (the Tianma bundle swaps the `compaction-basic` row; configuration is the same `BasicCompactionConfig` schema). v1 scope notes: per-model policy overrides in `summarize()` resolution are out of scope (configured target → routed target → agent options), and retry/circuit-breaker behavior is inherited from the upstream engine's `compactionRetries`/`maxOverflowRetries` rather than duplicated.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`summarize()` resolves the target, replays `input.messages` plus one final user message carrying `FIDELITY_INSTRUCTION`, streams through `ctx.llm.stream()` with `purpose: 'compaction'`, maps terminal finishes to the upstream fail-closed errors, and extracts the `<summary>` span from the text-only output. Rich output is rejected exactly like upstream. The instruction lives in [`src/instruction.ts`](src/instruction.ts) and the extraction in [`src/extract.ts`](src/extract.ts), both exported for direct testing.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The engine subclass: target resolution, envelope assembly, stream consumption |
| [`src/instruction.ts`](src/instruction.ts) | The fidelity instruction and its nine section headers |
| [`src/extract.ts`](src/extract.ts) | `<summary>` extraction with tolerant fallback and fail-closed guards |
| [`tests/compaction-summarize.spec.ts`](tests/compaction-summarize.spec.ts) | Instruction structure, extraction unit cases, end-to-end compaction with a scripted adapter |
| — | No runtime invariant companion is published; the engine inherits the upstream compaction invariants and owns no additional mutable relation. |

### Invariant ownership

No invariant companion is published because the subclass adds no session mutations: every durable effect flows through the inherited upstream transaction.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [compaction-basic](../../compaction/compaction-basic/README.md) — the engine this subclass extends
- [compaction contract](../../compaction/compaction/README.md) — the durable checkpoint framing this lands into
- [upstream pruner](../../compaction/compaction-tool-result-pruner/README.md) — the first-stage relief before summarization

-----

<a id="model-experience"></a>
## Model Experience

### Compaction instruction

#### What the model sees

The summarizer receives the replayed conversation plus one final user message carrying `FIDELITY_INSTRUCTION`: NO_TOOLS bookends around nine fixed sections, with all user messages listed and security constraints preserved verbatim. The landed checkpoint keeps only the extracted `<summary>` text inside the standard `<compacted-summary>` framing; the `<analysis>` scratchpad never becomes model-visible history.

#### Token effect

The instruction is a one-off final message on the auxiliary call; the landed checkpoint is bounded by `maxTokens`.

#### KV Cache effect

The envelope matches the last routed request (same prefix, same tool schemas), so the auxiliary call reuses the provider's warm prefix cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the fidelity engine does not yet cover. They are current package constraints, not a task backlog.

- **No per-model policy overrides** — `summarize()` target resolution is configured → routed → agent options; `modelPolicies` entries do not reach the fidelity call in v1.
- **Retry behavior is inherited, not ZCode's** — overflow retries come from the upstream engine; ZCode's consecutive-failure circuit breaker is not duplicated.
- **Untagged output passes through** — a provider ignoring the tag shape still lands a checkpoint, but without the nine-section structure.
- **Instruction is English** — the prompt craft has no localized variant.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The prompt ports from ZCode's `prompt.ts`; PR-5 (file rehydration) will consume this package's checkpoint semantics.

</details>
