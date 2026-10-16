---
description: "天码 MPS 执行节点控制：Web GUI 用来启动、停止并回读它所托管的执行节点进程的入口。"
kind: "package-reference"
---

# @tianma/dsh-mps-node-control

[English](README.md) | 中文

## 概述

给 Web GUI 一个运行执行节点的地方。节点本身是一个独立应用——`dsh --profile mps-node`，有自己的 home、编码根与凭据——所以本插件托管这个进程，而不是把节点挂进 GUI 的 profile：`ctx.mpsNodeControl` 负责启动、停止、报告它现在处在什么状态，并回读它打印的日志行。生命周期归 GUI：插件被销毁就把进程带走；部署自己的参数则通过启动 GUI 时的那份环境变量传给子进程。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂在需要 GUI 入口的组合里；Web 应用 bundle 为桌面与浏览器 profile 挂上它，不需要节点的自动化 profile 只要不加这一行即可。

配置项：`entry`（默认取启动本进程的那个入口）、`nodeBinary`（默认取运行中进程自己的 Node）、`loaders`（默认取本进程自己的模块加载器，源码启动能跑正是靠它）、`profile`（默认 `mps-node`）、`logLines`（默认 200）、`stopGraceMs`（默认 10 000）。

远程命名空间 `mpsNodeControl` 暴露 `status`、`start`、`stop`、`logs`。[@tianma/dsh-mps-node-ui](../mps-node-ui/README.zh.md) 的浏览器半边把它们渲染成设置页的一节；节点自己的部署参数**刻意不归本插件管**——子进程继承环境变量，缺什么由节点在日志里说明，而这些日志正是本服务回读的内容。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内情——点击展开</summary>

子进程按**本进程自己的启动方式**拉起：同一个 Node 二进制、同一套模块加载器、以 `process.argv[1]` 作为入口，再补上 `--profile mps-node`。因此源码启动（TypeScript 加载器下）与安装包启动（已安装 CLI 下）都不需要部署额外声明路径，同时这三者都保留可覆盖，供把节点放在别处的组合使用。

状态放在 TypeScript 的 `private` 字段而不是 ECMAScript 的 `#private` 字段里。调用方是通过 Cordis 的 Service 代理到达服务方法的，那个 receiver 并不是实例本身，所以 `#private` 字段在方法体里根本不可见。

一次读数要区分三种"结束"，调用方必须分得清：`starting` 覆盖从发出请求到操作系统确认之间的窗口；**进程从未存在**（二进制不存在）报 `failed`，带启动错误且没有 exit——没有任何退出码能解释它；**跑起来又结束**报 `stopped`，带退出码、信号与最后打印的几行，这正是"节点配置错了"与"节点本身坏了"的区别所在。

销毁时直接杀进程、不等待：插件拆卸无法 await，所以需要等它真正结束时调用方要用 `stop()`；而这个 effect 保证的就是"关掉 GUI 不会留下一个节点在跑"。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `MpsNodeControlService`：启动、停止、状态与最近输出环形缓冲 |
| [`src/types.ts`](src/types.ts) | 界面渲染用的阶段、退出与日志行词汇 |

</details>

<a id="further-exploration"></a>
## 进一步探索

- [@tianma/dsh-mps-node-bundle](../mps-node-bundle/README.zh.md)——挂载本服务所启动节点的 profile bundle。
- [@tianma/dsh-mps-executor](../mps-executor/README.zh.md)——节点本体：它领取什么、执行什么、交付什么。

<a id="model-experience"></a>
## Model Experience

没有。本插件托管一个进程并把它的状态报告给设置页，不注册任何提示词、工具或 Session 事件。

#### KV Cache effect

这里没有任何东西进入模型请求，因此本包既不增长也不替换任何请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **部署参数不在这里编辑** —— 平台地址、节点 id、密钥环境变量与编码根，都通过启动本 GUI 进程时的环境变量传给节点。若部署希望从界面改这些值，需要一个把它们写到节点会读的地方的界面，那不在本包职责内。
- **最近输出只在内存里** —— 环形缓冲只留最后 `logLines` 行，随进程消失；更早的内容以节点自己按天的日志文件为准。
- **读数不持久** —— GUI 重启后就忘了上一段节点进程是怎么结束的，直到下一段结束。
- **一个 GUI 一个节点** —— 本服务只托管一个子进程；一台机器要跑多个节点就在这个入口之外跑。
- **停止会在 `stopGraceMs` 后升级** —— 首次信号之后超过宽限期仍不退出的节点会被强杀，因此正在进行的长时间交付可能被一次停止切断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

启动约定是这里最值得保住的部分：子进程按 GUI 进程自己的启动方式拉起，因此入口、二进制与加载器都跟着部署走，而不是在部署里再声明一遍。产品将来换一种启动方式，这里不需要跟着改。

本包之所以存在，是因为节点是一个独立应用。若改成把节点 bundle 挂进桌面 profile，节点就会跑在 GUI 进程里，与 GUI 共用 home 与凭据，并随窗口关闭而死；那样只要没人开着窗口，平台看到的就是一个离线节点。

</details>
