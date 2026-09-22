# TianmaCoder 品牌规范 v1.0

> 归属：宜春天码信息集团 ｜ 定位：集团旗下软件工程前沿开发工具 · 官方 Harness · 外包领域最前沿、最标准化的规范能力。
>
> 本文件是 TianmaCoder 品牌的唯一权威来源（source of truth）。设计令牌见 [tokens/](tokens/)，标志资产见 [assets/](assets/)。
> 注意：仓库根目录另有 `BRAND_GUIDELINES.md`，那是上游 DeepSeek Harness 商标使用规范（约束社区如何提及 DeepSeek），与本文档互补、互不覆盖。

**English quick reference** — Primary color `#86E100` (graphics & dark surfaces only); body text on white uses `#4A8000` (WCAG AA). Headings: Manrope/Inter + PingFang SC/Noto Sans SC. Mono: JetBrains Mono. Voice: cutting-edge, standardized, delivery-first. Never place white text on `#86E100`.

## 1. 品牌速览

| 项 | 值 |
| --- | --- |
| 中文名 | 天码 |
| 英文名 | TianmaCoder |
| 母集团 | 宜春天码信息集团 |
| 定位语 | 软件工程前沿开发工具 · 官方 Harness |
| 能力主张 | 外包领域最前沿、最标准化的规范能力 |
| 主色 | 天码绿 `#86E100` |
| 语气三支柱 | 前沿锐度 · 标准范式 · 交付确定性 |

标志释义：**信号波标**——连续折线勾勒出双 "M"（天码 Tianma 的 M），如同一枚向前推进的代码脉冲；末端独立短笔画是"光标/信号闪断"，代表开发过程中每一次即时反馈。整体倾斜约 12°，传达前进感。

## 2. 色彩

### 2.1 品牌绿阶

| 名称 | Hex | 用途 | 白底对比度 |
| --- | --- | --- | --- |
| Green 50 | `#F7FFE8` | 最浅底纹 | — |
| Green 100 | `#F4FFDC` | 淡绿底、选中态底色 | — |
| Green 200 | `#E3FA9F` | 图表辅助 | — |
| Green 300 | `#CCF366` | 图表辅助 | — |
| Green 400 | `#ABEA2F` | 渐变端点、悬浮态 | — |
| **Green 500 ★** | **`#86E100`** | **标志、图形、按钮底色、深色面强调** | 1.64:1（禁作白底文字） |
| Green 600 | `#6FBB00` | 深色面上的 hover/按下态 | — |
| Green 700 | `#4A8000` | 白底正文级绿色文字、链接 | 4.80:1（AA） |
| Green 800 | `#3A6600` | 白底强强调文字、成功态 | 6.82:1（AAA） |
| Green 900 | `#2F5500` | 白底标题级绿色、AAA 文本 | 8.68:1（AAA） |
| Green 950 | `#1A3000` | 深色描边、代码高亮 | — |

### 2.2 墨色与中性（带绿灰调）

| 名称 | Hex | 用途 |
| --- | --- | --- |
| Ink 900 | `#0D1405` | 主文字、绿底上的文字（对白 18.76:1） |
| Ink 700 | `#333D28` | 次强调文字 |
| Ink 500 | `#5F6955` | 次要文字、说明（对白 5.77:1） |
| Ink 300 | `#C4CCB4` | 占位符、禁用态 |
| Ink 100 | `#E8EED9` | 分隔线、卡片描边 |

### 2.3 表面

| 名称 | Hex | 用途 |
| --- | --- | --- |
| Paper | `#FFFFFF` | 页面底 |
| Soft | `#FAFDF4` | 区块底 |
| Tint | `#F4FFDC` | 品牌氛围底 |
| Border | `#E4EFD2` | 边框 |
| Dark | `#101A04` | 深色页面底（`#86E100` 在其上 10.91:1） |
| Dark Elevated | `#16230A` | 深色卡片底 |

### 2.4 功能色（白底达 AA）

Success `#3A6600` ｜ Warning `#B45309` ｜ Danger `#B91C1C` ｜ Info `#1D4ED8`

### 2.5 硬性对比度规则（必须遵守）

1. `#86E100` 之上**禁止使用白色文字**（1.64:1），只能用墨色 `#0D1405`（12.78:1）。
2. 白底上的正文/链接级绿色**只能用 Green 700/800/900**。
3. `#86E100` 在白底上仅限：标志、插图、大色块、按钮底色、装饰图形；不得用于小于 24px 的白底图形的关键细节。
4. 深色面（Dark/Dark Elevated）上优先使用 `#86E100`，hover 用 Green 600。

### 2.6 终端 / CLI

优先真彩色 `\x1b[38;2;134;225;0m`；不支持时回退 xterm-256 色 **148**（`rgb(153,204,0)`），最后回退 ANSI 亮绿。

## 3. 标志

### 3.1 资产

| 文件 | 用途 |
| --- | --- |
| [tianmacoder-logo.svg](assets/tianmacoder-logo.svg) | 主标志（品牌绿，透明底） |
| [tianmacoder-logo-mono-black.svg](assets/tianmacoder-logo-mono-black.svg) | 单色-墨（打印、压印） |
| [tianmacoder-logo-mono-white.svg](assets/tianmacoder-logo-mono-white.svg) | 单色-白（深底、照片） |
| [tianmacoder-wordmark.svg](assets/tianmacoder-wordmark.svg) | 横排锁版（标 + 字，文字继承 `currentColor`） |
| [tianmacoder-favicon.svg](assets/tianmacoder-favicon.svg) | 站点图标（加粗笔画） |

### 3.2 使用规则

- **安全空间**：标志四周预留 ≥ 标志高度 25% 的空白。
- **最小尺寸**：图标 24px；横排锁版高 22px；印刷锁版高 ≥ 8mm。
- **允许的标志颜色**：仅 Green 500、Ink 900、纯白三色。
- **禁止**：拉伸/压缩变形、旋转、加投影/渐变/描边、改变笔画端点样式、在复杂背景上直接放置、用其他绿色替代 `#86E100`。
- 横排锁版的文字部分必须继承 `currentColor`（文档站内联渲染依赖此特性切换明暗主题），不得写死颜色。

## 4. 字体

### 4.1 字体栈

```css
--tc-font-heading: 'Manrope', 'Inter', 'Segoe UI', 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
--tc-font-body: 'Inter', 'Segoe UI', 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
--tc-font-mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
```

先加载开源字体（Manrope/Inter/JetBrains Mono），缺失时逐级回退到系统中文字体；代码与命令一律等宽字体。

### 4.2 字阶

| 层级 | 字重 | 字号/行高（桌面） | 移动端 |
| --- | --- | --- | --- |
| H1 | 700 | 40/48 | 32/40 |
| H2 | 700 | 32/40 | 28/36 |
| H3 | 600 | 24/32 | 22/30 |
| H4 | 600 | 20/28 | 18/26 |
| 正文 | 400 | 16/26 | 16/26 |
| 辅助 | 400 | 14/22 | 14/22 |
| 说明 | 400 | 12/18 | 12/18 |

标题与数字可使用 Green 900；正文绿色文字用 Green 700（见 2.5）。

## 5. 语气与文案

### 5.1 三支柱

1. **前沿锐度（Cutting-edge）**：用工程师的语言讲新东西，敢给结论、给基准、给数字；不堆形容词。
2. **标准范式（Standardized）**：每个主张可复现——给规范、给样例、给校验方式；这是我们外包规范能力的根基。
3. **交付确定性（Delivery-first）**：面向外包场景，承诺即交付；说清边界、验收标准与回滚路径。

### 5.2 语气对照

| 维度 | 我们是 | 我们不是 |
| --- | --- | --- |
| 表达 | 直接、量化、可验证 | 模糊、堆砌、不可证伪 |
| 立场 | 给判断和默认值 | 两边下注、和稀泥 |
| 态度 | 专业、克制、可依赖 | 营销腔、夸大、卖焦虑 |
| 术语 | 精准的工程术语 | 生造词、中英混杂堆砌 |

### 5.3 分场景示例

| 场景 | 语气 | 示例 |
| --- | --- | --- |
| 文档 | 冷静精确 | "该 API 处于预稳定期，字段变更需确认 `docs/session-format-status.md`。" |
| 营销 | 自信克制 | "把规范跑在流水线里：从需求到验收，全程可校验。" |
| 错误信息 | 有事实有出路 | "构建失败：`types/x.ts` 第 12 行类型不匹配。运行 `pnpm build` 查看完整输出。" |
| 成功反馈 | 简短具体 | "已通过 128 项门禁校验，耗时 42s。" |

### 5.4 禁用词

- 绝对化用语（"第一""最强""唯一"等）不得出现在对外宣传物中；引用集团定位语需经集团确认并核实事实依据（广告合规）。
- 不得贬低竞品，不得使用竞品商标进行对比营销。
- 不得使用"保证上线""百分百无缺陷"等无依据承诺。
- 涉及 DeepSeek/DeepSeek Harness 的表述，一律遵循仓库根目录 `BRAND_GUIDELINES.md`（"基于 DeepSeek Harness 构建"可用；不得暗示深度求索官方背书）。

## 6. 应用

- **产品前端（packages/client）**：已接入——`ui-primitives/TianmaLogo`（信号波标组件）、`BrandWordmark`（天码字标）、侧边栏与首屏 Hero 兜底标、欢迎语/账号平台/插件管理器等可见文案、浏览器标题（`brand.localBuild`）、以及 `ui-theme` 亮/暗两套 `--dsw-static-deepseek-*` 品牌阶（令牌名保持不变，值已映射为天码绿阶；亮色交互色 `rgb(74,128,0)` 达 AA，暗色品牌色即 LOGO 绿 `rgb(134,225,0)`）。
- **文档站（website/）**：favicon 与导航锁版已接入本品牌；令牌可映射到 VitePress 主题变量（`--vp-c-brand-1` 等映射属后续迭代）。
- **CLI**：启动横幅用真彩色品牌绿（见 2.6），ASCII 字标保持等宽对齐。
- **README/徽章**：shields.io 徽章色用 `86E100`（白字徽章除外——遵循 2.5，改用 logo/logo 文本 + 绿底墨字）。
- **演示与对外物料**：PPT 母版底色 Paper/Soft，标题 Ink 900，强调 Green 700；深色页用 Dark 底 + Green 500 强调。
- **图标风格**：线性图标，24px 网格，2px 圆头笔画（与标志一致），激活态 Green 700。

## 7. 资产管理与命名

- 目录：`brand/assets/`（矢量源文件）、`brand/tokens/`（机器可读令牌）。
- 命名：kebab-case，前缀 `tianmacoder-`；变体后缀 `-mono-black` / `-mono-white` / `-wordmark` / `-favicon`；位图导出加 `@2x`。
- 变更流程：改 `BRAND_GUIDELINES.md` → 同步 `tokens/design-tokens.json` 与 `tokens/design-tokens.css` → 在 `D:\Agent\MODIFICATION_LOG.md` 追加记录。
- 版权：本目录全部品牌资产版权归宜春天码信息集团，未经授权不得外部再分发。

## 8. 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 1.0 | 2026-09-22 | 首版：基于集团 LOGO 采样色 `#86E100` 建立色板、标志资产、字体、语气与应用规范 |
