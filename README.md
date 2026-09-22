# TianmaCoder

English | [中文](README.zh.md)

A secondary-development repository over DeepSeek Harness (dsh): porting ZCode's strengths (token accounting, recency-preserving compaction, summary fidelity, prompt craft) into dsh's Cordis plugin architecture.

**The development base is the full dsh source**; upstream updates merge in through the `dsh-upstream` remote.

## Docs

- [docs-integration-plan.md](docs-integration-plan.md) — the ZCode → dsh integration plan (P0 quality fixes / P1 continuity / P2 governance / verification protocol)
- [docs-integration-pr-roadmap.md](docs-integration-pr-roadmap.md) — the PR breakdown, milestones, and A/B verification protocol

## Upstream

- Base: https://github.com/deepseek-ai/deepseek-harness (master)
- Reference analysis: https://github.com/zai-org/ZCode

## Development

<a id="run"></a>

```sh
pnpm install
pnpm run build
pnpm dsh web --no-open
```

<a id="run-from-source"></a>

## Sync upstream

```sh
git fetch dsh-upstream
git merge dsh-upstream/master
```
