# bootstrapmb.com 接口逆向笔记

> 本文记录抓取 `bootstrapmb.com` 模板源码所依赖的接口与数据结构。
> 所有结论均为实测得出，未使用任何登录态。

---

## 一、站点结构总览

```
www.bootstrapmb.com          站点本体（详情页 / 搜索 / 文件树接口）
   └── /item/<ID>            项目详情页
   └── /item/<ID>/preview    预览壳页（iframe 容器）
        └── v.bootstrapmb.com/<view>    ★ 模板源码本体（静态文件服务器）
cdn.bootstrapmb.com          演示页注入的防调试脚本 CDN
imgs.bootstrapmb.com         缩略图 / 用户头像
```

关键认知：**详情页与预览页是两个不同的东西**，而**源码不在 `www` 域，在 `v` 域**。

---

## 二、三个未鉴权接口

### 1. 详情页 —— 取 `view`（上传目录键）

```
GET https://www.bootstrapmb.com/item/<ID>
```

从返回 HTML 中提取：

```html
<div id="treeview" view="2024/10/cpu7h15389">   <!-- view = 上传目录键 -->
<input id="resourcesID" type="hidden" value="15389">
<a class="fenlei" href="/muban/jiaoyu">教育培训</a>   <!-- 分类 -->
文件大小：5.68M
```

`view` 的形态是 `YYYY/M/xxxx<ID>`，例如：

| ID | view |
|---|---|
| 15389 | `2024/10/cpu7h15389` |
| 16713 | `2026/8/ucrc16713` |
| 8047 | `2020/5/ggek98047` |

注意 8047 的 `ggek98047` —— ID 前面还多一个 `0`，**不要试图拼 ID 猜路径**，必须从详情页取。

### 2. 预览壳页 —— 取源码根地址（★ 必须带 Referer）

```
GET https://www.bootstrapmb.com/item/<ID>/preview
Referer: https://www.bootstrapmb.com/item/<ID>
```

**这是最关键的一步，也是最容易踩的坑**：不带 `Referer` 时，服务端返回的 HTML 与
`/item/<ID>` 详情页**逐字节相同**（实测 12648 B，5 个不同 item 全部如此），看起来像"预览功能坏了"。

带上 `Referer` 后返回 3.7 KB 的预览框架页，内含真正的地址：

```html
<iframe id='iframe1' src='https://v.bootstrapmb.com/2024/10/cpu7h15389' ...></iframe>
```

> 实测结论：`iframe/@src` **恒等于** `https://v.bootstrapmb.com/` + `view`。
> 所以拿到 `view` 就能推断出源码地址，第二步只是用来交叉验证。

### 3. 文件树 —— 取目录结构

```
POST https://www.bootstrapmb.com/_Ajax/Opt
Content-Type: application/x-www-form-urlencoded

oper=getTree & view=<view> & id=<ID>
```

返回嵌套 `<ul>/<li>/<span>` 的目录树 HTML：

```html
<h4>教育行业和大学网站HTML5模板（共251个文件）</h4>
<div class="treeview"><ul id="code_tree" class="filetree">
  <li class="expandable"><span class="folder">assets</span>
    <ul><li><span class="css">bootstrap.min.css</span></li></ul>
  </li>
  ...
```

文件名带类型 class：`folder` / `css` / `js` / `img` / `html`。

`/_Ajax/Opt` 是个通用操作分发接口，`oper` 还支持
`getdetailnum` / `Liked` / `isvip` / `isfree` / `searchkey` / `browseitem` 等。

---

## 三、下载

源码根地址确定后，直接按相对路径取即可，无需任何鉴权：

```
GET https://v.bootstrapmb.com/<view>/<相对路径>
Referer: https://www.bootstrapmb.com/item/<ID>/preview
```

---

## 四、文件树的三个坑

### 坑 1：树是**不完整**的

站点声明的文件数往往大于树里列出的条目：

| ID | 声明 | 树里列出 | 补齐后实际 |
|---|---|---|---|
| 15389 | 251 | 217 | 251 |
| 16713 | 315 | 194 | 247 |
| 8047 | 295 | 285 | 236 |

**必须**再扫一遍已下载 HTML/CSS/JS 里的相对引用，把缺的补下来
（典型缺口：`assets/libs/`、`assets/vandor/`、`webfonts/`、图标字体）。

### 坑 2：树里列了，但 demo 服务器不提供

以下几类只存在于付费包，demo 站一律 404，属正常现象，**不要当成下载失败**：

| 类型 | 例子 |
|---|---|
| SCSS 源文件 | `assets/scss/components/_button.scss` |
| 后端脚本 | `assets/php/mail.php`、`contact-form.php` |
| 帮助文档 | `帮助文档/**`（中文目录名） |

### 坑 3：CSS 里的根相对路径

模板作者常把 `url(assets/img/x.png)` 这种**根相对路径**写进**子目录**的 CSS。
浏览器会按「相对本 CSS」解析成 `assets/css/assets/img/x.png` → 线上 demo 自己也是 404。

实测 16713 的 `assets/css/external-inline.css` 有 5 处这种问题。
抓取时可尝试「相对引用目录」和「相对站点根」两种候选路径，并可选地把它们改写成正确的相对路径。

---

## 五、注入物（演示版专有）

站点在 demo 文件里注入了三类东西，**付费包里没有**：

### 1. HTML：防调试脚本外链

```html
<script src="https://cdn.bootstrapmb.com/console-ban.min.js"></script>
```

11 KB 混淆代码。实测行为：

| 打开方式 | 结果 |
|---|---|
| `file://` | 正常 ✅ |
| `http://localhost:8080` | 弹 5 次 `扒皮代码，不可用` ❌ |
| `http://127.0.0.1:5500` | 弹 5 次 ❌ |
| `https://v.bootstrapmb.com/...` | 正常（自家域名被放行）|

### 2. JS：水印 + 强制跳转守卫

注入在**每个 JS 文件的首尾**。文案各年代不同，但结构一致：

```js
console.log('<任意提示，含 bootstrapmb.com>');
if(location.href.indexOf('ile:')<0){
  if(location.href.indexOf('<host自检串>')<0){
    <top.location|window.location|location.href>='<任意跳转地址>'
  }
}
```

实测到的变体：

| ID | 提示文案 | host 自检串 | 跳转写法 |
|---|---|---|---|
| 15389 | 这是演示代码,不是源代码… | `ot` | `top.location=` |
| 16713 | 当前为演示代码，源码出处… | `ap` | `window.location=` |
| 8047 | 此代码已混淆,不是源代码… | `stra` | `location.href=` |

注意 `ot` / `ap` / `stra` **都是 `bootstrapmb` 的子串**——这是它放行自家域名的方式。

**清理要点**：不要按中文文案匹配（各版不同），**以 `bootstrapmb.com` 域名为锚点**。

`file:` 检查意味着：用 `file://` 打开时守卫不触发；但用 localhost 起服务会被强行跳到广告页。

### 3. CSS：水印注释

```css
/*此代码已混淆,不是源代码。源码地址唯一出处: http://www.bootstrapmb.com/item/8047。(这个说明仅在演示里会看到,下载的源码里没有。)*/
```

夹在压缩 CSS 的首尾，同样按域名匹配清理。

### 4. 图片：模糊 + 烧录水印（**无法清理**）

部分项目（尤其早期项目）的**照片素材被模糊化并烧录了 `bootstrapmb.com` 水印**：

```
assets/img/slider/slider-1.jpg  →  1920x845，背景虚化，中央有 "bootstrapmb.com / 更多精品模板请访问 ↗"
```

这是**像素级损坏，脚本改不回来**。清晰无水印原图只在付费包里。
图标、插画之类矢量素材通常是干净的。

---

## 六、编码陷阱

站点不同年代注入的模板**混用 UTF-8 与 GBK**，同一个项目里都可能不一致：

| ID | HTML | CSS/JS |
|---|---|---|
| 15389 | UTF-8 | UTF-8 |
| 16713 | UTF-8 | UTF-8 |
| 8047 | UTF-8 | **GBK** |

**按 UTF-8 读、按 UTF-8 写回，会把 GBK 文件里的中文注释全部毁成乱码。**

正确处理：先嗅探（UTF-8 BOM → 严格 UTF-8 解码 → 失败则按 GBK/CP936），改完按原编码写回。

```powershell
$bytes  = [System.IO.File]::ReadAllBytes($path)
$strict = New-Object System.Text.UTF8Encoding($false, $true)   # throwOnInvalidBytes
try   { $text = $strict.GetString($bytes);              $enc = 'utf8' }
catch { $text = [Text.Encoding]::GetEncoding(936).GetString($bytes); $enc = 'gbk' }
```

---

## 七、不适用的情况

- `view` 属性缺失 → 该项目不是可预览的 HTML 模板（小程序 / WordPress 主题 / 插件）
- 分类为"微信小程序模板" → 站点自己也没做预览
