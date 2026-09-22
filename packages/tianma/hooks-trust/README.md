---
description: "Hook trust admission for third-party workspace hooks: a content-hash ledger where unchanged approvals pass, any change re-opens review, and denials persist across restarts."
kind: "package-reference"
---

# @tianma/dsh-hooks-trust

English | [中文](README.zh.md)

## Summary

Run third-party workspace hooks only when their exact command text has been approved. The ledger hashes each command (sha256) and records the decision: identical commands with an `approved` record pass, a single changed byte re-opens review, `denied` decisions persist across restarts, and a corrupted ledger fails closed to full review.

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

Mount the plugin to expose the ledger at `ctx.tianmaHookTrust`; a hook runner calls `evaluate(command, source)` before executing and `decide(command, state, source)` after a user ruling. Config: `ledgerPath` (default `<home>/.dsh/tianma-hook-trust.json`).

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`HookTrustStore` keeps a hash-keyed map of decisions, persisted as a versioned JSON document; restore tolerates absence and treats corruption as fail-closed (everything re-opens review). `apply` registers the store as the `tianmaHookTrust` service.

### Source map

| File | Role |
|---|---|
| [`src/store.ts`](src/store.ts) | Hashing, decisions, persistence, fail-closed restore |
| [`src/index.ts`](src/index.ts) | The service registration and config |
| [`tests/hooks-trust.spec.ts`](tests/hooks-trust.spec.ts) | Review-on-unknown, change-reopens, denial persistence, corruption fail-closed |
| — | No runtime invariant companion is published; the store is a hash-keyed ledger whose window-free decisions are asserted directly by test. |

### Invariant ownership

No invariant companion is published because the ledger owns no derived relation: each record is an independent decision fact.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [hooks bridges](../../hooks/README.md) — the Claude Code/Codex hook runners this ledger is built to gate

-----

<a id="model-experience"></a>
## Model Experience

### Hook admission ledger

#### What the model sees

Nothing. The ledger gates hook execution admission before commands run; its decisions are process-local state and never enter a request. The admission contract is the pair of calls a runner wraps around execution.

##### Admission contract

```markdown
const decision = trust.evaluate(command, source)   // 'approved' | 'denied' | 'review'
trust.decide(command, state, source)               // record the user's ruling
```

#### Token effect

Zero — no request surface changes.

#### KV Cache effect

None — nothing is added to or removed from any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the v1 boundary. They are current package constraints, not a task backlog.

- **Library first** — the upstream hooks runners do not call this ledger yet; wiring them is the follow-up (an upstream seam discussion).
- **Exact-command hashing** — whitespace differences count as different hooks; normalization is deferred.
- **No UI** — decisions are recorded programmatically; a review UI lands with the runner integration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Ported from ZCode's hooks trust layer (trust-domain/records/evaluation) in the minimal ledger form; the runner integration is the remaining half.

</details>