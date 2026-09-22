# TianmaCoder

基于 DeepSeek Harness (dsh) 的二次开发仓库:将 ZCode 的优势(token 计量、近因保全压缩、总结保真、提示词工艺)融入 dsh 的 Cordis 插件架构。

**开发主体为 dsh 完整源码**;上游更新通过 `dsh-upstream` 远程拉取合并。

## 文档

- [docs-integration-plan.md](docs-integration-plan.md) — ZCode → dsh 整合方案(P0 质量急救 / P1 连续性 / P2 治理 / 验证协议)

## 上游

- Base: https://github.com/deepseek-ai/deepseek-harness (master)
- 参考分析: https://github.com/zai-org/ZCode

## 开发

```sh
pnpm install
pnpm run build
pnpm dsh web --no-open
```

## 同步上游

```sh
git fetch dsh-upstream
git merge dsh-upstream/master
```
