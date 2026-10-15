---
description: "The MPS executor-node profile bundle: one patch layer mounting the executor node over dsh-base, for nodes launched with dsh --profile mps-node."
kind: "package-bundle"
---

# @tianma/dsh-mps-node-bundle

English | [中文](README.zh.md)

## Summary

Turn a dsh installation into a Tianma MPS executor node. List this bundle after `dsh-base` in a profile — the shipped `mps-node` template does exactly that — and the profile mounts the executor node whose configuration states the management platform's communication IP and port, and leaves the node heartbeating under `ctx.mpsExecutor`. Every row is independently retunable or disabled without touching code, and a CI verifier fails when an upstream row id drifts, so a stale override cannot ship silently.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Launch a node with the shipped template:

```sh
MPS_PLATFORM_HOST=192.168.1.10 MPS_PLATFORM_PORT=8791 MPS_NODE_ID=node-3f2a MPS_NODE_SECRET=<secret> \
  dsh --profile mps-node
```

The template composes `dsh-base` with this bundle, and this bundle's patch mounts the node row:

```yaml
- insert:
    - id: mps-executor
      name: '@tianma/dsh-mps-executor'
      config:
        platformHost: !!js process.env.MPS_PLATFORM_HOST ?? '127.0.0.1'
        platformPort: !!js Number(process.env.MPS_PLATFORM_PORT ?? 8791)
        nodeId: !!js process.env.MPS_NODE_ID ?? 'node-unconfigured'
        secretEnv: MPS_NODE_SECRET
        slotsTotal: !!js Number(process.env.MPS_NODE_SLOTS ?? 1)
        lanes: []
        tools: []
        autoStart: !!js Boolean(process.env.MPS_PLATFORM_HOST)
```

The environment indirection is what lets one installation image serve every node; write the values directly into the row instead when a deployment prefers a fixed profile. The two placeholders keep the profile loadable — `dsh mps-node --help` works on a machine with no environment — and `autoStart` is what decides whether the node dials at all: it is true only when `MPS_PLATFORM_HOST` is set, so an unconfigured node mounts and sits idle instead of registering under a placeholder identity. The secret is only ever read from the environment variable named by `secretEnv`.

The patch mounts one row and restates no permission row. `dsh-base` already composes `workspace-write` with `ask`, the pairing its preset table admits, and a node composes no approval answerer, so an action that needs approval is refused rather than parked for a person who is not there. A deployment that wants the deterministic wording instead sets `DSH_PERMISSION_MODE` in the node's environment, which is `dsh-base`'s own switch.

| Variable | Meaning |
|---|---|
| `MPS_PLATFORM_HOST` | Platform host, IPv4, or IPv6 address the node dials; required |
| `MPS_PLATFORM_PORT` | Platform port; defaults to `8791` |
| `MPS_PLATFORM_SCHEME` | `http` or `https`; defaults to `http` |
| `MPS_PLATFORM_BASE_PATH` | Path prefix; defaults to `/exec/v1` |
| `MPS_NODE_ID` | Id the platform knows this node by; required |
| `MPS_NODE_NAME` / `MPS_NODE_HOST` | Display name and reported host; default to the node id and this machine's host name |
| `MPS_NODE_SECRET` | Pre-shared secret; read by the plugin, never from configuration |
| `MPS_NODE_SLOTS` | Concurrent tasks; defaults to `1` |
| `MPS_NODE_WORKSPACE` | Workspace root the node reports; defaults to the process working directory |
| `MPS_AGENT_VERSION` | Agent version reported; defaults to `unknown` |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch` manifest field and resolved by the profile composer through that field. The bundle patch is applied after `dsh-base`, so its `insert` row adds the node and its id-targeted rows replace the targeted base row's whole config.

`scripts/verify-profile-patches.ts` validates every patch in the repository against the composition it targets, so a base row whose id changes cannot leave this bundle's override silently unattached. The profile name itself is registered in `PROFILE_TEMPLATES` in `packages/boot/app-boot/src/profile.ts`.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The patch layer: the executor node row and the platform address it reads |
| [`src/index.ts`](src/index.ts) | Module placeholder; this bundle carries no runtime API |

### Invariant ownership

The address the node dials belongs to the executor plugin's validated configuration, not to this patch: the patch only supplies values, and the plugin rejects a host that carries a scheme, a path, or a port.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [mps-executor](../mps-executor/README.md) — the plugin this bundle mounts, and the configuration it validates
- [mps-exec-core](../mps-exec-core/README.md) — the wire layer beneath that plugin
- [tianma group](../README.md) — where this bundle sits and how the family is composed

## Model Experience

Indirectly, through the executor node this bundle mounts, whose platform traffic and report sink own every model-facing effect.

#### KV Cache effect

Nothing here enters a model request; the patch contributes configuration and row replacements only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current bundle boundary. They are current constraints, not a task backlog.

- **The node session is the whole node** — the mounted plugin authenticates, registers, and heartbeats; task claiming, coding workspaces, and result submission are not part of it, so a node launched today holds its platform session without doing work.
- **Capabilities come from configuration** — the row states `lanes` and `tools`, and nothing probes the host for them yet.
- **One platform per profile** — the row names a single platform address; pointing one profile at several platforms is not supported.
- **No console logger** — no shipped profile mounts a console exporter, so the node's own reports reach `ctx.logger` without an output target. A deployment that must see them composes `@deepseek-ai/cordis-plugin-logger-console`, or reads the platform's own node view.
- **One handshake at load** — the node registers once when the profile loads, so a platform that is unreachable at that moment leaves the node idle until the process restarts; the reconnect supervisor arrives with the claim loop.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The template name and the bundle name are separate decisions: profiles are initialized per `$DSH_HOME` and are not shipped, so the `mps-node` template entry is what makes `dsh --profile mps-node` work on a fresh installation. Nothing here is authoritative beyond the sections above and the source.
</details>
