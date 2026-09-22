---
description: "Fidelity compaction summarizer subclassing the documented summarize() hook: ZCode's nine-section verbatim-preservation prompt with NO_TOOLS bookends, KV-prefix-preserving envelope unchanged."
kind: "package-reference"
---

# @tianma/dsh-compaction-summarize

English | [中文](README.zh.md)

## Summary

`dsh-compaction-summarize` is `BasicCompactionEngine` with one override: the documented `summarize()` customization hook. The auxiliary call keeps the upstream envelope exactly — replayed prefix, same tool schemas, instruction as the final user message — so the provider's KV prefix cache is reused. What changes is the instruction, ported from ZCode's hand-tuned compaction prompt: nine fixed sections, **every user message listed faithfully with security constraints preserved verbatim** (re-anchoring intent each compaction generation against chain-of-decay), a forced `<analysis>`-then-`<summary>` output shape, and NO_TOOLS bookends guarding the text-only turn. The `<analysis>` scratchpad is discarded; only the extracted `<summary>` lands as the checkpoint, and untagged output passes through as a tolerant fallback.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)

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
