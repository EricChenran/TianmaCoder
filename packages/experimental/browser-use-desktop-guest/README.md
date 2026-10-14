---
description: "Experimental desktop-guest browser tools: one shell lease per live Session driven through the Electron browser control seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-desktop-guest

English | [中文](README.zh.md)

## Summary

Mount beside the [browser-use service](../../browser-use/browser-use/README.md) to give a Session's model the desktop browser tool catalog (navigate, snapshot, aria, elementInfo, screenshot, viewport, record, downloads, dialog, state, click, hover, fill, check, type, press, scroll, cuaKeypress, cuaScroll, cuaDrag, back, forward, reload, select, wait, tabs, copy, paste): the tools drive one hardened guest web page that the Electron shell owns, reusing the workspace's sidebar-browser login state. The guest lives with the live Session — one lease per Session, released when the Session runtime is disposed. Browser state is not restored from the Session log.

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
- **Downloads are tracked per lease** — a download is attributed to the tab that was active when it started, and the residency limit will not close a tab while one of its downloads runs. The list covers the current lease only.
- **Selector searches cover same-origin frames only** — the element probe descends through frames the page lets it read and adds their offsets, so `click`, `hover`, `elementInfo`, and `wait` reach elements inside those frames. A cross-origin frame cannot be read or driven from the page's own world, so the miss names it instead of searching it; address that content with explicit coordinates.
- **Page dialogs are answered through the DevTools protocol** — the shell attaches a debugger session to each guest it creates so `browser_dialog` can list and answer `alert`, `confirm`, `prompt`, and `beforeunload` instead of the page blocking forever. A guest whose debugger is already owned, such as one with DevTools open, has no dialog channel and reports that the dialog could not be answered.
- **A dead renderer heals on the next command** — when a renderer process dies the shell drops that tab's ref cache, reports the tab as crashed to the pane and to `browser_tabs list`, and reloads the page before the next command that touches it. `browser_tabs list` is exempt so the crash stays visible, and a reload that the carrier refuses leaves the tab usable only for closing.
- **Interaction and capture need a presented surface** — the shell attaches this guest at the rectangle the Sidebar pane reported for the same Session, or at the configured `watch` rectangle; a pane whose report measured no area counts as not presenting. A lease nothing presents is parked inside the window at one pixel: the page keeps a real, if tiny, layout, so navigation and DOM reads still work, while clicking, typing, and screenshots need the pane or watch surface to give the page its size. A view placed outside the window instead would be fully clipped, and Chromium then gives the renderer a zero-sized viewport with no layout at all.
- **A requested viewport governs layout by scaling** — once `browser_viewport` names a size, that size is the page's layout viewport on every surface the lease attaches at: a surface the viewport fits draws it at its own size, one it does not fit is scaled down rather than clipped, and input the page reports in layout coordinates is scaled back into view coordinates on the way in. Until a pane presents the lease the size is recorded and takes effect when one does.
- **A tab is spared by the residency limit while it is in use** — selected, visible, operating, capturing, downloading, waiting on a dialog, loading, playing audio, or playing media. A suspended or idle background tab is not, so an overflowing pool closes the least recently used one.
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
