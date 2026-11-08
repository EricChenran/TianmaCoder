# 取图脚本的已知陷阱

改脚本前先读这四条。前三条都会让取图**整体失效而不报错**，在 Windows PowerShell 5.1 上尤其容易复发。

## 1. 字节左移会被截断

`[byte]` 做 `-shl` 按字节宽度截断，`0x08 -shl 8` 得 0。解析 JPEG 段长度和宽高时，高字节全部丢失，读出 64×85 这类荒谬尺寸，比例过滤于是把所有图都判为不合格。

```powershell
# 错
$height = ($d[$i + 5] -shl 8) -bor $d[$i + 6]
# 对
$height = ([int]$d[$i + 5] * 256) + [int]$d[$i + 6]
```

## 2. `ConvertFrom-Json` 不会拆开数组

5.1 把整组 JSON 数组当单个对象输出，`@($x)` 包一层不会展开。索引每读一次就套一层数组，`sha256` 去重随之失效，文件越存越乱。

```powershell
$parsed = $raw | ConvertFrom-Json
foreach ($e in $parsed) { [void]$Index.Add($e) }
```

## 3. 无 BOM 的脚本按 GBK 读

含中文的 `.ps1` 必须存成 **UTF-8 with BOM**。否则中文字面量被按 GBK 解析，直接语法错误，报错位置还指向无关行。

## 4. 不要把图片库放进技能目录

技能目录每次发布都会被整体覆盖，安装位置也可能是只读的。图库必须放在用户可写的数据目录，用 `-StoreRoot` 或 `DSH_IMAGE_STORE` 指定。

## 图源事实（2026-11-08 实测）

| 图源 | 检索页 | 直链 |
|---|---|---|
| Pexels | 200，单页约 40 条直链，无拦截 | 200，秒级 |
| Unsplash | 401 | 200，但要图片编号 |
| Pixabay | 403 | 200，但要完整路径 |

按图片编号拼直链命中率约六分之一，不可依赖。

## 5. 不要用 Invoke-WebRequest 抓检索页

Windows PowerShell 5.1 的 `Invoke-WebRequest` 请求 Pexels 检索页稳定返回 403，即使补上 TLS 1.2、`Accept`、`Accept-Language`、`Sec-Fetch-*` 等浏览器请求头也一样；同一时刻 `curl.exe` 返回 200。因此脚本只走 `curl.exe`，缺少时直接报错，不要重新引入这个回退。
