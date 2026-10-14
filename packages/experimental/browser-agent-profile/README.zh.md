---
description: "让 agent 用工具驱动桌面浏览器，并可实时旁观它的操作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-browser-agent-profile

[English](README.md) | 中文

## 概述

在桌面端为每个 Agent 装上 `browser_*` 工具，并让同一个页面同时被人看到。本组合包挂载 [browser-use 服务](../../browser-use/browser-use/README.zh.md) 与 [桌面 guest 提供方](../browser-use-desktop-guest/README.zh.md)，其 guest 复用侧栏浏览器的存储分区与登录态。它在 Web 与桌面端都**默认关闭**；在插件页选中后即在桌面端生效。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在桌面端打开插件页，在"官方"分组中启用 **浏览器自动化**。关闭它即移除本组合包的配置层。提供方只在桌面 Host 提供浏览器控制缝的环境里挂载，因此 Web 画像会把该行报为缺失服务而不是启动失败。

guest 复用 `default` 工作区分区，因此你在侧栏浏览器里已经登录过的页面，对 agent 也是已登录状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 browser-use 服务与带 `workspaceKey` 的桌面 guest 提供方。后续 profile 补丁可以按 id 覆盖这两行。[profile 组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序与报错；[桌面应用](../../../apps/desktop/README.zh.md) 提供其 Host 上的控制缝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[桌面 guest 提供方](../browser-use-desktop-guest/README.zh.md) · [会话级浏览器资源](../browser-use-runtime/README.zh.md) · [browser-use 服务](../../browser-use/browser-use/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地经由 [桌面 guest 提供方](../browser-use-desktop-guest/README.zh.md)，工具目录、结果与页面内容信任规则都由它负责。

#### KV Cache 影响

本配置层不直接向请求追加内容；缓存影响来自提供方的工具与提示词。开关本组合包会改变在线会话的工具列表，因而使其缓存前缀失效一次。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 本组合包默认关闭：没有任何随附画像会选中它，因此需要有人先在插件页启用，工具才存在。
- guest 依赖桌面 Host：Web 画像没有浏览器控制缝，该行会报缺失服务，而不是去驱动一个浏览器。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
