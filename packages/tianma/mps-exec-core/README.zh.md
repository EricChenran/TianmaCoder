---
description: "天码 MPS 执行节点的 exec/v1 线上协议层：由配置的通信 IP 与端口解析平台地址、响应外壳、错误码恢复、重试计划、日志脱敏、标识生成，以及节点 HTTP 客户端。"
kind: "package-reference"
---

# @tianma/dsh-mps-exec-core

[English](README.md) | 中文

## 概述

在不挂载 Cordis 的前提下说管理平台的 `exec/v1` 协议。一次调用即可把配置好的平台通信 IP 与端口解析成每个请求都要用到的主机地址与基础路径 URL；客户端随后执行各 JSON 端点，并以响应外壳里的 `code` 而不是 HTTP 状态码判定成败。本包同时持有围绕这条通信链路的约定：每个错误码要求何种恢复动作、失败的请求在重发前等待多久，以及哪些密钥值绝不能出现在上报的日志行里。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先解析部署给该节点配置的平台地址，再把同一个 IP 与端口交给实际发起请求的客户端：

```ts
const endpoint = resolvePlatformEndpoint({ host: '192.168.1.10', port: 8791, scheme: 'http' })
// endpoint.origin → http://192.168.1.10:8791
// endpoint.url('/register') → http://192.168.1.10:8791/exec/v1/register

const client = new ExecClient({ endpoint, nodeId: 'node-3f2a', token: () => currentToken })
const registered = await client.register({ /* identity, slots, capabilities */ })
```

`resolvePlatformEndpoint` 接受主机名、IPv4 地址，以及带或不带方括号的 IPv6 地址，并拒绝携带协议头、路径、空白或端口的取值。`platformEndpointFromUrl` 可从单个 `http`/`https` URL 中反读出这些地址组成，这正是部署把地址放在一个环境变量中时的形态。客户端支持替换传输实现，因此调用方无需网络即可对着假件运行。承载字节的端点——产物上传与任务材料下载——不在本客户端内，见下方限制。

除客户端之外，本包还持有四项由调用方自行施加的决策：`recoveryForCode(code)` 把外壳错误码映射为 `retry`、`reauthenticate`、`reregister`、`abandon-task`、`discard-result` 或 `halt-node`；`taskAttemptDelayMs` 与 `requestRetryDelayMs` 给出协议的任务尝试计划与带抖动的请求退避；`redactSecretText` 与 `redactSecretLines` 在批次上报前抹去凭据值；`ulid`、`logBatchId` 与 `artifactId` 生成幂等键；`formatRfc3339` 写出协议时间字段所需的本地偏移时间戳。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

外壳解析器从不读取 HTTP 状态码，也从不因未知字段或未知错误码而失败，因此新增了错误码的平台对旧节点依然可读；无法识别的错误码解析为 `retry`，避免版本错位把任务搁死。客户端把 `204` 读作认领长轮询没有任务，并把 `ALREADY_FINAL` 标记视为自己的成功，因为该错误码报告的是一次提交早已落定。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/endpoint.ts`](src/endpoint.ts) | 主机、端口、协议与基础路径校验；主机地址与请求 URL |
| [`src/protocol.ts`](src/protocol.ts) | 协议版本、外壳解析、错误码词表、已终态标记 |
| [`src/errors.ts`](src/errors.ts) | 携带所需恢复动作的外壳错误 |
| [`src/backoff.ts`](src/backoff.ts) | 任务尝试计划、请求退避、`Retry-After` 读取 |
| [`src/redact.ts`](src/redact.ts) | 日志行的凭据值脱敏 |
| [`src/ids.ts`](src/ids.ts) | ULID 生成与批次、产物标识形式 |
| [`src/time.ts`](src/time.ts) | 带数字 UTC 偏移的 RFC 3339 格式化 |
| [`src/client.ts`](src/client.ts) | JSON 端点客户端与其 `fetch` 传输 |
| [`tests/mps-exec-core.spec.ts`](tests/mps-exec-core.spec.ts) | 地址解析、外壳处理、恢复映射、退避、脱敏、标识、时间戳，以及客户端每个方法 |

### 不变量归属

地址是请求 URL 的唯一来源：客户端持有已解析的端点，不再重新解析其组成部分，因此一个已校验的主机不会被逐次调用重新解释。脱敏由调用方自己的 `containsSecretPattern` 断言，而不是由脱敏函数自我声明。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [mps-executor](../mps-executor/README.zh.md) —— 解析本包设置并驱动客户端的节点插件
- [tianma 分组](../README.zh.md) —— 本包在分组中的位置与该族的装配方式

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本包当前的边界，是当前约束而非任务清单。

- **不含字节端点** —— 产物上传与任务材料下载承载 `multipart/form-data` 与原始八位字节流；本客户端只执行 JSON 端点，这两条路径需要各自实现传输。
- **不含分片上传** —— 产物超过平台体积阈值后所需的 `init` / `chunk` / `complete` 流程未在此实现。
- **不含请求重试循环** —— 本包计算重试应等待的时长与错误码要求的恢复动作，循环本身、尝试计数与取消由调用方持有。
- **能力探测属于调用方** —— 此处不探测主机的工具与版本；由注册的节点提供。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

两条承载字节的路径是本包尚未覆盖的协议面，其传输落在哪里，将决定分片上传流程是共用本客户端的应答外壳处理，还是与之并列。除上文各节与源码之外，此处内容不具权威性。
</details>
