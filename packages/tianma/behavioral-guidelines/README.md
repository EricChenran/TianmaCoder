---
description: "ZCode-derived behavioral prompt sections as one named system-prompt contribution, for deployments that want stable communication and autonomy discipline across personas."
kind: "package-reference"
---

# @tianma/dsh-behavioral-guidelines

English | [中文](README.zh.md)

## Summary

`dsh-behavioral-guidelines` registers one named system-prompt section — `tianma:behavioral-guidelines`, ordered after the deployment persona prefix — carrying the behavioral copy ported from ZCode's hand-tuned `dynamic-sections.ts`: how to communicate with the user (final message carries the outcome, readability over compression), how to manage context and autonomous progress (act when informed, stop only on genuine scope changes, never end a turn on a promise), and code-comment discipline. The words are static by design: deployments tune placement by patching the row, not by editing the text, and a snapshot test pins the wording against drift.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin wherever agents run and the behavioral discipline should survive persona changes. The Tianma bundle inserts it as the `tianma-behavioral-guidelines` row; a deployment can disable it per profile with `disabled: true` or reorder by patching the row.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin holds no state: `apply` injects the `systemPrompt` service and registers one static section through `ctx.systemPrompt.section()`, so the effect unwinds with the plugin. Section order `100` sits between `DEPLOYMENT_PERSONA_PREFIX` (0) and `PLAN_POLICY` (500), so every persona keeps the same behavioral floor.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Section text and the one-effect plugin |
| [`tests/behavioral-guidelines.spec.ts`](tests/behavioral-guidelines.spec.ts) | Seam registration, ordering against the persona prefix, verbatim content, snapshot pin |
| — | No runtime invariant companion is published; the plugin registers one static prompt section through the system-prompt seam and exposes no event, service, or state an independent companion could observe. |

### Invariant ownership

No invariant companion is published because the plugin owns no mutable relation: the section either is registered (asserted by test) or the plugin is unloaded.

</details>
