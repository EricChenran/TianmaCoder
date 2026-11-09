# 时间轴数学与对齐（先看这一页，能省两小时）

整套流程只有一个时间轴：**`marks.json` 里相对录制起点的秒数**。其余全部由它派生，任何一处重新换算都会错位。

## 录制端

```
spawnWall         ffmpeg 进程启动时刻
syncWall          reLaunch 到登录页（整屏跳变）的时刻
scenes[i].start   (场景动作开始 - spawnWall) / 1000
scenes[i].end     (场景动作结束 - spawnWall) / 1000
```

录屏的 0 点 ≈ `spawnWall`，但 ffmpeg 真正抓到第一帧要晚 0.3–0.6 秒（设备打开、编码器初始化），
所以 `start` 直接当视频时间用会整体偏移。

## 对齐（compose.sync_offset）

录屏开头的「稳定页 → 登录页」是一次整屏跳变，用 10fps 抽帧算帧间差找峰值：

```python
detected = (argmax(diff) + 1) / 10          # 跳变在录屏里的秒数
offset   = detected - marks["syncAt"]       # 本次录制的启动误差，实测 -0.05 ~ +0.05
```

之后所有时间都减掉 `offset`：

```
demo_r0      = scenes[0].start - offset     # demo 段在录屏里的起点（解码 -ss 用它）
rel_starts[i] = scenes[i].start - offset - demo_r0
rel_ends[i]   = scenes[i].end   - offset - demo_r0
```

## 合成端

```
成片时刻 = COVER_SEC + rel + 0.2
  - COVER_SEC = 3.4（片头）
  - +0.2 是给字幕/章节的一点提前量，避免卡在切页瞬间
demo_len = rel_ends[-1] + 1.2
total    = COVER_SEC + demo_len + OUTRO_SEC
```

- 解码：`ffmpeg -ss <demo_r0> -i capture.mkv ...`，第 0 帧就是 `scenes[0]`。
- 章节高亮：`scene_at(rel)` 取「最后一个 start ≤ rel」的场景。
- 字幕：每段 `[COVER+rel_start+0.2, min(COVER+rel_end-0.1, 下一段 start+0.2)]`。
- 旁白：`COVER + rel_start + 0.35` 处贴入，比字幕晚 0.15 秒，听感更自然。
- 进度条：`rel / demo_len`。

## 常见错法

| 错法 | 后果 |
|---|---|
| 直接从录屏 0 秒解码 | demo 段多出 10 秒准备期，章节整体早一屏 |
| 用 `scenes[i].start`（未减 offset）当视频时间 | 字幕整体偏移 0.3–0.6 秒，越往后越明显 |
| 字幕时间再加一次 COVER | 多偏 3.4 秒 |
| 按帧号而不是按秒切场景 | 抓帧不吃满 25fps 时时间轴被压缩 |
| 旁白时长用「文件大小 ÷ 176400」 | 算成一半，旁白互相重叠（44.1k/16bit 单声道是 88200 字节/秒） |

## 场景时长

```
target = max(minSec, narration + 2.0)
```

`narration` 来自 `audio/durations.json`（`tts.ps1` 用 WAV 头 byteRate 实测）。
`+2.0` 是「念完还能看一秒半」的余量；小于 1.5 会显得赶。若某段动作本身耗时超过 target，
场景会自动拉长（marks.json 记真实值），不影响对齐，只是成片变长。
