---
description: "压缩后文件状态再水合：从 append-only 日志重建已读文件账本，注入为 agent 作用域提示节，让检查点之后的请求知道哪些文件已过期。"
kind: "package-reference"
---

# @tianma/dsh-compaction-file-rehydrator

[English](README.md) | 中文

## 概述

让模型的文件记忆跨越压缩存活。检查点落库后，本插件从 append-only 会话日志（压缩无法摧毁的那部分数据）重建已读文件账本（路径、读取次数、读后编辑），并注册为 agent 作用域的 system-prompt context——下一个请求立刻知道哪些文件是新鲜的、哪些是 STALE 的，再去编辑。

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

在跑长会话且会触发压缩的任何组合中挂载本插件。Tianma bundle 以 `tianma-compaction-file-rehydrator` 行插入。配置只有一项：`maxChars`（默认 4096 字符）限制渲染节的大小。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`apply` 监听 `agent/created`，为每个 agent 注册一个作用域 system-prompt context；provider 在每次组装时从 `agent.session.snapshotEvents()` 重建视图——tool call 解析名字与参数，tool result 携带结果，读后有编辑即标记 STALE。作用域注册保证其他 preset 的会话不受影响，效果随插件卸载而回退。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/view.ts`](src/view.ts) | 纯函数账本构建器与有界渲染器 |
| [`src/index.ts`](src/index.ts) | `agent/created` 接线与作用域 context 注册 |
| [`tests/file-rehydrator.spec.ts`](tests/file-rehydrator.spec.ts) | 账本核算、STALE 标记、预算限制、接线契约 |
| — | No runtime invariant companion is published; 本插件注册一个派生的提示 context，除派生视图外无可变关系。 |

### 不变式归属

No invariant companion is published because 视图是 append-only 日志的纯投影：事实由日志持有，本包只负责渲染。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [compaction-basic](../../compaction/compaction-basic/README.zh.md) — 本包平滑其后遗症的检查点写入者
- [system-prompt 组装](../../core/system-prompt/README.zh.md) — 作用域 context seam
- [session](../../core/session/README.zh.md) — 账本重建所依据的 append-only 日志

-----

<a id="model-experience"></a>
## 模型体验

### 再水合文件账本

#### 模型看到什么

压缩检查点之后，下一个请求包含一个 context 节：列出已读文件、读取次数、读后被编辑文件的 STALE 标记，并指示编辑前先重读过期路径。日志里没有读取记录时节不产生任何内容。

#### Token 影响

受 `maxChars`（默认 4096 字符）限制；通常几百 token，随组装后的提示每请求一次。

#### KV 缓存影响

该节是追加到持久消息流的动态 context 快照；只在账本变化时改变，因此在两次变化之间计入可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些局限定义再水合器不覆盖的部分。它们是当前的包约束，不是任务清单。

- **路径解析容错但不感知工具 schema** — 账本按 `path`/`file_path`/首个字符串参数取值；特殊工具 schema 可能少计数。
- **读取工具是固定集合** — 仅 `read`/`view` 变体；自定义读取类工具需要扩展白名单。
- **只做提示节，不做强制** — 账本是建议不是执法；过期编辑仍由 fs 版本守卫兜底，不由本节拦截。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

移植自 ZCode 的 read-file-state-hydrator；dsh 形态反转了存储方式（ZCode 再水化一个内部 map，dsh 从 append-only 日志渲染提示节——日志持有事实，别处无需持久化）。

</details>