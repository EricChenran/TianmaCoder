---
description: "Tianma bundle 补丁：在 dsh-base 之上采纳源自 ZCode 的压缩质量默认值与插件的行覆盖，供组合 Tianma 能力集的部署方使用。"
kind: "package-reference"
---

# @tianma/dsh-bundle

[English](README.md) | 中文

## 摘要

Tianma bundle 是一个分发补丁层，在 profile 的 bundle 列表中排在 `dsh-base`（以及任一模式 bundle）之后生效。每行按 id 覆盖一个 dsh-base 行——采纳调优后的默认值或换入 Tianma 插件——因此每个能力都可以通过移除所在行独立回滚，且上游 id 漂移导致覆盖过期时 `pnpm run verify:profile-patches` 会让 CI 失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)

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
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | 清单声明与可解析性检查 |

### 不变式归属

No invariant companion is published because 本包是静态补丁列表载体：每个被覆盖行的不变式由该行自己的包负责，bundle 本身无可变关系可查。

</details>
