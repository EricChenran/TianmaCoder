---
name: web-demo-video
display_name: "无头 Web 演示视频制作"
display_name_en: "Headless Web Demo Video"
description: >-
  把任意 Web 应用（官网、后台、H5、管理端）录制成带中文讲解字幕的演示视频
  （语音播报默认关闭，需要时开 narration）：
  用系统自带浏览器无头模式 + CDP 驱动真实点击交互，边操作边抓帧，再合成成片。
  与具体网站、具体前端框架无关——只认一份 plan.json（地址 + 登录配方 + 步骤）；
  环境自适应：浏览器/ffmpeg/中文字体逐项探测，缺失时按阶梯降级或给出各平台安装命令
  （语音引擎只在开启播报时才参与探测）。
  适用于：给客户出演示视频、给需求方看功能闭环、给测试留下可复核的操作证据、
  用真实点击暴露前端隐藏缺陷（本技能已借此发现 2 个静态检查查不出的产品缺陷）。
  触发词：演示视频、录屏、录制 demo、操作演示、讲解视频、demo video、screen recording、
  headless browser、CDP、无头浏览器、自动录屏、功能演示、产品演示。
description_zh: "无头浏览器驱动真实交互并录制带讲解字幕的演示视频（配音可选），与站点无关、跨平台自适应（浏览器/ffmpeg/字体缺失自动降级或给修复命令）。"
description_en: "Record subtitled demo videos of any web app by driving real interactions in a headless browser via CDP; narration is opt-in, site-agnostic and adapts across platforms with graceful degradation."
category: media
version: 2.0.0
runtime: generic
tags:
  - "演示视频"
  - "录屏"
  - "无头浏览器"
  - "CDP"
  - "字幕"
  - "配音"
agent_created: true
---

# 无头 Web 演示视频制作

用系统自带浏览器（Chromium 系）的无头模式 + CDP 驱动**真实点击交互**，边操作边抓帧，
最后拼帧、烧录讲解字幕，产出成片。**语音播报默认关闭**（只出字幕，节奏由每步 `minSec` 决定）；
需要配音时在 plan 顶层写 `"narration": true`，引擎会自动合成并让每步时长跟着配音走。

**与站点无关**：本技能不认识任何具体网站，只消化一份 `plan.json`。因此同一套流程可用于
官网、后台、管理端、H5 —— 换一个 plan 就换一个演示。

脚本目录：`scripts/`（零依赖，只用 Node 标准库）
参考资料：`references/`（环境矩阵 / 踩坑清单 / 步骤 DSL / 示例 plan）

---

## 一、什么时候用 / 不用

| 用 | 不用 |
|---|---|
| 给客户或需求方演示功能闭环 | 需要真人出镜讲解（这里只有字幕 + 可选 TTS 配音） |
| 留一份可复核的操作证据（点过哪些按钮、导出过什么文件） | 需要像素级视觉回归比对 |
| 想用「真点一遍」暴露静态检查发现不了的缺陷 | 目标应用需要人机验证码/短信登录等人工环节 |
| 需要批量产出多语言/多版本演示 | 目标含真实支付、删除等破坏性操作（除非只读模式） |

> 经验：**「打开页面 + 讲解」不是演示**。每个步骤都必须有真实操作（点击/筛选/填表/勾选/导出），
> 讲解只留一句话。这是本技能最容易做错的地方。

---

## 二、第 0 步：先体检，别急着录

```bash
node scripts/webdemo.mjs doctor          # 人类可读
node scripts/webdemo.mjs doctor --json   # 机器可读（CI 用）
```

体检项与**降级阶梯**（关键：缺失项不等于失败，按阶梯自动降级或给出修复命令）：

| 能力 | 必需 | 缺失时的行为 | 修复命令（按平台） |
|---|---|---|---|
| Node ≥ 22（内置 WebSocket） | ✅ | 直接失败并提示（低于 21 无内置 WebSocket） | 升级 Node 到 22 LTS；或在 `scripts/` 下 `npm i ws` |
| Chromium 系浏览器 | ✅ | 直接失败 | Win：`winget install Google.Chrome`；mac：`brew install --cask google-chrome`；Linux：`apt-get install -y chromium` |
| ffmpeg + ffprobe | ✅ | 直接失败 | Win：`winget install Gyan.FFmpeg`；mac：`brew install ffmpeg`；Linux：`apt-get install -y ffmpeg` |
| 临时目录可写 | ✅ | 直接失败 | 设置 `TMPDIR`/`TEMP` 到可写目录 |
| 中文语音（TTS） | ⭕ | **默认不参与**（播报关闭）；开启 `narration` 后缺失则**降级为「仅字幕」**，成片仍可用 | Win：设置→语言→语音 添加中文语音；mac：自带 `say`；Linux：`apt-get install -y espeak-ng` |
| 中文字体 | ⭕ | **警告**，字幕可能显示为方块 | Linux：`apt-get install -y fonts-noto-cjk`；Windows/macOS 通常自带 |

引擎自动探测顺序：
- 浏览器：显式配置 → `DSH_WEBDEMO_BROWSER` → Edge → Chrome → Chromium → Brave → PATH
- ffmpeg：显式配置 → `DSH_FFMPEG_PATH`/`DSH_FFPROBE_PATH` → PATH → 各平台常见安装位置（winget/brew/apt/snap/scoop）
- TTS（仅 `narration: true` 时使用）：Windows SAPI → macOS `say` → Linux `espeak-ng`/`espeak`/`pico2wave` → 无
- 字体：各平台已知路径 → `fc-list :lang=zh`（Linux/mac）

**跨环境加固（已内建，不用你管）**：调试端口用 `0` 由系统分配（多任务/CI 不撞端口）；
浏览器 stderr 落文件而非管道（受限沙箱下管道 stdio 会 EPERM）；
Linux 下 root/CI 自动加 `--no-sandbox --disable-dev-shm-usage`；`--headless=new` 失败自动退化 `--headless`；
`--no-proxy-server` + 旁路 loopback（避免系统代理拦截 127.0.0.1）。

环境矩阵与更多平台细节见 `references/environment-matrix.md`。

---

## 三、标准流程

```
① doctor   环境体检                     ← 必需项不过就别往下走
② probe    侦察：采集真实可点元素        ← 一次跑完目标页面，产出可点清单
③ plan     依据侦察结果写 plan.json      ← 步骤 = 一句话讲解 + 一串声明式动作
④ record --dry-run   干跑校验            ← 约 40 秒，逐步打印每个动作结果
⑤ tts      合成配音（默认跳过）          ← 仅 narration:true 时需要；产出 durations.json（决定时间轴）
⑥ record   正式录制（抓帧）
⑦ build    成片（拼帧/烧字幕/铺配音/合流）
⑧ 自查     抽帧读图 + 导出物核对（+ 音轨电平，仅开启播报时）
```

一条命令跑完 ⑤⑥⑦：`node scripts/webdemo.mjs demo --plan plan.json`
（`demo` = tts + record + build；未开启播报时 tts 自动跳过，因此默认就是一条命令出无声版。）

**没开播报时，节奏完全由 `minSec` 决定**，没有配音来兜底，所以：
`minSec` 要按「字幕读得完」来给，经验值 ≈ 中文字数 ÷ 6（下限 3.5s）；
比这更短会出现「字幕一闪而过」——这是无声版最常见的质量问题。

### 为什么必须先侦察（②）

**不要猜按钮文案**。`probe` 会登录后逐页回吐：按钮、导航、下拉、分段控件、表格行数、
首行单元格内容、当前打开的弹窗标题。照着真实文案写 plan，一次到位。

```bash
node scripts/webdemo.mjs probe --plan plan.json --workdir ./demo-work
```

### 干跑（④）是第一等公民

```bash
node scripts/webdemo.mjs record --plan plan.json --dry-run
```

走**完全相同的步骤**，但不抓帧、步长固定 500ms，逐步打印每个动作的返回值。
迭代成本从「重录 2 分钟」降到「干跑 40 秒」。动作失败时会回吐可用清单，例如：

```
! [1] {"type":"click","text":"驳回"} → NO-TEXT:驳回 AVAIL:通过|驳回|查看资料
```

---

## 四、plan.json 最小结构

```jsonc
{
  "name": "my-app",
  "url": "http://127.0.0.1:5173/",
  "viewport": { "width": 1600, "height": 900 },
  "capture": { "fps": 5, "jpegQuality": 82, "screenshotTimeoutMs": 4000 },
  "narration": false,                          // 语音播报开关，默认 false（只出字幕）；true 才做 TTS
  "login": {                                   // 可选；站点无关，全靠配置
    "fill": [
      { "by": "placeholder", "match": "账号", "value": "admin" },
      { "by": "placeholder", "match": "密码", "value": "…" }
    ],
    "submit": { "by": "text", "text": "登录" },
    "waitPath": { "startsWith": "/dashboard" }
  },
  "probeRoutes": ["订单", "设置"],              // probe 要逐个进入的导航
  "steps": [
    {
      "caption": "勾选两条订单，批量导出。",     // 字幕文案；开启 narration 时同时作为配音文案
      "minSec": 3,                              // 人工下限（开启播报且配音更长时以配音为准）
      "actions": [
        { "type": "nav", "text": "订单" },
        { "type": "checkRow", "index": 0 },
        { "type": "checkRow", "index": 1 },
        { "type": "click", "text": "导出选中" },
        { "type": "assert", "expr": "rows() > 0" }
      ]
    }
  ]
}
```

完整动作清单（18 种）与定位方式见 `references/step-dsl.md`；
**外观三件套**（片头标题卡 `cover`／字幕容器 `captions`／水印 `watermark`，含版权署名行）见 `references/step-dsl.md` §八；
两份可运行示例：`references/plan-example.json`（2 步最小）、
`references/plan-example-13steps.json`（13 步完整交互演示，覆盖筛选/下拉/表单保存/二次确认/
填备注驳回/抽屉/勾选批量导出，每步都带断言）。

> 实测：那份 13 步示例在通用引擎上一把跑通——13/13 动作成功、最大抓帧空档 0.27s、
> 静止补足 0 帧、成片 64.12s vs 时间轴 64.08s（偏差 0.04s）、音轨 mean −25.3dB
> （测这一版时显式开了 `"narration": true`；默认的无声版没有音轨指标）。

**UI 框架无关**：`uiKit` 默认 `auto`，取 Element Plus / Ant Design / 原生 HTML 三套选择器的并集，
因此同一份 plan 可跑在这三类界面上。可显式指定 `element` / `antd` / `basic` 以提升定位精度。

---

## 五、验收门禁（不达标不要交付）

`record-report.json` / `build-report.json` 里都有对应字段，逐项核对：

| 门禁 | 阈值 | 字段 |
|---|---|---|
| 交互成功率 | **100%**（任何 `NO-*` 都视为失败） | `record-report.json#failures` 为空 |
| 抓帧最大空档 | < 1.0s | `capture.maxGapSec` |
| 静止补足帧占比 | < 5% | `timeline.heldRatio` |
| 成片时长 vs 时间轴 | 偏差 < 1.0s | `build-report.json#durationSec` vs `timelineDurationSec` |
| 音轨有效 | `mean > −40dB` 且 `max < −0.1dB` | `build-report.json#audio` —— **仅当 `narration: true` 时适用**；无声版应确认 `narration:false` 且 `hasAudio:false` |
| 导出类操作 | 必须真有落盘文件，且与画面提示条数一致 | `record-report.json#downloads` |
| 字幕可读 | 中文正常渲染（无方块）+ 全不透明描边 | 抽关键帧读图确认 |

**抽帧自检**（必做，肉眼确认，别只信 JSON）：

```bash
ffmpeg -ss 33 -i out.mp4 -frames:v 1 -q:v 3 check.jpg            # 挑交互瞬间抽帧
ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null -        # 音轨电平（仅开启播报时）
```

---

## 六、必须知道的坑（详见 references/pitfalls.md）

这几条若不遵守，必然出错，不是「可能」：

1. **可见性判断不能用 `offsetParent`** —— `position: fixed` 元素的 `offsetParent` 恒为 `null`，
   弹窗、抽屉、Toast 会被全部误判为不可见。本技能统一用「盒模型尺寸 + 计算样式」。
2. **输入框要用原生 value setter + 派发 `input`/`change`** —— 直接赋 `value` 不会触发
   Vue/React 的受控更新，登录会静默失败。
3. **单次抓帧必须给硬超时** —— 曾出现一次 `captureScreenshot` 挂起 30 秒，阻塞抓帧循环期间
   演示继续走完，整段漏录、成片缩短。本技能默认 4 秒硬超时。
4. **时间轴不能按帧间隔拼** —— 帧间隔会把空档压缩掉。必须按演示真实时长 @25fps 均匀重采样，
   取「不晚于该时刻的最近一帧」。
5. **合流必须 `apad` 补静音** —— 音轨通常比画面短，直接 `-shortest` 会把视频截短（实测恒定短约 0.9s）。
6. **不做整页导航** —— 很多 SPA 的登录态只存内存，`location.href` 换页即登出。只用 `nav`/`click`。
7. **ASS 字幕的 `&HAABBGGRR` 里 AA 是 alpha** —— `0xC0` 是 75% 透明（描边几乎看不见），要用 `0x00`。
8. **不要把中文路径/文件名交给原生 exe** —— 先输出 ASCII 名，再用 Node/脚本改名。
9. **`Start-Process` 唤不起 AppX 默认应用** —— 打开产物统一用系统 shell（`explorer.exe`/`open`/`xdg-open`）。
10. **编辑文件可能搞崩 dev server** —— 某些编辑器的原子写入会在源码目录留下临时目录，
    被 Vite 的文件监听撞上导致 `EBUSY` 退出。录制前先确认站点可达。

---

## 七、产物与目录

```
<workDir>/
  inventory.json        # probe 产出：各页面可点元素清单
  durations.json        # tts 产出：每句配音时长（仅开启播报时有）
  captions.json         # record 产出：每句字幕的起止秒数（时间轴唯一真相）
  subs.srt              # 字幕文件（可单独外挂使用）
  subs.with-cover.srt   # 有片头时的外挂字幕（已对齐最终成片，外挂用这份）
  captions.ass          # 自绘排版字幕（设了 captions/cover 时才有）
  cover.ass             # 片头标题卡排版（设了 cover 时才有）
  frames.txt            # ffmpeg concat 清单（均匀 25fps）
  record-report.json    # 录制质量报告
  build-report.json     # 成片报告（含 narration / 音轨电平 / 封面文案）
  frames/               # 抓帧（默认保留，便于重合成；不需要可删）
  audio/nNN.wav         # 逐句配音（仅开启播报时有）
  downloads/            # 页面上真实导出/下载的文件
  <name>.mp4            # 成片
```

`--workdir` 指定工作目录；不指定则用 `./<name>-work`。
用 `node scripts/webdemo.mjs open <file>` 打开产物。
