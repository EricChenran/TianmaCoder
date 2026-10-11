# 环境矩阵：不同电脑上如何跑通

本技能的地基是**逐项探测 + 降级阶梯**，而不是「假设环境齐全」。下面列出被覆盖的环境差异、
探测方式、缺失时的行为与各平台修复命令。

---

## 一、平台差异总表

| 维度 | Windows | macOS | Linux |
|---|---|---|---|
| 浏览器默认位置 | `Program Files (x86)\Microsoft\Edge\...`（自带）、`Program Files\Google\Chrome\...`、`%LOCALAPPDATA%` | `/Applications/*.app/Contents/MacOS/*` | `/usr/bin/google-chrome`、`/usr/bin/chromium`、`/snap/bin/chromium`、`/opt/google/chrome/chrome` |
| 浏览器版本获取 | **`--version` 不回显**，走文件版本信息（PowerShell `VersionInfo.ProductVersion`） | `--version` | `--version` |
| ffmpeg 常见位置 | winget 包目录、`C:\ffmpeg\bin`、scoop shims、PATH | `/opt/homebrew/bin`、`/usr/local/bin`、PATH | `/usr/bin`、`/snap/bin`、`~/.local/bin`、PATH |
| 中文语音 | SAPI（`New-Object -ComObject SAPI.SpVoice`），典型语音 `Microsoft Huihui`（**仅 `narration: true` 时使用**） | `say`（`Tingting`/`Meijia`） | `espeak-ng -v zh` / `espeak -v zh` / `pico2wave -l zh-CN` |
| 中文字体 | `C:\Windows\Fonts\msyh.ttc`（Microsoft YaHei） | `/System/Library/Fonts/PingFang.ttc` | `fonts-noto-cjk` / `wqy-zenhei` / `fc-list :lang=zh` |
| 打开产物的 shell | `explorer.exe <file>` | `open <file>` | `xdg-open <file>` |
| 文本传参风险 | **高**：argv 传非 ASCII 易乱码 | 低（UTF-8） | 低（UTF-8，注意 `LANG`） |

> **文本一律走文件而不是 argv**：本技能的 TTS 会把每句文案写入 UTF-8 文件，再由引擎读取；
> 这消除了 Windows 上最大的一类「本地正常、换台机器就乱码」问题。

---

## 二、特殊环境

### 2.1 容器 / CI（Linux）

- **必须 `--no-sandbox`**：以 root 运行时 Chromium 拒绝启动。本技能在 `IS_ROOT || CI` 时自动加。
- **`--disable-dev-shm-usage`**：容器 `/dev/shm` 常只有 64MB，会导致渲染进程崩溃。本技能在
  `/dev/shm` 不存在或 root/CI 时自动加。
- **系统依赖**：精简镜像常缺 `libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libasound2`。
  缺失表现为「浏览器进程立即退出」或「未产出 DevToolsActivePort」——本技能会把浏览器 stderr
  尾部打印出来，直接看到缺哪个 `.so`。
- **字体**：`apt-get install -y fonts-noto-cjk`，否则字幕是方块。
- **无显示器**：`--headless=new` 不需要 X server；若显式设置了 `DISPLAY` 反而可能干扰。

### 2.2 WSL

- 浏览器通常装在 Windows 侧。两种做法：① 在 WSL 里装 Linux Chromium；② 用
  `DSH_WEBDEMO_BROWSER=/mnt/c/Program\ Files/.../msedge.exe` 指向 Windows 浏览器（跨系统调用可行，
  但文件路径与下载目录要落在 Windows 能访问的位置）。
- 推荐 ①，路径与权限最简单。

### 2.3 受限/受管电脑

| 限制 | 表现 | 处置 |
|---|---|---|
| 无法安装浏览器 | 探测不到 | 用系统自带 Edge（Windows 一定有）；或改用已有的 Chrome/Chromium 并用 `DSH_WEBDEMO_BROWSER` 指定 |
| 无法安装 ffmpeg | 合成阶段失败 | 让用户手动下载绿色版并设置 `DSH_FFMPEG_PATH`/`DSH_FFPROBE_PATH` |
| 无 TTS 语音 | 只有画面+字幕 | 默认就不出配音，无需处理；若已开 `narration: true` 则自动降级为「仅字幕」，成片仍可交付 |
| 临时目录不可写 | 启动即失败 | 设置 `TMPDIR`（Linux/mac）/ `TEMP`（Windows）到可写目录，或用 `--workdir` 指到项目内 |
| 系统代理拦截 localhost | 页面打不开/白屏 | 已内建 `--no-proxy-server` 与 `--proxy-bypass-list=<-loopback>` |
| 磁盘配额小 | 抓帧写满 | 降低 `capture.fps`、缩短步骤、或把 `--workdir` 指到大盘；1600×900 JPEG 约 120–200KB/帧，5fps×60s ≈ 60MB |
| 用户名含中文/空格 | 各类奇怪失败 | 本技能所有路径用 argv 数组传递、不拼 shell 字符串；产物先写 ASCII 名再改名 |

### 2.4 老旧浏览器

- `--headless=new` 需要 Chromium ≥ 112。本技能启动失败会自动退化 `--headless`。
- 若浏览器过旧导致 CDP 方法缺失（如 `Browser.setDownloadBehavior` 不可用），下载目录会拿不到文件——
  此时可改用页面上的「下载」按钮配合系统下载目录，或升级浏览器。

---

## 三、常见失败 → 判定 → 处置

| 现象 | 判定依据 | 处置 |
|---|---|---|
| `无法执行 <浏览器>` | 路径不存在 | 跑 `doctor` 看实际探测结果；用 `DSH_WEBDEMO_BROWSER` 显式指定 |
| `未产出 DevToolsActivePort` | 浏览器启动即退出 | 看 `<workDir>/browser.log`；Linux 多为缺 `.so`，Windows 多为 profile 目录被占用/权限不足。**若 `<workDir>/browser-profile` 是空的（0 条目）**，说明 `--user-data-dir` 没生效：检查 `--workdir` 是否传了相对路径（已内建绝对化），或是否有残留浏览器占着 profile 锁 |
| `未找到可用的页面调试目标` | 没有 page target | 确认启动参数带了初始页面（本技能默认 `about:blank`）；某些旧版需要 `PUT /json/new`（已内建尝试） |
| `目标站点不可访问` | 预检 fetch 非 2xx | 启动被测服务；注意 Vite/Next 端口被占会自动换端口而导致地址不对 |
| 动作 `NO-TEXT` / `NO-ROWBTN` | 文案不匹配 | 看返回的 `AVAIL:` 清单改文案；带角标的导航项用前缀匹配（已内建） |
| 动作 `NO-INPUT` | 定位不到输入框 | 换 `by`：`placeholder` → `label` → `selector`（详情页表单常无 placeholder，用 `label`） |
| 动作 `NO-SELECT` / `NO-OPTION` | 下拉定位失败 | 下拉占位多为 `<span>` 而非 input；本技能按下拉可见文本定位，选项只取可见项 |
| 动作 `E_ASSERT_FAILED` | 交互没达到预期 | 报告里附现场快照（行数/路径/Toast），据此修正步骤；**不要跳过断言** |
| 成片比时间轴短 ~1s | `-shortest` 截断 | 已用 `apad` 修掉；若自定义命令，记得音轨补静音 |
| 字幕显示方块 | 缺中文字体 | 装 CJK 字体；或 `--font-name` 指定已有字体名 |
| 字幕描边几乎看不见 | ASS alpha 反直觉 | `OutlineColour` 用 `&H00000000`（`0xC0` 是 75% 透明） |
| 录制中途站点挂了 | 抓帧大量报错 | 某些编辑器的原子写入会留下临时目录把 Vite 的文件监听搞崩（`EBUSY`）；重启 dev server 后重录 |
| 视频里有长静止段 | `timeline.heldSlots` 偏大 | 说明抓帧出现空档；看 `capture.maxGapSec`，通常是页面在做重计算或浏览器被抢占 |

---

## 四、最小可用环境清单

任何一台机器满足以下四条即可产出成片（**配音默认不出**，中文字体缺失只影响观感，都不影响可用性）：

1. Node ≥ 22（内置 WebSocket）
2. 任一 Chromium 系浏览器（Windows 自带 Edge 即可）
3. PATH 上有 `ffmpeg` 与 `ffprobe`
4. 一个可写的临时目录

先跑 `doctor`，它会逐项告诉你差什么、怎么补。
