---
description: "The engine-scraping search provider for ctx.web: how deployments search Baidu, Bing, and 360 result pages without a vendor search API, a credential, or an auxiliary model request."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-serp

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-serp`, the harness searches the web by reading the result pages Baidu, Bing, and 360 serve over plain HTTP. Choose it when a deployment must search without a vendor search API, without a credential on the search path, and without an auxiliary model request; the shipped base bundle selects it as `serp`. The provider queries every configured engine concurrently, drops the engines that failed or were challenged, and merges the survivors into one deduplicated source list. No engine returns a generated answer, so a result carries only citeable sources. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `serp` search provider, so `ctx.web.search()` resolves it when it is the only usable backend — or pin it with `searchProvider: serp`, which is what the base bundle does.

### When to choose it

Choose this backend when no search API is available or wanted and the deployment accepts reading engine result pages over HTTP: it needs no key, so an unconfigured installation still searches, and it spends no model tokens on retrieval. It is a poor fit when results must be complete or stable — the engine decides what a page contains, and it may answer a client it distrusts with a challenge page instead of results.

### Minimal configuration

Load the web service and the provider; every field has a shipped default, so the provider is usable with no configuration at all.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: serp
- name: '@deepseek-ai/dsh-web-search-serp'
```

| Field | Default | Meaning |
|---|---|---|
| `engines` | `[baidu, bing, so360]` | Engines to query, in result-merge order; an empty list fails at load |
| `endpoints` | each engine's own search endpoint | Endpoint override by engine, for a mirror or a test double |
| `timeoutMs` | `8000` | Per-search budget (ms), covering every engine request that search starts |
| `minIntervalMs` | `1000` | Minimum gap (ms) between two requests to one engine host; `0` disables the gap |
| `maxResultsPerEngine` | `10` | Largest number of rows read from one engine's page |
| `maxHtmlChars` | `2000000` | Largest fetched document the parsers read |
| `userAgent` | a Chrome browser identity | User agent sent with every engine request |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-serp) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each engine row maps to a `WebSearchSource`: `url`, `title`, and the row's summary as `snippet` when the engine renders one. Rows are interleaved by rank — every engine that answered is represented before any engine's second row — then deduplicated by canonical URL and bounded by the request's `maxResults` or `maxResultsPerEngine`. A duplicate or a bound-dropped row sets `truncated`. No engine returns a generated answer, so the result carries no `content`.

### Failures and recovery

An engine that fails — a network error, a non-2xx response, a challenge page, or a page with no parseable rows — is dropped while the remaining engines still answer. Only when every engine fails does the search throw `WebError` `WEB_PROVIDER_ERROR`, whose message names each engine and its own failure, including an unusable endpoint, an anti-automation challenge page, or a page whose layout no longer matches the parser. A caller abort or the per-search budget elapsing surfaces as `WEB_ABORTED`. HTTP redirects are followed because the request carries no credential; the redirect rejection rule applies to credential-bearing requests, which this provider does not make. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is three thin engine adapters behind one normalized result, with four deliberate rules:

- **Engine markup, not an API, is the interface.** Each adapter reads one engine's result rows with a small set of patterns over the fetched document, and each is pinned by a captured fixture. A layout change is a focused, testable edit to one adapter.
- **No DOM dependency.** The installation gains no runtime package: attribute, text, and row reading live in `src/html.ts`, which also decodes the entities engines emit. That keeps an engine change a parser change rather than a supply-chain change.
- **Degrade across engines, never across searches.** Engines fail independently and partially; one engine's challenge page leaves the other engines' sources in place instead of failing the whole search.
- **Say what failed.** A page with no parseable rows is reported as that engine's failure rather than as an empty result, because an empty parse is the signal that the layout changed or the request was challenged.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and validation, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SerpSearchProvider`: concurrent fan-out, per-engine request and error handling, the politeness gate, and the rank-interleaved merge |
| [`src/engines.ts`](src/engines.ts) | One spec per engine: endpoint, query parameter, and the parser that reads that engine's rows |
| [`src/html.ts`](src/html.ts) | Entity decoding, text and attribute reading, URL canonicalization, challenge markers, and the document bound |
| [`src/types.ts`](src/types.ts) | The engine ids and one parsed row (`SerpHit`) |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request flow

`search()` starts one request per configured engine under a single budget signal, built from the caller's signal and `AbortSignal.timeout(timeoutMs)`. Each engine request waits out its host's `minIntervalMs` gap, then GETs `{endpoint}?{queryParam}={query}` with a browser user agent and `accept-language`. The response is bounded to `maxHtmlChars`, parsed by that engine's adapter, sliced to `maxResultsPerEngine`, and returned to the merge. Engine failures are collected, never propagated, until the merge finds no survivor. The merged result is deduplicated by origin, path, and query with the fragment and a trailing slash removed, so two engines reporting the same page collapse into one source.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [dsh-web-search-deepseek](../web-search-deepseek/README.md) — the auxiliary-model search route this provider replaces in the shipped base bundle and that remains selectable.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-serp) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, and summaries or its exact `every configured search engine failed — <engine>: <failure>` errors under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints.

- **The fixtures pin one capture per engine** — each adapter is covered by a result page captured on 2026-10-11 (headers in `tests/fixtures/`); when an engine restructures its page, that engine's parser and fixture change together.
- **Results are whatever the engine served** — the provider does not filter advertisements, sponsored rows, or low-quality mirrors beyond dropping the engine's own widget and self pages, and it cannot rank rows the way an API's relevance score does.
- **Baidu rate-limits a client that searches repeatedly** — it answers a security-verification page with HTTP 200, which this provider reports as that engine's failure while the other engines still answer. The verification markers are listed in `src/html.ts`; an engine that changes its page needs its marker added there.
- **A query with genuinely no results cannot be told apart from a layout change** — both parse to zero rows, and the provider reports zero rows as that engine's failure rather than as an empty result.
- **Partial engine failures are silent in the result** — the seam's result carries no warning field, so a caller sees only the sources of the engines that answered; the failures appear only when every engine fails.
- **360 citations carry its click wrapper** — its rows link through `so.com/link?m=…`, which resolves to the target in a browser but is not the target URL, and resolving it would cost one extra request per row.
- **The provider does not consult `robots.txt` or any engine's terms of service** — a deployment that mounts it accepts the search operators' terms, and `minIntervalMs` is the only politeness knob it offers.
- **Only Baidu, Bing, and 360 are implemented** — Sogou needs a cookie handshake its own anti-automation page withholds, and Sohu's search page renders its results client-side, so neither is reachable over plain HTTP.
- **`snippet` depends on each engine's summary container** — a row that renders no summary contributes a URL and title only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Open: resolving engine wrapper URLs

360 and some Baidu rows cite a click wrapper rather than the target. Resolving a wrapper means one additional request per row, which the current design rejects on latency and rate-limit grounds; a bounded, cached resolver is the alternative if citation quality outweighs that cost.

#### Open: an engine challenge marker as configuration

The challenge markers are external-spec constants in `src/html.ts`. They stay constants while the engine set is fixed; a deployment adding engines of its own would need them per spec.

</details>
