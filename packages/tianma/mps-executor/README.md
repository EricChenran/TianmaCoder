---
description: "Tianma MPS executor node for dsh: a profile-row plugin that authenticates, registers, and heartbeats with the management platform whose communication IP and port the configuration states."
kind: "package-reference"
---

# @tianma/dsh-mps-executor

English | [中文](README.zh.md)

## Summary

Run one Tianma MPS executor node inside a dsh profile. The plugin reads the platform's communication address (host and port) from its profile row, reads the pre-shared secret from an environment variable, exchanges it for a bearer token, and registers this machine's identity, capacity, and capabilities. It keeps the heartbeat that carries running tasks and resource readings up while bringing commands down, and, with a runner composed, claims work within its slots, holds each lease, applies the abort and runtime-ceiling rules, and submits the outcome the attempt reached.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Point a node at its platform by configuration alone. The bundle's patch mounts the plugin row, and a deployment edits these fields to move the node to another platform:

```yaml
- id: mps-executor
  name: '@tianma/dsh-mps-executor'
  config:
    platformHost: 192.168.1.10   # the platform's IP, host name, or IPv6 address
    platformPort: 8791           # the platform's exec/v1 port
    platformScheme: http         # http over the LAN, https when the deployment terminates TLS
    nodeId: node-3f2a
    slotsTotal: 2
    lanes: [frontend, backend]
    tools: [node, git]
```

The plugin publishes the node's platform session at `ctx.mpsExecutor`. On load it authenticates and registers, then heartbeats on the period the platform assigns; `autoStart: false` mounts the node without starting it, which a deployment uses when something else drives the handshake.

| Field | Default | Meaning |
|---|---|---|
| `platformHost` | required | Platform host, IPv4 address, or IPv6 address; a scheme, path, or port here is rejected |
| `platformPort` | `8791` | Platform TCP port |
| `platformScheme` | `http` | `http` or `https` |
| `platformBasePath` | `/exec/v1` | Path prefix the endpoints hang off |
| `nodeId` | required | Id the platform knows this node by |
| `nodeName` | `nodeId` | Display name |
| `nodeHost` | this machine's host name | Address reported to the platform |
| `secretEnv` | `MPS_NODE_SECRET` | Environment variable holding the pre-shared secret; the secret is never read from configuration |
| `workspaceRoot` | the process working directory | Directory the node reports as its workspace root |
| `codingRoot` | `coding` inside the workspace root | Directory the node keeps its coding workspaces under |
| `slotsTotal` | `1` | Concurrent tasks the node accepts |
| `heartbeatSeconds` | `10` | Heartbeat period, until the platform assigns another |
| `claimLongPollSeconds` | `25` | Claim long-poll budget |
| `leaseRenewSeconds` | `30` | Lease renewal period, until a claim states the platform's own |
| `taskRuntimeSeconds` | `10800` | Runtime ceiling for one attempt, until the task payload states its own |
| `requestTimeoutMs` | `15000` | Budget for one ordinary request |
| `lanes` / `tools` | empty | Capability promise the node registers |
| `agentVersion` | `unknown` | Agent version reported |
| `labels` | empty | Operator labels |
| `autoStart` | `true` | Whether the node authenticates and registers as soon as the profile loads |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`resolveExecutorSettings` turns the row configuration into one resolved set: it validates the address through `@tianma/dsh-mps-exec-core`, falls back to this machine's host name and the process working directory, and builds the capability promise. `readNodeSecret` reads the environment variable and fails loudly when it is unset or blank, so a node never registers with an empty credential.

`MpsExecutorRuntime` owns the platform session: `bootstrap()` exchanges the secret for a token and registers, adopting the heartbeat period the platform returns rather than keeping a hardcoded one; `heartbeatOnce()` reports running tasks, slots, resources, and node time, which renews the leases of every task it names; `start()` and `stop()` own the timer, and the timer holds a reference so the hosting process stays alive while the node is online. A heartbeat failure applies the recovery its code demands: `halt-node` stops the node and its timer, `reauthenticate` clears the token and re-runs the handshake, and anything else waits for the next period with a warning. The commands a heartbeat brings down are applied here: `abort` cancels the named attempt, and a command this node does not implement is reported rather than dropped.

`TaskOrchestrator` owns the task lifecycle. It claims while a slot is free, reports each claimed task to the platform's running-task list, hands the attempt to the runner, and submits the outcome the attempt reached. The rules the platform cannot apply for the node live here: the renewal period and runtime ceiling a claim or payload states, the stop when a renewal answers `should_continue: false` (the attempt is discarded and no result is submitted, because that result would describe work the platform already reassigned), the `cancelled` outcome an abort forces, redaction and byte-bounding of submitted log lines, and result submission that retries while the platform's answer allows it. A node without a composed runner holds its session and claims nothing; the runner is looked up as `ctx.mpsTaskRunner` when claiming starts, so a runner mounted by any other row is found. The `TaskRunner` seam is the only way work runs: a runner receives the assignment, a cancellation signal, and reporting channels, and never talks to the platform or decides its own slots.

`WorkspaceStore` keeps the coding workspaces: one directory per platform workspace under the coding root, reused across that workspace's tasks because it carries what the workspace learned, plus a sidecar state file that survives a restart. A task ending never removes a directory; only the platform's `release_workspace` command does, and a removal is refused unless the directory really resolves inside the coding root, so a mistaken record or a junction cannot make the node delete something else. The store hands the directory an attempt works in to the runner, which is why a runner never decides where a workspace lives.

### Source map

| File | Role |
|---|---|
| [`src/config.ts`](src/config.ts) | The configuration schema, the resolved settings, and the secret read |
| [`src/runtime.ts`](src/runtime.ts) | The platform session: handshake, heartbeat, commands, timer, failure recovery |
| [`src/orchestrator.ts`](src/orchestrator.ts) | The task lifecycle: claim, lease, runtime ceiling, abort, logs, and result submission |
| [`src/workspace.ts`](src/workspace.ts) | The coding workspaces: one directory per workspace, the sidecar state, and release-driven removal |
| [`src/runner.ts`](src/runner.ts) | The `TaskRunner` seam and the context and outcome an attempt exchanges |
| [`src/report.ts`](src/report.ts) | The operator event and the error normalization every failure path uses |
| [`src/index.ts`](src/index.ts) | The Cordis plugin: report sink, auto-start, service publication, runner lookup, stop effect |
| [`src/startup.ts`](src/startup.ts) | The node profile's command line and the environment it documents |
| [`tests/mps-executor.spec.ts`](tests/mps-executor.spec.ts) | Address configuration, settings resolution, secret reading, handshake, heartbeat, commands, recovery, claiming through a composed runner, and plugin mounting |
| [`tests/orchestrator.spec.ts`](tests/orchestrator.spec.ts) | Claiming, leases, the runtime ceiling, aborts, log bounding, and result submission |

### Invariant ownership

The runtime holds the node id once and the protocol client reports it on every request, so a caller cannot submit a task-scoped call under another node's identity. The heartbeat period comes from either configuration or the platform's registration answer, never from a constant at the send site. Which tasks run and how far they got has one home, the runtime's running-task list, and the orchestrator only reports transitions into it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [mps-exec-core](../mps-exec-core/README.md) — the wire layer this plugin resolves its address through and drives
- [tianma group](../README.md) — where this package sits and how the family is composed

## Model Experience

None, as the node transports exec/v1 protocol traffic and hands each claimed attempt to a runner, so whatever a runner shows a model belongs to that runner's package.

#### KV Cache effect

Nothing here enters a model request, so this package neither grows nor replaces any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This limit defines the current package boundary. It is a current constraint, not a task backlog.

- **No runner is shipped** — the node claims and runs work only when a runner is composed; without one it holds its session, reports that, and claims nothing, because there is no way to do the work.
- **No checkout in the workspace yet** — the node creates and keeps one directory per workspace and removes it only on release, but it does not clone or fetch the task's repository, check out the work branch, or report the workspace's session yet.
- **Resource readings are supplied** — a deployment reports them through `setResources`; the node probes CPU, memory, and disk itself not at all.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Task claiming, the persistent coding workspace, and the agent runner are the next milestones; this package stops at the platform session so the handshake can be verified against a real platform first. Nothing here is authoritative beyond the sections above and the source.
</details>
