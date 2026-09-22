---
description: "CJK-aware density pricing and a rolling usage-calibration factor: the measurement cores that fix the 2–3x under-pricing of Chinese-heavy sessions before wiring into the token meter."
kind: "package-reference"
---

# @tianma/dsh-token-meter-calibration

English | [中文](README.zh.md)

## Summary

The upstream token meter prices all text at a flat 4 chars/token, which under-prices CJK-heavy sessions by 2–3×, so pressure reads low and compaction triggers late. This package carries the two measurement cores that fix that: a split-density estimator (`estimateTextTokensCalibrated`, CJK spans at 1.5 chars/token, everything else at 4 — pure-ASCII pricing stays bit-identical to upstream) and a `CalibrationFactor` (a rolling median-of-reported/estimated-ratios multiplier, clamped to [0.25, 4], versioned snapshots for persistence). A CI-pinned benchmark holds mixed-corpus deviation within 10% against tokenizer-representative ground truth while the flat-4 baseline is off by more than half on CJK-heavy text.

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

v1 ships the cores only — pure functions and state containers with no Cordis wiring. The integration step (listening to request usage, wrapping the `tokenMeter` measurement, persisting factors through the storage seam) is a separate follow-up change so this core lands reviewable and CI-pinned first; no bundle row mounts it yet.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The density split counts CJK code points (ideographs, kana, hangul, fullwidth forms, CJK punctuation) once per text and prices each span at its own density; the calibration factor keeps a bounded window of clamped reported/estimated ratios and exposes their median, so one pathological request cannot move pricing far, and a seeded snapshot replays as one aggregate sample keeping the window bound across restarts.

### Source map

| File | Role |
|---|---|
| [`src/density.ts`](src/density.ts) | CJK counting and split-density estimation |
| [`src/factor.ts`](src/factor.ts) | Rolling median calibration factor with versioned snapshots |
| [`src/index.ts`](src/index.ts) | Public exports |
| [`tests/token-meter-calibration.spec.ts`](tests/token-meter-calibration.spec.ts) | ASCII bit-compatibility, CJK counting, the 10% deviation benchmark, factor robustness and round-trips |
| — | No runtime invariant companion is published; the package exports pure functions and state containers with no service, event, or session mutation for an independent companion to observe. |

### Invariant ownership

No invariant companion is published because the package owns no mutable relation outside each `CalibrationFactor` instance, whose window bound is asserted by test.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [token-meter](../../llm/token-meter/README.md) — the measurement these cores calibrate
- [compaction-basic](../../compaction/compaction-basic/README.md) — the pressure decisions that mis-trigger today
- [spill family](../../spill/README.md) — size-driven offload once pressure is measured right

-----

<a id="model-experience"></a>
## Model Experience

None, as v1 ships pure measurement cores and mounts nothing.

#### KV Cache effect

No request surface exists to affect; the cores never see a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the v1 boundary. They are current package constraints, not a task backlog.

- **Cores only, no wiring** — no listener records usage, no `tokenMeter` wrapping, no persistence; the integration is a separate follow-up.
- **Densities are global constants** — 1.5/4 chars/token regardless of model; per-model tokenizers would need the adapter seam.
- **Factor is a single global multiplier** — envelope-similarity grouping is deferred; one factor serves all requests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The 10% benchmark pins the split against shifted truth densities (1.6/3.8) so the constants cannot silently regress to flat 4.

</details>
