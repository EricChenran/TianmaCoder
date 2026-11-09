---
name: demo-video
display_name: "演示视频（小程序 + Web 后台）"
display_name_en: "Demo Video (Mini Program and Web App)"
description: >-
  把微信小程序和 Web 应用（后台、官网、H5）录成演示视频：先按录制对象分流——小程序侧用
  miniprogram-automator 驱动开发者工具里的真实页面、ffmpeg 抓屏、Python 合成手机框与章节高亮、
  逐句字幕、中文旁白；Web 侧用无头 Chromium + CDP 驱动真实点击、逐帧抓屏、ffmpeg 出片，
  字幕必出、旁白可选。两套引擎各自只认一份输入：小程序侧 config + scenes + actions 三件套，
  Web 侧单个 plan.json。适用于客户交付演示、版本验收留存、运营讲解素材，以及用真实点击
  暴露静态检查发现不了的前端缺陷。触发词：演示视频、录屏、操作演示、功能演示、demo 视频、
  小程序录屏、后台演示、miniprogram automator、无头浏览器、CDP。
description_zh: "小程序（开发者工具 + automator）与 Web 后台（无头 Chromium + CDP）两条引擎合成演示视频，按录制对象分流。"
description_en: "Record demo videos for WeChat mini programs (DevTools + automator) and web apps (headless Chromium + CDP), picked by capture target."
category: media
version: 3.0.1
runtime: generic
tags:
  - "演示视频"
  - "录屏"
  - "小程序"
  - "微信开发者工具"
  - "无头浏览器"
  - "CDP"
  - "字幕"
  - "配音"
agent_created: true
---

# 演示视频（小程序 + Web 后台）

把「一堆页面截图」变成「一段能发客户的视频」：真实页面、真实点击、真实接口数据。本技能装了
**两套引擎**，先按录制对象分流，再照那一半做；两半的脚本、参考文档、坑清单互不依赖。

| 录制对象 | 走哪一半 | 输入 | 画面来源 |
|---|---|---|---|
| 微信小程序（竖屏） | `miniprogram/` | `config.json` + `scenes.json` + `actions.cjs` | 微信开发者工具模拟器，ffmpeg `ddagrab` 抓整屏 |
| 管理后台 / 官网 / H5（横屏为主） | `web/` | 单个 `plan.json` | 无头 Chromium 页面内逐帧截图 |

命令里的 `<技能>` 指加载本技能时给出的资源基准目录（本技能被发布到磁盘上的位置），
「相对技能目录」指相对同一个 `<技能>`。

---

## 一、什么时候用 / 不用

| 用 | 不用 |
|---|---|
| 给客户或老板演示功能闭环 | 需要真人出镜讲解（这里只有字幕与可选配音） |
| 版本验收留证据（谁点了什么、页面长什么样） | 需要像素级视觉回归比对 |
| 给运营、销售做功能讲解素材 | 目标含真实支付、真实删除（除非只读演示） |
| 用「真点一遍」暴露静态检查发现不了的缺陷 | 需要真机视频（小程序侧录的是开发者工具模拟器） |

> 经验：**「翻页 + 截图」不是演示**。每个场景或步骤至少一次真实交互（切规格、加购、筛选、
> 填表、导出、展开明细），讲解只留一句话。这是最容易做错的地方。

### 分流判断

1. 目标是含 `app.json` 的小程序工程、要在微信开发者工具里跑 → 走 `miniprogram/`。
2. 目标是浏览器打开的 http(s) 页面（后台、官网、H5）→ 走 `web/`。
3. 两边都要 → 出两条视频，不要混剪：画幅、时基、字体都不同。

---

## 二、小程序侧（竖屏，手机框 + 章节 + 字幕 + 旁白）

四步流水线：

```
① doctor   体检：开发者工具 / 自动化端口 / ffmpeg / node 模块 / 中文字体
② 写输入   config.json + scenes.json + actions.cjs（照抄 miniprogram/references/ 的示例改）
③ record   录制：跑场景并写 marks.json（唯一时间轴）
④ compose  合成：mp4 + srt + 封面 + 场景脚本 JSON
```

```bash
node <技能>/miniprogram/scripts/doctor.mjs --config demo/config.json
node <技能>/miniprogram/scripts/record.cjs --config demo/config.json --actions demo/actions.cjs --dry
powershell -File <技能>/miniprogram/scripts/tts.ps1 -Scenes demo/scenes.json -Audio demo/audio
node <技能>/miniprogram/scripts/record.cjs --config demo/config.json --actions demo/actions.cjs
python <技能>/miniprogram/scripts/compose.py --config demo/config.json --preview 30
python <技能>/miniprogram/scripts/compose.py --config demo/config.json
```

`compose.py` 需要 Pillow + numpy；系统 Python 没装这两个库时，用应用自带的解释器。
动作先用 `--dry` 干跑校验（约 30 秒），过了再正式录——**不要重录**是提速的关键。

### 三份输入

- `config.json`：`project`（小程序源码目录）、`devtools`（开发者工具目录）、`autoPort`、
  `outDir`、`outName`、`workDir`，以及品牌文案与配色、封面与片尾。示例见
  `miniprogram/references/example.config.json`。
- `scenes.json`：`fps` + `scenes[]`，每项 `id`、`chapter`（右侧章节条 2–5 字）、`caption`
  （字幕兼旁白，25–45 字）、`minSec`。`id` 必须与 `actions.cjs` 的键一一对应；实际时长 =
  `max(minSec, 旁白时长 + 2.0)`，保证旁白念完才切下一场。
- `actions.cjs`：`scenes` 映射场景 id 到一个 `async` 函数，`record.cjs` 传 `{ mp, tap,
  scroll, waitPage, sleep, log, config, workDir }`。

### 必须知道的机制（照着做，别改）

1. **抓屏用 ffmpeg `ddagrab`（DXGI），不要 `gdigrab`。** 开发者工具是 Electron + GPU 合成，
   `gdigrab` 抓到整帧全黑。参数：`ddagrab=0:framerate=25,hwdownload,format=bgra`。
2. **不要用 `mp.screenshot()` 逐帧抓。** 单帧约 760ms，25fps 不可能；它只适合单张截图校验。
3. **时间轴只认 `marks.json`。** 按墙上时钟记场景起止，抓屏启动有 0.3–0.6 秒误差，靠
   「首页 → 登录页」那次整屏跳变自动校正（`compose.py` 的 `sync_offset()`），残差 ±0.05 秒。
4. **合成必须从第一个场景 seek 进去。** 录屏含前置准备段，要从 `marks.scenes[0].start`
   开始解码，否则章节与字幕整体提前十几秒。
5. **旁白时长用 WAV 头实测，不要按文件体积估。** 44.1k/16bit 单声道是 88200 字节/秒；
   按 176400 算会得到一半，旁白互相重叠。
6. **TTS 语速用 `Rate = 2`。** SAPI 默认 0 太慢。
7. 章节高亮、字幕、旁白、进度条共用一套相对时间（相对第一个场景），不要各自换算。

时间轴数学见 `miniprogram/references/pipeline.md`。

### 常见坑（节选，全文见 `miniprogram/references/pitfalls.md`）

| 症状 | 原因 | 做法 |
|---|---|---|
| 录出来全黑 | `gdigrab` 抓 Electron 窗口 | 换 `ddagrab` |
| 章节比画面早十几秒 | 没 seek 到首场景 | `-ss <scenes[0].start>` 再解码 |
| 旁白叠在一起 | 时长按双声道估 | 用 `wave` 读帧数算秒 |
| 点商品卡没反应 | 卡片是自定义组件，宿主节点不冒泡 | 直接 `mp.navigateTo(...)` |
| 输入框塞不进字 | automator `input()` 抛 `stopPropagation` | `page.callMethod('onInput', …)` |
| 画面里是 IDE 而不是小程序 | 开发者工具没置前 | 录制前最大化 + 置前 |
| 画面有鼠标指针 | 桌面抓屏带光标 | 录制期间别动鼠标 |
| 旁白比画面短很多 | `minSec` 写死 | 用 `durations.json + 2.0` 兜底 |

其它：录制前确认后端已起（空数据录出来是白板）；开发者工具必须开自动化端口
（`cli.bat auto --project <dir> --auto-port <port>`，端口起来后 `ws://127.0.0.1:<port>`
才连得上）；`miniprogram-automator` 不随包发布，先在 `workDir` 里 `npm i miniprogram-automator`，
或用 `config.json` 的 `automatorModule` 指向它的入口；不要在录制中途跑别的 GUI 操作。

### 产物

```
<workDir>/  marks.json、audio/<nn>-<id>.wav、audio/durations.json、capture/*.mkv
<outDir>/   <outName>.mp4、<outName>-字幕.srt、<outName>-封面.jpg、<outName>-演示脚本.json
```

---

## 三、Web 侧（横屏，字幕必出、旁白可选）

八步流程，其中 ⑤⑥⑦ 合并为一条 `demo` 命令：

```
① doctor 体检   ② probe 侦察可点元素   ③ 写 plan.json   ④ record --dry-run 干跑
⑤ tts（仅 narration:true）  ⑥ record 录制抓帧  ⑦ build 成片  ⑧ 抽帧自查
```

```bash
node <技能>/web/scripts/webdemo.mjs doctor
node <技能>/web/scripts/webdemo.mjs probe --plan plan.json --workdir ./demo-work
node <技能>/web/scripts/webdemo.mjs record --plan plan.json --dry-run
node <技能>/web/scripts/webdemo.mjs demo --plan plan.json
```

`--dry-run` 走完全相同的步骤但不抓帧，逐步打印每个动作的返回值；动作失败会回吐可用文案，
例如 `NO-TEXT:驳回 AVAIL:通过|驳回|查看资料`。**不要猜按钮文案**，先 `probe` 拿真实清单。

### plan.json 最小结构

```jsonc
{
  "name": "my-app",
  "url": "http://127.0.0.1:5173/",
  "viewport": { "width": 1600, "height": 900 },
  "capture": { "fps": 5, "jpegQuality": 82, "screenshotTimeoutMs": 4000 },
  "narration": false,                       // 语音播报默认关，只出字幕
  "login": {                                // 可选，站点无关，全靠配置
    "fill": [{ "by": "placeholder", "match": "账号", "value": "admin" }],
    "submit": { "by": "text", "text": "登录" },
    "waitPath": { "startsWith": "/dashboard" }
  },
  "probeRoutes": ["订单", "设置"],
  "steps": [
    {
      "caption": "勾选两条订单，批量导出。",   // 字幕；开 narration 时兼配音文案
      "minSec": 3,                            // 字幕读得完的下限
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

18 种动作与定位方式见 `web/references/step-dsl.md`；两份可运行示例见
`web/references/plan-example.json` 与 `plan-example-13steps.json`。`uiKit` 默认 `auto`，
取 Element Plus / Ant Design / 原生 HTML 三套选择器的并集。不开播报时节奏完全由 `minSec`
决定（经验值 ≈ 中文字数 ÷ 6，下限 3.5s），给短了字幕会一闪而过。

### 必须知道的坑

1. **可见性判断不能用 `offsetParent`**（`position: fixed` 恒为 `null`）——用盒模型尺寸 + 计算样式。
2. **输入框用原生 value setter + 派发 `input`/`change`**，否则 Vue/React 受控更新不触发。
3. **单次抓帧给硬超时**（默认 4 秒），一次挂起会漏录整段。
4. **时间轴按真实时长 @25fps 均匀重采样**，不能按帧间隔拼。
5. **合流用 `apad` 补静音**，直接 `-shortest` 会把视频截短约 0.9 秒。
6. **不做整页导航**：`location.href` 换页会让只存内存的 SPA 登录态丢失。
7. **ASS 字幕 `&HAABBGGRR` 里 AA 是 alpha**：`0xC0` 是 75% 透明，要用 `0x00`。

### 产物

```
<workDir>/  inventory.json、captions.json、subs.srt、record-report.json、build-report.json、
            frames/、downloads/、audio/（开启播报时）
<name>.mp4  成片
```

---

## 四、验收门禁（不达标别交付）

| 门禁 | 小程序侧 | Web 侧 |
|---|---|---|
| 交互 | `--dry` 全部动作成功 | `record-report.json#failures` 为空（100%） |
| 旁白与画面同步 | 每段旁白起点 = 场景起点 ±0.5s | 开启播报时同左 |
| 音轨 | `volumedetect` 的 mean > −40dB | `build-report.json#audio` mean > −40dB |
| 时长 | 章节高亮与当前页面一致 | 成片 vs 时间轴偏差 < 1.0s |
| 画面干净 | 无 IDE 边框、无鼠标、无系统弹窗 | 同左 |
| 字幕可读 | 中文无方块，每行 ≤ 22 字 | 同左 |

抽帧核对（别只信 JSON）：

```bash
ffmpeg -ss 30 -i out.mp4 -frames:v 1 check.jpg
ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null -
```

## 五、常见变体

- **只要字幕不要旁白**：小程序侧跳过 `tts.ps1` 并把 `minSec` 给足（≈ 字数 ÷ 6，下限 4s），
  `record.cjs` 读不到 `durations.json` 时按 `minSec` 走，`compose.py` 检测不到 wav 会出无声版；
  Web 侧 `narration` 默认就是 `false`。
- **多语言版本**：复制 `scenes.json` / `plan.json` 改文案重新生成旁白即可，动作不用动；但各语言
  旁白时长不同，场景与步骤时长会变，**必须重新录**。
- **竖屏 H5**：走 `web/`，把 `viewport` 设成手机尺寸。
- **只要一张截图**：小程序侧用 `mp.screenshot()`，Web 侧用 `probe` 的截图即可，不必走整条流水线。

## 六、目录

```
<技能>/
├── SKILL.md
├── miniprogram/
│   ├── scripts/{doctor.mjs,record.cjs,tts.ps1,compose.py}
│   └── references/{pipeline.md,pitfalls.md,example.config.json,example.scenes.json,example.actions.cjs}
└── web/
    ├── scripts/webdemo.mjs + scripts/core/{capture,cdp,env,media,page}.mjs
    └── references/{environment-matrix.md,pitfalls.md,step-dsl.md,plan-example.json,plan-example-13steps.json}
```
