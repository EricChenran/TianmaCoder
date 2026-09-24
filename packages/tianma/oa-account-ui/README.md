---
description: "Tianma OA account surfaces for the Web GUI: the captcha sign-in dialog, the sidebar account launcher, and the Settings page that shows and edits the signed-in profile."
kind: "package-reference"
---

# @tianma/dsh-oa-account-ui

English | [中文](README.zh.md)

## Summary

The browser half of the Tianma OA account system: one snapshot from the Host's `oaAccount` Remote namespace backs the sign-in dialog, the sidebar launcher, and the Settings section showing the signed-in profile, its counters, and an editor for the fields its owner may change. Both surfaces read that one snapshot, so they cannot disagree about who is signed in, and no token reaches the browser. It also carries the client half of the conversation gate: while no account is signed in, every live session's composer is inert and names the reason.

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

Mount the plugin next to the settings shell, and mount the Host half ([@tianma/dsh-oa-account](../oa-account/README.md)) in the same composition: the browser half calls `remote.oaAccount` and renders nothing meaningful without it.

It registers the sidebar launcher in `settings.launcher` and the Settings page in `settings.section` (`id: 'oa-account'`, first) under the locale namespace `settings.oaAccount`, in English and Chinese.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply` keeps one `OaAccountSnapshot` and publishes it through the inject face's `hooks.oaAccount`, which the renderer binds as the `useOaAccount` seat; components subscribe to nothing themselves. The session stream is the only live source: each frame replaces the session projection and re-reads the profile and counters, and a terminal stream failure marks the snapshot failed rather than hiding the surfaces.

The sign-in dialog owns the captcha lifecycle. A challenge is single-use, so an attempt that the backend refuses always fetches a new one while keeping the typed account and password — a human's retry is rarely a fresh account name.

The composer cannot read this plugin — the dependency runs one way — so the gate is pushed rather than read: the plugin writes each live session into the conversation service's block registry and re-syncs on every snapshot change and every session-list change. The Host refuses the same prompt independently, so the two halves are one decision seen from both planes.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | The snapshot, the operations, and the slot registrations |
| [`src/client/SignInDialog.tsx`](src/client/SignInDialog.tsx) | The captcha sign-in form |
| [`src/client/AccountMenu.tsx`](src/client/AccountMenu.tsx) | The sidebar launcher and its avatar resolution |
| [`src/client/AccountSection.tsx`](src/client/AccountSection.tsx) | The Settings page: profile, counters, and the editor |
| [`src/client/composer-block.ts`](src/client/composer-block.ts) | The pushed composer block for the sessions the client lists |
| [`src/client/locales.ts`](src/client/locales.ts) | The English and Chinese dictionaries |
| [`src/client/contract.ts`](src/client/contract.ts) | The snapshot and injected-operation contract |

### Invariant ownership

No invariant companion is published: the plugin keeps no independent credential or account state, so there is no second observation that could diverge from the Host's.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [account package](../oa-account/README.md) — the Host service these surfaces render
- [settings subsystem](../../../docs/subsystems/settings.md) — the shell that owns the section and launcher slots

-----

<a id="model-experience"></a>
## Model Experience

### OA account surfaces

#### What the model sees

Nothing. These are presentation surfaces over Host-owned account state; no account fact enters a prompt, a tool result, or a request. The only effect a model can observe is indirect: while no account is signed in, `session/prompt` is refused before a turn begins.

#### Token effect

Zero — the browser half adds no request content.

#### KV Cache effect

None — nothing is added to or removed from any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current boundary.

- **The editor covers the name and the phone number.** An avatar is displayed but not edited from the GUI, and changing a password is a separate backend flow that this package does not implement.
- **The launcher shows localized copy until the profile answers.** The account name needs the profile read; before it lands the launcher says "Signed in" rather than showing a stale name.
- **Failure copy is the backend's own message.** A refused attempt shows what the backend said (for example, a disabled account) and falls back to localized copy only when the backend sends no message, so the product never invents a reason the backend did not give.
- **One status mapping.** `active` / `disabled` / `banned` are rendered from the account status; a status this build has never seen renders as unknown rather than as usable.
- **The surfaces render only where the composition mounts the account service.** A profile without the Host half has no account surfaces at all.
- **The client gate is pushed, not read.** The composer's block registry is the only channel the one-way dependency allows, so the plugin writes it directly and clears it when it unloads; a deployment that mounts the account UI without the conversation service keeps the Host-side refusal and loses only the disabled composer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Deliberately does not claim `settings.models.sign-in`: that slot is the model-credential onboarding, and the OA account token is not used for model requests, so both surfaces have to coexist.

</details>
