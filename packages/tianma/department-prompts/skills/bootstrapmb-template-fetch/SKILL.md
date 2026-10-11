---
name: bootstrapmb-template-fetch
display_name: "bootstrapmb 模板源码抓取"
display_name_en: "BootstrapMB Template Source Fetcher"
description: >-
  给一个 bootstrapmb.com 的项目 ID，把该模板的完整前端源码抓回本地：解析预览壳页
  拿到真实源码地址、拉取官方文件树、全量下载、再按引用补齐文件树漏掉的依赖
  （assets/libs、vandor、webfonts 等），最后剥离演示版注入的防调试脚本、水印注释
  与强制跳转守卫，并按原编码写回（站点混用 UTF-8 与 GBK），产出可直接打开的镜像。
  全程无需登录，三个未鉴权接口即可打通；换 ID 即换项目，零配置。
  适用于：批量收集某站的模板源码、把线上 demo 落到本地做离线参考、
  评估模板质量（顺带查出模板自身的断链、CSS 变量误用、素材水印等缺陷）。
  触发词：bootstrapmb、模板源码下载、下载模板、抓取模板、项目ID 下载源码、
  在线预览源码、item 预览、扒模板、template source download。
description_zh: "给 bootstrapmb.com 项目 ID 即抓回完整模板源码：解析隐藏的真实源码地址、补齐文件树漏列的依赖、剥离演示版水印与跳转守卫、按原编码写回，产出可离线打开的镜像，全程免登录。"
description_en: "Fetch a full template source tree from bootstrapmb.com by item ID: resolve the hidden real source URL, recover dependencies the official file tree omits, strip demo-only anti-debug and watermark injections with encoding preserved, and emit an offline-openable mirror — no login required."
category: web
version: 1.0.0
runtime: generic
tags:
  - "bootstrapmb"
  - "模板源码"
  - "源码下载"
  - "爬虫"
  - "逆向"
  - "PowerShell"
agent_created: true
---

# bootstrapmb 模板源码抓取

给一个项目 ID，把模板源码整棵抓回本地。

```powershell
pwsh -File scripts/download-bootstrapmb.ps1 -ItemId 16713
```

跑完得到两套目录：`bootstrapmb-<ID>`（原始镜像）和 `bootstrapmb-<ID>-clean`（干净版），
外加首页截图 `_preview_<ID>.png` 和元数据 `_meta.json`。

---

## 一、什么时候用 / 不用

| 用 | 不用 |
|---|---|
| 想拿到某个模板的完整前端源码做参考 | 项目是微信小程序模板（站点自己也没做预览） |
| 批量收集同类模板（换 ID 即可，脚本可循环） | 项目是 WordPress 主题 / 插件（不是静态模板） |
| 评估模板质量：断链、废弃依赖、素材水印 | 需要付费包里的 SCSS 源文件 / PHP 后端（demo 不提供） |
| 把线上 demo 落成本地离线副本 | 需要商业授权才能使用（**抓回来 ≠ 有授权**） |

> **授权提醒**：本技能只搬取公开演示页的静态资源，不破解付费内容。
> 用于生产前请自行确认模板授权。站点在 demo 里明示"下载的源码里没有这些备注"，
> 即演示代码与付费代码功能相同。

---

## 二、核心原理（三个未鉴权接口）

完整逆向笔记见 [references/endpoints.md](references/endpoints.md)。一句话版本：

```
1) GET  /item/<ID>                       → 详情页里的 view="YYYY/M/xxxx<ID>"
2) GET  /item/<ID>/preview  (★带Referer) → <iframe src="https://v.bootstrapmb.com/<view>">
3) POST /_Ajax/Opt  oper=getTree         → 完整目录树
   ↓
   GET  https://v.bootstrapmb.com/<view>/<相对路径>   ← 源码本体，免登录
```

**最容易踩的坑**：第 2 步不带 `Referer` 时，服务端返回的 HTML 与详情页**逐字节相同**，
看起来像"预览功能坏了"。带上 `Referer` 才会吐出真正的 iframe 地址。

---

## 三、脚本做了什么（8 步）

| 步 | 动作 | 关键点 |
|---|---|---|
| 1 | 读元信息 | 取 `view`、标题、分类、官方标注大小 |
| 2 | 解析源码根地址 | 带 `Referer` 请求预览页，取 iframe src |
| 3 | 拉文件树 | `/_Ajax/Opt` + `oper=getTree`，解析嵌套 `<li>/<ul>` |
| 4 | 全量下载 | 带 Referer，失败重试 3 次 |
| 5 | **补齐依赖** | 扫 HTML/CSS 引用，补文件树漏掉的 `assets/libs`、`vandor`、`webfonts` |
| 6 | 完整性校验 | 逐条验证内部引用，列出未解析项 |
| 7 | 生成干净版 | 剥外链 / 水印 / 守卫 + 修根相对路径 |
| 8 | 截图验证 | 无头 Edge/Chrome 渲染首页出 PNG |

### 第 5 步是必需项，不是可选项

官方文件树**不完整**，实测差距很大：

| ID | 站点声明 | 树里列出 | 补齐后实际 |
|---|---|---|---|
| 15389 | 251 | 217 | 251 |
| 16713 | 315 | **194** | 247 |
| 8047 | 295 | 285 | 236 |

16713 靠这一步从 149 个文件补到 247 个（+98），其中包括整个 `webfonts/` 字体目录——
少了它全套图标都不显示。

补齐时对引用尝试**两种候选路径**：相对引用所在目录、相对站点根。
后者是必需的，因为模板作者常把 `url(assets/img/x.png)` 这种根相对路径写进子目录的 CSS。

> **自己改写这段逻辑时注意**：判断文件是否落在输出目录内，不要用
> `$path.StartsWith($dest)`。若输出目录位于 8.3 短路径下（如 `%TEMP%` 常是
> `C:\Users\ADMINI~1\...`），`Get-ChildItem` 返回的是长路径，`StartsWith` 恒为 false，
> **整个补齐步骤会静默跳过且不报错**。先 `$dest = (Get-Item -LiteralPath $dest).FullName`
> 规范化，再用忽略大小写 + 带分隔符边界的比较。

---

## 四、参数

```powershell
pwsh -File scripts/download-bootstrapmb.ps1 -ItemId <ID> [选项]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-ItemId` | 必填 | 项目 ID，`item/16713/preview` 就填 `16713` |
| `-OutRoot` | 当前工作目录 | 输出根目录 |
| `-CodeOnly` | 关 | 只下 html/css/js，快速看代码 |
| `-NoClean` | 关 | 不生成干净版 |
| `-NoRepairPaths` | 关 | 不修 CSS 根相对路径 |
| `-NoShot` | 关 | 不截图 |

批量抓取：

```powershell
foreach ($id in 15389, 16713, 8047, 11854) {
    pwsh -File scripts/download-bootstrapmb.ps1 -ItemId $id
}
```

---

## 五、五个必读的坑

### 1. 编码：站点混用 UTF-8 和 GBK

同一个项目里都可能不一致（8047 是 HTML 用 UTF-8、CSS/JS 用 **GBK**）。
**按 UTF-8 读、按 UTF-8 写回会毁掉 GBK 里的中文注释。**
脚本按「UTF-8 BOM → 严格 UTF-8 → 失败则 GBK/CP936」嗅探，改完按原编码写回。
自己写脚本处理这个站的文件时，务必照做。

### 2. 水印文案各版不同，只能按域名匹配

| ID | 提示文案 | host 自检串 | 跳转写法 |
|---|---|---|---|
| 15389 | 这是演示代码,不是源代码… | `ot` | `top.location=` |
| 16713 | 当前为演示代码，源码出处… | `ap` | `window.location=` |
| 8047 | 此代码已混淆,不是源代码… | `stra` | `location.href=` |

中文文案完全不可靠。`ot`/`ap`/`stra` 都是 `bootstrapmb` 的子串（它这样放行自家域名）。
**一律以 `bootstrapmb.com` 域名为锚点**去匹配。

### 3. 必须用 `file://` 打开

注入的守卫是 `if(location.href.indexOf('ile:')<0 && ...)`，只放行 `file:`
和含自检串（即自家域名）的地址。所以：

| 打开方式 | 结果 |
|---|---|
| `file://` 双击 | 正常 ✅ |
| `localhost` / `127.0.0.1` 起服务 | **被强行跳到广告页 + 弹 5 次警告** ❌ |

干净版已剥离守卫，但统一用 `file://` 最省事。

### 4. 图片可能是「模糊 + 烧录水印」的降级素材

部分项目（尤其早期项目）的照片素材被**像素级降级**：背景虚化 + 中央烧录
`bootstrapmb.com` 水印。实测 8047 的 `assets/img/slider/slider-1.jpg` 即是。
**脚本改不回来**，清晰无水印原图只在付费包里。图标、插画类矢量素材通常干净。
脚本会截图让你直接肉眼判断。

### 5. 这些"失败"是正常的

| 现象 | 原因 |
|---|---|
| 一批 `.scss` 下不来 | SCSS 源文件只在付费包，demo 不部署 |
| `assets/php/mail.php`、`contact-form.php` 404 | 后端脚本不在 demo 里，表单必然不通 |
| `帮助文档/**` 404 | 中文目录名的帮助文档只在付费包 |
| `owl.video.play.png` 缺失 | Owl Carousel 自带的老毛病，多个模板都缺 |
| 剩余若干"未解析引用" | 服务器上也是 404，是模板自身断链，不是抓取失败 |

判断标准：拿未解析的路径去 `v.bootstrapmb.com` 直接请求，**也是 404** 就说明是模板的问题。

---

## 六、验收抓取结果

脚本自己会校验，看这三行就够：

1. `镜像共 N 个文件 / X MB` —— 与官方标注大小比较，差太多说明有缺
2. `检查 N 处引用，未解析 M 处` —— M 应当很小（个位数），且都能在服务器上复现 404
3. `残留检查通过，干净` —— 干净版无注入残留

再打开 `_preview_<ID>.png` 看一眼：**布局正常、图标显示 = 抓取完整**。
若截图里样式全丢，通常是 `assets/css` 没下全或路径修复没生效。

---

## 七、已验证案例

见 [references/case-notes.md](references/case-notes.md)（含三个项目的实测数据，
以及顺带查出的模板自身缺陷：CSS 变量名少一横导致 5 条规则静默失效、
`wishlist.html` 引用整个不存在的 `gsap/` 目录等）。
