# wechatide 驱动契约（小程序侧）

`record.cjs` 默认优先用微信开发者工具自带的 `wechatide` CLI 驱动真实交互；CLI 不在时退回
`miniprogram-automator`。本文只写录制用到的那部分接口与硬约束，完整工具表随开发者工具安装目录
走（`<安装目录>/resources/app.asar.unpacked/wechatide-skill/`），以 `wechatide -c <client> <tool> -h`
为准。

## 驱动选择

| 场景 | 做法 |
|---|---|
| `config.driver = "auto"`（默认） | 找到 CLI 用 CLI，找不到用 automator |
| 显式 `"wechatide"` | 找不到 CLI 直接报错，不静默降级 |
| 显式 `"automator"` | 必须自己先跑 `cli.bat auto --project … --auto-port …` |

CLI 的定位顺序：`config.wechatide` → 环境变量 `DSH_WECHATIDE_CMD` → PATH 上的 `wechatide` →
常见安装目录（`config.devtools` 优先）。Windows 下命令名是 `wechatide.cmd`。

## 三条硬约束

1. **每次 toolCall 都可能先返回待授权**：`{ ok: true, result: { status: "pending", taskId } }`。
   必须用 `polling_task_result --task-id <id>` 取最终结果；`pending` 不是成功。首次授权是
   **按 clientName** 记的（本技能用 `TianmaCoder`），要在开发者工具弹窗里点「允许」。
2. **不要同时开两套自动化**：CLI 打开的项目窗口和你手工跑的 `cli.bat auto` 会争同一个项目。
   用 CLI 驱动时就别再手工开自动化端口。
3. **不要在沙箱里跑 CLI**：它要连本机桌面与工具进程；沙箱内先说明再换非沙箱终端。

## 录制用到的工具与参数

| 用途 | 工具 | 关键参数 |
|---|---|---|
| 门禁：登录态与版本关系 | `check_wechatide_status` | `--skill-version <工具自带 skill 版本>` |
| 异步结果 | `polling_task_result` | `--task-id <id>` |
| 开/关项目窗口（幂等） | `open_project_window` / `close_project_window` | `--project <绝对路径>`；开窗可加 `--window-mode liteMode|fullMode` |
| 当前页面 | `automation_runtime_info` | `--action currentPage|pageStack|systemInfo` |
| 导航 | `automation_navigate` | `--action navigateTo|redirectTo|reLaunch|switchTab|navigateBack`，`--url` / `--delta` |
| 点、输入、读文本 | `automation_element_action` | `--action tap|input|text|…`，`--selector`，`--wait-for-selector`，`--value`，`--x`/`--y` |
| 页面级读写 | `automation_page_action` | `--action querySelectorAll|callMethod|getData|setData`，`--selector` / `--method` / `--args-file` |
| 滚动 | `automation_viewport_action` | `--action pageScrollTo --scroll-top <px>` |
| 截图 | `simulator_screenshot` | `--path <本地路径>`（不传就写系统临时目录） |
| 执行表达式 | `automation_evaluate` | `--fn-source "function(){…}"`，`--args-file` |
| 调 wx API | `automation_wx_api` | `--action call --method <api>`，`--args-file` |

`liteMode` 只开模拟器、不带编辑器与调试器，抓屏画面更干净，录制用它。

## 失败分层

驱动把失败分型成带 `code` 的错误，`record.cjs` 据此决定是否继续：

| code | 含义 | 处理 |
|---|---|---|
| `WECHATIDE_MISSING` | CLI 找不到/不可执行 | 检查 `config.wechatide` 或安装目录；或改 `driver=automator` |
| `WECHATIDE_LOGIN_EXPIRED` | 开发者工具登录过期 | 在工具里扫码登录后重跑，**不要**带着过期会话录 |
| `WECHATIDE_AUTH_TIMEOUT` | 授权弹窗没人点 | 点「允许」后重跑；授权按 clientName 只做一次 |
| `APPID_ERROR` | 项目 appid 未在该账号下注册 | 换成真实 appid；`touristappid` 这类占位符 CLI 不接受 |
| `WECHATIDE_INDEX_UNSUPPORTED` | 同选择器多命中且取不到坐标 | 改用坐标点击，或把 `driver` 设为 `automator` |
| `WECHATIDE_ELEMENT_MISSING` | 索引超出命中数量 | 核对选择器与下标 |
| `WECHATIDE_PAGE_TIMEOUT` | 等页面路由超时 | 检查路由片段是否写错、后端是否已起 |

## 与 automator 的差别（写动作时要记住）

- **索引点击**：CLI 的元素工具只认选择器，没有「第 N 个」。`tap(sel, { index })` 在 CLI 模式下
  先取 `selectAll(sel)` 的包围盒再点中心坐标；取不到坐标就报 `WECHATIDE_INDEX_UNSUPPORTED`，
  不会静默点第一个。写动作时优先给唯一选择器。
- **`mp` 是兼容层**：`mpShim` 提供了 `currentPage / reLaunch / navigateTo / redirectTo / switchTab /
  navigateBack / pageScrollTo / evaluate / callWxMethod / screenshot`，以及页面的
  `$ / $$ / callMethod / data`。automator 独有的能力（如 `mp.mockWxMethod` 的完整语义）没有覆盖。
- **输入框**：CLI 的 `input` 走真实事件；automator 模式仍按老办法用 `page.callMethod('onInput', …)`。
- **`--dry` 干跑**：两种驱动都支持，仍然建议先干跑再正式录。
