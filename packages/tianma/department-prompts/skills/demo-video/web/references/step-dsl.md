# 步骤 DSL 参考

`plan.json` 的 `steps[]` 每一项 = **一句讲解** + **一串声明式动作**。

```jsonc
{
  "caption": "勾选两条订单，批量导出。",   // 字幕文案；开启 narration 时同时作为配音文案
  "minSec": 3,                              // 人工下限（未开播报时它就是步长；开了播报则取 max(minSec, 配音时长+0.9s)）
  "actions": [ /* 见下表 */ ]
}
```

设计原则：
- **声明式，不开放任意 JS**。断言只允许只读探针命名空间，缩小注入面。
- **失败要能自解释**。所有动作返回 `ok` 或 `NO-XXX:...`（尽量附 `AVAIL:` 可用清单）。
- **默认遇错即停**（`continueOnError: false`），避免带着错误一路录到底。

---

## 一、动作一览

| type | 参数 | 语义 | 失败时的诊断 |
|---|---|---|---|
| `nav` | `text` | 点应用内导航（**不做整页跳转**，保护内存态登录） | `NO-TEXT` + 可用导航清单 |
| `click` | `text` 或 `selector` | 按可见文本 / CSS 选择器点击 | `NO-TEXT`/`NO-SELECTOR` + 可用按钮清单 |
| `fill` | `by`,`match`,`value` | 填输入框。`by` = `placeholder`(默认) / `label` / `selector` | `NO-INPUT` + 页面上所有 input 的占位/name |
| `pick` | `select`,`option` | 下拉筛选（按下拉可见文本定位容器） | `NO-SELECT`/`NO-OPTION` + 可见选项清单 |
| `confirm` | `buttonText` | 弹窗二次确认 | `NO-MSGBOX`/`NO-MSGBTN` + 当前按钮文案 |
| `closeTop` | — | 关闭最上层弹窗/抽屉 | `NO-OVERLAY` / `NO-CLOSE-BTN` |
| `overlayTitle` | — | 读当前弹窗标题（用于断言弹对了没） | 返回字符串 |
| `checkRow` | `index` | 勾选表格第 index 行的复选框 | `NO-ROW`/`NO-CHECKBOX` |
| `rowAction` | `index`,`text` | 点第 index 行内文案为 text 的按钮 | `NO-ROWBTN` + 该行可用按钮 |
| `rowActionAny` | `index`,`texts[]` | 命中任一文案（用于「禁用/启用」这类二选一） | `NO-ROWBTN-ANY` + 该行可用按钮 |
| `seg` | `text` | 点分段控件/单选按钮（如「折线/柱状」） | `NO-SEG` |
| `toggleBox` | `label` | 按标签文字勾选/取消复选框 | `NO-CHECKBOX` |
| `scroll` | `y` | 页面滚动 | — |
| `toast` | — | 读当前 Toast 文案（用于断言「导出成功」这类提示） | 返回字符串 |
| `wait` | `ms` | 固定等待 | — |
| `waitText` | `text`,`timeoutMs` | 等文本出现 | `等待超时` |
| `waitPath` | `startsWith`,`timeoutMs` | 等路由变化 | `等待超时` |
| `assert` | `expr` | 断言（受限命名空间，见下） | `E_ASSERT_FAILED` + 现场快照 JSON |
| `eval` | `js` | 逃生门，**默认禁用**（需 `allowEval: true`） | `E_EVAL_DISABLED` |

---

## 二、定位方式的取舍

| 场景 | 推荐写法 | 原因 |
|---|---|---|
| 按钮/导航 | `{"type":"click","text":"导出"}` | 文案即契约，比选择器稳定；失败会回吐可用清单 |
| 带角标的导航 | 同上 | 引擎做了「精确 → 前缀」两段匹配，`入驻审核\n1` 也能命中 |
| 表单输入 | `by: "placeholder"` | 最稳；placeholder 通常在改版时也会保留 |
| 详情页表单 | `by: "label"` | 这类输入框常无 placeholder，靠 label 文本定位 |
| 找不到文案的元素 | `{"selector": ".my-btn"}` | 最后手段；改版即失效，尽量少用 |
| 表格行内操作 | `rowAction` / `rowActionAny` | 直接按行内按钮文案点，避免依赖列顺序 |

> **列表刷新后行号会变**：筛选/排序/翻页之后，`index` 的含义就变了。
> 需要稳定定位时，让被测应用给行加 `data-*` 标识，或用 `assert` 先确认当前列表状态再操作。

---

## 三、断言命名空间（只读）

```jsonc
{ "type": "assert", "expr": "rows() === 1" }
{ "type": "assert", "expr": "hasText('已导出')" }
{ "type": "assert", "expr": "path().includes('/camps/')" }
{ "type": "assert", "expr": "overlayTitle().includes('驳回')" }
{ "type": "assert", "expr": "toast().length > 0" }
{ "type": "assert", "expr": "downloadCount() >= 1" }
```

可用函数：`rows()`、`hasText(t)`、`path()`、`toast()`、`overlayTitle()`、`downloadCount()`

**不允许**：分号、花括号、方括号、箭头函数、`function`、`eval`、`Function`、`import`、`require`、
`fetch`、`XMLHttpRequest`、`__proto__`、`constructor`。含这些的表达式会直接报错（不静默通过）。

断言失败时，引擎会附上现场快照（路径、按钮、行数、首行、打开的弹窗），据此改步骤即可，**不要跳过断言**。

---

## 四、登录配方（站点无关）

```jsonc
"login": {
  "fill": [
    { "by": "placeholder", "match": "账号", "value": "admin" },
    { "by": "placeholder", "match": "密码", "value": "…" }
  ],
  "submit": { "by": "text", "text": "登录" },
  "waitPath": { "startsWith": "/dashboard" },   // 与 waitText 二选一或都用
  "waitText": "退出登录",
  "timeoutMs": 20000
}
```

要点：
- 登录后页面会重渲染，引擎会**重新注入辅助库**，不需要你处理。
- 登录口令只存在于 plan 文件本身；`record-report.json` 与日志**不记录登录值**。
  但 plan 文件是明文，不要提交到公开仓库。
- 需要图形验证码/短信验证的站点不适合本流程，请改用人工录屏。

---

## 五、完整示例（可运行）

见 `references/plan-example.json`。核心片段：

```jsonc
{
  "caption": "搜索营地，列表实时收敛。",
  "minSec": 3,
  "actions": [
    { "type": "nav", "text": "营地管理" },
    { "type": "wait", "ms": 900 },
    { "type": "fill", "by": "placeholder", "match": "搜索营地", "value": "安吉" },
    { "type": "click", "text": "搜索" },
    { "type": "wait", "ms": 1000 },
    { "type": "assert", "expr": "rows() === 1" },
    { "type": "click", "text": "重置" },
    { "type": "wait", "ms": 700 }
  ]
}
```

---

## 六、写步骤的经验规则

1. **每次点击后留 `wait`**：300–1200ms，视页面动效与请求而定。缺等待是最常见的偶发失败原因。
2. **关键状态用 `assert` 锁死**：例如「筛选后只剩 1 行」，避免录出「其实没筛成功」的视频。
3. **一步一个主题**：一句话讲解对应一个可观察的结果，不要把 5 个操作塞进一句「看看功能」。
4. **导出类动作一定要核对落盘**：`downloads/` 里必须有文件，且条数与画面提示一致。
   可以直接断言 `{ "type": "assert", "expr": "downloadCount() >= 1", "timeoutMs": 6000 }`
   （录制期会轮询下载目录写入 `window.__demoDownloads`；加 `timeoutMs` 是为了等下载真正落盘）。
5. **破坏性操作放到最后或指向测试环境**：需要时开 `readOnly: true`。
6. **`minSec` 要按字幕读得完来给**：默认不出配音，`minSec` 就是步长，没有配音兜底。
   经验值 ≈ 中文字数 ÷ 6，下限 3.5s；一句话 24–29 字大约需要 4.5–5s。
   （plan 载入时会对过短的 `minSec` 告警并给建议值；开着播报时它只是下限，不会误报。）

---

## 七、plan.json 顶层字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | `webdemo` | 产物名前缀 |
| `url` | 必填 | 目标地址 |
| `uiKit` | `auto` | `auto` / `element` / `antd` / `basic` |
| `viewport` | 1600×900 | 视口尺寸（同时决定抓帧分辨率） |
| `capture.fps` | 5 | 抓帧频率 |
| `capture.jpegQuality` | 82 | 帧质量 |
| `capture.screenshotTimeoutMs` | 4000 | **单帧硬超时，不要调大** |
| `timelineFps` | 25 | 成片帧率 |
| `continueOnError` | false | 遇错是否继续 |
| `readOnly` | false | 拒绝破坏性按钮 |
| `allowEval` | false | 是否允许 `eval` 动作 |
| `fontName` | 自动探测 | 字幕字体 |
| `browserPath`/`ffmpegPath`/`ffprobePath` | 自动探测 | 显式指定可绕过探测 |
| `workDir` | `./<name>-work` | 工作目录 |
| `probeRoutes` | `[]` | probe 要逐个进入的导航文案 |
| `tts.rate` | 0 | 语速（SAPI 为 −10..10），仅 `narration: true` 时生效 |
| `narration` | `false` | **语音播报开关**。默认 `false`：只烧字幕，步长 = `minSec`；设 `true` 才跑 TTS，并令步长 = `max(minSec, 配音时长 + 0.9s)`。只认布尔 `true` |
| `captions` | 不设 = SRT 描边字幕 | 字幕外观，给了就走自绘 ASS 圆角容器。见 §八 |
| `watermark` | 不设 = 无水印 | 常驻水印。见 §八 |
| `cover` | 不设 = 无片头 | 片头标题卡（含版权/署名行）。见 §八 |

---

## 八、外观三件套：片头卡 / 字幕容器 / 水印

三者都是**可选**的；不写就是「SRT 描边字幕 + 无片头 + 无水印」的朴素形态。写了才会走自绘 ASS 排版。

### 8.1 `cover` 片头标题卡

```jsonc
"cover": {
  "title": "驻车集 · 平台总后台",              // 主标题
  "subtitle": "管理端功能演示",                 // 副标题
  "footer": "营地入驻审核 · 车位余量总览",       // 页脚（可留空）
  "attribution": "© 2026 帆远网络科技",         // 最底部的版权/署名行（半透明小字）
  "durationSec": 3.5,                          // 片头时长；**默认 4，设为 0 即关闭片头**
  "bgColor": "0x1F3A33"                        // 底色，ffmpeg 语法
}
```

要点与坑：

- **片头会把整条时间轴整体后移 `durationSec`**：ASS 字幕挂在正片段上（用未偏移的时间），音轨与成片用偏移后的时间，
  引擎已两套都处理。报告里的 `expectedDurationSec` = `timelineDurationSec + coverSec`，核对时长偏差用它，别用 `timelineDurationSec`。
- 有片头时会额外产出 `subs.with-cover.srt`（与最终成片对齐），外挂字幕请用这一份，而不是 `subs.srt`。
- **同一个对象里混了两种颜色语法**：`bgColor` 走 ffmpeg 的 `color=c=`，写 `0x1F3A33`；
  而 `titleColor`/`subtitleColor`/`footerColor`/`accentColor` 走 ASS，写 `&HBBGGRR&`。写反了不会报错，只会颜色不对。
- 可调字号：`titleSize`(76) / `subtitleSize`(34) / `footerSize`(22) / `attributionSize`(18)。
- 版式固定：标题在高度 41% 处、下方一条强调色短横、副标题在其下，页脚在 90%、版权行在页脚之下——槽位固定，不要指望自由排版。

### 8.2 `captions` 字幕容器

```jsonc
"captions": {
  "mode": "box",                 // "box" 圆角深色容器（推荐）| "plain" 只出白字
  "fontSize": 46,
  "radius": 16,
  "paddingX": 34,
  "paddingY": 18,
  "marginBottom": 50,            // 容器距底边
  "bgColor": "&H1C1A19&",        // ASS 语法
  "bgAlpha": "&H22&",            // &HAA& 里 AA 是透明度，00 = 全不透明
  "textColor": "&H00FFFFFF&"
}
```

- 容器高度 = 实测字墨高 × `fontSize` + 2×`paddingY`（启动时会用一帧渲染标定 CJK 字宽/墨高，报告里会打印标定值）。
- 行尾若是全角标点，容器会回收半格右内边距（否则右边看着偏大）——这是有意的，不是计算错误。

### 8.3 `watermark` 常驻水印

```jsonc
"watermark": {
  "text": "驻车集 V1.0 · 平台总后台",
  "fontSize": 22,
  "position": "bottom-left",     // bottom-left / bottom-right / top-left / top-right
  "marginX": 14,
  "marginY": 14,
  "color": "&H006A6A6A&",
  "alpha": "&H46&"
}
```

- **别放右上角**：后台类应用右上角通常是操作员名与「退出登录」，水印压上去两边都看不清。稳妥位置是 `bottom-left`
  （字幕容器居中，最长一句也够不到左下角；容器底部在 `height − marginBottom`，水印再往下贴底即可）。
- 想多行水印可用 `lines: [{ text, fontSize, color, alpha }]` 代替 `text`。
- 绘制顺序上水印先入队、字幕容器后画，**水印永远不会压住字幕**（代价是长字幕会盖住水印）。
