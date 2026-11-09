# 踩坑清单（全部在本机实测过）

按「症状 → 原因 → 做法」排列，遇到问题先搜症状。

## 录制

**画面全黑，只有一个加载圈**
`ffmpeg -f gdigrab -i title=...` 抓 Electron 窗口拿不到 GPU 合成内容。
→ 改用 `ddagrab`：
```
ffmpeg -filter_complex "ddagrab=0:framerate=25,hwdownload,format=bgra" -c:v libx264 ...
```
（`ddagrab` 需要 ffmpeg 7+，Windows 8+。）

**录到的是 IDE / 别的窗口**
开发者工具没置前。录前用 Win32 置前 + 最大化：
```powershell
[Win]::ShowWindow($h, 3); [Win]::BringWindowToTop($h); [Win]::SetForegroundWindow($h)
```
按 `MainWindowTitle` 找窗口（微信开发者工具的标题是小程序项目名）。

**画面抖动 / 分辨率变化**
录制期间改了窗口大小、切换了缩放、或系统弹了通知。
→ 录前固定窗口，录制期间不要操作鼠标键盘，关掉即时通讯弹窗。

**自动化点了没反应**
- 自定义组件的宿主节点不冒泡：`page.$('.goods-item')` 能拿到节点，但 `tap()` 不触发组件内部 `bindtap`。
  → 直接走路由：`mp.navigateTo('/packageA/pages/detail/index?id=' + id)`。
- 元素在视口外：`tap()` 不会自动滚动。先 `scroll()` 再点。
- 页面还没渲染完：每个导航后至少 `sleep(1000)`，或 `waitPage()` 轮询。

**输入框塞不进字**
`element.input()` 在部分页面抛 `e.stopPropagation is not a function`（automator 构造的事件对象不完整）。
→ 走页面方法：`page.callMethod('onInput', { detail: { value: '玫瑰' } })`，再 `page.callMethod('doSearch')`。

**`mp.screenshot()` 太慢**
单帧 700–800ms，25fps 不可能，抓 10 秒只有十几帧。
→ 只用来做单张校验，正式录制一律 ddagrab 实时抓屏。

**开发者工具连不上**
- 必须先开自动化模式：`cli.bat auto --project <dir> --auto-port 9420`，等端口监听后再连。
- 每个项目同时只能有一个自动化实例；换项目前先关掉旧的。
- 工具需要登录微信；扫码后 `appid` 用项目自带的即可。

## 合成

**章节比画面早十几秒**
没对录屏 seek 到首场景。见 `references/pipeline.md`。

**字幕和旁白对不上**
旁白时长算错（双声道/单声道混淆），或场景时长没按旁白兜底。
→ `tts.ps1` 用 WAV 头 byteRate 算真实秒数；`record.cjs` 用 `max(minSec, 旁白+2)`。

**旁白互相重叠**
同上，某段旁白比场景长。合成前打印每段 `narrationSec` 与 `targetSec` 抽查。

**片尾文字和底图叠在一起**
片尾只把底图压暗 86%，半透明文字会透出章节卡片。
→ 直接 `Image.blend(last, solid, 1.0)`，用纯背景再叠文字。

**手机画面被裁掉一圈**
设备矩形识别把 IDE 的工具栏/分割线也算进去了。
→ 本技能的 `detect_device_rect` 用「左右边缘列贯穿 + 整行占比」找屏幕，再向外扩 60px 补圆角；
若仍不准，抽第一帧看 `device rect` 是否等于模拟器可视区。

**画面糊**
模拟器在 1920×1080 桌面上只有约 356×774，直接 1:1 贴进 1440×900 的手机框最清晰；
把手机框放大到 1.2 倍以上就会糊。要更清晰只能换更大分辨率的桌面。

**ffmpeg 报 Broken pipe**
解码进程还在喂帧，编码进程已经结束（我们提前停止读取）。属正常，忽略。

## 内容

**页面数据是空的**
后端没起、或登录态失效、或数据库没种子。录前先跑一遍 doctor 里的接口探测，手动过一遍页面。

**数字自打脸**
例：分销页「可提现余额 -¥39.90」。种子数据里提现额 > 佣金。
→ 要么修种子数据，要么在脚本里避开该卡片（先滚动过去），并在交付说明里写明。

**登录后马上跳走**
登录成功后会 `switchTab` 回首页，登录页停留时间很短。
→ 场景开始前留 0.9–1.2 秒给登录页，登录成功的 toast 也是真实反馈，可保留。

## 交付

字幕、封面、场景脚本 JSON 和视频一起给；SRT 用 UTF-8（无 BOM），时间轴与视频一致。
视频建议 H.264 + AAC、`+faststart`，微信/企业微信/浏览器都能直接播。
