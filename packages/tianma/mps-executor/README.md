---
description: "Tianma MPS executor node for dsh: a profile-row plugin that authenticates, registers, and heartbeats with the management platform whose communication IP and port the configuration states."
kind: "package-reference"
---

# @tianma/dsh-mps-executor

English | [中文](README.zh.md)

## Summary

Run one Tianma MPS executor node inside a dsh profile. The plugin reads the management platform's communication address — the host or IP and the port — from its profile row, reads the pre-shared secret from an environment variable, exchanges that secret for a bearer token, registers this machine's identity, capacity, and capabilities, and keeps the heartbeat that carries running tasks, slot capacity, and resource readings up to the platform while bringing commands back down. The node is the profile's application, so the process is `dsh --profile <node profile>` rather than a second binary beside the harness.

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
| `slotsTotal` | `1` | Concurrent tasks the node accepts |
| `heartbeatSeconds` | `10` | Heartbeat period, until the platform assigns another |
| `claimLongPollSeconds` | `25` | Claim long-poll budget |
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

`MpsExecutorRuntime` owns the platform session: `bootstrap()` exchanges the secret for a token and registers, adopting the heartbeat period the platform returns rather than keeping a hardcoded one; `heartbeatOnce()` reports running tasks, slots, resources, and node time, which renews the leases of every task it names; `start()` and `stop()` own the timer, and the timer holds a reference so the hosting process stays alive while the node is online. A heartbeat failure applies the recovery its code demands: `halt-node` stops the node and its timer, `reauthenticate` clears the token and re-runs the handshake, and anything else waits for the next period with a warning.

### Source map

| File | Role |
|---|---|
| [`src/config.ts`](src/config.ts) | The configuration schema, the resolved settings, and the secret read |
| [`src/runtime.ts`](src/runtime.ts) | The platform session: handshake, heartbeat, timer, failure recovery |
| [`src/index.ts`](src/index.ts) | The Cordis plugin: report sink, auto-start, service publication, stop effect |
| [`tests/mps-executor.spec.ts`](tests/mps-executor.spec.ts) | Address configuration, settings resolution, secret reading, handshake, heartbeat, recovery, and plugin mounting |

### Invariant ownership

The runtime holds the node id once and the protocol client reports it on every request, so a caller cannot submit a task-scoped call under another node's identity. The heartbeat period comes from either configuration or the platform's registration answer, never from a constant at the send site.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [mps-exec-core](../mps-exec-core/README.md) — the wire layer this plugin resolves its address through and drives
- [tianma group](../README.md) — where this package sits and how the family is composed

## Model Experience

None, as the node runtime transports exec/v1 protocol traffic for the management platform and registers no prompt, tool, or Session event of its own.

#### KV Cache effect

Nothing here enters a model request, so this package neither grows nor replaces any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This limit defines the current package boundary. It is a current constraint, not a task backlog.

- **Platform session only** — the plugin authenticates, registers, and heartbeats; it does not claim tasks, prepare coding workspaces, run the agent, or submit results, and the capability lists it registers are configuration rather than probe results.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Task claiming, the persistent coding workspace, and the agent runner are the next milestones; this package stops at the platform session so the handshake can be verified against a real platform first. Nothing here is authoritative beyond the sections above and the source.
</details>
