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
| `gitUserName` | `tianma-mps-node` | 注入到节点每一次提交的 `user.name` |
| `gitUserEmail` | `mps-node@localhost` | 注入到节点每一次提交的 `user.email` |
| `maxArtifactBytes` | `524288000` | 节点单次上传的产物上限（协议单请求上限之下） |
| `cliRunner.command` | `['dsh', '--profile', 'headless']` | 一次尝试运行的命令与前置参数；建议指向可执行文件的绝对路径 |
| `cliRunner.logsDirectory` | 工作区根目录下的 `logs` | 运行器为每次尝试保存原始日志的目录 |
| `cliRunner.dshHome` | 继承环境 | 该次运行使用的 `DSH_HOME`，使节点的 profile 目录自成一份 |
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

`publishChanges` 负责把一次尝试的成果交回去。它以**逐命令注入**的机器人身份提交（绝不改动宿主机全局 git 配置）并推送工作分支，但只在做完平台无法替它做的两项检查之后：每一处改动都必须在软链接解析后仍位于工作区内，且任何被改动的文本文件都不得携带凭据。一旦拒绝，就不会留下任何可推送的东西；此时结果里的证据会如实报告改动路径、提交与是否已推送——这也是"只有本次尝试什么都没发布时，运行器自报的证据才会被采用"的原因。

`checkoutSessionReporter` 让平台看到的工作区会话始终为真：节点先把会话引用、它当时看到的基线提交与它服务的任务记在工作区旁边，然后才上报，因此即使平台拒收，引用也不会丢。重启后节点读回这些记录并重新上报——这正是"刚起来的节点仍能在平台的工作区页上显示会话与编码路径"的原因；该上报只用于展示与排查，因此平台拒收它只是告警，不会让握手失败。

`clientArtifactUploader` 负责把一次尝试产出的文件存上去：只从工作区内读取，计算平台用来校验内容的 SHA-256，自行生成幂等键，并以 multipart 上传——文件传输需要一种传输层无法用 JSON 编码的请求体。**无法传输的文件会被直接拒绝**（工作区之外的路径、不是文件的东西、超过单请求可承载的字节数），而不是让传输中途失败；无论部署把自己的上限配到多大，节点都不会超过协议的单请求上限。`paths.ts` 是"路径是否在工作区内"这条规则的唯一归属，因此读取产物与上报改动受同一套约束。

另一个方向是运行器上下文上的 `resource()`：节点下载任务携带的材料（任务简报、载荷引用的输入文件），并与平台给出的摘要核对，**不一致的字节绝不会交到运行器手里**。材料被拒时返回的是平台惯用的信封，因此运行器看到的是平台自己的错误码，而不是一个裸状态码。

`tianmaCliRunner` 是节点自带的运行器：它在一次尝试里运行 tianmacoder CLI，并把那个进程的行为变成结果。进程之外的一切归节点——工作目录就是这次尝试的编码工作区；命令与指令以**参数数组**传递而不是拼成 shell 行（指令属于外部输入）；运行打印的内容边到边上报为该尝试的日志；取消时先请求结束、宽限期后再强杀；原始日志写在**工作区之外**，因为工作区里的一切都是节点要提交的内容。非零退出、被停止、或什么都没改的运行都报 failed 而不是交付；确实改了文件的运行会走 `publish()`——提交、推送与提交前自检都在那里。当没有任何一方以 `mpsTaskRunner` 提供运行器时，节点就回退到这个运行器，因此装好 CLI 的节点开箱即可工作；想要别的执行策略的部署自行组合提供者，这个回退便永远不会被用到。它默认启动的 profile、以及该 profile 接受的"任务作为参数"的形态，由一条以源码方式启动真实 CLI 的用例钉住，因此上游改名会先让测试失败，而不是让每台节点的第一次尝试失败。

`writeTaskBook` 把载荷里"智能体需要、而提示词放不下"的部分交给这次尝试：约束、交付要求、任务引用的材料、它来自的聊天、该工作区最近完成的任务与规则——写成工作区里的 `PROMPT.md`。提示词仍是指令加一句指路，因此再长的聊天记录或规则集都不必塞进单个参数。任务书是节点自己的输入，所以节点写入时同时把它加进仓库的本地排除清单：工作区里其余内容才是提交要交回的东西，节点自己的文件不属于交付改动。

`fetchMaterials` 在运行开始前把任务携带的文件取进工作区，放在 `.materials/` 下，按平台给出的文件名命名并削减成无法离开该目录的名字。该目录与任务书一样被加进仓库本地排除清单，任务书也会列出每个文件，因此智能体读的是平台附上的原件，而不是一串 id。平台拒收的材料、或超过节点单请求可取回上限的材料，会让这次尝试报 `blocked`——协议为"缺信息"保留的结果——因为一个在没有输入的情况下硬做的尝试只能靠猜。

`read_only` 是节点唯一不推送的模式：它照常提交，然后把工作分支打成 git bundle 写进工作区内的 `.bundles/`（与任务书一样不进仓库），再由节点把它作为该次尝试的 `bundle` 产物上传，并把其 id 作为证据里的 `patch_artifact_id`、同时报 `pushed: false`。平台从该产物里取回改动——这正是它那份基线克隆的用途。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/config.ts`](src/config.ts) | 配置 schema、已解析设置与密钥读取 |
| [`src/runtime.ts`](src/runtime.ts) | 平台会话：握手、心跳、指令、定时器、失败恢复 |
| [`src/orchestrator.ts`](src/orchestrator.ts) | 任务生命周期：认领、租约、运行时限、中止、日志与结果提交 |
| [`src/workspace.ts`](src/workspace.ts) | 编码工作区：每个工作区一个目录、旁挂状态与释放驱动的删除 |
| [`src/checkout.ts`](src/checkout.ts) | 代码流转：fetch 缓存、校验派发基线、重置工作分支 |
| [`src/git.ts`](src/git.ts) | git 边界：参数数组启动与经脱敏的失败信息 |
| [`src/publish.ts`](src/publish.ts) | 交回成果：提交前自检、提交、推送与 `read_only` 的 bundle |
| [`src/session.ts`](src/session.ts) | 工作区的会话：节点记录什么、重启后重新上报什么 |
| [`src/artifacts.ts`](src/artifacts.ts) | 上传尝试产出：读取、摘要与节点愿意传输的大小 |
| [`src/paths.ts`](src/paths.ts) | 编码工作区内路径约束的唯一归属 |
| [`src/cli-runner.ts`](src/cli-runner.ts) | 运行器：一次尝试一个 CLI 进程、它的日志、停止与结果 |
| [`src/task-book.ts`](src/task-book.ts) | 任务书：把载荷所述内容渲染给智能体 |
| [`src/materials.ts`](src/materials.ts) | 任务携带的材料：在运行前取进工作区 |
| [`src/runner.ts`](src/runner.ts) | `TaskRunner` 接缝，以及一次尝试交换的上下文与结果 |
| [`src/report.ts`](src/report.ts) | 运维事件与所有失败路径共用的错误归一化 |
| [`src/index.ts`](src/index.ts) | Cordis 插件：报告出口、自动启动、服务发布、运行器查找、停止副作用 |
| [`src/startup.ts`](src/startup.ts) | 节点 profile 的命令行与它记录的环境变量 |
| [`tests/mps-executor.spec.ts`](tests/mps-executor.spec.ts) | 地址配置、设置解析、密钥读取、握手、心跳、指令、恢复、经组合运行器认领任务与插件挂载 |
| [`tests/orchestrator.spec.ts`](tests/orchestrator.spec.ts) | 认领、租约、运行时限、中止、日志限长与结果提交 |

### 不变量归属

运行时只持有一次节点 ID，协议客户端在每个请求上上报它，因此调用方无法以其他节点的身份提交任务级调用。心跳周期来自配置或平台的注册应答，绝不来自发送处的常量。哪些任务在跑、跑到哪一步只有一处归属——运行时的运行中任务列表——编排器只负责把状态变化汇报进去。任务的代码只能经 `prepareCheckout` 进入工作区，因此基线校验只有一处，任何运行器都无法从一个平台并未派发的树开始干活；离开工作区也只能经 `publishChanges`，工作区范围与凭据两项检查都在那里。平台关于"某工作区由哪个会话服务"的认知也只有一处来源：节点先记录再上报，因此上报被拒不会丢掉引用。路径约束本身也只有一处归属 `resolveWithinWorkspace`，读取产物与上报改动不会各自漂移。

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

- **运行器需要 CLI** —— 节点默认回退到 `dsh --profile headless`，因此没有已构建或已安装 CLI 的节点会把每一次尝试都报成失败；部署若自行组合 `mpsTaskRunner` 提供者，则替换掉这个回退。
- **任务书只陈述载荷所述内容** —— 平台发来什么就渲染什么，节点既不替它总结聊天记录，也不替它补上平台留白的意图。
- **材料一次请求取一份** —— 超过协议单请求上限的材料会被拒绝（分片反向拉取尚未实现），此时该尝试报 `blocked`，而不是在没有它的情况下继续做。
- **日志是行而不是事件** —— 一次运行内部的进度只有打印出来才可见，因为节点跑的是 CLI profile 而不是流式 profile。
- **产物一次请求一个** —— 节点最多上传协议单请求上限之内的文件，超过就拒绝，因为大文件所需的分片上传尚未实现。
- **`read_only` 的 bundle 需要基线** —— bundle 把基线提交记为前置条件，因此接收方必须已经持有它；节点只交回工作分支。
- **git 取自 `PATH`** —— 节点从环境里启动 `git`；没有 git 的主机会把每一次编码尝试都报成失败。
- **资源读数由外部提供** —— 由部署通过 `setResources` 上报；节点自身完全不探测 CPU、内存与磁盘。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

任务认领、持久化编码工作区与 Agent 运行器是后续里程碑；本包止步于平台会话，以便先对着真实平台验证握手。除上文各节与源码之外，此处内容不具权威性。
</details>
