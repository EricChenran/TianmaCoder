---
description: "Recency-preserving tool-result clearing on the toolResultPruner seam: the active window stays byte-identical while older oversized results clear wholesale, replacing head/middle/tail pruning."
kind: "package-reference"
---

# @tianma/dsh-compaction-recency-pruner

English | [中文](README.zh.md)

## Summary

`dsh-compaction-recency-pruner` registers the same `ctx.toolResultPruner` seam as the upstream pruner, with ZCode microcompact semantics: the most recent `keepRecentResults` tool results are never touched regardless of size, and older oversized results from whitelisted volume-heavy tools (`read`, `grep`, `bash`, …) are cleared wholesale to one `[Old tool result content cleared]` marker line. Degradation is shaped "new context intact, old context zeroed" — never "everything partially truncated", which is the upstream failure mode for code tasks whose load-bearing span sits in the middle of a fresh read.

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

Mount this plugin **instead of** `dsh-compaction-tool-result-pruner` (the Tianma bundle swaps the `tool-result-pruner` row). It is invoked by the same compaction trigger pipeline — `dsh-compaction-basic` calls `pruneSession` when pressure qualifies — so it inherits the trigger gating for free. The idle-timeout trigger from ZCode's microcompact is deliberately out of scope here: scheduling belongs to the trigger pipeline, not the clearer.

| Field | Default | Meaning |
|---|---|---|
| `keepRecentResults` | `5` | Results this recent (surface order) are never cleared |
| `thresholdChars` | `8192` | Clear an older result only when its text exceeds this many code points |
| `minCharsSaved` | `1024` | Skip candidates saving less (ZCode's 256-token gate at 4 chars/token) |
| `compactableTools` | read/write/edit/glob/grep/bash/pwsh/web_search/web_fetch | Whitelist; empty list means every tool |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`pruneSession` resolves tool names from `tool/call` log events (not surface nodes), collects `tool/result` surface candidates, excludes the active-window tail, and for each eligible candidate lands the same replay-safe transaction as the upstream pruner: a `compaction/prune` shadow-price event pricing the shadowed node through `ctx.tokenMeter`, then a `tool/result` replacement citing the shadowed seq. The original text blocks collapse to one marker line; rich blocks (images with logged offload selections) are preserved in order. The complete original remains in the append-only session log for exact replay.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The seam service: candidate collection, active-window guarantee, clearing transaction |
| [`src/config.ts`](src/config.ts) | Policy resolution and defaults; the cleared marker |
| [`src/types.ts`](src/types.ts) | Config and result contracts |
| [`tests/recency-pruner.spec.ts`](tests/recency-pruner.spec.ts) | Active-window byte-identity, threshold/whitelist/savings gates, replacement shape, shadow-price protocol, plugin load |
| — | No runtime invariant companion is published; the service rewrites surface nodes through the session's own validated append transaction and exposes no package-owned event that an independent companion could observe. |

### Invariant ownership

No invariant companion is published because every mutation flows through `Session.append`'s canonical surface-contract validation; the plugin owns no separate mutable relation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [upstream tool-result pruner](../../compaction/compaction-tool-result-pruner/README.md) — the head/middle/tail behavior this replaces
- [compaction-basic](../../compaction/compaction-basic/README.md) — the trigger pipeline calling this seam
- [spill family](../../spill/README.md) — out-of-context storage with retrieval, a stricter alternative for huge outputs

-----

<a id="model-experience"></a>
## Model Experience

### Cleared old tool result

#### What the model sees

Older oversized whitelisted results become exactly one text line: `[Old tool result content cleared]`. The most recent `keepRecentResults` results — and every below-threshold or non-whitelisted result — stay byte-identical, including rich blocks.

#### Token effect

Each cleared result drops from its full text size to 33 code points; the shadow-price event keeps replay accounting exact.

#### KV Cache effect

Surface replacement rewrites existing history nodes, invalidating the KV prefix from the first replaced node onward — the same effect the upstream pruner's replacements have.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when to keep the upstream pruner instead. They are current package constraints, not a task backlog.

- **Event-level recency, not round grouping** — the window counts tool-result events, not ZCode's assistant-round groups; interleaved turns can keep slightly more than the group equivalent.
- **No idle-time trigger** — ZCode's 60-minute idle clearing is out of scope; clearing runs only from the compaction trigger pipeline.
- **Whitelist is name-exact** — custom or renamed tools need explicit `compactableTools` entries; an empty list clears every tool's old results.
- **Cleared means re-readable, not recoverable in-context** — the model must re-read a cleared file to see it again; the append-only log keeps the original for replay and audit only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Semantics port from ZCode's `microcompact.ts` (keep-recent-5, 256-token savings gate); the char-based translation at 4 chars/token is documented in the config table.

</details>
