# 天码 MPS 平台侧开发方案（接入串 + 节点策略下发）

> 配套文档：[`mps-node-side-plan.md`](mps-node-side-plan.md)（执行节点侧开发方案，TianmaCoder 仓实施）
> 状态：提案（2026-10-27）。实施仓库：`D:\AI技术团队`（Backend Go + Frontend/admin-console Vue）；本文档存放于 TianmaCoder 仓，交平台团队执行。
> 原则：**节点上报事实，平台决定策略**。平台是策略唯一所有者；节点只上报硬件/能力/资源事实并执行通信。

## 1. 背景与问题

- 节点接入流程碎片化：管理台创建节点产出 `id + secret` 两段值，操作员需分别抄录到节点端表单与环境变量，一个平台地址被拆成 host/port/scheme/basePath 四项手填；
- 策略错位：槽数、服务车道、模型路由等调度策略目前由节点侧自行配置，平台（管理方）反而不可见不可控；
- 调度缺口：`ExecClaim`（`Backend/internal/store/exec.go`）候选查询只按优先级/能力/工作区亲和筛选，**未按节点空闲槽过滤**——`available_slots` 字段收下未用，满槽节点可被超派，任务空转一个租约周期（约 15 分钟）后靠超时重派兜底；
- 下发管道闲置：`GET /exec/v1/config` 与心跳 `config_revision` 变更信号两端均已实现（节点侧 `runtime.ts:479` 会自动重拉应用），但平台 `/config` payload 目前几乎为空。

## 2. 目标

- 管理员创建节点后拿到**一条接入串**，节点端粘贴即接入（配合节点侧方案）；
- 管理台成为节点策略唯一编辑入口：槽数（含硬件推荐）、车道、磁盘水位、任务时限、模型路由；
- 策略变更经 `config_revision` 推送，节点 ≤2 个心跳周期生效；
- 认领调度不再超派：无空闲槽的节点不进 coding 候选。

## 3. 现状锚点（平台仓库内位置）

| 模块 | 位置 |
|---|---|
| exec/v1 路由与服务 | `Backend/internal/execapi/server.go`、`handlers.go` |
| 认领查询 | `Backend/internal/store/exec.go` 的 `ExecClaim` |
| 节点管理 API（创建/轮换/动作） | `Backend/internal/httpapi/node_handlers.go` |
| 管理台节点页 | `Frontend/admin-console/src/views/nodes/index.vue`（创建+密钥弹窗）、`detail.vue` |
| 协议文档 | `docs/天码信息生产管理系统-执行节点接入协议.md` 及增量说明 |

## 4. 接入串（与节点侧文档 §3 一致，改动需双端同步）

```
http://192.168.1.10:8791/exec/v1#node=node-3f2a&secret=<密钥>
```

- 生成位置：`createNode` 与 `rotateNodeSecret`（`node_handlers.go`）的响应在现有 `{id, secret}` 之外**新增 `join` 字段**，纯响应增量，不改库表（接入串只是 id+secret+平台地址的拼接）；
- 平台地址取自服务自身监听配置；若部署经反代，需可配置对外通告地址（建议环境变量 `MPS_PUBLIC_EXEC_URL`，缺省 `http://<监听IP>:8791/exec/v1`）；
- 安全沿用现状：密钥仅此一次展示、不落日志不进审计 detail；接入串同理。管理台展示时密钥段默认打码，"显示/复制"按钮。
- 版本演进：fragment 内参数名即隐式版本；未来破坏性变更换参数名或加 `v=2`，节点按未知参数忽略。

## 5. 节点策略模型

存储：`nodes` 表新增 `policy` JSON 列（或独立 `node_policies` 表，团队按现有迁移习惯定；下述以 JSON 列描述）。字段与默认值：

```json
{
  "slots_total": 1,                    // int ≥1，调度并发上限
  "lanes": ["coding", "chat_answer"],  // 允许的工作种类
  "disk_min_gb": 5,                    // 节点低于该空闲磁盘时不派
  "task_runtime_seconds": 10800,       // coding 任务时限缺省
  "answer_runtime_seconds": 0,         // 0=跟随租约
  "agent_default": { "provider": "", "model": "" }  // 成对出现，空=不覆盖
}
```

- 编辑入口：管理台节点详情页"策略"区（`node:manage` 权限）；每次修改 `policy_revision += 1` 并发布 SSE 事件 `nodes`/`node.policy.updated`；
- **槽数推荐**：详情页显示节点注册/心跳上报的 `resources`（CPU/内存/磁盘）与 `capabilities`，按 `clamp(CPU逻辑核数/4, 1, 4)` 给推荐 badge，管理员确认生效——节点上报事实，平台决定策略。

## 6. `/config` 与 `register` 响应扩容

键名与节点侧实现严格一致（`mps-node-side-plan.md` §5.1）：

| 键 | 类型 | 说明 |
|---|---|---|
| `slots_total` | int | 覆盖节点自报槽数，claim 门控与展示均以此为准 |
| `lanes` | string[] | 节点只认领这些工作种类 |
| `disk_min_gb` | int | 节点本地磁盘水位 |
| `task_runtime_seconds` | int | 任务时限缺省（任务载荷声明优先，现状不变） |
| `answer_runtime_seconds` | int | 问答时限缺省，0=跟随租约 |
| `agent_default` | object | `{provider, model}` 节点级模型路由缺省，空值=不覆盖 |
| `config_revision` | int | 复用现有字段，policy_revision 并入其单调递增 |

- `GET /exec/v1/config`：返回上述全部键；
- `POST /register` 响应：同步携带（首次注册即生效，不等第一次心跳触发的 `/config`）；
- 未配置策略的存量节点：返回缺省值（等同上表默认），节点行为与今天一致——**向后兼容，v1 增量**（协议 §2.1：节点必须忽略未知字段）。

## 7. 任务级模型路由

派发载荷构建处（载荷组装位于编排器/派发管线）：coding 与 chat_answer 载荷新增**可选** `agent` 块：

```json
{ "agent": { "provider": "deepseek-official", "model": "deepseek-v4-pro" } }
```

- 优先级：任务载荷 `agent` > 节点策略 `agent_default` > 节点自身配置/档案默认；
- 工作项级别可留覆盖位（如工作区绑定默认模型），首版不必做，载荷块预留即可。

## 8. 超派过滤（`ExecClaim` 修复）

候选查询增加节点侧条件（示意）：

```sql
-- 认领节点必须有空闲槽：slots_total(policy 覆盖后) - slots_running > 0
AND ( COALESCE(n.policy->>'$.slots_total', n.slots_total) - n.slots_running ) > 0
-- 或仅认领 answer 类任务时豁免（answer 不占槽）
```

- 车道过滤同理：policy `lanes` 不含 `coding` 的节点不进 coding 候选；`chat_answer` 不占槽、不受空闲槽约束（与节点侧现状语义一致，`orchestrator.ts:387`）；
- 心跳更新的 `slots_running` 是过滤依据，维持现有入库路径。

## 9. admin-console UI 改造

1. **新增节点对话框**（`nodes/index.vue`）：提交后弹窗直接展示接入串卡片——密钥段打码 + [显示] + [复制接入串] + 警示"仅显示一次"；节点名默认自动生成"执行节点-XXXX"（可改）。
2. **节点详情页**（`detail.vue`）新增两区：
   - **接入区**：节点 ID、接入状态（从未注册=未接入）、[重新生成接入串]（即轮换密钥升级文案；确认文案："旧接入串立即失效，正在运行的节点需重新粘贴"）；
   - **策略区**：槽数（+硬件推荐 badge）、车道勾选、磁盘水位、任务时限、模型路由下拉（模型目录与现有来源一致）。
3. **节点列表**：加"接入状态"列（未接入/在线/离线/维护中），未接入置顶，解决"建了节点没人配"的追踪。

## 10. 协议文档增量

《执行节点接入协议》追加增量说明（沿用 20261017/20261018 增量文档惯例）：
- 接入串格式与生成时机；
- `/config`、`register` 响应新键语义与缺省值；
- 载荷可选 `agent` 块；
- 认领门控补充："无空闲槽的节点不派 coding；`chat_answer` 不受此限"。

## 11. 兼容与阶段

| 组合 | 行为 |
|---|---|
| 新平台 + 新节点 | 完整体验 |
| 新平台 + 旧节点 | 旧节点忽略新键照常运行；超派过滤对旧节点同样生效（依据其自报槽数） |
| 旧平台 + 新节点 | `/config` 无新键 → 节点用本地默认，行为同今天 |

- **阶段 A**（先行，无依赖）：接入串下发（`node_handlers.go` 响应 + admin-console 创建流）+ 超派过滤；
- **阶段 B**：策略模型 + `/config`/`register` 扩容 + 详情页策略编辑；
- **阶段 C**：任务级 `agent` 载荷块 + 协议文档增量。

## 12. 测试与验收

- Go 单测：接入串拼装（含通告地址配置）、policy 落库与 revision 递增、`/config` payload 键齐全、`ExecClaim` 空闲槽/车道过滤（满槽节点、answer 豁免、policy 覆盖自报值三种情形）；
- `execnode-stub` 回归：38 项自检清单重跑，确认新键被旧桩忽略、超派过滤不误伤；
- 验收（PM）：创建节点 → 复制接入串 → 节点端粘贴上线 ≤3 分钟；改槽数 → 节点 ≤20s 生效；密钥轮换 → 节点端有引导恢复；管理台全程可见接入状态。

## 13. 明确不做

- 不做节点自助注册端点（`/enroll`）；
- 不给接入串加 TTL/过期（密钥生命周期即接入串生命周期，轮换即失效）；
- 不改传输模型（不上 WebSocket/SSE 推送，"平台不主动连接节点"是协议安全边界）；
- 二维码、局域网自动发现列为后续可选增强，不进首版。
