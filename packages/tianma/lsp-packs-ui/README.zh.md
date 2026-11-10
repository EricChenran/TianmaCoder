---
description: "Web GUI 插件页上的天码语言包卡片：列出桌面端可选的语言智能包，并通过桌面桥接安装或卸载。"
kind: "package-reference"
---

# @tianma/dsh-lsp-packs-ui

[English](README.md) | 中文

## 概述

在插件页增加一张语言包卡片，用来管理桌面外壳提供的可选语言包。只有当桌面外壳暴露 `dshDesktop.lspPacks` 时卡片才注册；普通浏览器里不注册任何内容，因此从不安装语言包的 Web 部署不会多出一张空页面。

每一行显示外壳报告的包状态（`missing` 未安装、`installed` 已就绪、`broken` 不完整），并提供对应动作：安装缺失或不完整的包，或卸载已安装的包。下载、失败回滚与写 profile 补丁都由外壳负责，卡片只负责展示状态并转发请求。

## 目录

- [使用这个包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用这个包

在 web bundle 的补丁里登记该插件，或从 profile 挂载：

```yaml
- insert:
    - id: lsp-packs-ui
      name: '@tianma/dsh-lsp-packs-ui'
```

卡片只出现在桌面端应用的插件页。安装会改写桌面 profile 的用户补丁；正在进行的会话可能需要重新打开一次，新语言才会出现在工具说明里。

<a id="understand-the-implementation"></a>
## 实现说明

浏览器侧在确认桌面桥接存在后注册一条 `plugins.item` 条目。状态由外壳持有：每次操作后卡片重新读取列表，因此安装失败时仍能看到之前的状态和失败原因。文案通过 `settings.lsp-packs` 命名空间本地化。

<a id="model-experience"></a>
## 模型体验

### 语言包管理卡片

#### 模型看到的内容

没有。卡片只是浏览器里的页面，不贡献提示词文本、不注册工具、也不产生会话事件。

#### Token 影响

无。本包不组装提示词、不发送请求。安装语言包会改变后续会话看到的工具清单（例如 `lsp`），那是语言包的效果，不是本卡片的效果。

#### KV Cache 影响

无；本包既不组装也不发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **无法取消**：卡片不能取消已经开始的安装；每次安装由外壳自己的超时限制。
- **Java 需要较新的 JDK**：目录里的 Eclipse JDT 快照要求 JDK 25；本机缺 JDK 或版本过低时，卡片分别显示「需要 JDK」或「JDK 版本过低」并禁用安装，避免挂载一个起不来的服务器。
- **样式独立**：卡片使用本包自己的 CSS Module 类，尚未接入共享基础组件的间距体系。

### 开发备注

卡片每次渲染都重新读取桥接而不是缓存它，因此在桌面外壳里重新加载渲染进程时，看到的 API 与 preload 暴露的完全一致。
