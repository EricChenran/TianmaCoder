---
description: "Post-compaction file-state rehydration: the read-file ledger rebuilt from the append-only log and injected as an agent-scoped prompt section, so requests after a checkpoint know which files are stale."
kind: "package-reference"
---

# @tianma/dsh-compaction-file-rehydrator

English | [中文](README.zh.md)

## Summary

Keep the model's file memory alive across compaction. After a checkpoint lands, this plugin rebuilds the read-file ledger (paths, read counts, post-read edits) from the append-only session log — the part compaction cannot destroy — and registers it as an agent-scoped system-prompt context, so the next request already knows which files are fresh and which are STALE before it edits.

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

Mount the plugin in any composition whose agents run long sessions with compaction. The Tianma bundle inserts it as the `tianma-compaction-file-rehydrator` row. One config knob: `maxChars` (default 4096) bounds the rendered section.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply` listens for `agent/created` and registers one scoped system-prompt context per agent; the provider re-evaluates on every assembly by rebuilding the view from `agent.session.snapshotEvents()` — tool calls resolve names and arguments, tool results carry outcomes, edits after reads flag STALE. Scoped registration means sessions on other presets are untouched, and the effect unwinds with the plugin.

### Source map

| File | Role |
|---|---|
| [`src/view.ts`](src/view.ts) | The pure ledger builder and bounded renderer |
| [`src/index.ts`](src/index.ts) | The `agent/created` wiring and scoped context registration |
| [`tests/file-rehydrator.spec.ts`](tests/file-rehydrator.spec.ts) | Ledger accounting, STALE flagging, budget bounding, wiring contract |
| — | No runtime invariant companion is published; the plugin registers a derived prompt context and owns no mutable relation beyond the derived view. |

### Invariant ownership

No invariant companion is published because the view is a pure projection of the append-only log: the log owns the facts, this package renders them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [compaction-basic](../../compaction/compaction-basic/README.md) — the checkpoint writer whose aftermath this package smooths
- [system-prompt assembly](../../core/system-prompt/README.md) — the scoped context seam
- [session](../../core/session/README.md) — the append-only log the ledger rebuilds from

-----

<a id="model-experience"></a>
## Model Experience

### Rehydrated file ledger

#### What the model sees

After a compaction checkpoint, the next request includes a context section listing read files with read counts, a STALE flag on files edited since their last read, and an instruction to re-read before editing stale paths. With no reads in the log the section contributes nothing.

#### Token effect

Bounded by `maxChars` (default 4096 chars); typically a few hundred tokens, once per request inside the assembled prompt.

#### KV Cache effect

The section is a dynamic context snapshot appended to the durable message stream; it changes only when the ledger changes, so it rides the reusable prefix between edits.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the rehydrator does not cover. They are current package constraints, not a task backlog.

- **Path resolution is shape-tolerant, not tool-aware** — the ledger keys on `path`/`file_path`/first-string arguments; exotic tool schemas may under-count.
- **Read tools are a fixed set** — `read`/`view` variants only; custom read-like tools need a whitelist extension.
- **Prompt-section only** — the ledger is advice, not enforcement; stale edits are still caught by the fs version guard, not by this section.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Ported from ZCode's read-file-state-hydrator; the dsh shape inverts the storage (ZCode rehydrates an internal map, dsh renders a prompt section from the append-only log — the log keeps the facts so nothing else must persist).

</details>