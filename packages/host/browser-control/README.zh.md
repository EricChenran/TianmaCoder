---
description: "Host 浏览器控制缝的线上契约：Host 插件与 Electron shell 内嵌浏览器 guest 之间的请求、结果与事件形状。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-browser-control

[English](README.md) | 中文

## 概述

一条 IPC 缝的类型与窄守卫：Host 插件请求内嵌浏览器操作（租约、执行、释放），Electron shell 以关联结果与不请自来的 guest 事件作答。本包只钉住信封——请求关联、三个操作、带稳定错误码的结果联合、事件形状；不保存浏览器状态，也不执行任何操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

desktop host 导入客户端契约并以 `desktopBrowserControl` Cordis 服务暴露给插件；Electron shell 导入请求与结果形状用于自身的入站校验。从包根导入以下任意内容：请求联合、结果与事件联合、`isBrowserControlRequest`/`isBrowserControlMessage` 守卫、`DesktopBrowserControl` 客户端接口、带稳定 `code` 的 `BrowserControlError`。

### 线上形状

一条请求是单个判别对象（`type: 'browser'`），携带 `requestId` 与 `acquire`、`execute`、`release` 三者之一。shell 以相同 `requestId` 回答 `type: 'browser-result'`：`ok` 加 JSON `result`，或 `error` 加可选稳定 `code`。不请自来的事实以 `type: 'browser-event'` 传输。每个消息体都必须能过结构化克隆；`BrowserControlJson` 类型是操作所携带内容越过边界时的形状。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

[源码](src/index.ts)只有类型、两个守卫和一个错误类；无运行时依赖、无 I/O。`BrowserControlRequestInput` 是分布式 `Omit`，插件在不含信封构造请求时每个操作保留自己的字段。[desktop host](../../../apps/desktop-host/src/browser-control.ts) 用本契约包装请求客户端与 Cordis 服务注册；[shell](../../../apps/desktop/src/browser-control-main.ts) 在自己的信任边界上独立声明校验并分发到 guest 处理。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Browser use](../../../docs/subsystems/browser-use.zh.md) — provider 选择与 Session 所有权。

-----

<a id="model-experience"></a>
## 模型体验

无：本包只包含类型、守卫与一个错误类。

#### KV Cache 影响

无；本包不添加任何模型可见内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作


- **只有信封** — `execute` 内部的命令词表由 Electron shell 持有并校验；本包钉住信封，无法描述存在哪些命令。
- **单一传输假设** — 形状假定结构化克隆 IPC；无法承载它们的传输需要自己的契约。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

shell 有意用自己的守卫复检入站消息；修改形状时保持两个守卫字面一致，并在同一次变更中更新 `apps/desktop/tests` 里的缝契约 spec。

</details>
