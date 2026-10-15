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
| `gitUserName` | `tianma-mps-node` | `user.name` injected into every commit the node makes |
| `gitUserEmail` | `mps-node@localhost` | `user.email` injected into every commit the node makes |
| `maxArtifactBytes` | `524288000` | Largest artifact the node uploads, before the protocol's single-request ceiling |
| `cliRunner.command` | `['dsh', '--profile', 'headless']` | Command and leading arguments one attempt runs; point it at an absolute executable path |
| `cliRunner.logsDirectory` | `logs` inside the workspace root | Directory the runner keeps one raw log per attempt under |
| `cliRunner.dshHome` | inherited | `DSH_HOME` the run uses, so a node's profile directory stays its own |
| `cliRunner.jsonEvents` | `false` | Ask the run for its event stream, so each turn and tool call reaches the platform and the node learns the session to report |
| `diskMinGb` | `5` | Free disk space below which the node claims nothing until there is room |
| `slotsTotal` | `1` | Concurrent tasks the node accepts |
| `heartbeatSeconds` | `10` | Heartbeat period, until the platform assigns another |
| `claimLongPollSeconds` | `25` | Claim long-poll budget |
| `leaseRenewSeconds` | `30` | Lease renewal period, until a claim states the platform's own |
| `taskRuntimeSeconds` | `10800` | Runtime ceiling for one attempt, until the task payload states its own |
| `requestTimeoutMs` | `15000` | Budget for one ordinary request |
| `lanes` / `tools` | lanes empty, tools probed | Capability promise the node registers; stated tools replace the probed set |
| `agentVersion` | probed from the CLI | Agent version reported; the stated value is the fallback when the CLI cannot say |
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

`prepareCheckout` brings the workspace's repository cache to the commit the platform dispatched: it initializes and fetches that cache instead of cloning a fresh tree, fetches the base branch and then every other branch — a workspace's later tasks are dispatched from the work branch an earlier task pushed, not from the base branch — checks that the origin holds the dispatched `base_commit` at all, and refuses to work from a base no fetch can reach, then creates the work branch at that commit, resets the tree to it, and clears untracked files, so a retry in the same workspace starts from the dispatched base rather than from the last attempt's leftovers. Every git command runs through `cliGit`, which spawns git with an argument list — a task's own text never becomes shell syntax — and keeps git's diagnostics, redacted, for the attempt's summary.

`publishChanges` hands the attempt's work back. It commits under the robot identity injected per command — the host's global git configuration is never touched — and pushes the work branch, but only after the two checks the platform cannot make for it: every change must stay inside the workspace once symlinks resolve, and no changed text file may carry a credential. A refusal leaves nothing behind to push, and the result's evidence then reports the changed paths, the commit, and whether the branch was pushed, which is why a runner's own evidence is only used when the attempt published nothing.

`checkoutSessionReporter` keeps the platform's view of a workspace's session true: the node records the session reference, the baseline commit it saw, and the task it served beside the workspace, and only then reports it, so a report the platform refuses never loses the reference. A restart reads those records back and re-reports them, which is what keeps the platform's workspace page showing the session and coding path of a node that just came up; that report is for display and troubleshooting only, so the platform refusing one is a warning rather than a failed handshake.

`clientArtifactUploader` stores what an attempt produced. It reads the file only from inside the workspace, computes the SHA-256 the platform verifies the contents against, mints the idempotency key, and uploads it as multipart, because a file transfer needs a body the transport cannot JSON-encode. It refuses a file it cannot transfer — a path outside the workspace, something that is not a file, or more bytes than one request may carry — rather than failing a transfer halfway, and it never claims more than the protocol's single-request ceiling however a deployment configures its own limit. `paths.ts` holds the confinement rule both directions use, so reading an artifact and reporting a change are held to the same one.

The other direction is `resource()` on the runner's context: the node downloads a material the task carries — the brief, an input file the payload references — and checks it against the digest the platform states, so bytes that do not match never reach a runner. A refused material arrives as the usual envelope, so a runner sees the platform's own code rather than a bare status.

`tianmaCliRunner` is the runner the node ships: it runs the tianmacoder CLI on one attempt and turns what that process did into a result. The node owns everything around the process — the working directory is the attempt's workspace, the command and instruction travel as an argument array rather than a shell line (an instruction is external input), what the run prints is streamed into the attempt's log as it arrives, cancellation asks the run to end and kills it after a grace period, and the raw log is written outside the workspace because everything inside the workspace is what the node commits. A run that exits non-zero, is stopped, or changes nothing is reported as failed rather than as a delivery; a run that changed files goes through `publish()`, which is where the commit, the push, and the pre-commit checks live. The node falls back to this runner when nothing composes one under `mpsTaskRunner`, so a node that installs the CLI works out of the box; a deployment that wants a different execution strategy composes its own provider and the fallback is never reached. The profile it starts by default, the positional task that profile accepts, the event stream a `--json` run prints, and the wording it uses for a session it does not hold are pinned by a spec that starts the real CLI from source, so an upstream rename fails a test rather than every node's first attempt. With `jsonEvents` the run is asked for its event stream: each turn, tool call, tool result, and piece of the answer becomes a log line the platform reads as it happens, the run's session is reported as the protocol requires, and the final answer is kept in the attempt's notes. The payload may name the session a previous task in the workspace used, and the node adopts it. When the CLI no longer holds that session — a wiped profile, say — the node says so, starts a new one, and reports it, so the platform keeps tracking the same work instead of reading a failure that has nothing to do with the task.

`writeTaskBook` gives the attempt everything the payload carries that the agent needs and the prompt cannot hold: the constraints, the delivery requirements, the materials the task references, the chat it came from, the workspace's recent tasks, and the rules — written as `PROMPT.md` in the workspace. The prompt stays the instruction plus a pointer, so a long transcript or rule set never has to fit in one argument. The book is the node's own input, so the node adds it to the repository's local excludes as it writes it: everything else in the workspace is what the commit hands back, and the node's own file is not part of the delivered change.

`fetchMaterials` brings the files a task carries into the workspace before the run starts, under `.materials/`, named after the file the platform stated and reduced to a name that cannot leave the directory. The directory is added to the repository's local excludes like the task book, and the book names each file so the agent reads what the platform attached rather than a list of ids. A material the platform refuses, or one larger than the node fetches in one request, is reported as `blocked` — the protocol's outcome for missing information — because an attempt that works without its inputs would have to guess at them.

A `read_only` task is the one mode where the node does not push: it commits the work as usual, then writes a git bundle of the work branch into `.bundles/` inside the workspace — kept out of the repository like the task book — and the node uploads it as the attempt's `bundle` artifact, reporting its id as the evidence's `patch_artifact_id` with `pushed: false`. The platform fetches the change out of that artifact, which is what its clone of the baseline is for.

`collectEvidence` produces what the task's deliverables require before the attempt reports: the build and the end-to-end command run in the delivered workspace through the host shell — the payload states a shell command, and the node interpolates nothing into it — each keeping its output in `.evidence/` (kept out of the repository) for the platform to read, and the report the agent wrote is taken from the file the payload names. A required command that fails stops the dependent work, and the attempt reports `failed` with that command's exit code and last line rather than claiming a delivery the platform's gates would reject. The runner uploads each of those files as the artifact the protocol names — a `log` per command, the `report` — and reports their ids in the result's evidence.

A screenshot is the one piece of evidence the node cannot produce, because only the run that captured it knows its viewport and route: the task book tells the attempt to write them under `.evidence/screenshots/` and to declare each in `.evidence/screenshots.json` with its route, caption, and size, and the node checks that declaration — the file is there, inside the workspace, and no smaller than the platform accepts — before uploading each with the metadata the platform keeps and reporting `screenshots[]` in the evidence.

The node is also exercised end to end: a spec boots this plugin through the Loader from a `cordis.yml`, with its configuration validated, dials a platform on this host, and runs real tasks in a real clone — the agent is a stub, everything else is the node: the checkout, the commit, the push or the bundle, the evidence commands, the artifacts, the session report, the capability promise, and the result. Both access modes are covered — a `read_write` task is pushed to the origin and a `read_only` one goes back as a bundle with nothing pushed — as are the platform's instructions — an aborted attempt is stopped and reported `cancelled`, and a released workspace is deleted and struck from the node's records — and the materials it hands a task: one is brought into `.materials/` and named in the task book before the attempt starts, and one whose bytes do not match the digest the platform stated blocks the attempt instead of running on it. What the node does with credentials is covered as well: a line an attempt prints with a secret in it reaches the platform with the value taken out, and a tree that carries one is refused before anything is committed. The confinement a task can ask for is covered too: an attempt that leaves a link pointing outside the workspace is refused before anything is committed, so nothing reaches the origin.

The platform's configuration is fetched when the revision it states moves: the node follows the heartbeat interval the platform asks for — re-arming its timer without dropping the work in flight — and names the parameters it keeps at the values it declared, so an instruction never disappears silently.

The capabilities a node registers are probed, because the platform schedules on them: the tools come from the machine's `PATH` and the agent version from the CLI the node runs. A deployment that wants to be scheduled for a stated set of tools, or to report a stated version, still can — the probe is what happens when it states none.

Every heartbeat carries a reading of this machine — the free space on the disk the coding workspaces live on, the memory in use, and the CPU time spent between two readings — because the platform schedules on what a node has. When that free space falls below `diskMinGb` the node stops claiming work and tells the platform it is draining, says so once per state change, and names the workspaces it keeps; it never deletes one, because releasing a bound workspace is the platform's decision. When there is room again it resumes with the platform as well, so a node that is not claiming is not a node the platform keeps dispatching to.

A log batch the platform could not take waits on disk instead of disappearing: the lines describe work that already happened, so the node keeps them under the coding root and offers them again under the same batch id, which the platform deduplicates. The spool is offered again before the result is submitted, so the log a result refers to is whole by the time it arrives. A batch the platform answers on is dropped when it refuses that batch outright, and the node says so — a gap in the log reaches the operator rather than being retried forever. A report the platform cannot take — progress, a session — is a warning rather than the end of the attempt: the work is not the report, and the next report carries the newest state.

### Source map

| File | Role |
|---|---|
| [`src/config.ts`](src/config.ts) | The configuration schema, the resolved settings, and the secret read |
| [`src/runtime.ts`](src/runtime.ts) | The platform session: handshake, heartbeat, commands, timer, failure recovery |
| [`src/orchestrator.ts`](src/orchestrator.ts) | The task lifecycle: claim, lease, runtime ceiling, abort, logs, and result submission |
| [`src/workspace.ts`](src/workspace.ts) | The coding workspaces: one directory per workspace, the sidecar state, and release-driven removal |
| [`src/checkout.ts`](src/checkout.ts) | The code flow: fetch the cache, hold the dispatched base, reset the work branch |
| [`src/git.ts`](src/git.ts) | The git boundary: argument-list spawning and redacted failures |
| [`src/publish.ts`](src/publish.ts) | Handing work back: the pre-commit checks, the commit, the push, and the `read_only` bundle |
| [`src/session.ts`](src/session.ts) | The session serving a workspace: what the node records and re-reports |
| [`src/artifacts.ts`](src/artifacts.ts) | Uploading what an attempt produced: reads, the digest, and the size the node will transfer |
| [`src/paths.ts`](src/paths.ts) | The one confinement rule for paths inside a coding workspace |
| [`src/cli-runner.ts`](src/cli-runner.ts) | The runner: one CLI process per attempt, its logs, its stop, and its result |
| [`src/task-book.ts`](src/task-book.ts) | The task book: what the payload states, rendered for the agent |
| [`src/materials.ts`](src/materials.ts) | The materials a task carries, brought into the workspace before the run |
| [`src/evidence.ts`](src/evidence.ts) | The build, the end-to-end run, and the report the deliverables require |
| [`src/runner.ts`](src/runner.ts) | The `TaskRunner` seam and the context and outcome an attempt exchanges |
| [`src/report.ts`](src/report.ts) | The operator event and the error normalization every failure path uses |
| [`src/index.ts`](src/index.ts) | The Cordis plugin: report sink, auto-start, service publication, runner lookup, stop effect |
| [`src/startup.ts`](src/startup.ts) | The node profile's command line and the environment it documents |
| [`tests/mps-executor.spec.ts`](tests/mps-executor.spec.ts) | Address configuration, settings resolution, secret reading, handshake, heartbeat, commands, recovery, claiming through a composed runner, and plugin mounting |
| [`tests/orchestrator.spec.ts`](tests/orchestrator.spec.ts) | Claiming, leases, the runtime ceiling, aborts, log bounding, and result submission |

### Invariant ownership

The runtime holds the node id once and the protocol client reports it on every request, so a caller cannot submit a task-scoped call under another node's identity. The heartbeat period comes from either configuration or the platform's registration answer, never from a constant at the send site. Which tasks run and how far they got has one home, the runtime's running-task list, and the orchestrator only reports transitions into it. A task's code only ever reaches its workspace through `prepareCheckout`, so a base the origin does not hold is refused in one place and no runner can start work from a tree nobody dispatched, and it only ever leaves through `publishChanges`, which is where the workspace confinement and credential checks live. What the platform knows about a workspace's session comes from one place too: the node records it beside the workspace before reporting it, so a refused report never costs the reference. Confinement itself has one home, `resolveWithinWorkspace`, so reading an artifact and reporting a change cannot drift apart.

</details>

-----

The platform's `release_workspace` is honoured for workspaces this node is not working in: a release that arrives while an attempt is still in a workspace is reported and kept, because deleting the tree would take the ground out from under that attempt. The platform can release it again once the attempt has settled.

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

- **The runner needs the CLI** — the node falls back to `dsh --profile headless`, so a node without the built or installed CLI reports every attempt as failed; a deployment that composes its own `mpsTaskRunner` provider replaces the fallback.
- **Materials arrive in one request each** — the node fetches a material with one request and refuses a larger one, because the chunked reverse fetch is not implemented; uploads are chunked above the protocol's threshold.
- **A `read_only` bundle needs the baseline** — the bundle names the base commit as a prerequisite, so the receiver must already hold it; the node hands back the work branch only.
- **Git comes from `PATH`** — the node spawns `git` from the environment; a host without it reports every coding attempt as failed.
- **The book states what the payload states** — a section is rendered only when the platform sends it, and the node neither summarises the chat nor orders the work the platform left implicit.
- **A refused material stops the attempt** — a material over the single-request ceiling, or one the platform refuses, makes the attempt report `blocked` rather than working without it.
- **Screenshots are declared, not captured** — the node takes no screenshots: it reads what the attempt declared in `.evidence/screenshots.json`, checks that each file is there and at least as large as the platform accepts, and uploads them with the metadata the declaration states. The platform's own content checks are the platform's.
- **A spooled log waits by task** — the spool keeps one file per task under the coding root's `.buffers`, so a batch whose task the platform has since forgotten is dropped with a report rather than retried for the life of the node.
- **The CLI must be one the host can start directly** — the node starts the configured command itself, with the task's workspace as its working directory. An installed `dsh` is fine; a launch whose loader or profile resolves from the repository it lives in is not, because the workspace is a customer repository somewhere else entirely. Point `cliRunner.command` at an executable (or at an interpreter with absolute paths), not at a batch shim this node would have to run through a shell that re-parses the task text.
- **The releasable list has nowhere to go** — the protocol's heartbeat carries the resource readings but no field for the workspaces a full node could release, so that list reaches the operator through the node's own report and the platform sees only the reading.
- **Platform configuration is partly followed** — the node acts on the heartbeat interval; the claim long poll, the log batch caps, the artifact ceiling, and the redaction rules stay at the values this node declared in its capabilities, and the node says so in its report when the platform states different ones.
- **Progress inside a run is estimated** — the event stream reports each turn and tool call, but the node states no percentage for them: only the stages it knows for certain (coding, collecting evidence, uploading) carry one.
- **Resource readings are supplied** — a deployment reports them through `setResources`; the node probes CPU, memory, and disk itself not at all.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Task claiming, the persistent coding workspace, and the agent runner are the next milestones; this package stops at the platform session so the handshake can be verified against a real platform first. Nothing here is authoritative beyond the sections above and the source.
</details>
