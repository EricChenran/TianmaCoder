---
description: "Tianma MPS executor-node surfaces for the Web GUI: the Settings page that starts and stops the node and reads back what it logged."
kind: "package-reference"
---

# @tianma/dsh-mps-node-ui

English | [中文](README.zh.md)

## Summary

Put the executor node on the Settings page. The browser half keeps one node snapshot fed by the Host's `mpsNodeControl` Remote namespace and renders it as one section: the phase the process is in, its profile, its process id and start time, how the last process ended, buttons that start and stop it, and the recent lines it printed. Every operation goes through the Host, and a composition that mounts no node control simply has no section to render.

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

Mount both halves: the service in [@tianma/dsh-mps-node-control](../mps-node-control/README.md) and this surface. The Web application bundle mounts both, so the desktop and browser profiles get the section and an automation profile that mounts neither gets nothing.

The section registers into the `settings.section` slot under the id `mps-node`, ordered before the upstream sections, and its copy lives in the `settings.mpsNode` locale namespace in both shipped languages.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The snapshot is the single source the section reads, so the state it shows and the buttons it enables can never disagree: `start` and `stop` mark the snapshot busy, take the Host's answer as the new reading, and re-read the status and the lines; a refused call surfaces the Host's own message, and an empty one means "failed without a message", which the component renders as its localized copy.

The section re-reads every five seconds while it is open and stops when it closes, because the process it watches changes without asking anyone. The buttons are disabled while a call is in flight and while the node is already running (or stopping), so a double click cannot race the Host.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | The apply closure: the snapshot, the operations, and the section registration |
| [`src/client/NodeSection.tsx`](src/client/NodeSection.tsx) | The rendered section |
| [`src/client/contract.ts`](src/client/contract.ts) | What the closure publishes and injects |
| [`src/client/locales.ts`](src/client/locales.ts) | The English and Chinese copy |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [@tianma/dsh-mps-node-control](../mps-node-control/README.md) — the Host service this surface drives.
- [@tianma/dsh-mps-executor](../mps-executor/README.md) — the node whose output this section shows.

<a id="model-experience"></a>
## Model Experience

None, as this plugin renders a Settings section over the node-control Remote namespace; it registers no prompt, tool, or Session event.

#### KV Cache effect

Nothing here enters a model request, so this package neither grows nor replaces any request prefix.

## Known Limitations and Deferred Work

- **The parameters are read-only here** — the platform address, node id, secret environment, and coding root are what the GUI process was started with; this section shows the node's output about them but cannot change them.
- **Polling, not a stream** — the section re-reads every five seconds while it is open, so a node that dies between two reads shows the older reading until the next one.
- **The output shown is what the Host keeps** — the ring is bounded by the service's `logLines`, so older lines are only in the node's own log files.
- **No launcher outside Settings** — the node is reachable from the Settings page only; a sidebar entry or a tray item would be additional surfaces over the same snapshot.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The section registers with `order: -5`, ahead of the upstream sections, because the node is the thing this deployment is here to run. The order is the one place to change that judgement.

The five-second re-read is deliberately not a stream: the Host offers no change notification for a process, and a Settings page that is open is the only surface that needs one. A stream would be the right move if a second surface ever reads the same snapshot.

</details>
