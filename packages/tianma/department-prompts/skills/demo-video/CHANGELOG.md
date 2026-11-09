# 变更记录 · demo-video

## 3.0.0

两套引擎合并为一个技能 `demo-video`，随技术部模式发布；换项目只换各自那份输入。

### 合并

- 原 `web-demo-video` 2.0.0（无头 Chromium + CDP，横屏 Web）与原用户级
  `miniprogram-demo-video` 1.0.0（微信开发者工具 + miniprogram-automator，竖屏小程序）
  合成一个技能。`SKILL.md` 改为「先按录制对象分流」，两半各自保留原有脚本与参考文档，
  互不依赖；原先两侧重复的触发词（演示视频、操作演示、功能演示）只保留一份。
- 目录改为 `web/`（`scripts/webdemo.mjs` + `scripts/core/*.mjs`、`references/*`）与
  `miniprogram/`（`scripts/{doctor.mjs,record.cjs,tts.ps1,compose.py}`、`references/*`）。
  文档里的命令统一相对技能目录书写。

### 修复

- **原 `skills/web-demo-video/scripts/lib/` 命中了仓库 `.gitignore` 的 `lib/` 规则，5 个引擎模块
  从未入库**——干净克隆后 `assertPackagedSkill` 会报缺文件，技术部模式启动即失败。目录改名为
  `scripts/core/`，`webdemo.mjs` 的 import 同步改写。教训：技能资产目录名不要复用构建产物的忽略规则。
- 小程序侧示例配置去掉了本机绝对路径与源项目品牌，改为占位符。

## 2.0.0 — Web 引擎

行为默认值有**破坏性变更**，并修掉 5 个实测缺陷。

### 破坏性变更

- **语音播报改为默认关闭**（`narration` 默认 `false`）。成片默认只烧字幕，每步时长由 `minSec` 决定。
  之前依赖「自动出配音」的 plan，升级后不会再有音轨——需要配音请显式写 `"narration": true`。
- 连带影响：不开播报时 `minSec` 是**唯一**的节奏来源，请按「字幕读得完」给值（≈ 中文字数 ÷ 6，
  下限 3.5s）；plan 载入时会对过短的 `minSec` 给出告警与建议值。

### 修复（均为实测撞出，不是推演）

| # | 症状 | 根因 | 处理 |
|---|---|---|---|
| 1 | `rows()` 把隐藏行算成数据行（用户列表 6 行被数成 18 行），据此写的断言必错 | `SEL.tableRow` 里的 `table tbody tr` 未过滤可见性，命中 el-date-picker 关闭后仍留在 DOM 里的日历表 | 新增 `dataRows()`（可见且有 `td`/`role=row`），`rows()`／`rowAction`／`checkRow`／`inventory().firstRow` 共用同一数据源 |
| 2 | `downloadCount()` 恒为 0，写 `downloadCount() >= 1` 必然 `E_ASSERT_FAILED` | 该探针读 `window.__demoDownloads`，但没有任何代码写入 | 录制期新增下载目录轮询写入该变量（只在文件列表变化时求值，避免与抓帧抢 CDP；排除 `.crdownload`/`.tmp`） |
| 3 | 动作类型写错、`assert` 语法非法、缺必填字段，都要录到中途才发现 | plan 载入期无校验 | 新增载入期校验：动作白名单 + 每类必填字段 + `assert` 表达式预检 + `minSec` 过短告警，错误一次性全部回吐 |
| 4 | 「固定 `wait` + 断言 Toast」偶发失败（Toast 出现时刻取决于接口延迟） | 断言只求值一次 | `assert` 支持可选 `timeoutMs`，超时内每 200ms 重试 |
| 5a | 浏览器启动失败报「未产出 DevToolsActivePort」，而 `<workDir>/browser-profile` 是空的 | `--workdir` 传相对路径时被直接拼进 `--user-data-dir` | `workDirOf()` 统一 `resolve()` 成绝对路径；凡交给原生 exe 的路径都绝对化 |
| 5b | 上一次运行结束后，下一次运行必然启动失败 | Windows 上 Edge/Chrome 是「启动器 + 真正的浏览器进程」两段式，只杀启动器会留下占着 profile 锁的孤儿进程 | Windows 用 `taskkill /PID <pid> /T /F` 杀整棵树 |
| 5c | 三次重试被同一个残留锁一起带死 | 三次重试共用同一 profile 目录 | 每轮换独立 profile 目录；启动器退出后另给 5s 宽限期等端口文件 |

### 其他

- `demo` 现在真的是 `tts + record + build`（此前文档写「一条命令跑完 ⑤⑥⑦」，但 `demo` 并不跑 tts）。
- `build-report.json` 新增 `narration` 字段；`cover` 补齐 `attribution`。
- 文档补齐外观三件套（`cover` 片头卡 / `captions` 字幕容器 / `watermark` 水印），见 `web/references/step-dsl.md` §八。
- 新增踩坑条目 P22b、P24b、P24c；P16/P17/P21/P22 按新行为改写。

## 1.0.0 — 小程序引擎

来自商城小程序演示视频（2 分 01 秒、11 场景）的完整实操复盘。

- `miniprogram/scripts/doctor.mjs`：开发者工具 / 自动化端口 / automator / ffmpeg（含 ddagrab 能力）/
  Python 图像库 / 中文字体 / 目录，一次体检。
- `miniprogram/scripts/record.cjs`：ddagrab 抓屏 + miniprogram-automator 驱动，按「旁白时长 + 2 秒」
  定场景长度并写 `marks.json`；支持 `--dry` 干跑。
- `miniprogram/scripts/tts.ps1`：SAPI 中文旁白，默认 2 倍速，用 WAV 头 byteRate 算真实时长。
- `miniprogram/scripts/compose.py`：手机框 + 章节高亮 + 字幕 + 进度条 + 片头片尾 + 旁白；
  配置驱动文案与配色；`--preview t` 秒出单帧。
- `miniprogram/references/pipeline.md`：时间轴数学（同步校正、seek 到首场景、四者共用相对时间）。
- `miniprogram/references/pitfalls.md`：gdigrab 黑屏、组件点击不冒泡、input 异常、旁白重叠等 20 余条实测坑。
