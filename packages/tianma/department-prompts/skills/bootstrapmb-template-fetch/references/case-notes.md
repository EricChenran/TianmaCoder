# 实测案例与模板缺陷记录

> 三个项目全部实跑验证，数据为脚本最后一次运行的输出。

---

## 一、抓取结果对比

| ID | 标题 | view | 官方声明 | 树里列出 | 补齐 | 最终文件 | 大小 |
|---|---|---|---|---|---|---|---|
| 15389 | 教育行业和大学网站HTML5模板 Eginay | `2024/10/cpu7h15389` | 251 | 217 | +34 | **251** | 7.28 MB |
| 16713 | 电子商务项目Bootstrap模板 Bevy | `2026/8/ucrc16713` | 315 | 194 | **+98** | **247** | 12.18 MB |
| 8047 | 绿色大气教育行业学校网站 Glaxdu | `2020/5/ggek98047` | 295 | 285 | +0 | **236** | 23.5 MB |

注意 16713：树里只列出 194 个，实际有 247 个 —— **差 98 个文件全靠第 5 步补齐**。
若跳过补齐步骤，得到的是一个缺整套字体和图标的残废镜像。

## 二、清理结果对比

| ID | HTML 外链 | JS 水印/守卫 | CSS 水印注释 | 路径修复 | 未解析引用 |
|---|---|---|---|---|---|
| 15389 | 23 文件 / 23 处 | 12 文件 / 48 处 | 0 | 无需 | 3 |
| 16713 | 8 文件 / 8 处 | 4 文件 / 16 处 | 0 | 1 文件 / 5 处 | 11 |
| 8047 | 0 | **7 文件 / 28 处** | **16 文件 / 32 处** | 无需 | 1 |

8047 最初（按中文文案匹配的窄正则）清理结果是 **0** —— 文案完全不同导致漏清。
改成按域名匹配后抓到 28+32 处。这是本技能最核心的一个修正。

### 编码情况

| ID | HTML | CSS / JS | 中文字符来源 |
|---|---|---|---|
| 15389 | UTF-8 | UTF-8 | 仅 JS 水印 |
| 16713 | UTF-8 | UTF-8（含 BOM） | 仅 JS 水印 |
| 8047 | UTF-8 | **GBK** | 水印注释，共 1480 字 |

8047 清理后：1480 个水印中文字符 → 0，**其余内容零损坏，全部文件解码正常**。

---

## 三、素材降级（无法修复）

`bootstrapmb` 对部分项目的照片素材做了**像素级降级**：

```
8047  assets/img/slider/slider-1.jpg   1920x845
      → 背景明显虚化，画面中央烧录 "bootstrapmb.com / 更多精品模板请访问 ↗"
```

这是图像内容本身被改过，任何脚本都无法还原。同项目的图标、插画类素材是干净的。
判断方法：跑完看 `_preview_<ID>.png` 截图即可肉眼确认。

---

## 四、顺带查出的模板自身缺陷

这些**不是抓取失败**，是模板本身的 bug（在服务器上请求同样是 404）。

### 公共问题

| 问题 | 出现于 | 说明 |
|---|---|---|
| `owl.video.play.png` 缺失 | 15389、8047 | Owl Carousel 的 `owl.carousel.min.css` 引用它，但包内从没打包过这个图标 |
| 联系表单无后端 | 15389、8047 | POST 到 `contact-form.php` / `assets/php/mail.php`，包内都没有 |
| 帮助文档目录缺失 | 8047 | `帮助文档/**` 共 19 个文件只在付费包 |
| SCSS 源文件缺失 | 三个都有 | demo 只部署编译后的 CSS |

### 15389（Eginay）

| 问题 | 位置 | 说明 |
|---|---|---|
| 路径少一个斜杠 | `index2.html`、`index3.html` | 写成 `assets/images/home2favicon/apple-icon-60x60.png`，应为 `home2/favicon/...` |
| **CSS 变量名少一横** | `assets/css/blog.css` | 声明是 `--primary--color`（双横线），却 5 次写成 `var(--primary-color)`。同文件正确写法用了 56 次 → 这 5 条规则的颜色静默失效 |
| 字体声明未加载 | `custom.css` | 用了 `"Barlow"` 但页面从未引入该字体 |
| 倒计时死日期 | `assets/js/custom.js` | 硬编码 `'2024'` 和 `'09/14/'` |

### 16713（Bevy）

| 问题 | 位置 | 说明 |
|---|---|---|
| **根相对路径写在子目录 CSS 里** | `assets/css/external-inline.css` | `url(assets/imgs/.../x.jpg)` 共 5 处。CSS 在 `assets/css/` 下，浏览器解析成 `assets/css/assets/imgs/...` → 线上 demo 自己也 404。脚本已自动改写修复 |
| **整页脚本全断** | `wishlist.html` | 引用 `assets/vandor/jquery/jquery.min.js`（包内只有 `jquery.js`）和整个 `assets/vandor/gsap/` 目录（不存在）→ 该页所有交互失效 |
| FontAwesome Pro 字体不全 | `fontawesome-pro.min.css` | CSS 里同时声明 `.woff2` 和 `.ttf`，但只有 `.woff2` 被打包。浏览器会优先用 woff2，实际无影响 |

> 16713 用的 `fontawesome-pro.min.css` 是 **Font Awesome Pro**（商业授权版本）。
> 即使拿到 webfonts，商用也需要相应授权。

### 8047（Glaxdu）

| 问题 | 位置 | 说明 |
|---|---|---|
| jQuery 版本极旧 | `assets/js/vendor/jquery-1.12.4.min.js` | 2016 年版本，含已知安全漏洞 |
| 素材水印 | slider / banner 照片 | 见上节 |

---

## 五、三个项目的技术栈

| ID | 框架 | 关键库 | 页面数 |
|---|---|---|---|
| 15389 | Bootstrap **4.0.0** | jQuery 3.7.1、Owl Carousel、WOW.js、magnific-popup、Font Awesome **6.5.1** | 23 |
| 16713 | Bootstrap（vandor 目录） | jQuery、Swiper、Font Awesome **Pro**、GSAP | 22 |
| 8047 | Bootstrap **3** | jQuery **1.12.4**、Owl Carousel、Slick、Modernizr | 17 |

三个模板都是**纯静态、无构建工具、无 package.json**，HTML + 手写 CSS + jQuery 插件。

---

## 六、复现命令

```powershell
foreach ($id in 15389, 16713, 8047) { pwsh -File scripts/download-bootstrapmb.ps1 -ItemId $id }
```

单次耗时：4.7s（15389，7MB）～ 134s（8047，23.5MB），主要时间花在图片下载。
