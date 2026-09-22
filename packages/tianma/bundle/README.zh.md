---
description: "Tianma bundle：在 dsh-base 之上采纳源自 ZCode 的压缩质量默认值与插件的单层补丁，供组合 Tianma 能力集的部署方使用。"
kind: "package-bundle"
---

# @tianma/dsh-bundle

[English](README.md) | 中文

## 概述

在任何 base-backed profile 之上组合 Tianma 能力集：把本 bundle 列在 `dsh-base` 与模式 bundle 之后，即可提高压缩逐字保留尾部、停止 AGENTS.md 静默截断、并换入近因保全裁剪器与高保真总结器。每个能力一行，可独立禁用或调参而无需改代码；上游行 id 漂移会让覆盖过期时，CI 校验器直接失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 profile 中把本 bundle 列在 base 与模式 bundle 之后，或通过有序 `--patch` 覆盖层传入：

```yaml
bundles:
  - '@deepseek-ai/dsh-base'
  - '@deepseek-ai/dsh-web-app'
  - '@tianma/dsh-bundle'
```

补丁覆盖的每一行都保留自己的配置块，部署方可独立调参或禁用（`disabled: true`）任一能力，无需改代码。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本 bundle 是覆盖其他包所拥有行的静态补丁文档：不挂载服务、不发出事件、不持有可变状态；每个被覆盖行的行为与不变式由该行自己的包负责。补丁会整体替换目标行的 `config`，因此每行重述其拥有的全部键；`scripts/verify-profile-patches.ts` 解析本文件与 dsh-base 补丁，断言每个被覆盖的 id 在基础层恰好出现一次。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 本包实体：行覆盖，每个能力一行，行内注释说明理由 |
| [`src/index.ts`](src/index.ts) | 包入口；不携带运行时 API |
| — | No runtime invariant companion is published; 本包是静态补丁列表载体（由其他包拥有的 loader 行组成的 YAML 文档）；不挂载服务、不发出事件、无可变关系可查。每个被覆盖行自己的包承载该行的不变式。 |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | 清单声明、可解析性与行替换检查 |

### 不变式归属

No invariant companion is published because 本包是静态补丁列表载体：每个被覆盖行的不变式由该行自己的包负责，bundle 本身无可变关系可查。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Tianma 包映射](../README.zh.md) — 本 bundle 挂载的插件家族
- [dsh-base bundle](../../bundle/base/README.zh.md) — 被覆盖行所在的基础层
- [app-boot profiles](../../boot/app-boot/README.zh.md) — bundle 在 profile 中如何叠加
- [整合方案](../../../docs-integration-plan.md) — 本 bundle 交付的 Tianma 路线图

-----

<a id="model-experience"></a>
## 模型体验

间接生效：经每个被覆盖行的包，由该行拥有模型可见行为。

#### KV 缓存影响

本 bundle 自身不增加请求前缀；任何缓存影响由被覆盖行的包负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限说明补丁层需要留心的地方。它们是当前的包约束，不是任务清单。

- **行替换需重述完整配置** — 上游默认值变更不会流入被覆盖的行；校验器只抓 id 漂移不抓语义漂移，升级上游时需要复核行配置。
- **能力集固定为已交付的行** — 采纳未来的 Tianma 包仍需编辑本补丁（一行），不是纯配置操作。
- **无按模式重述** — 重述了被覆盖行配置的模式 bundle 按最后写入胜出；模式专属的 Tianma 值需要单独的模式补丁。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
