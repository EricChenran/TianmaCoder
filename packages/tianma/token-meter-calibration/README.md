---
description: "CJK-aware density pricing plus a rolling usage-calibration factor, wired into the token meter so Chinese-heavy sessions stop reading 2–3x light."
kind: "package-reference"
---

# @tianma/dsh-token-meter-calibration

English | [中文](README.zh.md)

## Summary

The upstream token meter prices all text at a flat 4 chars/token, under-pricing CJK-heavy sessions by 2–3× so pressure reads low and compaction triggers late. This package mounts the correction on the meter: a split-density estimator (`estimateTextTokensCalibrated`, CJK spans at 1.5 chars/token, everything else at 4) supplies a per-session density ratio, and a `CalibrationFactor` — the rolling median of reported/estimated ratios, clamped to [0.25, 4] — closes the residual against provider usage. The plugin rewrites the meter's measurement by that product, leaving a provider-usage baseline untouched, so a non-CJK surface with no sample stays bit-identical.

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

Mount the package as a Cordis plugin; it injects `tokenMeter`, registers `ctx.tianmaTokenCalibration`, and corrects every measurement the meter produces for the session being measured. The plugin records one sample per provider-reported call and writes the factor to `<harness home>/tianma-calibration.json` when it unloads.

```yaml
- id: tianma-token-calibration
  name: '@tianma/dsh-token-meter-calibration'
  config:
    window: 256
```

| Config key | Default | Meaning |
|---|---|---|
| `statePath` | `<harness home>/tianma-calibration.json` | Calibration state file. |
| `window` | `256` | Rolling reported/estimated sample window. |

`ctx.tianmaTokenCalibration` exposes `factorValue` (the residual multiplier, 1 before any sample), `sampleCount`, `estimateSession(session)` (both density prices over the session's model-visible surface), `sessionMultiplier(session)` (density ratio times residual), `record(estimated, reported)`, and `persist()`.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Two independent corrections multiply. The **density ratio** is `calibrated ÷ flat` over `session.deriveMessages()`: both terms price the same messages through the same structural overheads, so those cancel and only the text-density difference survives. The **residual factor** is the median of clamped `reported ÷ estimated` ratios over a 256-sample window, seeded from the persisted snapshot as one aggregate sample so the window bound holds across restarts.

Applying the product rewrites the measure's heuristic quantities: node prices, the surface total, the signed surface delta, and an `estimated` baseline all scale, while a `usage` baseline — provider ground truth — passes through. `surfaceTokens` stays the sum of the node prices and `totalTokens` stays `baseline + surfaceDeltaTokens` floored at zero, so every documented measure invariant survives the rewrite. A multiplier of exactly 1 returns the meter's own object.

Samples come from `assistant/message` events carrying `usage`; the estimate paired with each is the calibrated price of the session surface at that point, so the residual tracks the gap the density split leaves.

### Source map

| File | Role |
|---|---|
| [`src/density.ts`](src/density.ts) | CJK counting and split-density text estimation |
| [`src/estimate.ts`](src/estimate.ts) | Message pricing under a selectable density |
| [`src/surface.ts`](src/surface.ts) | Session-surface density prices and ratio |
| [`src/factor.ts`](src/factor.ts) | Rolling median calibration factor with versioned snapshots |
| [`src/measure.ts`](src/measure.ts) | Measurement rescaling that preserves the measure invariants |
| [`src/service.ts`](src/service.ts) | `UsageCalibrator` state container, usage scanning, persistence |
| [`src/index.ts`](src/index.ts) | Plugin: namespace exports, meter correction, usage sampling |
| [`tests/token-meter-calibration.spec.ts`](tests/token-meter-calibration.spec.ts) | ASCII bit-compatibility, CJK counting, the 10% deviation benchmark, factor robustness |
| [`tests/wiring.spec.ts`](tests/wiring.spec.ts) | Real-meter composition: ASCII identity, CJK correction, sampling, dispose |
| [`tests/coverage.spec.ts`](tests/coverage.spec.ts) | Pricing branches, default state paths, unusable persisted state |
| — | No runtime invariant companion is published; the package owns no cross-plugin relation, and its two mutable relations — the factor window and the measure rewrite — are asserted by test. |

### Invariant ownership

No invariant companion is published because the package mutates no shared log or registry state: the factor's window bound is local to each `CalibrationFactor`, and the meter rewrite is installed and removed by one effect whose restoration the wiring spec asserts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [token-meter](../../llm/token-meter/README.md) — the measurement this plugin corrects
- [compaction-basic](../../compaction/compaction-basic/README.md) — the pressure decisions that read it
- [tianma bundle](../bundle/README.md) — the patch list that mounts this row

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the token meter: the plugin rewrites the pressure measurement that compaction reads, so when compaction triggers follows CJK-aware pricing, while no prompt, tool schema, or Session event changes.

#### KV Cache effect

The plugin adds no request surface of its own. A corrected pressure measurement can advance or delay compaction, and a compaction checkpoint replaces the request prefix the following step sends.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the package boundary. They are current constraints, not a task backlog.

- **The correction replaces `tokenMeter.measure`** — the meter publishes no pricing extension point, so the plugin wraps that one method on the service instance for its lifetime and restores it on unload. A native measurement seam would remove the replacement.
- **Densities are global constants** — 1.5/4 chars/token regardless of model; per-model tokenizers would need the adapter seam.
- **The factor is a single global multiplier** — envelope-similarity grouping is deferred; one factor serves all requests.
- **Tool schemas ride the message ratio** — tool schemas are priced by the surface's message density rather than their own, which over-corrects their mostly-ASCII JSON slightly on CJK-heavy sessions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The 10% benchmark pins the split against shifted truth densities (1.6/3.8) so the constants cannot silently regress to flat 4. The wiring spec pins the other half of the contract: a non-CJK surface must measure exactly as the uncalibrated meter does, and disposal must restore both the meter method and the service registration.

</details>
