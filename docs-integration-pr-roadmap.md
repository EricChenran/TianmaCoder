# ZCode 优势融入 dsh：PR 拆解、路线图与验证机制

版本：v1（2026-09-22）

> **状态（2026-09-22）**：PR-0~PR-4 已提交评审——[#6](https://github.com/EricChenran/TianmaCoder/pull/6) scaffold、[#7](https://github.com/EricChenran/TianmaCoder/pull/7) 配置与行为准则、[#8](https://github.com/EricChenran/TianmaCoder/pull/8) 近因裁剪器、[#9](https://github.com/EricChenran/TianmaCoder/pull/9) 高保真总结器、[#10](https://github.com/EricChenran/TianmaCoder/pull/10) 计量校准核心。栈顶 doc-sync 42 门禁全绿；PR-5~PR-7 待后续。
上游文档：[docs-integration-plan.md](docs-integration-plan.md)（总方案）、[docs/architecture.md](docs/architecture.md)、[docs/capability-seams.md](docs/capability-seams.md)
交付形态：全部以独立插件包 + profile patch（cordis.patch.yml）交付，不 fork、不改 vendor/。

---

## 0. PR 总体约定

所有 PR 遵守同一套工程约束，评审时按此清单核对：

1. **可回滚性**：每个 PR 只含一个 profile patch 行替换或一个新包；回滚 = 从 profile 移除该行 + 删除包目录，不触碰其他配置。
2. **命名空间**：所有新包使用 `@tianma/dsh-*` 前缀，与上游 `@deepseek-ai/dsh-*` 严格隔离；唯一允许的上游引用方式是通过 seam（`ctx.*`）注册，禁止 import 上游包内部模块。
3. **测试门禁**：新代码纳入 `pnpm run test`（per-file 100% 覆盖率门禁适用于 `packages/*/*/src`，新包须达到同等标准）；每个 PR 附带行为级测试，测试语义直接映射验收条款。
4. **文档门禁**：每个落地 PR 同步交付 Agent Note（`proposed/feature/` 起步，落地时转 `implemented/`，英中双语三文件组），并更新 [docs-integration-plan.md](docs-integration-plan.md) 对应条目的状态。
5. **补丁可校验**：每个 patch 行替换在 CI 中用 `dsh --profile web --dump-config` 断言目标行的 id 命中且仅命中一次，防止上游行 id 漂移后补丁静默失效（fail-closed）。
6. **开关化**：每个新插件提供 profile 级 on/off，出问题可在不改代码的情况下逐项关闭、二分定位。

### PR 依赖图

```
PR-0 (补丁基线与校验脚本) ──► 全部后续 PR
PR-1 (配置修正) ──► 独立可合
PR-2 (recency-pruner) ──► 独立可合（依赖 PR-0 的校验）
PR-3 (summarizer 子类) ──► 独立可合；与 PR-1 的 retainRatio 联调
PR-4 (usage 校准) ──► 独立可合；PR-3 的截断重试受益于它
PR-5 (文件再水合) ──► 依赖 PR-3（消费 compaction commit 事件语义）
PR-6 (CI 门禁) / PR-7 (hooks 信任链) ──► 独立可合，不阻塞 P0
```

---

## 1. PR 拆解

### PR-0 基础设施：补丁行校验脚本与插件脚手架 【前置，0.5 人日】

- **新增**：
  - `scripts/verify-profile-patches.ts`：对每个声明了 patch 的 profile 执行 `--dump-config`，断言被替换行的 id 存在、替换后无孤儿引用。加入 `scripts/run-gates.ts` 门禁链（`pnpm run doc-sync` 所在链路）。
  - `packages/tianma/` workspace 组 + `tsconfig`/`pnpm-workspace` 挂载 + 插件包模板（README、SKILL 无、vitest 配置）。
- **测试**：脚本自身单测；对一个样例 patch 做正/反断言（故意写错 id 时必须失败）。
- **验收**：在 CI 中故意破坏一个 patch id → 门禁红灯；恢复 → 绿灯。

### PR-1 配置级修正与行为规范文本（P0-4）【0.5 人日，当天可合】

- **范围**：
  - `retainRatio` 0.16 → 0.35（compaction 配置 patch 行替换）。
  - `agent-instructions` `maxBytes` 65536 → 262144。
  - 新包 `@tianma/dsh-behavioral-guidelines`：以 `personaPrefix` / order 0 具名 contribution 注入 ZCode `dynamic-sections.ts` 移植文本（沟通方式、自主推进边界、最终消息承载结论三节）。
- **测试**：dump-config 断言两处配置值；contribution 注册后组装校验（fail-closed 组装不报错）；注入文本的快照测试（防止文案漂移）。
- **验收**：`--dump-config` 中三个值生效；一个含 >64KB 工程规范（AGENTS.md）的样例仓库不再被静默截断。
- **回滚**：移除 patch 行与包即可，无持久化影响。

### PR-2 近因保全裁剪器 recency-pruner（P0-1）【2~3 人日】

- **新增包**：`@tianma/dsh-compaction-recency-pruner`。
- **注册 seam**：`ctx.toolResultPruner`；profile patch 替换 `dsh-compaction-tool-result-pruner` 行。
- **语义（照抄 ZCode `microcompact.ts`，逐条实现）**：
  - `keepRecentGroups = 5`：最近 5 组工具调用结果完整保留，零改动。
  - 更早结果整体替换为 `[Old tool result content cleared]`，不做头/尾部分截断。
  - 单次清理节省 < 256 token 时不执行。
  - 支持 60 分钟空闲触发。
  - 工具白名单：Read / Bash / Grep / Glob / WebFetch / Edit / Write。
- **测试**：
  - 单测：组边界（恰好 5 组 / 6 组 / 空 session）、白名单外工具不清理、token 阈值边界（255/256）、替换占位符文案快照。
  - 属性测试：任意输入下最近 5 组字节级不变。
  - 对照测试：固定语料上"token 缓解量 ≥ 现 pruner 的 90%"作为 CI 断言（语料入 `benchmarks/`）。
- **验收**：活跃窗口零内容损失；缓解量达标；与 `dsh-compaction-basic` 组装后端到端跑通一个录制的长 session（snapshot replay 无异常）。

### PR-3 压缩总结器升级 summarize-summarizer（P0-3）【3~4 人日】

- **新增包**：`@tianma/dsh-compaction-summarize`，子类化 `dsh-compaction-basic`，仅覆盖文档声明的唯一定制钩子 `summarize()`。
- **融入 ZCode `prompt.ts` 全套工艺**：
  1. 9 段式总结结构：主请求意图 / 技术概念 / 文件与代码 / 错误与修复 / 全部用户消息 / 待办 / 当前工作 / 下一步 / 关键上下文。
  2. 全部用户消息逐条保留；安全约束逐字保留，每代总结从 append-only 原文重锚定（抑制链式衰减）。
  3. `<analysis>` → `<summary>` 强制思维链输出格式。
  4. NO_TOOLS 前后缀护栏（纯指令文本层面，保持 KV 前缀对齐）。
  5. prompt-too-long 截断重试（≤3 次）、连续失败熔断（3 次后降级到上游行为）。
  6. `willRetriggerNextTurn` 边界：一次压不完时标记下轮续压，替代直接报错回滚。
- **测试**：
  - 结构测试：9 段标题齐全、用户消息逐字出现（fuzz 含中文/代码块/逐字约束的合成 session）。
  - 护栏测试：总结请求上下文中不含工具 schema（NO_TOOLS 生效断言）。
  - 重试/熔断：mock provider 分别返回 prompt-too-long ×4（第 4 次必须不再重试）、连续失败 ×3（触发熔断降级）。
  - 续压：构造超限 session，断言产出 `willRetriggerNextTurn` 标记而非报错。
- **验收**：与 PR-1 联调后跑完整压缩链路；盲测 A/B（见 §3 验证机制）约束回忆通过率显著提升。

### PR-4 token-meter usage 校准（P0-2）【2 人日】

- **新增包**：`@tianma/dsh-token-meter-calibration`。
- **机制**：
  - 监听 `agent/*` 请求成功事件，记录真实 provider usage（含 cache read/write）。
  - 短期：语言感知密度（中文字符 ~1.5 chars/token）作为冷启动估算；随样本积累，按"请求信封相似度"建立校准因子注入 `ctx.tokenMeter` 测量。
  - 校准因子持久化于非 session 存储，附版本字段；样本窗口滚动（如最近 N=1000 次请求）。
- **测试**：注入 mock usage 序列后估算收敛；中英文混合语料 |估算−真实|/真实 ≤ 10% 的基准测试（语料与阈值写死进 CI）；存储迁移与滚动窗口单测。
- **验收**：中文为主会话估算偏差 ≤10%（现状 50%~66%）；校准失效（无样本）时回退到语言感知密度，永不回退到固定 CHARS_PER_TOKEN=4。

### PR-5 文件状态再水合 rehydration（P1-1）【3 人日，依赖 PR-3】

- **新增包**：`@tianma/dsh-compaction-file-rehydrator`。
- **机制**：监听 compaction commit 事件 → 从 append-only 全量 log 重建"已读文件 + 版本"视图 → 以 system-reminder 风格上下文节注入（等价 ZCode `read-file-state-hydrator` 的 `restoredCount` 语义）。只读重建，不写 session log 的历史段（append-only 约束）。
- **测试**：合成 log（读 A v1 → 改 A v2 → 压缩）→ 断言注入节含 A 当前版本；log 截断/损坏时 fail-safe（跳过注入并记日志，不阻断会话）；注入节大小上限与裁剪顺序单测。
- **验收**：对比实验中压缩后 3 轮内重复 Read 次数下降 ≥50%。

### PR-6 架构策略 CI 门禁（P2-1）【1~2 人日，不阻塞 P0】

- **新增**：`architecture-policy.yaml`（自有插件间的 roots/requires/publicEntrypoints/layers 声明）+ CI job 校验（移植 ZCode 模式），约束 `@tianma/*` 内部依赖方向；上游依赖只允许走 seam。
- **验收**：故意新增一条越层 import → CI 红灯。

### PR-7 hooks 信任链（P2-2）【2~3 人日，不阻塞 P0】

- **新增包**：`@tianma/dsh-hooks-trust`，参照 ZCode `core/src/hooks/` 的 trust-domain / evaluation / records / admission 分层：项目自带 hook 首次执行前哈希记录 + 用户审查准入。
- **测试**：哈希变更后重审、审查拒绝后不执行、记录持久化迁移。
- **验收**：未审查 hook 首次触发走审查流；已批准 hook 哈希未变时静默放行。

### 明确不做（与 docs-integration-plan.md §P3 一致）

ZCode 静态分层架构、桌面原生壳、SEA 分发：与 Cordis 组合模型冲突或 dsh 已有等价物。dynamic-workflow 类型化编译工作流仅在 P0 验证收益后另立项（届时按本文件模板补充 PR 拆解）。

---

## 2. 路线图与里程碑

以 M0 合入日为 T0。每个里程碑有明确出口判据（gate），未过 gate 不进入下一阶段；任何里程碑内出现短会话回归（见 §3 判据）立即回滚该阶段补丁并归因。

| 里程碑 | 周期 | 内容（PR） | 出口判据（gate） |
|---|---|---|---|
| **M0 基础设施就绪** | T0 + 2 天 | PR-0、PR-1 | 补丁校验门禁在 CI 常绿；dump-config 三项配置生效；>64KB AGENTS.md 样例不再截断 |
| **M1 压缩质量核心** | T0 + 2 周 | PR-2、PR-3 | 单测/覆盖率全绿；基准语料上缓解量 ≥90%、9 段结构与逐字保留断言通过；内部 dogfood 5 个真实长任务无致命问题 |
| **M1.5 A/B 盲测（人工 gate）** | T0 + 2.5 周 | 无新 PR，专项验证 | §3 协议首轮跑完：长会话桶"约束回忆 + 产出 diff 质量"显著优于原版；未达标则回到 PR-2/PR-3 修因，不进入 M2 |
| **M2 计量校准** | T0 + 4 周 | PR-4 | 中文会话估算偏差 ≤10%（CI 基准固化）；压缩触发时机在长会话回放中不再错位 |
| **M3 连续性与治理** | T0 + 6 周 | PR-5、PR-6 | 再水合重复 Read ↓≥50%；架构门禁 CI 常绿；压缩后 3 轮连续性主观评审通过 |
| **M4 信任链与收尾** | T0 + 8 周 | PR-7 | hooks 审查流端到端可用；全套文档（Agent Notes ×7、docs-integration-plan 状态更新）过 doc-sync 门禁；发布内部版本 tag |
| **按需立项** | — | P3 类型化工作流 | M1.5 A/B 结论产出后决策 |

里程碑评审会（每阶段出口）：对照本表判据逐条核对，产出 go / no-go 结论与证据链接（CI run、A/B 数据表）；no-go 时的回滚与归因结论写入对应 Agent Note。

**风险与缓冲**：
- 上游行 id 漂移（dsh 处于开发者预览期，破坏性变更频繁）→ PR-0 的 fail-closed 校验使漂移在 CI 即刻暴露；升级上游时先跑全量 patch 校验。
- `summarize()` 是唯一声明钩子，深改可能受限 → PR-3 设计上仅依赖该钩子 + 指令文本护栏，不 hack 内部；若钩子表达力不足，记录到 Agent Note 并与上游讨论，不绕路。
- A/B 盲测需要人工评审带宽 → M1.5 提前锁定 2 名评审与任务集，任务集在 M0 期间就冻结（见 §3.1）。

---

## 3. 验证机制

三层验证：**CI 门禁（每 PR）→ 回放回归（每里程碑）→ A/B 盲测（M1.5 与发布前）**。

### 3.1 A/B 盲测协议（最终判据）

- **环境控制**：同一模型端点、同一 temperature/系统配置；仅"原版 dsh"与"原版 + 本项目补丁"两配置对跑。
- **任务集**（M0 期间冻结，存 `benchmarks/ab-tasks/`）：
  - 短会话桶：≥10 个 <30min 任务（不触发压缩）——守回归。
  - 长会话桶：≥10 个 >2h 任务（必触发压缩）——主战场，须含中文需求、多文件代码任务、带明确用户约束的任务（约束用于回忆测试）。
  - 每任务录制 session log，支持 snapshot replay 复跑。
- **信号采集**：
  1. 压缩/裁剪触发时间点与次数（session log 时间线）。
  2. 被裁内容是否含目标代码（对录制 log 离线审计：目标区域 = 任务最终 diff 涉及的文件/函数）。
  3. 产出 diff 质量：评审按盲测编号打分（正确性 / 完整性 / 是否违反用户约束），评审者不知配置归属。
  4. 压缩后约束回忆测试：压缩完成后的下一轮注入固定问句（"本任务用户提出了哪些约束？"），逐条比对原任务约束清单。
- **判定**：
  - 生效判据：长会话桶质量差距收窄 ≥70%（按 3、4 两项综合分），且短会话桶无回归（综合分下降 <5%）→ 技术部归因成立且修复有效。
  - 回归判据：短会话桶任一任务综合分下降 >10% → 该阶段补丁整体回滚，逐项二分（每个插件有独立开关）定位后重验。

### 3.2 回放回归（里程碑级）

- 用 `pnpm run test:snapshot`（无 key 录制回放）维护一组"典型长会话"录制：M1 起每个里程碑在两配置下复跑，对比压缩次数、token 曲线、最终产出快照；曲线与快照差异超阈值需在评审会上解释。
- 再水合（PR-5）专属指标：压缩后 3 轮内重复 Read 计数，从录制 log 机械统计，进入里程碑评审表。

### 3.3 CI 门禁（PR 级，长期常驻）

| 门禁 | 覆盖 | 归属 |
|---|---|---|
| 单测 + per-file 100% 覆盖率 | 所有新包 | 既有 CI |
| `verify-profile-patches`（fail-closed 行 id 校验） | 所有 profile patch | PR-0 |
| 基准语料断言：缓解量 ≥90%、估算偏差 ≤10% | PR-2 / PR-4 | 各自 PR 内固化 |
| 结构断言：9 段 / 逐字保留 / NO_TOOLS / 熔断 | PR-3 | PR-3 |
| 架构策略校验（`@tianma/*` 依赖方向、seam-only 上游引用） | 全部新包 | PR-6 |
| doc-sync（Agent Notes 双语三文件 + 计划文档状态同步） | 每 PR | 既有门禁 |

### 3.4 线上观测（合入后）

- 每个插件输出结构化运行指标（触发次数、跳过原因、节省 token、校准偏差样本），走既有 runtime-diagnostics 通道；dogfood 期（每个里程碑后 1 周）每日巡检，异常即用 profile 开关热关闭。

---

## 4. 状态追踪

每个 PR 合入时：在本文件 PR 标题后追加 `（已合入 @ commit）`；里程碑 gate 通过/失败在 §2 表格中追加结论链接。docs-integration-plan.md 的 P0/P1/P2/P3 条目同步标注对应 PR 编号。
