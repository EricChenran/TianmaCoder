# M3/M4 交付验证报告(2026-09-22)

本轮交付:PR-3 补全、PR-5、PR-4b、PR-6、PR-7,以及配套的全模式覆盖与前端标注(上一提交 `42f45cf`)。

## 1. 交付清单与测试证据

| 项 | 内容 | 测试 | 结果 |
|---|---|---|---|
| PR-3 补全 | 高保真总结器韧性层:prompt-too-long 截断重试(≤3 次)、连续失败熔断(3 次降级上游 `summarizeWithLlm`)、最终挤压时落确定性 fallback 检查点(逐字用户消息+会话尾部,代替报错回滚) | `summarize-resilience.spec.ts` 8 项(重试截断、fallback 落库、熔断降级后自动复位) | ✅ 17/17 |
| PR-5 | `@tianma/dsh-compaction-file-rehydrator`:从 append-only 日志重建已读文件账本(read/edit 计数、STALE 标记),经 `agent/created` 注册 agent 作用域 system-prompt context,每次组装实时重算 | `file-rehydrator.spec.ts` 6 项(账本核算、STALE、预算、接线) | ✅ 6/6 |
| PR-4b | `@tianma/dsh-token-meter-calibration` 装配层:`UsageCalibrator`(usage 采样→滚动因子)+ `scanSessionUsages` 扫描器 + `ctx.tianmaTokenCalibration` 注册 + 因子持久化(`<home>/tianma-calibration.json`) | `calibration-service.spec.ts` 等 12 项 | ✅ 12/12 |
| PR-6 | `architecture-policy.yaml` + `scripts/verify-architecture.ts`:每个 tianma 包只允许声明的上游 seam、禁止跨包 import、禁止相对路径逃逸;`pnpm run verify:architecture` | `verify-architecture.spec.ts` 5 项(正/反/多基准) | ✅ 5/5 + 仓库审计通过 |
| PR-7 | `@tianma/dsh-hooks-trust`:第三方 hook 命令 sha256 账本(未变批准放行/一字之改重审/拒绝持久化/账本损坏 fail-closed),注册 `ctx.tianmaHookTrust` | `hooks-trust.spec.ts` 4 项 | ✅ 4/4 |
| 配套 | 桌面迁移设计文档双语对(工作区既有中文稿)、品牌改名(system-prompt identity → TianmaCoder)的测试/文档跟进、Web 入口 `Promise.withResolvers` polyfill | 44 文件 5962 项上游测试(品牌影响面) | ✅ 5962 passed |

## 2. 门禁结果

- tianma 全量单测:**69/69 通过**(11 个测试文件)
- `verify:profile-patches`(6 上游层 fail-closed 校验):**通过**
- `verify:architecture`(机器架构门禁):**通过**
- `doc-sync`:**42/42 通过**(含双语配对 1101 对、config catalog 双语、cordis catalog、模型体验审计、export JSDoc)
- `tsc -b tsconfig.host.json`:**0 error**
- 品牌影响面测试(system-prompt/agent-loop/app-boot):**5962 passed, 2 skipped**

## 3. 诚实边界(必须知晓)

1. **PR-4b 的最终一公里**:校准因子已可计算并持久化,但 compaction 压力决策读取因子的上游 seam 尚不存在——当前它作为服务供消费方调用,不自动改写 `tokenMeter` 行为(README 已声明)。
2. **PR-7 的执行器接线**:信任账本已就绪,但上游 hooks-claude-code/codex 执行器尚未调用 `evaluate()`——需要与上游讨论 seam 后接线(README 已声明)。
3. **M1.5 A/B 盲测未执行**:按路线图这是人工评审 gate(需 DEEPSEEK_API_KEY + 2 名评审 + 冻结任务集),自动化无法替代;协议与任务集目录已就绪。
4. **willRetriggerNextTurn 语义调整**:实现为"最终挤压落 fallback 检查点",而非向上游追加新日志事件类型(避免持久化类型变更审批)。效果等价(不报错、不回滚、下轮可继续),实现路径已写入包 README。

## 4. 与路线图的偏差记录

- PR-3 的 `modelPolicies` 按模型策略覆盖仍未实现(上游 seam 限制,与 PR-9 时声明一致)。
- PR-5 的注入形态从"内部 map 再水化"改为"作用域提示节"(dsh 的 append-only 日志让该形态更干净),验收指标(重复 Read ↓50%)待 A/B 验证。
- 空闲触发 microcompact 维持不做(归属触发管线,需上游讨论)。
