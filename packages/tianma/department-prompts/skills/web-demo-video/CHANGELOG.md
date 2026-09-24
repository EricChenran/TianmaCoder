# 变更记录 · web-demo-video

## 2.0.0

行为默认值有**破坏性变更**，并修掉 5 个实测缺陷。升级后请留意第一节。

### 破坏性变更

- **语音播报改为默认关闭**（`narration` 默认 `false`）。成片默认只烧字幕，每步时长由 `minSec` 决定。
  之前依赖「自动出配音」的 plan，升级后不会再有音轨——需要配音请显式写 `"narration": true`。
- 连带影响：不开播报时 `minSec` 是**唯一**的节奏来源，请按「字幕读得完」给值（≈ 中文字数 ÷ 6，下限 3.5s）；
  plan 载入时会对过短的 `minSec` 给出告警与建议值（仅在未开启播报时；开着播报 `minSec` 只是下限，不会误报）。

### 修复（均为实测撞出，不是推演）

| # | 症状 | 根因 | 处理 |
|---|---|---|---|
| 1 | `rows()` 把隐藏行算成数据行（用户列表 6 行被数成 18 行、订单总览 10 行被数成 22 行），据此写的断言必错 | `SEL.tableRow` 里的 `table tbody tr` 未过滤可见性，命中 el-date-picker 关闭后仍留在 DOM 里的日历表 | 新增 `dataRows()`（可见 且 有 `td`/`role=row`），`rows()`／`rowAction`／`rowActionAny`／`checkRow`／`inventory().firstRow` **共用同一数据源**，行索引与行计数不再打架 |
| 2 | `downloadCount()` 恒为 0，写 `downloadCount() >= 1` 必然 `E_ASSERT_FAILED` | 该探针读 `window.__demoDownloads`，但没有任何代码写入 | 录制期新增下载目录轮询写入该变量（只在文件列表变化时求值，避免与抓帧抢 CDP；排除 `.crdownload`/`.tmp`）；报告里的 `downloads` 复用同一读取 |
| 3 | 动作类型写错、`assert` 语法非法、缺必填字段，都要录到中途才发现（曾写了不存在的 `"spacer"` 白跑一轮） | plan 载入期无校验 | 新增载入期校验：动作白名单 + 每类必填字段 + `assert` 表达式预检 + `minSec` 过短告警；错误与告警一次性全部回吐 |
| 4 | 「固定 `wait` + 断言 Toast」偶发失败（Toast 出现时刻取决于接口延迟） | 断言只求值一次 | `assert` 支持可选 `timeoutMs`，在超时内每 200ms 重试；不给则保持单次求值（向后兼容） |
| 5a | 浏览器启动失败：报「未产出 DevToolsActivePort」，而 `<workDir>/browser-profile` **是空的（0 条目）**，日志只有 extension sync 噪声 | `--workdir` 传相对路径时被直接拼进 `--user-data-dir`，浏览器把它解析到别处，等于没生效 | `workDirOf()` 统一 `resolve()` 成绝对路径；教训：凡交给原生 exe 的路径都绝对化 |
| 5b | 上一次运行结束后，下一次运行**必然**启动失败 | Windows 上 Edge/Chrome 是「启动器 + 真正的浏览器进程」两段式，只 `proc.kill()` 启动器会留下占着 profile 锁的孤儿进程 | Windows 用 `taskkill /PID <pid> /T /F` 杀整棵树 |
| 5c | 三次重试被同一个残留锁一起带死 | 三次重试共用同一 profile 目录 | 每轮换独立 profile 目录（`browser-profile-r1`/`-r2`）；启动器「退出」不再立即判死，退出后另给 5s 宽限期等端口文件 |

### 其他

- `demo` 现在真的是 `tts + record + build`（此前文档写「一条命令跑完 ⑤⑥⑦」，但 `demo` 并不跑 tts，开着播报也只会出无声视频）。未开启播报时自动跳过 tts。
- `build-report.json` 新增 `narration` 字段；`cover` 补齐 `attribution`（此前报告看不出封面署了什么名）。
- 文档补齐**外观三件套**（`cover` 片头卡 / `captions` 字幕容器 / `watermark` 水印）：代码一直支持，但此前文档一字未提，只能靠读 `media.mjs` 发现。见 `references/step-dsl.md` §八。
- 新增踩坑条目：P22b（无声版 `minSec` 给太短）、P24b（路径绝对化）、P24c（杀浏览器进程树）；P16/P17/P21/P22 按新行为改写。

## 1.0.0

首个版本：无头浏览器 + CDP 驱动真实点击交互，边操作边抓帧，拼帧、烧字幕、可选 TTS 配音出成片；
带 `doctor` 环境体检、`probe` 元素侦察、`--dry-run` 干跑校验与录制/成片质量报告。
