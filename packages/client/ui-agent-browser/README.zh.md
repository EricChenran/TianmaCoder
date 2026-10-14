---
description: "右侧 Sidebar 的 Agent 浏览器 tab：呈现 agent 自动化正在操作的嵌入式浏览器页面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-browser

[English](README.md) | 中文

## 概述

把 agent 自动化正在操作的嵌入式浏览器页面，作为右侧 Sidebar tab 呈现在发起它的 Session 旁边。本包注册 tab 类型、本地化 guide 条目与标题；guest 页面本身由 Desktop 主进程持有，经 Desktop 载体到达 tab。本包不会向被访问内容注入 Electron 或 Node 能力。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从右侧 Sidebar guide 打开 **Agent 浏览器**，或交给自动化打开：当 agent 为当前屏幕上的会话获取浏览器租约时，该 tab 会自动出现——窗格既是人观察 agent 操作的地方，也是 guest 量尺寸的表面。该 tab 附着到所属 Session 的 agent 浏览器租约，因此面板跟随自动化正在处理的页面，自身不再发起第二次导航。与相邻的浏览器 tab 一样，它支持多开。

### 何时选择

需要观察或接管自动化时选择 Agent 浏览器。想自己访问地址时选择[浏览器](../ui-sidebar-browser/README.zh.md)；两者并存并共用 workspace 存储分区，因此你已登录的页面对自动化同样已登录。

### 最小配置

本包没有插件配置。profile 通过 bundle patch 启用随附条目：

```yaml
- id: ui-agent-browser
```

客户端插件可通过 `ctx.sidebarRight.openTab('agent-browser')` 打开 tab。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

### tab 定义

`agentBrowserDefinition` 声明 tab 类型 `agent-browser`，`priority: 'builtin'` 并带一个 guide 条目；标签取自本插件的 locale 命名空间，文案因此归 locale 所有。

### Slot 注册

插件通过 `ctx.slots.inject` 针对 `'sidebar.right.pane.tab'` 与 `'sidebar.right.pane.tab.title'` 注册，以 `AGENT_BROWSER_ID` 为 key。注入会等待 Sidebar Right 的声明，声明塌缩时移除这两项贡献，并随插件 fiber 一起退出。

### 载体

guest 是 Desktop 主进程创建的加固离屏 `WebContentsView`。tab 主体用 `ResizeObserver` 测量自身面板，并经应用 preload 上报矩形；主进程据此把活动 tab 的视图 attach 到该矩形，人类由此看到自动化正在操作的页面。本包的 client 半边仅负责呈现，不持有 Electron 或 Node 能力。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [嵌入式浏览器子系统](../../../docs/subsystems/browser-use.zh.md) —— provider、工具与归属。
- [右侧 Sidebar](../../../docs/subsystems/sidebar-right.zh.md) —— tab 组合、导航与生命周期。
- [browser-use-desktop-guest](../../experimental/browser-use-desktop-guest/README.zh.md) —— 驱动 guest 的模型侧工具。
- [host-browser-control](../../host/browser-control/README.zh.md) —— Host 到主进程的命令信封。

-----

<a id="model-experience"></a>
## 模型体验

无：Agent 浏览器 tab 属于面向用户的呈现状态，不注册任何工具、prompt 段落或 Session 事件。

#### KV Cache 影响

无；观看 guest 页面不会进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- tab 主体会测量自己的面板并把矩形上报给 Desktop shell，由 shell 把 agent guest 绘制在其上；面板本身不绘制页面内容，且在自动化为同一 Session 打开租约之前保持空白。
- 面板目前只上报几何信息，尚未绘制"正在操作"指示、元素高亮、弹窗提示与下载进度。
- 该 tab 附着于 Session 的 agent 浏览器租约，自身不拥有导航：没有地址栏，打开 tab 也不会加载自动化未加载过的 URL。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

tab 类型在 `packages/bundle/web-app/cordis.patch.yml` 注册；省略该行的 profile 没有 Agent 浏览器 tab，其他行为不变。

</details>
