---
description: "MPS 执行节点 profile bundle：一层 patch 即可在 dsh-base 之上挂载执行节点，供 `dsh --profile mps-node` 启动的节点使用。"
kind: "package-bundle"
---

# @tianma/dsh-mps-node-bundle

[English](README.md) | 中文

## 概述

把一个 dsh 安装变成天码 MPS 执行节点。在 profile 的 bundle 列表里把本包列在 `dsh-base` 之后——随发行版交付的 `mps-node` 模板正是这么做的——该 profile 就会挂载执行节点：节点的配置声明管理平台的通信 IP 与端口，并让节点在 `ctx.mpsExecutor` 上持续心跳。每一行都可以独立重调或停用而不必改代码，且当上游行 ID 发生漂移时 CI 校验会失败，因此过期的覆盖项无法悄悄发布。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用随发行版交付的模板启动节点：

```sh
MPS_PLATFORM_HOST=192.168.1.10 MPS_PLATFORM_PORT=8791 MPS_NODE_ID=node-3f2a MPS_NODE_SECRET=<secret> \
  dsh --profile mps-node
```

该模板把 `dsh-base` 与本 bundle 组合起来，而本 bundle 的 patch 挂载节点行：

```yaml
- insert:
    - id: mps-executor
      name: '@tianma/dsh-mps-executor'
      config:
        platformHost: !!js process.env.MPS_PLATFORM_HOST ?? '127.0.0.1'
        platformPort: !!js Number(process.env.MPS_PLATFORM_PORT ?? 8791)
        nodeId: !!js process.env.MPS_NODE_ID ?? 'node-unconfigured'
        secretEnv: MPS_NODE_SECRET
        slotsTotal: !!js Number(process.env.MPS_NODE_SLOTS ?? 1)
        lanes: []
        tools: []
        autoStart: !!js Boolean(process.env.MPS_PLATFORM_HOST)
        cliRunner: !!js "({ command: [process.env.MPS_DSH_BIN ?? 'dsh', '--profile', 'headless'], dshHome: process.env.MPS_DSH_HOME ?? '', jsonEvents: true })"
```

启动前可以先确认这台机器会拨哪个地址：`dsh --profile mps-node --show-config` 会打印解析后的接入点、身份、工作区与编码根、agent CLI，以及它将遵守的各项上限（接活前要求的可用磁盘、心跳与认领间隔、续租周期、单次运行上限、单次上传的产物上限），读的就是本行所读的同一份环境；密钥只打印变量名，绝不打印值。

环境变量间接寻址让同一份安装镜像可以服务每一台节点；若部署更希望固定 profile，把取值直接写进该行即可。两个占位值让 profile 始终可加载——在没有任何环境变量的机器上 `dsh mps-node --help` 也能用——而是否真的发起连接由 `autoStart` 决定：它只在设置了 `MPS_PLATFORM_HOST` 时为真，因此未配置的节点只挂载并保持空闲，而不会以占位身份去注册。密钥只会从 `secretEnv` 指定的环境变量读取。

本 profile 已用"从源码启动 + 一个监听在配置地址上的桩平台"实测：节点完成认证（`POST /exec/v1/auth/token`）、注册（`POST /exec/v1/register`），随后按平台给的时间间隔循环认领（队列空时 204）与心跳（`POST /exec/v1/heartbeat`）。这是本环境能给出的全部证据——profile 自身无需安装依赖，但要把任务跑到端到端，仍需真实平台与模型凭证。

该 patch 只挂载一行，不重述任何权限行。`dsh-base` 本就组合了 `workspace-write` 与 `ask`，这正是其预设表所承认的配对，而节点不组合任何审批应答者，因此需要审批的动作会被拒绝，而不是为不在场的人一直挂住。若部署想要确定性的文案，就在节点环境里设置 `DSH_PERMISSION_MODE`——那是 `dsh-base` 自己的开关。

| 环境变量 | 含义 |
|---|---|
| `MPS_PLATFORM_HOST` | 节点要连的平台主机名、IPv4 或 IPv6 地址；必填 |
| `MPS_PLATFORM_PORT` | 平台端口；默认 `8791` |
| `MPS_PLATFORM_SCHEME` | `http` 或 `https`；默认 `http` |
| `MPS_PLATFORM_BASE_PATH` | 路径前缀；默认 `/exec/v1` |
| `MPS_NODE_ID` | 平台识别本节点的 ID；必填 |
| `MPS_NODE_NAME` / `MPS_NODE_HOST` | 展示名称与上报主机；默认取节点 ID 与本机主机名 |
| `MPS_NODE_SECRET` | 预共享密钥；由插件读取，绝不来自配置 |
| `MPS_NODE_SLOTS` | 并发任务数；默认 `1` |
| `MPS_NODE_WORKSPACE` | 节点上报的工作区根目录；默认取进程工作目录 |
| `MPS_AGENT_VERSION` | 上报的 Agent 版本；默认 `unknown` |
| `MPS_DSH_BIN` | 节点执行一次尝试所用 CLI 的绝对路径；默认取 `PATH` 上的 `dsh` |
| `MPS_DSH_HOME` | 该次运行使用的 `DSH_HOME`，使节点的 profile 目录自成一份；不设则继承环境 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

本包的实质是 `cordis.patch.yml`，由 manifest 的 `dsh.bundle.patch` 字段声明，profile 组装器通过该字段解析它。bundle patch 在 `dsh-base` 之后应用，因此它的 `insert` 行新增节点，而按 ID 定位的行会整体替换被指向的 base 行配置。

`scripts/verify-profile-patches.ts` 会对仓库内每个 patch 针对其目标组合做校验，因此某个 base 行一旦改 ID，本 bundle 的覆盖项不可能悄悄失效。profile 名称本身登记在 `packages/boot/app-boot/src/profile.ts` 的 `PROFILE_TEMPLATES` 中。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | patch 层：执行节点行及其读取的平台地址 |
| [`src/index.ts`](src/index.ts) | 模块占位；本 bundle 不携带运行时 API |

### 不变量归属

节点所连的地址属于执行插件那份经校验的配置，而不是本 patch：patch 只提供取值，而插件会拒绝把协议头、路径或端口写进 host。节点执行所用的运行器同样属于执行插件：它回退到此处声明的 CLI 运行器，而组合任何其它 `mpsTaskRunner` 提供者都会替换掉这个回退，无需改动本 patch。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [mps-executor](../mps-executor/README.zh.md) —— 本 bundle 挂载的插件，以及它所校验的配置
- [mps-exec-core](../mps-exec-core/README.zh.md) —— 该插件之下的线上协议层
- [tianma 分组](../README.zh.md) —— 本 bundle 在分组中的位置与该族的装配方式

<a id="model-experience"></a>
## 模型体验

Indirectly, through the executor node this bundle mounts, whose platform traffic and report sink own every model-facing effect.

#### KV Cache effect

Nothing here enters a model request; the patch contributes configuration and row replacements only.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本 bundle 当前的边界，是当前约束而非任务清单。

- **节点会话就是当前的全部节点能力** —— 挂载的插件负责认证、注册与心跳；任务认领、编码工作区与结果提交都不在其中，因此今天启动的节点只保持平台会话而不干活。
- **能力来自配置** —— 该行声明了 `lanes` 与 `tools`，目前还没有任何探测主机的步骤。
- **一个 profile 只对一个平台** —— 该行只命名一个平台地址，尚不支持让一个 profile 指向多个平台。
- **没有控制台日志** —— 没有任何随发行版交付的 profile 挂载控制台导出器，因此节点自身的报告只到达 `ctx.logger` 而没有输出目标。需要看到它们的部署可以挂载 `@deepseek-ai/cordis-plugin-logger-console`，或改看平台侧的节点视图。
- **加载时只握手一次** —— 节点在 profile 加载时注册一次，因此此刻不可达的平台会让节点停在空闲状态直到进程重启；重连监督随认领循环一起到来。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

模板名与 bundle 名是两个独立决定：profile 按 `$DSH_HOME` 逐个初始化、并不随发行版分发，因此真正让全新安装能跑起 `dsh --profile mps-node` 的是 `mps-node` 模板项。除上文各节与源码之外，此处内容不具权威性。
</details>
