---
description: "Tianma OA account surfaces for the Web GUI: the captcha sign-in dialog, the sidebar account launcher, and the Settings page that shows and edits the signed-in profile."
kind: "package-reference"
---

# @tianma/dsh-oa-account-ui

[English](README.md) | 中文

## 概述

天码 OA 账户体系的浏览器半边：来自 Host `oaAccount` 远端命名空间的同一份快照，支撑登录对话框、侧栏启动器，以及展示已登录资料、工作台计数与可改字段编辑器的设置区块。两处读同一份快照，因此不会对"谁已登录"给出不一致的说法，Token 也不会到达浏览器。它还承载对话闸门的客户端半边：未登录时每个存活会话的输入框都变为惰性并说明原因。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件挂载在设置外壳旁边，并在同一组态里挂载 Host 半边（[@tianma/dsh-oa-account](../oa-account/README.zh.md)）：浏览器半边调用 `remote.oaAccount`，缺少 Host 半边时渲染不出有意义的内容。

它在 `settings.launcher` 注册侧栏启动器、在 `settings.section`（`id: 'oa-account'`，排在最前）注册设置页，locale 命名空间为 `settings.oaAccount`，提供英文与中文。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

`apply` 维护一份 `OaAccountSnapshot`，并通过注入面的 `hooks.oaAccount` 发布——渲染器把它绑定成 `useOaAccount` 座位，组件自身不做任何订阅。会话流是唯一的实时来源：每一帧替换会话投影并重新读取资料与计数，流终止性失败会把快照标记为失败，而不是把界面藏起来。

登录对话框负责验证码生命周期。验证码是一次性的，因此被后端拒绝的一次尝试总会重新取一张新验证码，同时保留已输入的账号与密码——人类重试时很少需要重打账号名。

输入框无法读取本插件（依赖是单向的），因此闸门是**推送**而非读取：插件把每个存活会话写进对话服务的 block 注册表，并在每次快照变化与会话列表变化时重新同步。Host 会独立拒绝同一条提示词，因此两侧是同一个决定的两个平面。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 快照、操作与 slot 注册 |
| [`src/client/SignInDialog.tsx`](src/client/SignInDialog.tsx) | 带验证码的登录表单 |
| [`src/client/AccountMenu.tsx`](src/client/AccountMenu.tsx) | 侧栏启动器与头像地址解析 |
| [`src/client/AccountSection.tsx`](src/client/AccountSection.tsx) | 设置页：资料、计数与编辑器 |
| [`src/client/composer-block.ts`](src/client/composer-block.ts) | 为客户端已列出的会话推送输入框 block |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文文案字典 |
| [`src/client/contract.ts`](src/client/contract.ts) | 快照与注入操作的契约 |

### 不变式归属

不发布 invariant 伴生包：本插件不持有独立的凭据或账户状态，因此不存在可能与 Host 观测结果发散的第二份观测。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [账户包](../oa-account/README.zh.md) —— 这些界面所渲染的 Host 服务
- [设置子系统](../../../docs/subsystems/settings.zh.md) —— 拥有区块与启动器 slot 的外壳

-----

<a id="model-experience"></a>
## 模型体验

### OA 账户界面

#### 模型看到什么

什么都没有。这些是 Host 所持有账户状态之上的展示界面；没有任何账户事实进入提示词、工具结果或请求。模型唯一能观察到的影响是间接的：在未登录时，`session/prompt` 会在回合开始前被拒绝。

#### Token 影响

零 —— 浏览器半边不向请求添加任何内容。

#### KV Cache 影响

无 —— 任何请求前缀都没有增删。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前边界。

- **编辑器覆盖姓名与手机号。** 头像只做展示、不在界面里编辑；改密码是后端另一条流程，本包未实现。
- **资料读取返回前启动器显示通用文案。** 账户姓名依赖资料读取；在它返回前启动器显示"已登录"，而不是展示一个陈旧姓名。
- **失败文案用后端原话。** 被拒绝的尝试显示后端给出的信息（例如账号已停用），只有后端未给信息时才回落到本地化文案，因此产品不会编造后端没说过的原因。
- **状态映射唯一。** `active` / `disabled` / `banned` 由账户状态渲染；本构建从未见过的状态按"未知"渲染，而不是按可用处理。
- **只有组态挂载了账户服务时界面才存在。** 没有 Host 半边的档案完全没有账户界面。
- **客户端闸门是推送而非读取。** 单向依赖下输入框的 block 注册表是唯一通道，因此插件直接写入它、并在卸载时清除；只挂载账户界面而没有对话服务的组态，仍保留 Host 侧拒绝，只是少了输入框禁用。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作背景 —— 点击展开</summary>

刻意**不**占用 `settings.models.sign-in`：那个 slot 是模型凭据引导，而 OA 账户 token 不用于模型请求，因此两套界面必须共存。

</details>
