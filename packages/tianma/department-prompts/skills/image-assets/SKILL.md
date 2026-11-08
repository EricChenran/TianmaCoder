---
name: image-assets
description: 技术部配图取用：按检索词从 Pexels 抓真实照片，并发下载、按比例与尺寸过滤、校验与去重，落本地图库并复制进工程 assets；支持库内复用与离线重取。触发词：配图、图片素材、真实照片、商品图、封面图、横幅大图、背景图、头像、免版权图、下载图片、找不到图、banner 没有素材。
---

# 配图取用

前端做首屏、商品卡、专题位时缺图，用这个技能取真实照片：按检索词抓取，按比例和尺寸过滤，校验后用内容哈希去重，存进本地图库，再复制进工程目录。

## 为什么不走联网搜索

联网搜索加页面抓取每张图要两三次往返，还要解析渲染后的页面，图源站点还会直接拒绝访问。实测结论：Unsplash 检索页返回 401、Pixabay 检索页返回 403，只有 Pexels 检索页可以直接取到图片直链，单页约四十条。图片地址也不能靠编号拼：按图片编号猜直链实测约六分之一命中。所以本技能固定抓 Pexels 检索页，其余图源只在本地库里复用，不做检索。

## 前置条件

- Windows PowerShell 5.1 即可，不要求 PowerShell 7。
- 需要 `curl.exe`（Windows 10 1803 起随系统提供）。实测 `Invoke-WebRequest` 会被图源站点以 403 拒绝，补 TLS 与浏览器请求头均无效，因此脚本不做回退：缺 curl 时明确报错，并提示改用库内复用。
- 图片库默认在用户本地数据目录，可用环境变量 `DSH_IMAGE_STORE` 覆盖。**不要**把图存进技能目录：技能目录每次发布都会被覆盖，安装在只读位置时也不可写。

## 用法

首次取图并直接放进工程：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Get-Image.ps1 -Query "coffee shop" -Count 6 -Orientation landscape -MinWidth 1200 -CopyTo <工程目录>\Frontend\web\src\assets
```

同类需求复用库里已有的图，不联网：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Get-Image.ps1 -Query "咖啡" -Count 4 -LibraryOnly
```

中文检索词会先查内置对照表转英文；Pexels 中文检索命中率低，尽量直接给英文词。

## 参数

| 参数 | 说明 |
|---|---|
| `-Query` | 检索词，必填 |
| `-Count` | 需要张数，默认 8 |
| `-Orientation` | `landscape` 横幅与首屏大图、`portrait` 竖版专题、`square` 头像位、`any` 不过滤 |
| `-MinWidth` | 最小宽度像素，挡掉缩略图尺寸 |
| `-CopyTo` | 复制到目标工程目录 |
| `-LibraryOnly` | 只查本地库，不联网 |
| `-StoreRoot` | 图库根目录，默认取 `DSH_IMAGE_STORE` 或用户本地数据目录 |
| `-BudgetSec` | 整批时间预算，默认 90 秒 |
| `-Throttle` | 并发数，默认 6 |

## 输出与退出码

标准输出是一段 JSON，含 `saved`、`failed`、`files`、`storeDir`、`elapsedMs`。

| 退出码 | 含义 | 接下来做什么 |
|---|---|---|
| 0 | 成功，且达到需求数一半以上 | 直接用 |
| 2 | 库内无命中 | 去掉 `-LibraryOnly` 重新抓 |
| 3 | 检索无候选 | 换更通用的英文词 |
| 4 | 成功数不足一半 | 放宽比例或尺寸条件，或降级到本地绘制的占位图 |
| 5 | 缺少 curl.exe | 安装 curl，或改用 `-LibraryOnly` 复用库内图片 |

退出码非 0 时不要把时间耗在反复重试上：先用库内存量图，再退到本地绘制的拟真占位图。

## 交付要求

- 图片必须落进工程目录，运行时禁止外链。
- 图源为 Pexels License，免费商用、无需署名；`index.json` 保留原始地址便于回溯。
- 交付说明里记录图源，并提醒上线前替换为自有素材。
- 内容图走真实照片；小尺寸功能图标走图标库或自绘线性图标，两者不混用。

## 维护

改动脚本前先看 `references/pitfalls.md`，里面记着三个会让取图整体失效的 PowerShell 5.1 陷阱。
