---
description: "Tianma integration packages: ZCode-derived quality plugins composed over dsh through profile patches, never by patching upstream packages."
kind: "package-group"
---

# tianma/ — Tianma integration family

English | [中文](README.zh.md)

## Summary

Subsystem reference: [`docs/subsystems/tianma.md`](../../docs/subsystems/tianma.md)

The `tianma/` group carries the TianmaCoder secondary-development surface for DeepSeek Harness: plugins porting ZCode's context-compaction quality mechanisms (recency-preserving pruning, fidelity summarization, token-meter calibration) plus the bundle that mounts them. Packages register only through upstream seams (`ctx.*`); upstream `@deepseek-ai/dsh-*` internals are never imported except through each package's documented public extension point. Every mount happens as a profile patch row replacement, so each capability rolls back by removing one row.

## Table of Contents

- [Packages](#packages)
- [Composition](#composition)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`bundle/`](bundle/README.md) | The Tianma bundle: profile patch replacing dsh-base rows to adopt Tianma defaults and plugins |
| [`behavioral-guidelines/`](behavioral-guidelines/README.md) | ZCode-derived behavioral prompt sections registered as a named system-prompt contribution |
| [`department-prompts/`](department-prompts/README.md) | Department operating rules for the shipped 技术部 / 商务部 modes, plus the 商务部 document toolbox |
| [`compaction-recency-pruner/`](compaction-recency-pruner/README.md) | Recency-preserving tool-result clearing replacing the head/middle/tail pruner |
| [`compaction-summarize/`](compaction-summarize/README.md) | Fidelity compaction summarizer subclassing the documented `summarize()` hook |
| [`token-meter-calibration/`](token-meter-calibration/README.md) | CJK-aware density estimation and usage-driven calibration factors |
| [`compaction-file-rehydrator/`](compaction-file-rehydrator/README.md) | Post-compaction read-file ledger rebuilt from the append-only log, injected as a scoped prompt section |
| [`hooks-trust/`](hooks-trust/README.md) | Content-hash trust ledger for third-party workspace hooks |

<a id="composition"></a>
## Composition

Add the Tianma bundle after `dsh-base` (and any mode bundle) in a profile's bundle list. Its `cordis.patch.yml` overrides dsh-base rows by id; `scripts/verify-profile-patches.ts` fails CI when an upstream id drifts so a stale override can never ship silently. Each replaced row keeps the plugin's own config block, so a deployment can retune or disable (`disabled: true`) any single capability without touching code.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Why patches instead of editing upstream defaults</summary>

The roadmap (`docs-integration-pr-roadmap.md`) fixes the delivery shape: independent packages plus profile patch rows, upstream files untouched. That keeps upstream merges conflict-free, makes every capability independently revertible, and lets the patch verifier prove the wiring stays intact.
</details>
