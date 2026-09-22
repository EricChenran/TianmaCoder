# ZCode 优势融入 DeepSeek Harness 方案

版本:v1(2026-09-22)
目标:把 ZCode 在 token 计量、上下文保全、压缩保真、提示词工艺上的优势,以 dsh 官方扩展路径(out-of-tree 插件 + profile patch)融入 dsh,不 fork 主仓库。

## 0. 总原则

1. **不 fork,走组合**:dsh 的扩展模型是 profile → bundle → cordis.patch.yml 三层叠加,任何配置行可按 id 整行替换(`dsh --profile web --dump-config` 查看行 id)。所有改动以独立插件包 + profile 补丁交付,上游升级零冲突。
2. **保留 dsh 的正确设计**:append-only session log、KV 前缀对齐、fail-closed 组装校验不动。移植的是 ZCode 的"保真策略",不是它的架构。
3. **按你们技术部的诊断排序**:P0 全部瞄准"长任务压缩后产出劣化"的已证实机制。

## P0 质量急救(对应产出质量问题的根因)

### P0-1 用"近因保全裁剪器"替换 tool-result-pruner 【最高优先级】

问题:dsh 默认 pruner 对超过 8192 字符的工具结果无差别"头 4096 + 尾 1024、中段挖除",不豁免最近结果——代码任务的目标区域恰在中段。
方案:新插件 `@yourorg/dsh-compaction-recency-pruner`,注册同一个 `ctx.toolResultPruner` seam,通过 profile patch 替换 `dsh-compaction-tool-result-pruner` 行。语义照抄 ZCode `microcompact.ts`:
- 保留最近 5 组工具调用结果完整不动(`keepRecentGroups=5`)
- 更早的结果整体替换为 `[Old tool result content cleared]`,不做部分截断
- 单次清理至少节省 256 token 才执行;支持 60 分钟空闲触发
- 只针对 Read/Bash/Grep/Glob/WebFetch/Edit/Write 类大输出工具
验收:活跃窗口(最近 5 组)零内容损失;token 缓解量不低于现 pruner 的 90%。

### P0-2 token-meter 接入 provider usage 校准

问题:`estimate.ts` 固定 `CHARS_PER_TOKEN=4`,中文低估 2~3 倍,压力误判导致压缩触发错位。
方案:新插件监听 `agent/*` 请求成功事件,记录每次真实 provider usage(含 cache read/write),按"请求信封相似度"建立校准因子注入 `ctx.tokenMeter` 的测量;短期先做语言感知密度(中文字符按 ~1.5 chars/token 计)。
验收:中文为主会话中 |估算−真实|/真实 ≤ 10%(现状 50%~66% 偏差)。

### P0-3 通过 summarize() 钩子升级压缩总结器

问题:dsh 总结保留率默认 16%、无逐字保留要求、总结请求带工具 schema 却无防调工具护栏、超长只能报错回滚。
方案:子类化 `dsh-compaction-basic`(`summarize()` 是文档声明的唯一定制钩子),融入 ZCode `prompt.ts` 全套工艺:
- 9 段式结构(主请求意图/技术概念/文件与代码/错误与修复/全部用户消息/待办/当前工作/下一步/关键上下文)
- **全部用户消息逐条 + 安全约束逐字保留**(每代总结从原文重锚定,抑制链式衰减)
- `<analysis>` → `<summary>` 强制思维链输出
- NO_TOOLS 前后缀护栏(指令文本层面,保持 KV 前缀对齐不破坏)
- prompt-too-long 截断重试(≤3 次)、连续失败熔断(3 次)
- `willRetriggerNextTurn` 边界:一次压不完时标记下轮续压,替代直接报错
验收:盲测 A/B 20 个长任务;压缩后"用户约束回忆测试"通过率显著提升。

### P0-4 配置级修正(当天可完成)

- `retainRatio` 0.16 → 0.35(逐字保留的近期尾部)
- `agent-instructions` 的 `maxBytes` 65536 → 262144,避免大仓库工程规范静默丢弃
- 以 `personaPrefix`/系统提示词 contribution 移植 ZCode `dynamic-sections.ts` 的行为规范文本(沟通方式、自主推进边界、最终消息承载结论),注册为 order 0 的具名贡献

## P1 压缩后连续性

### P1-1 文件状态再水合插件

问题:压缩后模型对"我读过哪些文件、什么版本"失忆,反复重读;fs 层 FS_STALE_VERSION 只在 edit 命中时兜底。
方案:新插件在 compaction commit 事件后,从 append-only 全量 log(ZCode 做不到的优势:dsh 原始数据永远在)重建文件版本视图,以 system-reminder 风格的上下文节注入;等价 ZCode `read-file-state-hydrator` 的 `restoredCount` 语义。
验收:压缩后 3 轮内的重复 Read 次数下降 ≥50%。

## P2 治理与信任

### P2-1 架构策略机器门禁
把 ZCode `architecture-policy.yaml` 模式(模块 roots/requires/publicEntrypoints/layers + CI 校验)作为独立 CI job 引入你们的 dsh 插件仓,约束自有插件间的依赖方向。

### P2-2 hooks 信任链
参照 ZCode `core/src/hooks/` 的 trust-domain/evaluation/records/admission 分层,为 dsh hooks 包补一个信任评估插件:项目自带 hook 首次执行前走哈希记录 + 用户审查。

## P3 结构性移植(可选,成本高)

- **类型化编译工作流**:ZCode dynamic-workflow(先类型检查再执行的 TS 编排 + escalation)作为新插件家族挂到 dsh workflow seam。工程量大,建议验证 P0 收益后再立项。
- **不建议移植**:ZCode 的静态分层架构、桌面原生壳、SEA 分发——与 Cordis 组合模型冲突或 dsh 已有等价物。

## 验证协议(贯穿全程)

1. 同一模型端点、同一任务集,两配置对跑(dsh 原版 vs +P0 补丁)
2. 任务分桶:短会话(<30min)/ 长会话(>2h,必触发压缩)
3. 信号:压缩/裁剪触发时间点、被裁内容是否含目标代码、产出 diff 质量、压缩后约束回忆测试
4. 判据:若长会话桶质量差距收窄 ≥70% 且短会话桶无回归,证明技术部归因成立且修复有效

## 实施顺序与工作量

| 阶段 | 内容 | 工作量 |
|---|---|---|
| 第 1 天 | P0-4 全部配置补丁 + prompt 文本移植 | 0.5 人日 |
| 第 1 周 | P0-1 recency-pruner 插件 | 2~3 人日 |
| 第 1~2 周 | P0-3 summarizer 子类 | 3~4 人日 |
| 第 2 周 | P0-2 usage 校准 | 2 人日 |
| 第 3 周 | P1-1 再水合 | 3 人日 |
| 按需 | P2/P3 | 另立项 |
