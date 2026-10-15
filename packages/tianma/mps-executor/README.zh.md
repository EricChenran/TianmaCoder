---
description: "dsh 的天码 MPS 执行节点：一个行级配置插件，以配置里声明的通信 IP 与端口完成对管理平台的认证、注册与心跳。"
kind: "package-reference"
---

# @tianma/dsh-mps-executor

[English](README.md) | 中文

## 概述

在一个 dsh profile 里运行一个天码 MPS 执行节点。插件从配置行读取平台的通信地址（主机与端口），从环境变量读取预共享密钥，用密钥换取 Bearer 令牌，并注册本机的身份、容量与能力。它维持心跳：上行携带运行中的任务与资源读数，下行带回平台指令；在组合了运行器时，它还会在自己的槽位内认领任务、维持租约、执行中止与运行时限规则，并提交本次尝试达成的结果。

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
| `codingRoot` | 工作区根目录下的 `coding` | 节点存放编码工作区的目录 |
| `slotsTotal` | `1` | 节点接受的并发任务数 |
| `heartbeatSeconds` | `10` | 心跳周期，直到平台另行指定 |
| `claimLongPollSeconds` | `25` | 认领长轮询预算 |
| `leaseRenewSeconds` | `30` | 租约续期周期，直到某次认领给出平台自己的取值 |
| `taskRuntimeSeconds` | `10800` | 单次尝试的运行时限，直到任务载荷给出自己的取值 |
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

`MpsExecutorRuntime` 持有平台会话：`bootstrap()` 用密钥换取令牌并完成注册，采用平台返回的心跳周期而不是保留硬编码值；`heartbeatOnce()` 上报运行中的任务、槽位、资源与节点时间，并因此续租它列出的每个任务；`start()` 与 `stop()` 持有定时器，而该定时器本身持有引用，使宿主进程在节点在线期间保持存活。心跳失败会按错误码施加对应恢复动作：`halt-node` 停止节点与定时器，`reauthenticate` 清除令牌并重跑握手，其余情况只记一条告警并等待下一个周期。心跳带回的指令在此处施加：`abort` 取消被点名的尝试，而本节点尚未实现的指令会被上报而不是被丢弃。

`TaskOrchestrator` 持有任务生命周期：在有空闲槽位时认领，把每个已认领任务上报进平台的运行中任务列表，把尝试交给运行器，并提交该尝试达成的结果。平台无法替节点施加的规则都在这里：认领或载荷给出的续期周期与运行时限、某次续期返回 `should_continue: false` 时的停止（该尝试被丢弃且不提交结果，因为那份结果描述的是平台已重新派发的活）、中止强制产生的 `cancelled` 结果、提交日志行的脱敏与按字节限长，以及在平台应答允许时持续重试的结果提交。没有组合运行器的节点只保持会话、不认领任何任务；运行器在开始认领时按 `ctx.mpsTaskRunner` 查找，因此由其他行挂载的运行器同样能被找到。`TaskRunner` 是任务得以执行的唯一入口：运行器收到任务、取消信号与上报通道，从不直接与平台通信，也不自行决定槽位。

`WorkspaceStore` 保管编码工作区：在编码根目录下为每个平台工作区建一个目录，并在该工作区的多个任务之间复用——它承载着这个工作区学到的东西；另有一份重启后仍在的旁挂状态文件。任务结束绝不删除目录，只有平台的 `release_workspace` 指令会；而且删除前会校验该目录确实解析在编码根目录之内，因此记错的记录或一个 junction 都无法让节点删掉别的东西。该存储把本次尝试要工作的目录交给运行器，这也是运行器从不自行决定工作区位置的原因。

`prepareCheckout` 把工作区的仓库缓存带到平台派发的那个 commit：它初始化并 fetch 这份缓存（而不是重新 clone 一棵新树），把派发的 `base_commit` 与 `origin/<base_branch>` 真正持有的提交比对、不一致就拒绝开工，然后在该提交上创建工作分支、把工作树重置到它并清掉未跟踪文件——因此在同一工作区重试时，起点是平台派发的基线，而不是上一次尝试的残留。所有 git 命令都经 `cliGit` 以参数数组启动（任务自身的文本永远不会变成 shell 语法），并保留 git 的原始诊断、经脱敏后用于本次尝试的摘要。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/config.ts`](src/config.ts) | 配置 schema、已解析设置与密钥读取 |
| [`src/runtime.ts`](src/runtime.ts) | 平台会话：握手、心跳、指令、定时器、失败恢复 |
| [`src/orchestrator.ts`](src/orchestrator.ts) | 任务生命周期：认领、租约、运行时限、中止、日志与结果提交 |
| [`src/workspace.ts`](src/workspace.ts) | 编码工作区：每个工作区一个目录、旁挂状态与释放驱动的删除 |
| [`src/checkout.ts`](src/checkout.ts) | 代码流转：fetch 缓存、校验派发基线、重置工作分支 |
| [`src/git.ts`](src/git.ts) | git 边界：参数数组启动与经脱敏的失败信息 |
| [`src/runner.ts`](src/runner.ts) | `TaskRunner` 接缝，以及一次尝试交换的上下文与结果 |
| [`src/report.ts`](src/report.ts) | 运维事件与所有失败路径共用的错误归一化 |
| [`src/index.ts`](src/index.ts) | Cordis 插件：报告出口、自动启动、服务发布、运行器查找、停止副作用 |
| [`src/startup.ts`](src/startup.ts) | 节点 profile 的命令行与它记录的环境变量 |
| [`tests/mps-executor.spec.ts`](tests/mps-executor.spec.ts) | 地址配置、设置解析、密钥读取、握手、心跳、指令、恢复、经组合运行器认领任务与插件挂载 |
| [`tests/orchestrator.spec.ts`](tests/orchestrator.spec.ts) | 认领、租约、运行时限、中止、日志限长与结果提交 |

### 不变量归属

运行时只持有一次节点 ID，协议客户端在每个请求上上报它，因此调用方无法以其他节点的身份提交任务级调用。心跳周期来自配置或平台的注册应答，绝不来自发送处的常量。哪些任务在跑、跑到哪一步只有一处归属——运行时的运行中任务列表——编排器只负责把状态变化汇报进去。任务的代码只能经 `prepareCheckout` 进入工作区，因此基线校验只有一处，任何运行器都无法从一个平台并未派发的树开始干活。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [mps-exec-core](../mps-exec-core/README.zh.md) —— 本插件据以解析地址并驱动的线上协议层
- [tianma 分组](../README.zh.md) —— 本包在分组中的位置与该族的装配方式

## Model Experience

None, as the node transports exec/v1 protocol traffic and hands each claimed attempt to a runner, so whatever a runner shows a model belongs to that runner’s package.

#### KV Cache effect

Nothing here enters a model request, so this package neither grows nor replaces any request prefix.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本包当前的边界，是当前约束而非任务清单。

- **未随包交付运行器** —— 只有在组合了运行器时节点才会认领并执行任务；没有运行器时它只保持会话、上报这一事实并且什么都不认领，因为没有执行任务的途径。
- **提交、推送与证据属于运行器** —— 节点负责准备好检出；以机器人身份提交、推送工作分支、收集改动文件与证据、上传产物都归运行器，本包未实现。
- **git 取自 `PATH`** —— 节点从环境里启动 `git`；没有 git 的主机会把每一次编码尝试都报成失败。
- **资源读数由外部提供** —— 由部署通过 `setResources` 上报；节点自身完全不探测 CPU、内存与磁盘。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

任务认领、持久化编码工作区与 Agent 运行器是后续里程碑；本包止步于平台会话，以便先对着真实平台验证握手。除上文各节与源码之外，此处内容不具权威性。
</details>
