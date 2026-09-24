---
description: "Tianma OA user account: captcha sign-in, the dual-token session kept in the credential seam's records, the single silent re-sign on 401, and the signed-in gate the browser prompt path reads."
kind: "package-reference"
---

# @tianma/dsh-oa-account

English | [中文](README.zh.md)

## Summary

Sign the product's user in against the Tianma OA backend and decide whether a conversation may start. One Host service owns the captcha challenge, the token pair, the stored account projection, and the profile, workbench, and profile-write operations the Settings page renders. The same plugin mounts `ctx.promptAdmission`, so the browser prompt path refuses a conversation until a signed-in account is `active`. Tokens live in the credential seam's records; the browser never receives one.

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

Mount the plugin in a bundle that carries an interactive user. Only the Web application bundle does, so the automation profiles (`headless`, `acp`, `sdk`) keep running without an account.

Config: `baseUrl` (required; the OA API root including its version segment), `requestTimeoutMs` (default 30 000), `requireSignIn` (default `true`; turning it off mounts the surfaces without gating the product).

The Remote namespace `oaAccount` exposes `session`, `captcha`, `signIn`, `signOut`, `profile`, `stats`, `updateProfile`, `gate`, and the `watch` stream. The browser half of [@tianma/dsh-oa-account-ui](../oa-account-ui/README.md) consumes it.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The session is one grant record, `tianma-oa-account/session`, written through `ctx.credentials`: the credential seam supplies the atomic write, the cross-process file lock, and the owner-only mode, so the tokens survive restarts and a sign-out in one process is visible to the next call in another. A record this plugin cannot parse reads as signed out rather than as an error.

`authorized()` is the one protected-request path: it reads the stored access token, runs the request, and on a single `401` exchanges the stored refresh token for a new access token before retrying once. A refused re-sign deletes the record and reports the backend's own reason, which is what distinguishes a disabled account from an expired token in the surfaces.

`gate()` reads the stored status and decides whether a conversation may start; `OaPromptAdmission` publishes that decision through `ctx.promptAdmission`, the extension point `SessionCommandController.prompt` consults before any session work. Account status is therefore re-checked by the backend on every request, and a status the backend flips behind a stored session takes effect at the next conversation.

### Backend contract notes

The shipped backend differs from the specification in three places the wire layer absorbs, and each is exercised against the live backend rather than assumed:

| Specification | Shipped backend | This package |
|---|---|---|
| `captcha_code` | `captcha` | sends both spellings, so either contract authenticates |
| `image` | `img` | accepts either key |
| `refresh` returns `token`, `refresh_token`, and `user` | returns `token` alone | keeps the stored refresh token and re-reads the profile instead |

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service, the stored-session schema, the gate, and `OaPromptAdmission` |
| [`src/protocol.ts`](src/protocol.ts) | Base-URL validation, the envelope, and the closed failure vocabulary |
| [`src/types.ts`](src/types.ts) | The account projection and the failure and gate vocabularies |
| [`tests/oa-account.spec.ts`](tests/oa-account.spec.ts) | Stored session, single re-sign, status gate, refusal codes, envelope failures |

### Invariant ownership

No invariant companion is published: the service owns no relation an independent observer could see diverge. The stored record is read through the credential seam on every call, so a stale in-memory copy cannot exist.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [credential subsystem](../../../docs/subsystems/credentials.md) — the records this session is stored in
- [approval subsystem](../../../docs/subsystems/approval.md) — the other question the prompt path asks before a turn

-----

<a id="model-experience"></a>
## Model Experience

### OA account

#### What the model sees

Nothing. Account state gates whether a conversation starts at all; once it starts, no account fact enters a request, a prompt section, or a tool result. A refusal is a business error on the `session/prompt` call that the caller reports to the human, not a model-visible message.

#### Token effect

Zero — the account adds no request content.

#### KV Cache effect

None — nothing is added to or removed from any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current boundary.

- **The gate covers the browser prompt path.** `SessionCommandController.prompt` is where every browser prompt — send, queue, and steer — enters a session, so it is where the check lives. Automation entry points that carry no interactive user (SDK, ACP, schedule, webhook) mount no admission check and stay ungated by design.
- **Sign-out is local.** The backend keeps no token revocation list, so signing out discards the record and the next request's status check is what actually ends a session.
- **No scheduled renewal.** The access token is refreshed on the next `401` rather than ahead of its two-hour expiry.
- **Two spellings are sent for the captcha answer.** The tolerance exists because the specification and the shipped backend disagree; it can be reduced to one spelling once the backend settles.
- **The profile write covers the fields the account owner may change** (`name`, `phone`, `avatar`); password changes are a separate backend flow and are not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Replaces the DeepSeek account login this product shipped before: the seam, the provider, the Remote controller, and the browser surfaces were removed rather than adapted, and inference authentication no longer consults any account service.

</details>
