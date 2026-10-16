---
description: "天码 MPS 执行节点的 Web GUI 界面：启动、停止节点并回读它日志的设置页。"
kind: "package-reference"
---

# @tianma/dsh-mps-node-ui

[English](README.md) | 中文

## 概述

把执行节点放到设置页上。浏览器半边维护一份节点快照，数据来自宿主 `mpsNodeControl` 远程命名空间，并把它渲染成一节：进程当前阶段、profile、进程号与启动时间、上一次进程如何结束、启动/停止按钮，以及它最近打印的日志行。所有操作都经宿主完成；没有挂载节点控制的组合就自然没有这一节可渲染。

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

两半一起挂：宿主服务在 [@tianma/dsh-mps-node-control](../mps-node-control/README.zh.md)，界面在这一包。Web 应用 bundle 两者都挂，所以桌面与浏览器 profile 都拿到这一节；两者都不挂的自动化 profile 则什么都没有。

这一节注册进 `settings.section` 槽位，id 为 `mps-node`，排在上游各节之前；文案放在 `settings.mpsNode` 语言命名空间里，随已发布的两种语言一起。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内情——点击展开</summary>

快照是这一节唯一的数据来源，因此它显示的状态与它启用的按钮不可能互相矛盾：`start` 与 `stop` 先把快照置为忙，拿宿主的回答当作新的读数，再重新读一次状态与日志；被拒绝的调用会把宿主自己的消息显示出来，而空消息表示"失败了但没说原因"，组件这时渲染本地化文案。

这一节在打开期间每五秒重读一次、关闭即停——它盯着的进程不会问任何人就自己变化。调用进行中、节点已在运行（或正在停止）时按钮是禁用的，所以连点也不会与宿主抢跑。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | apply 闭包：快照、操作与这一节的注册 |
| [`src/client/NodeSection.tsx`](src/client/NodeSection.tsx) | 渲染出来的那一节 |
| [`src/client/contract.ts`](src/client/contract.ts) | 闭包对外发布与注入的内容 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文文案 |

</details>

<a id="further-exploration"></a>
## 进一步探索

- [@tianma/dsh-mps-node-control](../mps-node-control/README.zh.md)——本界面所驱动的宿主服务。
- [@tianma/dsh-mps-executor](../mps-executor/README.zh.md)——本页展示其输出的节点本体。

<a id="model-experience"></a>
## Model Experience

没有。本插件基于节点控制的远程命名空间渲染设置页的一节，不注册任何提示词、工具或 Session 事件。

#### KV Cache effect

这里没有任何东西进入模型请求，因此本包既不增长也不替换任何请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **参数在这里是只读的** —— 平台地址、节点 id、密钥环境变量与编码根就是启动 GUI 进程时的那份环境；这一节会显示节点关于它们的输出，但改不了。
- **轮询而不是流** —— 打开期间每五秒重读一次，因此某个节点在两次读数之间死掉时，界面会先显示旧读数到下一次为止。
- **显示的是宿主保留的那部分** —— 环形缓冲受服务的 `logLines` 限制，更早的行只在节点自己的日志文件里。
- **设置页之外没有入口** —— 节点只能从设置页够到；侧栏入口或托盘项会是同一份快照之上的额外界面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

这一节以 `order: -5` 注册，排在上游各节之前，因为节点正是这套部署在这里要跑的东西。这个排序就是改这个判断的唯一一处。

五秒一次的重读刻意没有做成流：宿主对进程没有变更通知，而需要通知的界面只有打开着的设置页这一个。等将来有第二个界面读同一份快照时，改成流才是对的。

</details>
