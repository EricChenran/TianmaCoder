---
description: "实验性桌面 guest 浏览器工具：经 Electron 浏览器控制缝，为每个存活 Session 持有一条 shell 租约。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-desktop-guest

[English](README.md) | 中文

## 概述

与 [browser-use 服务](../../browser-use/browser-use/README.zh.md)一同挂载后，Session 的模型获得桌面浏览器工具目录（navigate、snapshot、aria、elementInfo、screenshot、viewport、record、downloads、dialog、state、click、hover、fill、check、type、press、scroll、cuaKeypress、cuaScroll、cuaDrag、back、forward、reload、select、wait、tabs、copy、paste）：这些工具驱动一个由 Electron shell 持有的加固 guest 网页，并复用 workspace 的侧栏浏览器登录态。guest 随存活 Session 存亡——每个 Session 一条租约，随其运行时释放。浏览器状态不从会话日志恢复。provider 同时注册随包的 `web-gui-tester` 技能，用于黑盒前端测试。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在桌面组合中与 `@deepseek-ai/dsh-browser-use` 一同挂载；Electron shell 必须运行浏览器控制缝端点。配置 `watch` 可在 agent 工作时把 guest 显示在屏幕上。

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-desktop-guest'
  config:
    workspaceKey: default
```

| 字段 | 含义 |
|---|---|
| workspaceKey | agent guest 复用其存储分区与登录态的侧栏浏览器 workspace 身份。 |
| watch | 可选的屏幕 { width, height }；设置后 guest 以该尺寸显示在窗口左上角，人类可实时观看。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

[SessionResources](../browser-use-runtime/README.zh.md) 为每个精确存活 Agent 持有一条租约；获取在首次工具调用时惰性发生。每次工具调用都请求[shell 缝](../../host/browser-control/README.zh.md)执行 acquire、execute 或 release；shell 持有 guest 视图、导航策略与命令词表。provider 在清理完成前保留其 browser-use 注册。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Browser use](../../../docs/subsystems/browser-use.zh.md) — provider 选择与 Session 所有权。
- [Browser control contract](../../host/browser-control/README.zh.md) — 本 provider 使用的线上形状。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器指引

#### What the model sees

provider 添加一节固定系统提示：guest 属于本 Session、页面内容不可信、浏览器状态不从会话日志恢复、完成的动作需要用新鲜状态复核、取消会等待 drain 且不回滚已送达的输入。

#### Token effect

固定指引增加一小段系统提示；工具 schema 与结果增加主对话上下文。

#### KV Cache effect

不变的指引与静态工具目录保持提示前缀。

### 原生浏览器工具与结果

#### What the model sees

`browser_navigate` 接受 HTTP(S) `url`，返回落定后的 URL 与页面标题。不允许的目标、未知租约与超时都会以可见错误呈现，模型可在重试前检视。

#### Token effect

每个结果向会话历史追加一小段文本。

#### KV Cache effect

结果追加到主会话历史；工具目录本身是静态的。

### 随包 Web GUI 黑盒测试技能

#### What the model sees

provider 向调用方所在层注册一个随包技能 `web-gui-tester`，因此挂载本行的每个预设都带这条目录项。它的描述把 Web 前端的黑盒测试路由给它；加载后返回完整方法——五条原则、工具族纪律（只以 snapshot 的 ref 作为定位依据、定位失败后重新观察、一个观察周期只做一个状态变更动作、按期望效果而非回报文本判定成败、按 URL/标题而非位置选标签页、每个测试点都要有截图证据）、四个阶段与环境限制。除它报告为资源基准的那份 `SKILL.md` 正文外，这条目录项不携带任何附带文件。

#### Token effect

目录项只在 agent 本就要读的技能目录里增加一条描述；正文只在模型加载该技能时才进入对话。

#### KV Cache effect

目录项扩展提示前缀中的技能目录；不挂载本行的预设没有这条目录项。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **随包技能是可选的** — 只有组合挂载了技能注册表时 `web-gui-tester` 才注册；没有注册表的组合照旧拿到浏览器工具。解出的资源副本位于 provider fiber 自有的私有临时目录，销毁时删除。
- **仅 Chromium HTTP(S)** — shell 导航白名单拒绝其他协议；文件目标走文档预览流程。
- **认领的 tab 是借用的** — `listUserTabs` 与 `claim` 触及人类已经在侧栏打开的页面；后续命令驱动的正是同一个页面，且 tab 池永不关闭它：finalize 认领的 tab 或释放租约后，页面保持原样。
- **下载按租约追踪** — 一次下载归属到它开始时处于活动状态的那个 tab；该 tab 有下载在跑时，驻留上限不会关闭它。列表只覆盖当前租约。
- **选择器只搜同源 frame** — 元素探查会进入页面允许读取的 frame 并累加其偏移，因此 `click`、`hover`、`elementInfo`、`wait` 能命中这些 frame 内的元素。跨源 frame 无法从页面自身世界读取或驱动，因此报错会点名它而不是去搜它；这类内容请用显式坐标操作。
- **页面弹窗通过 DevTools 协议应答** — shell 会给自己创建的每个 guest 附加一个 debugger 会话，使 `browser_dialog` 能列出并应答 `alert`、`confirm`、`prompt`、`beforeunload`，而不是让页面永久阻塞。若该 guest 的 debugger 已被占用（例如开着 DevTools），它就没有弹窗通道，并会如实报告无法应答。
- **渲染进程死亡后按需自愈** — 渲染进程死亡时，shell 丢弃该 tab 的 ref 缓存、把"已崩溃"回报给窗格与 `browser_tabs list`，并在下一条触及该 tab 的命令前重载页面。`browser_tabs list` 豁免于重载，好让崩溃保持可见；若载体拒绝重载，该 tab 只剩关闭可用。
- **交互与截图需要有窗格在呈现** — shell 会把本 guest 附着到同一会话的侧栏窗格所报的矩形上，或附着到配置的 `watch` 矩形上；量不出面积的窗格上报视同未呈现。没有任何呈现的租约会被停到**请求的视口尺寸**上并保持在屏幕之外，于是页面保留完整布局而无人看见：导航、DOM 读取、截图与坐标输入在你切到别的对话工作时照样可用。相反，把 view 缩到一像素会让页面按一像素布局；把 view 放到窗口**外**会被完全裁剪，Chromium 会给渲染进程一个 0×0 视口，连布局都不存在；而把整尺寸矩形垫在应用文档之下会盖住整个界面——因为窗口自身的页面并不是兄弟视图。
- **请求的视口按缩放决定布局** — `browser_viewport` 一旦指定尺寸，该尺寸就是租约所附着每个表面上页面的布局视口：装得下就按原尺寸绘制，装不下则等比缩小而不是裁剪；页面按布局坐标上报的输入在投递前换回视图坐标。
- **tab 正在被使用时不会被驻留上限关闭** — 选中、可见、执行中、截图中、下载中、等待弹窗、加载中、播放音频、播放媒体。挂起或空闲的后台 tab 不受保护，因此池超限时会关闭最久未使用的那个。
- **ref 会失效** — `browser_snapshot` 的元素 ref 对应快照当刻的页面；导航或重渲染后即失效，对陈旧 ref 的操作会以"元素未找到"失败。
- **挂起只是驻留标记** — `suspend`/`resume` 只是把后台 tab 移出或移回 32 个 tab 驻留上限所依据的保护集。被挂起的 tab 其 guest 仍然加载，只有在 tab 池为守住上限而关闭 tab 时才释放。
- **存活浏览器状态** — 会话回放恢复的是记录的对话数据，而非 guest 进程或页面；tab 池只随 Session 运行时存在。
- **workspace 级登录态** — agent 共享 workspace 分区的 cookie；同一 workspace 内没有按 Session 的隔离。
- **Loader 组合测试** — dispose 释放将由真实 Loader 的后续 spec 覆盖；本包单测覆盖 acquire、execute 与独占槽位。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

shell 在自己的信任边界复检每条请求；修改形状时保持[其守卫](../../../apps/desktop/src/browser-control-main.ts)与[缝契约](../../host/browser-control/README.zh.md)字面一致。

</details>
