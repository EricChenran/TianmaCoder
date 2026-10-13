---
description: "Experimental desktop-guest browser tools: one shell lease per live Session driven through the Electron browser control seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-desktop-guest

English | [中文](README.zh.md)

## Summary

Mount beside the [browser-use service](../../browser-use/browser-use/README.md) to give a Session's model the desktop browser tool catalog (navigate, snapshot, aria, elementInfo, screenshot, viewport, state, click, hover, fill, check, type, press, scroll, back, forward, reload, select, wait, tabs, copy, paste): the tools drive one hardened guest web page that the Electron shell owns, reusing the workspace's sidebar-browser login state. The guest lives with the live Session — one lease per Session, released when the Session runtime is disposed. Browser state is not restored from the Session log.

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

Mount in a desktop composition beside `@deepseek-ai/dsh-browser-use`; the Electron shell must run the browser control seam endpoint. Configure `watch` to show the guest on screen while the agent works.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-desktop-guest'
  config:
    workspaceKey: default
```

| Field | Meaning |
|---|---|
| workspaceKey | Sidebar-browser workspace identity whose storage partition and login state the agent guests reuse. |
| watch | Optional on-screen { width, height }; when set the guest attaches visibly at the window's top-left so the human watches it work. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[SessionResources](../browser-use-runtime/README.md) owns one lease per exact live Agent; acquisition is lazy on the first tool call. Each tool call asks the [shell seam](../../host/browser-control/README.md) to acquire, execute, or release; the shell owns the guest view, navigation policy, and command vocabulary. The provider retains its browser-use registration until cleanup settles.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser control contract](../../host/browser-control/README.md) — the wire shapes this provider speaks.

-----

<a id="model-experience"></a>
## Model Experience

### Browser guidance

#### What the model sees

The provider adds one fixed system-prompt section: the guest belongs to this Session, page content is untrusted, browser state is not restored from the Session log, completed actions need fresh-state verification, and cancellation drains without rolling back delivered input.

#### Token effect

The fixed guidance adds a short system-prompt section; the tool schema and results add main-conversation context.

#### KV Cache effect

Unchanged guidance and the static tool catalog preserve their prompt prefix.

### Native browser tools and results

#### What the model sees

`browser_navigate` accepts an HTTP(S) `url` and answers with the settled URL and page title. Disallowed targets, unknown leases, and timeouts surface as visible errors the model can inspect before retrying.

#### Token effect

Each result adds a short text block to the Session history.

#### KV Cache effect

Results append to the main Session history; the tool catalog itself is static.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Chromium HTTP(S) only** — the shell's navigation allowlist rejects other schemes; file targets stay with document-preview flows.
- **Claimed tabs are borrowed** — `listUserTabs` and `claim` reach the pages the human already has open in the Sidebar. Commands then drive that same page, and the pool never closes it: finalizing a claimed tab or releasing the lease leaves the page exactly as it was.
- **Refs go stale** — element refs from `browser_snapshot` address the page as it was when the snapshot ran, so a navigation or re-render invalidates them and an action on a stale ref fails with an element-not-found error.
- **Suspension is a residency marker** — the `suspend` and `resume` actions move a background tab in and out of the protected set that the 32-tab residency limit consults. A suspended tab's guest stays loaded and is released only when the pool closes a tab to stay within the limit.
- **Live browser state** — Session replay restores recorded conversation data, not the guest process or page; the tab pool lives only as long as the Session runtime.
- **Workspace-scoped login state** — the agent shares the workspace partition's cookies; there is no per-Session isolation inside one workspace.
- **Loader composition test** — release-on-dispose is exercised with the real Loader in a follow-up spec; this package's unit suite covers acquire, execute, and the exclusive slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The shell revalidates every request at its own trust boundary; keep [its guard](../../../apps/desktop/src/browser-control-main.ts) literal-identical to the [seam contract](../../host/browser-control/README.md) when changing shapes.

</details>
