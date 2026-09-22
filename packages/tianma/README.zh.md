---
description: "Tianma 集成包族：源自 ZCode 的质量插件，通过 profile patch 组合到 dsh 之上，绝不修改上游包。"
kind: "package-group"
---

# tianma/：Tianma 集成家族

[English](README.md) | 中文

## 摘要

子系统参考：[`docs/subsystems/tianma.zh.md`](../../docs/subsystems/tianma.zh.md)

`tianma/` 组承载 TianmaCoder 对 DeepSeek Harness 的二次开发面：移植 ZCode 上下文压缩质量机制的插件（近因保全裁剪、高保真总结、token 计量校准）以及挂载它们的 bundle。包只通过上游 seam（`ctx.*`）注册；除各包文档声明的公开扩展点外，绝不 import 上游 `@deepseek-ai/dsh-*` 内部模块。所有挂载都是 profile patch 行替换，回滚任一能力只需移除一行。

## 目录

- [包](#packages)
- [组合](#composition)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`bundle/`](bundle/README.zh.md) | Tianma bundle：替换 dsh-base 行以采纳 Tianma 默认值与插件的 profile patch |
| [`behavioral-guidelines/`](behavioral-guidelines/README.zh.md) | 移植自 ZCode 的行为提示词节，以具名 system-prompt contribution 注册 |
| [`compaction-recency-pruner/`](compaction-recency-pruner/README.zh.md) | 近因保全的工具结果清理，替换头/中/尾裁剪器 |
| [`compaction-summarize/`](compaction-summarize/README.zh.md) | 高保真压缩总结器，子类化文档声明的 `summarize()` 钩子 |
| [`token-meter-calibration/`](token-meter-calibration/README.zh.md) | 中文感知密度估算与 usage 驱动的校准因子 |
| [`compaction-file-rehydrator/`](compaction-file-rehydrator/README.zh.md) | 压缩后从 append-only 日志重建已读文件账本，注入为作用域提示节 |
| [`hooks-trust/`](hooks-trust/README.zh.md) | 第三方 workspace hook 的内容哈希信任账本 |

<a id="composition"></a>
## 组合

在 profile 的 bundle 列表中，把 Tianma bundle 放在 `dsh-base`（以及任一模式 bundle）之后。其 `cordis.patch.yml` 按 id 覆盖 dsh-base 行；`scripts/verify-profile-patches.ts` 在上游 id 漂移时让 CI 失败，杜绝过期覆盖静默上线。每个被替换的行保留插件自己的配置块，部署方可独立调参或禁用（`disabled: true`）任一能力，无需改代码。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>为什么用 patch 而不是改上游默认值</summary>

路线图（`docs-integration-pr-roadmap.md`）固定了交付形态：独立包 + profile patch 行，不触碰上游文件。这让上游合并零冲突、每个能力可独立回滚，并让补丁校验器证明装配始终完好。
</details>
