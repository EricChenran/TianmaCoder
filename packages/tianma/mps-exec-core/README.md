---
description: "exec/v1 wire layer for the Tianma MPS executor node: platform address resolution from a configured host and port, response envelopes, error-code recovery, retry schedules, log redaction, identifier minting, and the node HTTP client."
kind: "package-reference"
---

# @tianma/dsh-mps-exec-core

English | [中文](README.zh.md)

## Summary

Speak the management platform's `exec/v1` protocol without a Cordis mount. One call resolves the configured platform host and port into the origin and base-path URLs every request is built from; the client then performs each JSON endpoint and decides success from the response envelope's `code` rather than the HTTP status. The package also owns the vocabulary around that traffic: the recovery each error code demands, the delay before a failed request repeats, and which secret values never leave the host in a log line.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Resolve the address a deployment points the node at, then hand the same host and port to the client that dials it:

```ts
const endpoint = resolvePlatformEndpoint({ host: '192.168.1.10', port: 8791, scheme: 'http' })
// endpoint.origin → http://192.168.1.10:8791
// endpoint.url('/register') → http://192.168.1.10:8791/exec/v1/register

const client = new ExecClient({ endpoint, nodeId: 'node-3f2a', token: () => currentToken })
const registered = await client.register({ /* identity, slots, capabilities */ })
```

`resolvePlatformEndpoint` accepts a host name, an IPv4 address, or an IPv6 address with or without brackets, and rejects a value that carries a scheme, a path, whitespace, or a port. `platformEndpointFromUrl` reads the address parts back out of one `http`/`https` URL, which is the form a deployment may keep in a single environment variable. The client takes a transport override, so a caller can run it against a fake without a network. Endpoints that carry bytes — artifact upload and resource download — are not part of the client; see the limitations below.

Beyond the client, the package holds four decisions the caller applies itself: `recoveryForCode(code)` maps an envelope code to `retry`, `reauthenticate`, `reregister`, `abandon-task`, `discard-result`, or `halt-node`; `taskAttemptDelayMs` and `requestRetryDelayMs` give the protocol's attempt schedule and a jittered request backoff; `redactSecretText` and `redactSecretLines` strip credential values before a batch is submitted; `ulid`, `logBatchId`, and `artifactId` mint the idempotency keys; and `formatRfc3339` writes the local-offset timestamps the protocol's time fields expect.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The envelope parser never consults the HTTP status and never rejects an unknown field or code, so a platform that adds a code stays readable to an older node; an unrecognized code resolves to `retry`, which keeps a task from being stranded by a version skew. The client reads a `204` as an absent task for the claim long poll, and treats the `ALREADY_FINAL` marker as its own success, because that code reports that a submission had already landed.

### Source map

| File | Role |
|---|---|
| [`src/endpoint.ts`](src/endpoint.ts) | Host, port, scheme, and base-path validation; origin and request URLs |
| [`src/protocol.ts`](src/protocol.ts) | Protocol version, envelope parser, code vocabulary, already-final marker |
| [`src/errors.ts`](src/errors.ts) | Envelope error with its required recovery |
| [`src/backoff.ts`](src/backoff.ts) | Task-attempt schedule, request backoff, `Retry-After` reading |
| [`src/redact.ts`](src/redact.ts) | Credential-value redaction for log lines |
| [`src/ids.ts`](src/ids.ts) | ULID minting and the batch and artifact id forms |
| [`src/time.ts`](src/time.ts) | RFC 3339 formatting with a numeric UTC offset |
| [`src/client.ts`](src/client.ts) | The JSON endpoint client and its `fetch` transport |
| [`tests/mps-exec-core.spec.ts`](tests/mps-exec-core.spec.ts) | Address resolution, envelope handling, recovery mapping, backoff, redaction, ids, timestamps, every client method |

### Invariant ownership

The address is the single source of the request URLs: the client holds the resolved endpoint and never re-parses its parts, so a validated host cannot be re-interpreted per call. Redaction is asserted by the caller's own `containsSecretPattern` check rather than by the redacting itself.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [mps-executor](../mps-executor/README.md) — the node plugin that resolves this package's settings and drives the client
- [tianma group](../README.md) — where this package sits and how the family is composed

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current package boundary. They are current constraints, not a task backlog.

- **No byte endpoints** — artifact upload and resource download carry `multipart/form-data` and raw octet streams; this client performs the JSON endpoints only, so those two paths need their own transport work.
- **No chunked upload** — the `init` / `chunk` / `complete` flow an artifact above the platform's size threshold needs is not implemented here.
- **No request retry loop** — the package computes the delay a retry deserves and the recovery a code demands, but the caller owns the loop, its attempt counting, and its cancellation.
- **Capability detection is the caller's** — nothing here probes the host for tools or versions; the registering node supplies them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The two byte-carrying paths are the remaining protocol surface, and where their transport lands decides whether the chunked-upload flow shares this client's envelope handling or sits beside it. Nothing here is authoritative beyond the sections above and the source.
</details>
