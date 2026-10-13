---
description: "Wire contract for the Host browser control seam between Host plugins and the Electron shell's embedded browser guests."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-browser-control

English | [中文](README.zh.md)

## Summary

Types and narrow guards for one IPC seam: Host plugins request embedded-browser operations (lease, execute, release) and the Electron shell answers with correlated results and unsolicited guest events. The package pins only the envelope — request correlation, the three operations, the result union with its stable error codes, and the event shape. It stores no browser state and executes nothing.

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

The desktop host imports the client contract and exposes it to plugins as the `desktopBrowserControl` Cordis service; the Electron shell imports the request and result shapes for its own inbound validation. Import the package root for any of: the request union, the result and event unions, the `isBrowserControlRequest`/`isBrowserControlMessage` guards, the `DesktopBrowserControl` client interface, or the `BrowserControlError` with its stable `code`.

### Wire shapes

One request is a single discriminated object (`type: 'browser'`) carrying a `requestId` plus one `acquire`, `execute`, or `release` variant. The shell answers with `type: 'browser-result'` under the same `requestId`, `ok` plus either a JSON `result` or an `error` with an optional stable `code`. Unsolicited facts travel as `type: 'browser-event'`. Every message body must survive structured clone; the `BrowserControlJson` type is the boundary for anything an operation carries.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [source](src/index.ts) is types, two guards, and one error class; it has no runtime dependencies and no I/O. `BrowserControlRequestInput` is a distributive `Omit` so each operation keeps its own fields when a plugin builds a request without the envelope. The [desktop host](../../../apps/desktop-host/src/browser-control.ts) wraps this contract with the request client and its Cordis service registration; the [shell](../../../apps/desktop/src/browser-control-main.ts) redeclares validation at its own trust boundary and dispatches to guest handling.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package ships types, guards, and one error class only.

#### KV Cache effect

None; the package adds no model-visible content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Envelope only** — the command vocabulary inside `execute` is owned and validated by the Electron shell; this package pins the envelope and cannot describe which commands exist.
- **One transport assumption** — the shapes assume structured-clone IPC; transports that cannot carry them need their own contract.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The shell revalidates inbound messages with its own guard on purpose; keep the two guards literal-identical when changing shapes, and update the seam contract spec in `apps/desktop/tests` in the same change.

</details>
