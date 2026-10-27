# 天码 MPS 执行节点侧开发方案（接入串 + 平台策略下发）

> 配套文档：[`mps-platform-side-plan.md`](mps-platform-side-plan.md)（平台侧开发方案，交平台团队实施）
> 状态：提案（2026-10-27）。实施仓库：`D:\Agent\TianmaCoder`。
> 原则：**节点上报事实，平台决定策略**。凡是"这台机器上才知道的事"留在节点侧；凡是"该怎么管这台机器的决策"由平台下发。

## 1. 背景与问题

当前接入一个执行节点需要跨 5 层配置：

1. 平台管理台创建节点，得到 `node_id` + `secret`（人工抄录）；
2. 桌面端"执行节点"设置表单 14 个字段（`mps-node-ui/src/client/NodeSection.tsx`）；
3. 17 个 `MPS_*` 环境变量（`mps-executor/src/config.ts` 的 `EXECUTOR_ENV`）；
4. profile patch 行从环境变量读入插件配置（`mps-node-bundle/cordis.patch.yml`）；
5. 三层解析优先级（表单保存值 → 继承环境 → 协议默认），UI 需展示每个值的来源。

痛点：一个平台地址拆 4 字段；`nodeId` 与 `secret` 分离在两个渠道靠人工对齐；槽位/车道/模型路由等**策略**字段散在节点侧，而平台才是管理方；保存仅下次启动生效。

## 2. 目标

- 首次接入 = "粘贴一次接入串 → 测试 → 启动"，3 分钟内完成，零手填字段（粘贴与选目录除外），全程不看文档；
- 平台修改策略（槽数/车道/模型路由/时限）后，节点在 2 个心跳周期内（≤20s）自动生效，无需重启、无需节点侧操作；
- 密钥轮换场景，节点端从收到 401 到恢复上线全程有界面引导，无需查日志。

## 3. 接入串规范（与平台侧文档 §4 一致，改动需双端同步）

```
http://192.168.1.10:8791/exec/v1#node=node-3f2a&secret=<密钥>
```

- 前半段是普通 `http(s)` URL：scheme + host + port + basePath，用 `platformEndpointFromUrl`（`mps-exec-core/src/endpoint.ts:154`）解析；
- 身份放在 **fragment（`#` 之后）**：`node=<平台铸造的节点ID>` 与 `secret=<预共享密钥>`。fragment 不会被浏览器/HTTP 客户端发给服务器，接入串被误当 URL 打开时密钥不进任何访问日志；
- 解析规则：URL 部分必须合法且为 http/https；`node`、`secret` 必须存在且非空；多余参数忽略。解析失败必须报出**缺了什么**，不许笼统"格式错误"；
- 安全红线：接入串本体与 secret 值不得出现在任何日志、错误消息、`--show-config` 输出中；接入串整体作为一个模式加入 `mps-exec-core/src/redact.ts` 的脱敏清单；解析成功后立即把 secret 写入密钥存储（现有 `mps-node-control.json` 的 `nodeSecret` 字段位），**粘贴框清空，明文不滞留 UI**。

## 4. 配置优先级（重定义）

```
平台下发（/config、register 响应） > 显式环境变量 > 内置默认
```

表单保存值归入"显式"一档（保存即写 `mps-node-control.json` 并于下次启动注入环境）。原"表单 > 继承环境"的细分合并，UI 不再需要展示 4 种来源，仅区分 **平台下发 / 本机设置 / 默认**。

### 字段去向

| 字段 | 去向 |
|---|---|
| platformHost/Port/Scheme/BasePath、nodeId、secret | 合并为接入串（节点侧仍可单独覆盖，调试用） |
| workspaceRoot、networkProxy | 留在节点表单（本机事实） |
| slotsTotal、lanes、diskMinGb、taskRuntimeSeconds、answerRuntimeSeconds、agentProvider/agentModel | **平台下发**；节点侧值降级为回退默认；表单中转只读展示 |
| nodeName、nodeHost、labels | 平台侧节点元数据，从节点表单移除 |
| 其余（心跳周期、长轮询、租约等） | 现状已是平台覆盖，不动 |

## 5. 包级改动清单

### 5.1 mps-executor

- `src/config.ts`
  - 新增 `MPS_JOIN` 环境变量：`executorConfigFromEnv` 先读它，解析成功后展开为现有 `Config` 字段；显式旧变量优先于接入串展开值（用户明确写的赢）；
  - `slotsTotal/lanes/diskMinGb/taskRuntimeSeconds/answerRuntimeSeconds/agent*` 的 JSDoc 改为"回退默认，平台下发优先"；
  - `EXECUTOR_ENV` 保留全部旧键（调试覆盖），新增 `join: 'MPS_JOIN'`。
- `src/startup.ts`：`--help` 与 `--show-config` 输出补 `MPS_JOIN` 说明；`--show-config` 逐项标注值的来源档位。
- `src/runtime.ts`
  - `#applyConfiguration`（`runtime.ts:479` 触发点不变）扩展识别新键：`slots_total`、`lanes`、`disk_min_gb`、`task_runtime_seconds`、`answer_runtime_seconds`、`agent_default{provider,model}`；平台未下发的键保留节点自声明值（`runtime.ts:543` 回退逻辑已有，扩展到新键）；
  - 应用后日志一条：`platform configuration rN applied (slots=2 lanes=coding,chat_answer …)`，**不得**包含密钥。
- `src/orchestrator.ts`：认领与满槽判断改用"当前生效槽数"（平台下发值优先于启动时配置值）。

### 5.2 mps-node-control

- `DEPLOYMENT_ENV` 缩减为 `join`、`workspaceRoot`、`networkProxy`、`nodeSecret` 四键；旧键读取保留但移入 `LEGACY_DEPLOYMENT_ENV`（仅迁移提示用）；
- `launchEnvironment`：注入 `MPS_JOIN=<保存的接入串>`（接入串按现状存 `mps-node-control.json`，新增字段 `join`；secret 拆出后不再单独存）；
- `config()` 读数：`effective` 三档来源（platform/local/default）；新增 `platformPolicy` 只读块（槽数/车道/模型路由/config_revision，由节点进程经 ops 目录落盘的策略快照读取——`/config` 应用时写 `ops/policy.json`，node-control 直接读文件，不新增 IPC）；
- `probe()`：结果细分 `dns-failed / refused / timeout / answered(status)` 四类，文案"发生了什么 + 下一步做什么"；
- 新增：监听节点 stderr/stdout 行，识别 `NODE_SECRET_INVALID` / `NODE_DISABLED` 失败态，置 `MpsNodeStatus.error` 并让 UI 展开接入区（见 §6.5）；
- 保存时若进程在运行，`saveConfig` 响应携带 `needsRestart: true`。

### 5.3 mps-node-ui

页面重排为四区（状态卡 / 接入 / 本机环境 / 平台策略），任务与日志区保留。交互规格：

1. **PasteBox 粘贴组件**（接入区）
   - 多行大输入框，占位文案含示例；进入编辑态自动聚焦；支持"粘贴"按钮（读剪贴板）与 Ctrl+V；
   - 粘贴即解析：下方三行摘要 `✓ 平台地址 …`、`✓ 节点 ID …`、`✓ 密钥已接收（不回显）`；解析失败红框 + 指出缺失项；识别到"只有 host 没有身份"的旧式手填时提示改用平台生成的接入串；
   - 保存成功后清空粘贴框（密钥已入库）。
2. **DirPicker 目录选择器**（本机环境区，基于现有 `browse()`）
   - 选择后显示目标盘剩余空间；低于平台下发的 `disk_min_gb` 时黄条警告"低于水位 Y GB，节点将不认领任务"；
   - 当场校验：目录存在、可写（中文/空格/括号合法，协议已明确）；失败说人话；
   - 占位符显示将生效值；附"上次使用"快捷项。
3. **保存与生效**：保存后 inline 提示"已保存，重启后生效 [立即重启]"（一键 stop→start）。
4. **平台策略区（只读）**：槽数、车道、模型路由、配置版本 rN，标注"由平台管理台下发"；提供"去平台管理台修改"外链位（URL 由部署配置，缺省隐藏）。旧策略字段全部移入"高级（调试覆盖）"折叠区，默认收起。
5. **401 引导**：`status.error` 命中密钥失效时，状态卡黄条"密钥已失效（可能已在平台轮换），请粘贴新接入串"，接入区自动展开并聚焦粘贴框。
6. 首次接入（无任何保存值时）接入区显示三步微指引（粘贴 → 测试 → 启动）。
7. `locales.ts` 补全双语键；术语统一：接入串 / join code。

### 5.4 mps-node-bundle

`cordis.patch.yml`：executor 行的地址与身份来源改为 `MPS_JOIN` 优先（`process.env.MPS_JOIN` 存在时用它解析，否则走旧变量），`autoStart` 判定同步改为"接入串或 MPS_PLATFORM_HOST 存在"。

## 6. 兼容与回退

- 旧平台 + 新节点：`/config` 无新键 → 节点用本地默认，行为同今天；接入串里不含策略，不受影响；
- 新平台 + 旧节点：旧节点忽略新键，照常运行；
- `MPS_JOIN` 与旧变量混用：显式旧变量 > 接入串展开值 > 默认；
- 阶段 1（本仓可独立先行，不依赖平台改动）：`MPS_JOIN` 解析 + UI 重排 + DirPicker + 立即重启 + 401 引导；阶段 2：`/config` 新键应用 + 策略只读区 + 高级折叠收尾。

## 7. 测试计划

- `mps-executor/tests/`：接入串解析（合法/缺 node/缺 secret/坏 URL/带多余参数/与旧变量混用优先级）、`#applyConfiguration` 新键应用与回退、claim 用平台槽数；
- `mps-node-control/tests/`：`join` 保存/注入/回读、`needsRestart`、probe 分类、策略快照文件读写；
- `mps-node-ui` 既有 spec 模式补交互用例；
- 红线用例：接入串与 secret 不出现在任何日志/错误/`--show-config` 输出（复用 `containsSecretPattern` 断言模式）。

## 8. 明确不做

- 不换 WebSocket/SSE（协议"平台不主动连接节点"是安全边界）；
- 不合并 `/auth/token` 与 `/register`；
- 不做节点自助注册（`/enroll`）——预铸造身份 + 接入串已够简单，自助注册引入审批复杂度；
- 不做局域网自动发现（mDNS）——多一个组件，与"更简单"相悖。
