# TianmaCoder 网页端 → Electron 客户端迁移设计方案（PR 文档）

[English](desktop-client-migration-plan.md) | 中文

> 状态：设计评审稿（Draft PR）；日期：2026-09-22；范围：`apps/desktop`、`apps/desktop-host`、`apps/web`、`apps/cli`、根脚本与文档；关联决策：`apps/desktop/README.md`（thin-wrapper、packaging & updates、primary-runtime 三项已归档决策）

## 1. 需求复述与目标

用户需求：将 TianmaCoder 从"浏览器访问 Web 服务"的使用形态，改造为"独立安装、独立窗口的 Electron 桌面客户端"形态，并要求先产出设计方案 PR 文档供评审。

### 目标

1. **形态目标**：用户双击桌面图标即用，无需打开浏览器、无需手动启动 `dsh web` 服务；具备原生窗口、系统托盘语义（应用菜单）、自动更新、离线可安装。
2. **复用目标**：不重写业务——Web 前端（`apps/web` 的 Vite 产物）与 Host 后端原样作为客户端的渲染层与服务层，Electron 只做"壳"。
3. **安全目标**：渲染进程零 Node 能力、零任意 IPC；所有提权能力收敛在 preload 白名单桥 + 主进程。
4. **质量目标**：Web 形态与桌面形态共享同一套前端与 Host 实现，任何功能改动两种形态同时生效，不出现形态分叉。

### 非目标（明确不做）

- 不为桌面形态单独开发一套 UI。
- 不把 Host 后端重写为主进程内嵌服务（保持独立子进程，崩溃隔离不变）。
- 本 PR 不做代码签名证书采购与商店上架（打包链路已预留 unsigned 通道）。

## 2. 现状盘点（关键事实）

调研确认：仓库中 **Electron 桌面形态的基础设施已大体存在**，本方案不是从零搭建，而是"补齐、收口、验收"：

| 资产 | 位置 | 现状 |
|---|---|---|
| Electron 主进程 | `apps/desktop/src/` | 已有 main/preload 全套（窗口、单实例锁、更新、欢迎窗、强制更新、目录选择、麦克风权限、平台内嵌视图、Windows 标题栏布局等 40+ 模块） |
| 私有 Host 进程 | `apps/desktop-host/` | RunAsNode 子进程拉起共享 profile runner |
| Web 前端 | `apps/web/` | Vite 构建 `@deepseek-ai/dsh-web-frontend`，dist 被桌面壳以 `dsh-app://app/` 自定义协议加载 |
| 打包与更新 | `apps/desktop/electron-builder.config.mjs` + 根 `package:desktop*` 脚本 | 支持 mac arm64/x64、win x64（含 unsigned）、`electron-updater` |
| 独立运行时 | `scripts/primary-runtime/` | 桌面自带 Python/Node/pnpm 载荷，免系统依赖 |
| Web 形态入口 | `apps/cli`（`dsh web`，端口 3080） | 保留，与桌面端口 19387 互不干扰 |

因此本方案的核心工作是四件事：**品牌与身份收口、体验差异收口、验证闭环、发布链路打通**。

## 3. 总体架构

```
┌─ Electron main process (apps/desktop, main.ts) ──────────────┐
│  Single-instance lock → owns $DSH_HOME/profiles/desktop      │
│  BrowserWindow loads dsh-app://app/ (packaged apps/web dist) │
│  dsh-app://shell/ → local update/welcome assets (no Host)    │
│  IPC allowlist bridge (boot injection/ready/shutdown/picker/ │
│  update confirmation)                                        │
└──────────────┬──────────────────────────────────────────────┘
               │ RunAsNode subprocess (ELECTRON_RUN_AS_NODE=1)
┌─ Private Host (apps/desktop-host, port 19387) ───────────────┐
│  Shared profile runner + Web Host: authenticated HTTP API +  │
│  WebSocket. Desktop-only profile: apps/desktop deps come     │
│  from app.asar/dsh; only external plugins install through    │
│  the shared Plugin Manager + bundled pnpm                    │
└──────────────────────────────────────────────────────────────┘
```

关键原则（沿用既有决策，PR 中作为验收约束）：

1. **薄壳原则**：桌面壳不实现业务；共享 Web 行为 + 桌面适配器。
2. **单一版本原则**：Electron 壳与 `@deepseek-ai/dsh` 同版本发布，一个升级单元，杜绝壳/内核版本漂移。
3. **进程所有权原则**：桌面独占 `profiles/desktop`，CLI/Web 与桌面共享产品数据但不共享可执行包、插件激活与 lockfile，两进程不竞争同一 profile。
4. **传输复用原则**：加载打包 Web 静态资源（自定义协议），鉴权 API/WS 走同一 Host 实现。

## 4. 改造工作分解

### P0 — 品牌与身份收口（本 PR 主体新增工作）

品牌已切换为 TianmaCoder（见 `brand/`、`packages/client/ui-primitives` 的 TianmaLogo），但桌面壳内仍残留 "DeepSeek Harness" 身份，需收口：

1. `apps/desktop` 产品名、About 面板、应用菜单文案、welcome/更新对话框文案：DeepSeek Harness → TianmaCoder（en/zh 双语，过 `verify-client-ui-i18n` 门禁）。
2. 图标：`resources/icon.png/svg` 及平台变体替换为 `brand/assets/` 的信号波标导出物（Windows ICO 多尺寸、macOS ICNS 内缩圆角 1024px、安装器侧边 BMP 164×314），遵循 `apps/desktop/README.md` 的图标规范。
3. `electron-builder` 的 `productName`/`appId`/更新 feed 元数据与安装器文案同步品牌。
4. 更新通道与 `x-client-platform` 映射保留机制不变，仅改对外显示名。

### P1 — 体验差异收口

1. **窗口与标题栏**：Windows 40-DIP 原生标题栏配色取自应用调色板——确认取色源为 TianmaCoder 主题 token 而非旧品牌色。
2. **加载页**：共享加载页品牌化（logo/文案），等待 Host boot 注入后原地启动 client，不跳转新文档。
3. **首次运行**：welcome 窗流程核对（语言 zh_CN/en_US、更新说明），文案品牌化。
4. **深度链接/文件关联**：如产品需要（如 `tianmacoder://`），列为后续 PR，本期不做。

### P2 — 验证闭环（评审通过后执行）

1. `pnpm build:lib && pnpm build:web && pnpm dev:desktop` 开发态冒烟：窗口加载、登录、会话、插件页、目录选择、F12 DevTools。
2. `pnpm package:desktop:win:x64:unsigned` 本机出包 + `check:package`；安装/启动/卸载冒烟。
3. 更新链路本地验证：`pnpm --filter @deepseek-ai/dsh-desktop run test:updates:local`。
4. 既有测试面：`apps/desktop/tests`、`apps/desktop-host`、web 前端 vitest 全绿；i18n 门禁通过。
5. 双形态回归：`apps/cli` 的 `dsh web`（端口 3080）与桌面（19387）并行启动互不干扰，profile 互不污染。

### P3 — 发布链路（后续 PR）

签名（Windows 硬件 token 流程已在打包脚本中实现，需要证书）、macOS 公证、更新 feed 上线。本期仅产出 unsigned 包用于内测。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 品牌替换触碰大量 i18n 断言，门禁失败 | 逐包替换并跑 `verify-client-ui-i18n`；快照用 vitest -u 统一更新 |
| Windows 打包 PE 扫描/签名流程在 unsigned 下的行为差异 | 内测统一走 `package:desktop:win:x64:unsigned`，签名流程留到 P3 专项验证 |
| Web 与桌面共用前端，改动可能破坏 `dsh web` 形态 | 双形态并行回归纳入验收清单（P2.5） |
| `profiles/desktop` 内旧版本残留（原 DeepSeek 命名时期的 profile） | 启动时 runtime descriptor 校验已兜底不兼容；必要时在升级说明中提示重置 profile |

## 6. 验收标准

1. Windows x64 unsigned 安装包可安装、启动、完成一次完整对话，全程无需浏览器与系统 Node/Python。
2. 应用图标、名称、About、菜单、加载页均为 TianmaCoder 品牌；中英文随 shell locale 切换。
3. `apps/desktop`、`apps/desktop-host`、`apps/web` 测试全绿，i18n 门禁通过。
4. 桌面与 Web 形态功能一致：同一功能改动在 `dsh web` 下行为不变。
5. 本地更新链路冒烟通过（test:updates:local）。

## 7. 实施顺序与提交切分

1. `feat(desktop): rebrand shell identity to TianmaCoder`（P0.1–P0.3，含图标资产）
2. `feat(desktop): polish loading/welcome experience under new brand`（P1）
3. `chore(desktop): migration verification checklist and docs`（P2 结果记录 + 本文档定稿）
4. P3 签名/公证/发布另行 PR。
