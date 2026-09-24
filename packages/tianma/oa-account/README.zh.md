---
description: "Tianma OA user account: captcha sign-in, the dual-token session kept in the credential seam's records, the single silent re-sign on 401, and the signed-in gate the browser prompt path reads."
kind: "package-reference"
---

# @tianma/dsh-oa-account

[English](README.md) | 中文

## 概述

让产品用户通过天码 OA 后端登录，并判定一条对话是否可以开始。一个 Host 服务负责验证码挑战、双 Token、已存账户投影，以及设置页要渲染的资料、工作台与资料写入操作。同一个插件还挂载 `ctx.promptAdmission`，因此浏览器提示词路径在账户已登录且状态为 `active` 之前一律拒绝开始对话。Token 存在凭据 seam 的记录里，浏览器永远拿不到它。

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

在**带有交互用户**的组态里挂载本插件。只有 Web 应用组态满足这个条件，因此自动化档案（`headless`、`acp`、`sdk`）无需账户即可继续运行。

配置：`baseUrl`（必填，OA API 根地址并含版本段）、`requestTimeoutMs`（默认 30 000）、`requireSignIn`（默认 `true`；关闭后仍挂载界面但不拦截产品）。

远端命名空间 `oaAccount` 暴露 `session`、`captcha`、`signIn`、`signOut`、`profile`、`stats`、`updateProfile`、`gate` 与 `watch` 流。浏览器半边 [@tianma/dsh-oa-account-ui](../oa-account-ui/README.zh.md) 消费它。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

会话就是一条 grant 记录 `tianma-oa-account/session`，经 `ctx.credentials` 写入：凭据 seam 提供原子写、跨进程文件锁与仅属主可读权限，因此 Token 可跨重启存活，且一个进程里的登出对另一个进程的下一次调用可见。本插件解析不了的记录按"未登录"处理，而不是报错。

`authorized()` 是唯一的受保护请求路径：读出已存 access token、发起请求，遇到**一次** `401` 时用已存 refresh token 换取新 access token 后重试一次。续签被拒即删除记录并上抛后端自身的原因——这正是界面上区分"账号被停用"与"Token 过期"的依据。

`gate()` 读取已存状态并判定对话能否开始；`OaPromptAdmission` 把该判定通过 `ctx.promptAdmission` 发布出去，这就是 `SessionCommandController.prompt` 在做任何会话工作之前查询的扩展点。因此账户状态由后端在每次请求上重新校验，后端在已存会话背后改掉的状态会在下一次对话时生效。

### 后端契约注记

实际后端与规范在三处不一致，由 wire 层吸收，且每一处都经过对真实后端的验证而非假设：

| 规范 | 实际后端 | 本包 |
|---|---|---|
| `captcha_code` | `captcha` | 两种写法都发送，任一契约都能认证 |
| `image` | `img` | 两个键都接受 |
| refresh 返回 `token`、`refresh_token`、`user` | 只返回 `token` | 保留已存 refresh token，并改为重新读取资料 |

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体、已存会话 schema、闸门与 `OaPromptAdmission` |
| [`src/protocol.ts`](src/protocol.ts) | 基址校验、信封解析与闭集失败词表 |
| [`src/types.ts`](src/types.ts) | 账户投影、失败词表与闸门词表 |
| [`tests/oa-account.spec.ts`](tests/oa-account.spec.ts) | 会话存取、单次续签、状态闸门、拒绝码、信封失败 |

### 不变式归属

不发布 invariant 伴生包：本服务不持有任何可被独立观测到发散的派生关系。记录在每次调用时都经凭据 seam 重新读出，因此不存在陈旧的内存副本。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [凭据子系统](../../../docs/subsystems/credentials.zh.md) —— 会话所存放的记录
- [审批子系统](../../../docs/subsystems/approval.zh.md) —— 提示词路径在回合开始前要问的另一个问题

-----

<a id="model-experience"></a>
## 模型体验

### OA 账户

#### 模型看到什么

什么都没有。账户状态决定对话能否开始；一旦开始，任何账户事实都不会进入请求、提示词段落或工具结果。拒绝是 `session/prompt` 调用上的业务错误，由调用方报给人类，不是模型可见的消息。

#### Token 影响

零 —— 账户不向请求添加任何内容。

#### KV Cache 影响

无 —— 任何请求前缀都没有增删。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前边界。

- **闸门覆盖的是浏览器提示词路径。** `SessionCommandController.prompt` 是所有浏览器提示词——发送、排队、steer——进入会话的唯一入口，因此检查放在那里。不携带交互用户的自动化入口（SDK、ACP、schedule、webhook）不挂载准入检查，按设计不受此闸门约束。
- **登出是本地的。** 后端不维护 Token 吊销名单，因此登出只是丢弃记录，真正结束会话的是下一次请求时的状态校验。
- **不做定时续签。** access token 在下一次 `401` 时续签，而不是在其两小时有效期前主动续签。
- **验证码答案发送两种字段名。** 这层容错源于规范与实际后端不一致；待后端定稿后可收敛为一种。
- **资料写入覆盖账户所有者可改的字段**（`name`、`phone`、`avatar`）；改密码是后端另一条流程，未实现。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作背景 —— 点击展开</summary>

本包取代了该产品此前的 DeepSeek 账户登录：seam、provider、Remote 控制器与浏览器界面都是**被移除**而非改造，推理鉴权也不再查询任何账户服务。

</details>
