---
name: ui-confirmation-doc
description: 编制《UI 界面确认单》（DOCX+PDF）：对 Web 管理后台与微信小程序逐屏截图，套用甲方提供的确认书模板成文。默认只拍一级页面（后台全部菜单页 / 小程序 tab 与主包入口页）加 5 张以内核心二级页（详情、下单、订单详情等），不逐页全量截图。模板的结构、措辞、图注格式、结论与签署表一律不改。触发词：UI确认书、UI确认单、界面确认、做确认书、后台截图、小程序截图、界面截图成文。
---

# UI 界面确认单（ui-confirmation-doc）

本技能做一件事：把一个项目的**实际界面截图**，套进甲方给的《UI 确认书》模板，产出可签字的 DOCX + PDF。

## 三条铁律

1. **不改模板**。模板的页面设置、字体字号、图注格式、图片版式、"确认结论"措辞、签署表全部照搬，只换图注文字和配图；缺板块时按模板已有写法（`Web界面：`）补一个同格式的 `小程序界面：`。
2. **只拍一级页面 + 核心二级页面**。后台=登录页 + 侧边栏每一项；小程序=tabBar 五页 + 主包入口页；二级页每端最多 5 张。合计控制 16–24 张。细则见 `references/scope-policy.md`，**先读再截**。
3. **交付两件**：`<文件名>.docx` 与同名 `.pdf`。

## 执行流程

1. **读模板**：打开用户给的模板 docx，确认板块标题、图注样例、结论与签署表结构，记下锚点标题（通常 `Web界面：`）。
2. **摸清页面清单**（以代码为准，不凭印象）：
   - Web：`src/router/*.ts` 里挂在布局组件下的 children = 一级页面；
   - 小程序：`app.json` 的 `pages` + `tabBar.list` = 一级页面。
3. **截 Web 后台**：写 `plan.json`（参照 `references/plan-example.json`），执行
   `node <技能>/scripts/web-capture.mjs plan.json`。
4. **截小程序**：写 `mp-plan.json`（参照 `references/mp-plan-example.json`），执行
   `node <技能>/scripts/mp-capture.cjs mp-plan.json`。
5. **写清单**：`manifest.json`（参照 `references/manifest-example.json`），每个板块给标题、图宽、图注。
6. **生成文档**：`python <技能>/scripts/build_docx.py manifest.json`。
7. **校验**：结构检查 + 渲染目检（见下）。
8. **交付**：转 PDF，`present` 两个文件，汇报页数、图数与截图范围。

## 写 plan 之前先探一下页面

选择器随版本变（同一个后台可能从 `el-menu-item` 换成 `<button class="nav-item">`，
弹窗从 `el-dialog` 换成 `el-drawer`）。写 plan 前先跑一段探测，别靠猜：

```js
import { launch } from 'file:///<技能目录>/scripts/cdp.mjs';
const b = await launch({ profileDir: '<临时目录>', width: 1440, height: 900 });
await b.goto('http://localhost:5173/login');
console.log(await b.evalp(`Array.from(document.querySelectorAll('button')).map(e=>e.innerText.trim())`));
console.log(await b.evalp(`Array.from(document.querySelectorAll('.el-dialog,.el-drawer')).map(e=>e.className)`));
await b.close();
```

拿到按钮文字与弹窗类名再写 `actions`，能省掉大半轮返工。

## Web 后台截图

`web-capture.mjs` 用无头 Chromium + CDP，不依赖内置浏览器工具（该工具在部分环境截图会报
`UnknownVizError` / `显示面不可用`）。

动作词表（`plan.shots[].actions`）：

| type | 参数 | 说明 |
|---|---|---|
| `goto` | `url` | 整页跳转（会刷新，SPA 内存态登录会丢） |
| `menu` | `text` | 点侧边栏菜单项，按文字匹配 |
| `btn` | `text`、`scope` | 按按钮文字点击，`scope` 限定容器（如 `.el-dialog__footer`） |
| `rowbtn` | `row` 或 `rowText`、`text` | 点表格某一行里的按钮 |
| `radio` | `text` | 点 el-radio-button 选项 |
| `fill` | `placeholder` / `selector` / `scope`+`index`、`value` | 填输入框（触发 input/change/blur） |
| `wait` / `waitFor` / `waitGone` | `ms` / `selector` | 等待 |
| `esc` | — | 关弹窗 |
| `setViewport` | `width`、`height` | 改视口（做响应式截图） |
| `scroll` / `hover` / `eval` | — | 备用 |

截帧选项：`fit: true` 把视口高度撑到内容高度（页面类截图用，避免滚动裁剪）；不写则固定视口
（弹窗类截图用，背景留全屏）。

## 小程序截图

前置条件：

1. 微信开发者工具已安装并**已登录**；
2. 打开「设置 → 安全设置 → 服务端口」，否则 CLI 直接报
   `IDE service port disabled`；
3. 本技能目录执行过 `npm i miniprogram-automator`。

`mp-plan.json` 里 `auto` 段填 CLI 路径与项目路径，脚本会先跑
`cli auto --project <路径> --auto-port 9420` 打开自动化通道，再连接截屏。

- 页面用 `page`（路由）+ `query`（参数，**中文不要 URL 编码**，页面会原样显示成 `%E9%B2%9C...`）；
- `login` 段做一次「勾选协议 → 授权登录」，后续页面才有登录态；
- `close: false` 可保留会话，方便后续补拍；默认截完关闭，下次需重新 `cli auto`。

## 生成文档

`build_docx.py` 直接改模板本体：删除模板原有图注/图片段，按清单克隆模板自己的图注段与图片段
（继承 9pt 加粗居中、keepNext、段前段后间距、居中图片段），因此版式与模板逐像素一致。

关键参数：

- `imageWidthEmu`：横版后台图用模板原值 `5256000`（5.75in，两幅一页）；竖版手机图用
  `3566160`（3.9in，单幅一页，保证小字可读）。1 英寸 = 914400 EMU。
- `anchorHeading`：模板里第一个板块标题的文字，脚本据此定位插入点。
- 图号由脚本连续编号（`图 01　登录（/login）`），**不要在 caption 里重复写图号**。

## 校验与交付

```bash
# 结构检查（Python 与 checker 路径见 office-docx 技能的 Installed 段落）
python <office-skills>/scripts/check_office.py UI确认书.docx --out checks.json \
  --contains "小程序界面：" --contains "以下无正文"

# 渲染目检（LibreOffice Kit）
node <cli.js> render --input UI确认书.docx --output-dir _render --dpi 90 --pages 1,2,10,11
```

目检重点：图注与图片是否同页（图注段应带 keepNext）、板块标题是否掉在页尾、图片是否被页边裁切、
结论页与签署页是否完整。确认后 `convert` 出 PDF。

## 常见坑

**小程序侧**

1. 用 PowerShell 启动微信开发者工具前必须清掉 `ELECTRON_RUN_AS_NODE`（本机环境常被父进程设为
   `1`），否则 exe 当 Node 运行，报 `bad option: --disable-gpu` 并立刻退出。
2. 服务端口设置存于
   `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\WeappLocalData\localstorage_*.json`
   的 `security.enableServicePort`，改完需重启开发者工具；重启后同目录出现 `.ide` 与
   `.ide-status`（内容 `On`）即生效。**改前备份**。
3. 截图分辨率上限就是模拟器输出（iPhone 12/13 Pro 约 289×625）。CDP 对渲染层做
   `setDeviceMetricsOverride` 或 `clip.scale` 会得到平铺错图，不要在这上面耗时间；直接按
   3.9in 宽放进文档即可。
4. `miniprogram-automator` 的 `mp.close()` 会结束自动化会话，之后必须重新 `cli auto`。
5. `cli auto` 输出被 `Select-Object -First N` 之类的管道提前关闭，IDE 会退出自动化模式；
   要重定向到文件或整段读完。

**Web 侧**

6. SPA 后台的登录态常存在内存里，截图过程中不要 `goto` 刷新；用 `menu` 点菜单切换页面。
7. Element Plus 弹窗/抽屉关闭统用 `esc` + `waitGone`，选择器统一写 `.el-overlay`，比区分
   `el-dialog` / `el-drawer` 稳。
8. 项目在确认书签发前又改过版的话，旧截图就作废了——重跑一遍脚本比补图快；交付时把截图时间写进汇报。

**文档侧**

8. 克隆模板段落时只保留第一个 `w:r` 的格式再改文字；直接 `paragraph.text = ...` 会丢掉字号与加粗。
9. 新增的板块标题要加 `w:keepNext`，否则标题孤零零落在页尾、图片翻到下一页。
10. 图片高度按 `宽 × 原始高/宽` 计算后显式传入，避免 python-docx 按 96dpi 猜出的尺寸溢出页面。

## 目录结构

```
ui-confirmation-doc/
├── SKILL.md
├── CHANGELOG.md
├── scripts/cdp.mjs                 无头 Chromium + CDP 驱动与页面动作词表
├── scripts/web-capture.mjs        按 plan.json 逐屏截图（Web 后台）
├── scripts/mp-capture.cjs         微信开发者工具自动化截图（小程序）
├── scripts/build_docx.py          套模板生成确认书（保留模板版式与措辞）
├── references/scope-policy.md     截图范围口径（一级全覆盖 + 二级抽样，数量红线）
├── references/plan-example.json   Web 截图计划示例
├── references/mp-plan-example.json 小程序截图计划示例
└── references/manifest-example.json 文档清单示例
```

## 交付前自检

- [ ] 一级页面一页不漏，二级页每端不超过 5 张，总数 16–24
- [ ] 模板的结论措辞、签署表、页面设置未被改动
- [ ] 图号连续，图注带真实路由，中文参数没有被 URL 编码
- [ ] 每张图注与图片同页，没有孤页、没有图片被裁
- [ ] 页数、图数在汇报里说明，并说明"按口径未截的页面"（如地址编辑、收藏、客服）
- [ ] docx 与 pdf 同名同源，已 `present`
