---
description: "The Tianma bundle patch: row overrides adopting ZCode-derived compaction quality defaults and plugins over dsh-base, for deployments composing the Tianma capability set."
kind: "package-reference"
---

# @tianma/dsh-bundle

English | [中文](README.zh.md)

## Summary

The Tianma bundle is a distribution patch layer applied after `dsh-base` (and any mode bundle) in a profile's bundle list. Each row overrides one dsh-base row by id — adopting a retuned default or swapping in a Tianma plugin — so every capability is independently revertible by removing its row, and `pnpm run verify:profile-patches` fails CI when upstream id drift would leave an override stale.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)

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
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Manifest declaration and parseability checks |

### Invariant ownership

No invariant companion is published because the package is a static patch-list carrier: each overridden row's package owns that row's invariants, and the bundle owns no mutable relation to check.

</details>
