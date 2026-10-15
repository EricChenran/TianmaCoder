---
description: "dsh 的天码 MPS 执行节点：一个行级配置插件，以配置里声明的通信 IP 与端口完成对管理平台的认证、注册与心跳。"
kind: "package-reference"
---

# @tianma/dsh-mps-executor

[English](README.md) | 中文

## 概述

在一个 dsh profile 里运行一个天码 MPS 执行节点。插件从自身的 profile 配置行读取管理平台的通信地址——主机或 IP 与端口——从环境变量读取预共享密钥，用密钥换取 Bearer 令牌，注册本机的身份、容量与能力，并维持心跳：上行携带运行中的任务、槽位容量与资源读数，下行带回平台指令。节点就是该 profile 的应用本体，因此进程是 `dsh --profile <节点 profile>`，而不是挂在宿主旁边的另一个可执行文件。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

只靠配置即可把节点指向其平台。bundle 的 patch 挂载插件行，部署方改动以下字段即可把节点迁到另一个平台：

```yaml
- id: mps-executor
  name: '@tianma/dsh-mps-executor'
  config:
    platformHost: 192.168.1.10   # the platform's IP, host name, or IPv6 address
    platformPort: 8791           # the platform's exec/v1 port
    platformScheme: http         # http over the LAN, https when the deployment terminates TLS
    nodeId: node-3f2a
    slotsTotal: 2
    lanes: [frontend, backend]
    tools: [node, git]
```

插件把节点的平台会话发布在 `ctx.mpsExecutor`。加载时它会完成认证与注册，随后按平台指定的周期发送心跳；`autoStart: false` 会挂载节点但不启动它，供由其他组件驱动握手的部署使用。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `platformHost` | 必填 | 平台主机名、IPv4 或 IPv6 地址；此处携带协议头、路径或端口会被拒绝 |
| `platformPort` | `8791` | 平台 TCP 端口 |
| `platformScheme` | `http` | `http` 或 `https` |
| `platformBasePath` | `/exec/v1` | 各端点所依附的路径前缀 |
| `nodeId` | 必填 | 平台识别本节点的 ID |
| `nodeName` | `nodeId` | 展示名称 |
| `nodeHost` | 本机主机名 | 上报给平台的地址 |
| `secretEnv` | `MPS_NODE_SECRET` | 存放预共享密钥的环境变量名；密钥从不从配置读取 |
| `workspaceRoot` | 进程工作目录 | 节点上报的工作区根目录 |
| `slotsTotal` | `1` | 节点接受的并发任务数 |
| `heartbeatSeconds` | `10` | 心跳周期，直到平台另行指定 |
| `claimLongPollSeconds` | `25` | 认领长轮询预算 |
| `requestTimeoutMs` | `15000` | 单个普通请求的预算 |
| `lanes` / `tools` | 空 | 节点注册的能力承诺 |
| `agentVersion` | `unknown` | 上报的 Agent 版本 |
| `labels` | 空 | 运维标签 |
| `autoStart` | `true` | profile 加载后是否立即认证并注册 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

`resolveExecutorSettings` 把行配置变成一份已解析的设置：它通过 `@tianma/dsh-mps-exec-core` 校验地址，回退到本机主机名与进程工作目录，并构造能力承诺。`readNodeSecret` 读取该环境变量，在未设置或为空时显式失败，因此节点绝不会带着空凭据注册。

`MpsExecutorRuntime` 持有平台会话：`bootstrap()` 用密钥换取令牌并完成注册，采用平台返回的心跳周期而不是保留硬编码值；`heartbeatOnce()` 上报运行中的任务、槽位、资源与节点时间，并因此续租它列出的每个任务；`start()` 与 `stop()` 持有定时器，而该定时器本身持有引用，使宿主进程在节点在线期间保持存活。心跳失败会按错误码施加对应恢复动作：`halt-node` 停止节点与定时器，`reauthenticate` 清除令牌并重跑握手，其余情况只记一条告警并等待下一个周期。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/config.ts`](src/config.ts) | 配置 schema、已解析设置与密钥读取 |
| [`src/runtime.ts`](src/runtime.ts) | 平台会话：握手、心跳、定时器、失败恢复 |
| [`src/index.ts`](src/index.ts) | Cordis 插件：报告出口、自动启动、服务发布、停止副作用 |
| [`tests/mps-executor.spec.ts`](tests/mps-executor.spec.ts) | 地址配置、设置解析、密钥读取、握手、心跳、恢复与插件挂载 |

### 不变量归属

运行时只持有一次节点 ID，协议客户端在每个请求上上报它，因此调用方无法以其他节点的身份提交任务级调用。心跳周期来自配置或平台的注册应答，绝不来自发送处的常量。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [mps-exec-core](../mps-exec-core/README.zh.md) —— 本插件据以解析地址并驱动的线上协议层
- [tianma 分组](../README.zh.md) —— 本包在分组中的位置与该族的装配方式

## Model Experience

None, as the node runtime transports exec/v1 protocol traffic for the management platform and registers no prompt, tool, or Session event of its own.

#### KV Cache effect

Nothing here enters a model request, so this package neither grows nor replaces any request prefix.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本包当前的边界，是当前约束而非任务清单。

- **仅覆盖平台会话** —— 插件负责认证、注册与心跳；它不认领任务、不准备编码工作区、不运行 Agent、也不提交结果，且它注册的能力列表来自配置而非探测结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

任务认领、持久化编码工作区与 Agent 运行器是后续里程碑；本包止步于平台会话，以便先对着真实平台验证握手。除上文各节与源码之外，此处内容不具权威性。
</details>
