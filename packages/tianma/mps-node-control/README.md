---
description: "Tianma MPS executor-node control: the Web GUI's entry that starts, stops, and reads back the executor node process it supervises."
kind: "package-reference"
---

# @tianma/dsh-mps-node-control

English | [中文](README.zh.md)

## Summary

Give the Web GUI one place to run the executor node. The node is an application of its own — `dsh --profile mps-node`, with its own home, coding root, and credentials — so this plugin supervises that process instead of mounting the node into the GUI's profile: `ctx.mpsNodeControl` starts it, stops it, reports where it stands, and hands back the lines it printed. The GUI owns the lifecycle, so disposing the plugin takes the process down; the deployment's own parameters reach the child through the environment the GUI itself was started with.

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

Mount the plugin wherever a GUI entry is wanted; the Web application bundle mounts it for the desktop and browser profiles, and an automation profile that never wants a node simply leaves the row out.

Config: `entry` (defaults to the `dsh` CLI shipped beside this package), `nodeBinary` (defaults to the running process's own Node), `loaders` (defaults to this process's own module loaders, which is what makes a source launch work), `profile` (default `mps-node`), `logLines` (default 200), `stopGraceMs` (default 10 000).

The Remote namespace `mpsNodeControl` exposes `status`, `start`, `stop`, `logs`, `config`, `saveConfig`, and `probe` — one deliberately wrong-credential `POST /auth/token` against the address the form currently holds, where any HTTP answer (a 401 above all) proves the path is open, the way the platform's own integration note tests it. The browser half of [@tianma/dsh-mps-node-ui](../mps-node-ui/README.md) renders them as a Settings section. The node's deployment parameters may be stated two ways: a deployment sets the `MPS_*` environment this GUI inherits, or the Settings form saves them (plain JSON beside the node profile, never a profile patch row) and `start` overlays them onto the child's environment — saved first, inherited second, the node's own defaults last. The node secret is part of the same form: it is stored beside the profile, never echoed back to the page (reads report only whether it is set), injected as `MPS_NODE_SECRET` at the next launch, and cleared by saving the field blank, which falls back to the environment's value.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The child is launched the way this process itself was launched — the same Node binary and the same module loaders — but through the `dsh` CLI entry resolved beside this package, with `--profile mps-node` appended (the process's own entry is only the fallback: the packaged desktop host takes positional argv, so relaunching it with `--profile` would read the flag as a path). A source launch and a packaged launch therefore both work with no deployment stating paths, while each of the three stays overridable for a composition that keeps the node somewhere else.

State is held in TypeScript-private fields rather than ECMAScript `#private` ones. Callers reach a service method through the Cordis Service proxy, whose receiver is not the instance, so a `#private` field would be invisible to the method body.

A reading separates three endings that a caller has to tell apart. `starting` covers the window between the request and the operating system's confirmation. A process that never existed at all — a binary that is not there — reports `failed` with the launch error and no exit, because no exit can account for it. A process that ran and then ended reports `stopped` with its exit code, signal, and the last lines it printed, which is what tells a misconfigured node apart from a broken one.

Disposal kills the process without waiting: a plugin teardown cannot await, so `stop()` is what a caller uses when it wants to await the end, and the effect is the guarantee that closing the GUI does not leave a node behind.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MpsNodeControlService`: launching, stopping, status, and the recent-output ring |
| [`src/types.ts`](src/types.ts) | The phases, exit, and log-line vocabulary the surface renders |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [@tianma/dsh-mps-node-bundle](../mps-node-bundle/README.md) — the profile bundle that mounts the node this service starts.
- [@tianma/dsh-mps-executor](../mps-executor/README.md) — the node itself: what it claims, runs, and delivers.

<a id="model-experience"></a>
## Model Experience

None, as this plugin supervises a process and reports its state to a Settings surface; it registers no prompt, tool, or Session event.

#### KV Cache effect

Nothing here enters a model request, so this package neither grows nor replaces any request prefix.

## Known Limitations and Deferred Work

- **The deployment's parameters are not editable here** — the platform address, node id, secret environment, and coding root reach the node through the environment this GUI process was started with. A deployment that wants them changed from the interface needs a surface that writes them somewhere the node reads, which this package does not own.
- **The recent output is memory only** — the ring holds the last `logLines` lines and is lost with the process, so the node's own daily log files stay the record of anything older.
- **The reading is not persistent** — a GUI restart forgets how the last node process ended until the next one does.
- **One node per GUI** — the service supervises a single child; a machine that must run several nodes runs them outside this entry.
- **A stop escalates after `stopGraceMs`** — a node that ignores the first signal for longer than the grace period is killed, so a long delivery in flight can be cut short by a stop.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The launch convention is the part worth keeping: the child is started the way the GUI process itself was started, so the entry, the binary, and the loaders all follow the deployment instead of being restated in it. A new way of launching the product therefore keeps working here without a matching change.

This package exists because the node is a separate application. Mounting the node bundle into the desktop profile instead would put the node inside the GUI process, where it would share the GUI's home and credentials and die with the window; the platform would see an offline node whenever nobody had the window open.

</details>
