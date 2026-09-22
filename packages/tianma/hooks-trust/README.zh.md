---
description: "第三方 workspace hook 的信任准入：内容哈希账本，未变化的批准直接放行，任何变更重新审查，拒绝跨重启持久化。"
kind: "package-reference"
---

# @tianma/dsh-hooks-trust

[English](README.md) | 中文

## 概述

第三方 workspace hook 只有在其**精确命令文本**被批准后才允许执行。账本对每条命令做 sha256 哈希并记录决定：相同命令存在 `approved` 记录即放行；哪怕改一个字节也重新审查；`denied` 跨重启持久化；账本损坏时 fail-closed 全部重审。

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

挂载插件后账本暴露在 `ctx.tianmaHookTrust`；hook 执行方在执行前调用 `evaluate(command, source)`，在用户裁定后调用 `decide(command, state, source)`。配置：`ledgerPath`（默认 `<home>/.dsh/tianma-hook-trust.json`）。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`HookTrustStore` 维护以哈希为键的决定映射，持久化为带版本的 JSON 文档；restore 容忍文件缺失，并把损坏视为 fail-closed（全部重开审查）。`apply` 将该存储注册为 `tianmaHookTrust` 服务。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/store.ts`](src/store.ts) | 哈希、决定、持久化、fail-closed 恢复 |
| [`src/index.ts`](src/index.ts) | 服务注册与配置 |
| [`tests/hooks-trust.spec.ts`](tests/hooks-trust.spec.ts) | 未知开审、变更重审、拒绝持久化、损坏 fail-closed |
| — | No runtime invariant companion is published; 本账本是哈希键的决定集合，无派生关系，决定由测试直接断言。 |

### 不变式归属

No invariant companion is published because 账本不持有派生关系：每条记录都是独立的决定事实。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [hooks 桥接](../../hooks/README.zh.md) — 本账本旨在约束的 Claude Code/Codex hook 执行器

-----

<a id="model-experience"></a>
## 模型体验

### Hook 准入账本

#### 模型看到什么

什么都不看到。账本在命令执行前把关准入；其决定是进程内状态，从不进入请求。准入契约是执行方包裹执行过程的一对调用。

##### 准入契约

```markdown
const decision = trust.evaluate(command, source)   // 'approved' | 'denied' | 'review'
trust.decide(command, state, source)               // record the user's ruling
```

#### Token 影响

零——请求面没有任何变化。

#### KV 缓存影响

无——任何请求前缀都不增不减。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限定义 v1 边界。它们是当前的包约束，不是任务清单。

- **库优先** — 上游 hooks 执行器尚未调用本账本；接线是后续工作（需与上游讨论 seam）。
- **精确命令哈希** — 空白差异视为不同 hook；归一化已延期。
- **无 UI** — 决定通过编程记录；审查 UI 随执行器集成一起落地。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

以最小账本形态移植自 ZCode 的 hooks 信任层（trust-domain/records/evaluation）；剩余的一半是执行器集成。

</details>