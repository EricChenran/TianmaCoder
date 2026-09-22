---
description: "The Tianma bundle: one patch layer adopting ZCode-derived compaction quality defaults and plugins over dsh-base, for deployments composing the Tianma capability set."
kind: "package-bundle"
---

# @tianma/dsh-bundle

English | [中文](README.zh.md)

## Summary

Compose the Tianma capability set over any base-backed profile: list this bundle after `dsh-base` and a mode bundle to raise the verbatim compaction tail, stop silent AGENTS.md truncation, and swap in the recency-preserving pruner and fidelity summarizer. Each capability is one row, independently disabled or retuned without touching code, and a CI verifier fails when upstream row-id drift would leave an override stale.

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

List the bundle after the base and mode bundles in a profile, or pass it through an ordered `--patch` overlay:

```yaml
bundles:
  - '@deepseek-ai/dsh-base'
  - '@deepseek-ai/dsh-web-app'
  - '@tianma/dsh-bundle'
```

Every row the patch overrides keeps its own config block, so a deployment can retune or disable (`disabled: true`) any single capability without touching code.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a static patch document over rows other packages own: it mounts no service, emits no events, and holds no mutable state; each overridden row's package owns that row's behavior and invariants. A patch replaces the targeted row's whole `config`, so each row restates every key it owns, and `scripts/verify-profile-patches.ts` parses this file plus the dsh-base patch to assert each overridden id exists exactly once in the base layer.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: row overrides, one row per capability, with per-row rationale as inline comments |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| — | No runtime invariant companion is published; the package is a static patch-list carrier (a YAML document of loader rows owned by other packages); it mounts no service, emits no events, and owns no mutable relation to check. Each overridden row's own package carries that row's invariants. |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Manifest declaration, parseability, and row-swap checks |

### Invariant ownership

No invariant companion is published because the package is a static patch-list carrier: each overridden row's package owns that row's invariants, and the bundle owns no mutable relation to check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tianma package map](../README.md) — the plugin family this bundle mounts
- [dsh-base bundle](../../bundle/base/README.md) — the layer whose rows are overridden
- [app-boot profiles](../../boot/app-boot/README.md) — how bundles stack in a profile
- [Integration plan](../../../docs-integration-plan.md) — the Tianma roadmap this bundle delivers

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each overridden row's package, which owns that row's model-facing behavior.

#### KV Cache effect

The bundle itself adds no request prefix; each overridden row's package owns any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you where the patch layer needs care. They are current package constraints, not a task backlog.

- **Row replacement restates whole config** — an upstream default change does not flow into an overridden row; the verifier catches id drift, not semantic drift, so upstream upgrades need a row-config review.
- **Capability set is fixed to shipped rows** — adopting a future Tianma package still means editing this patch (one row), not configuration alone.
- **No per-mode restatement** — mode bundles that restate an overridden row's config win over this layer by last-write; a mode-specific Tianma value would need its own mode patch.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
