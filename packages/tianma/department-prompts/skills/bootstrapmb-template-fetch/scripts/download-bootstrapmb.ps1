<#
.SYNOPSIS
  通过 bootstrapmb.com 的项目 ID 快速下载模板源码。

.DESCRIPTION
  原理（三个未鉴权接口，无需登录）：

    1) 详情页 https://www.bootstrapmb.com/item/<ID>
         └─ <div id="treeview" view="YYYY/M/xxxx<ID>">   ← view 就是上传目录键
    2) 预览壳页 https://www.bootstrapmb.com/item/<ID>/preview   【必须带 Referer: 详情页】
         └─ <iframe src="https://v.bootstrapmb.com/<view>">      ← 真正的模板源码地址
    3) 文件树 POST https://www.bootstrapmb.com/_Ajax/Opt
         Body: oper=getTree & view=<view> & id=<ID>
         └─ 返回完整目录树 HTML

  拿到源码根地址后即可全量下载；再抓一遍 HTML/CSS 里的相对引用，补上目录树
  没列出的 assets/libs（Font Awesome、magnific-popup 等），最后剥掉站点注入的
  防调试外链与跳转守卫。

.PARAMETER ItemId
  bootstrapmb 项目 ID，例如 item/16713/preview 就填 16713。

.PARAMETER OutRoot
  输出根目录，默认当前工作目录。

.PARAMETER NoClean
  只产出原始镜像，不生成干净版。

.PARAMETER CodeOnly
  只下载 html/css/js，不下载图片字体（快速看代码时用）。

.EXAMPLE
  pwsh -File download-bootstrapmb.ps1 -ItemId 16713
  pwsh -File download-bootstrapmb.ps1 -ItemId 15389 -OutRoot D:\tpl -CodeOnly
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateRange(1, 9999999)]
    [int]$ItemId,

    [string]$OutRoot = '.',

    [switch]$NoClean,
    [switch]$NoRepairPaths,
    [switch]$NoShot,
    [switch]$CodeOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
$SITE = 'https://www.bootstrapmb.com'
$CODE_EXT = @('.html', '.htm', '.css', '.js', '.json', '.map', '.scss', '.php', '.txt', '.svg')

function Write-Step($msg) { Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  √ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

function Invoke-Get {
    param([string]$Url, [hashtable]$Headers, [int]$Retry = 3)
    for ($i = 1; $i -le $Retry; $i++) {
        try {
            return Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $Headers -TimeoutSec 45
        } catch {
            if ($i -eq $Retry) { throw }
            Start-Sleep -Milliseconds (400 * $i)
        }
    }
}

function Save-File {
    param([string]$Url, [string]$Path, [hashtable]$Headers, [int]$Retry = 3)
    for ($i = 1; $i -le $Retry; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Path -Headers $Headers -TimeoutSec 60
            return $true
        } catch {
            if ($i -eq $Retry) { return $false }
            Start-Sleep -Milliseconds (400 * $i)
        }
    }
}

# ---------------------------------------------------------------- 1. 项目元信息
Write-Step "步骤 1/8  读取项目 <$ItemId> 元信息"

$itemUrl = "$SITE/item/$ItemId"
$itemHtml = (Invoke-Get -Url $itemUrl -Headers @{ 'User-Agent' = $UA }).Content

$title = [regex]::Match($itemHtml, '<title>(.*?)</title>').Groups[1].Value.Trim()
$view  = [regex]::Match($itemHtml, 'id="treeview"\s+view="([^"]+)"').Groups[1].Value
$size  = [regex]::Match($itemHtml, '文件大小：\s*([^<]+)').Groups[1].Value.Trim()
$cate  = ([regex]::Matches($itemHtml, '<a class="fenlei"[^>]*>([^<]+)</a>') | ForEach-Object { $_.Groups[1].Value }) -join ' / '

Write-Ok "标题: $title"
if ($size) { Write-Ok "官方标注大小: $size" }
if ($cate) { Write-Ok "分类: $cate" }

if (-not $view) {
    Write-Warn "详情页里没有找到 view 属性 —— 该项目可能不是可预览的 HTML 模板（小程序/WordPress/插件等）。"
    Write-Warn "已保存详情页供人工判断: $itemUrl"
    exit 2
}
Write-Ok "view = $view"

# ---------------------------------------------------------------- 2. 预览壳页
Write-Step "步骤 2/8  解析真实源码地址（预览壳页，带 Referer）"

$prevUrl = "$itemUrl/preview"
$prevHtml = (Invoke-Get -Url $prevUrl -Headers @{ 'User-Agent' = $UA; 'Referer' = $itemUrl }).Content

$iframeSrc = [regex]::Match($prevHtml, "<iframe[^>]*src=['""]([^'""]+)['""]").Groups[1].Value
if (-not $iframeSrc) {
    $iframeSrc = "https://v.bootstrapmb.com/$view"
    Write-Warn "预览页未返回 iframe（站点可能改版），按惯例推断地址。"
}
$demoBase = $iframeSrc.TrimEnd('/') + '/'
Write-Ok "源码根地址: $demoBase"

# ---------------------------------------------------------------- 3. 文件树
Write-Step "步骤 3/8  拉取官方文件树"

$treeResp = Invoke-WebRequest -Uri "$SITE/_Ajax/Opt" -Method POST -UseBasicParsing `
    -Headers @{ 'User-Agent' = $UA; 'X-Requested-With' = 'XMLHttpRequest'; 'Referer' = $itemUrl } `
    -Body @{ oper = 'getTree'; view = $view; id = "$ItemId" } -TimeoutSec 45
$treeHtml = $treeResp.Content

if (-not $treeHtml -or $treeHtml.Length -lt 50) {
    Write-Warn "文件树接口返回空，改用「从 index.html 爬取」模式。"
    $paths = @('index.html')
} else {
    $declared = [regex]::Match($treeHtml, '共(\d+)个文件').Groups[1].Value
    if ($declared) { Write-Ok "官方声明文件数: $declared" }

    # 解析嵌套 <li>/<ul> 目录树
    $rx = [regex]'(?s)<li[^>]*>|</li>|<ul[^>]*>|</ul>|<span class="([^"]*)">([^<]*)</span>'
    $stack = New-Object System.Collections.ArrayList
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($m in $rx.Matches($treeHtml)) {
        $v = $m.Value
        if ($v.StartsWith('<ul') -or $v.StartsWith('</ul>')) { continue }
        elseif ($v.StartsWith('</li>')) { if ($stack.Count -gt 0) { $stack.RemoveAt($stack.Count - 1) } }
        elseif ($v.StartsWith('<li')) { [void]$stack.Add($null) }
        else {
            $cls = $m.Groups[1].Value; $name = $m.Groups[2].Value
            if ($cls -eq 'folder') { if ($stack.Count -gt 0) { $stack[$stack.Count - 1] = $name } }
            else {
                $arr = @($stack | Where-Object { $_ -ne $null })
                $paths.Add((($arr + $name) -join '/'))
            }
        }
    }
    $paths = @($paths | Sort-Object -Unique)
    Write-Ok "解析出 $($paths.Count) 个文件"
}

# ---------------------------------------------------------------- 4. 下载
$safe = ($title -replace '[\\/:*?"<>|]', '') -replace '\s+', '_'
$dest = Join-Path $OutRoot "bootstrapmb-$ItemId"
$clean = Join-Path $OutRoot "bootstrapmb-$ItemId-clean"

Write-Step "步骤 4/8  下载到 $dest"

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
# 关键：把 $dest 规范成长路径形式。若 -OutRoot 落在 8.3 短路径下（如
# %TEMP% = C:\Users\ADMINI~1\...），Get-ChildItem 返回的却是长路径
# C:\Users\Administrator\...，后面用 StartsWith($dest) 做归属判断会全部判false，
# 导致「补齐依赖」整步静默跳过。这里统一成同一种形式。
$dest = (Get-Item -LiteralPath $dest).FullName

$headers = @{ 'User-Agent' = $UA; 'Referer' = $prevUrl }
$targets = $paths
if ($CodeOnly) { $targets = @($paths | Where-Object { $CODE_EXT -contains [System.IO.Path]::GetExtension($_).ToLower() }) }

$ok = 0; $fail = 0; $failList = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($rel in $targets) {
    $out = Join-Path $dest ($rel -replace '/', '\')
    $dir = Split-Path $out -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (Save-File -Url ($demoBase + $rel) -Path $out -Headers $headers) { $ok++ }
    else { $fail++; $failList += $rel }
}
$sw.Stop()
Write-Ok "下载完成: 成功 $ok, 失败 $fail, 耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
if ($failList.Count -and $failList.Count -le 10) { $failList | ForEach-Object { Write-Warn "  失效: $_" } }

# ---------------------------------------------------------------- 5. 补齐依赖
Write-Step "步骤 5/8  爬取引用，补齐目录树未列出的依赖（assets/libs 等）"

# 收集「引用点」：{ Dir = 引用所在目录, Ref = 原始相对路径 }
function Get-Refs {
    param([string]$Path)
    $out = New-Object System.Collections.Generic.List[object]
    $txt = Get-Content $Path -Raw -ErrorAction SilentlyContinue
    if (-not $txt) { return $out }
    $dir = Split-Path $Path -Parent
    $ext = [System.IO.Path]::GetExtension($Path).ToLower()
    $patterns = @()
    if ($ext -eq '.css') {
        $patterns += 'url\(\s*[''"]?([^''")]+)[''"]?\s*\)'
        $patterns += '@import\s+[''"]([^''"]+)[''"]'
    } else {
        $patterns += '(?:src|href)\s*=\s*[''"]([^''"]+)[''"]'
        # HTML 内联 <style> 里的 url()
        $patterns += 'url\(\s*[''"]?([^''")]+)[''"]?\s*\)'
    }
    foreach ($p in $patterns) {
        foreach ($m in [regex]::Matches($txt, $p)) {
            $r = $m.Groups[1].Value.Trim()
            if ($r -match '^(https?:)?//|^data:|^mailto:|^tel:|^javascript:|^#|^%|^$') { continue }
            $out.Add([pscustomobject]@{ Dir = $dir; Ref = ($r -split '[?#]')[0] })
        }
    }
    return $out
}

# 判断路径是否位于某根目录下（大小写不敏感 + 带上分隔符，避免同前缀误判）
function Test-PathUnder {
    param([string]$Path, [string]$Root)
    $r = $Root.TrimEnd('\', '/')
    return $Path.Equals($r, [System.StringComparison]::OrdinalIgnoreCase) -or
           $Path.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# 把「引用」解析成候选本地路径：先按常规（相对引用所在目录），再按根相对兜底
# —— 很多模板 CSS 把 url(assets/img/x.png) 这种根相对路径写在子目录的 CSS 里
function Get-Candidates {
    param([string]$Dir, [string]$Ref)
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($cand in @((Join-Path $Dir $Ref), (Join-Path $dest $Ref), (Join-Path $dest $Ref.TrimStart('/')))) {
        try { $full = [System.IO.Path]::GetFullPath($cand) } catch { continue }
        if ((Test-PathUnder -Path $full -Root $dest) -and -not $list.Contains($full)) { $list.Add($full) }
    }
    return $list
}

$queue = New-Object System.Collections.Generic.Queue[object]
foreach ($f in Get-ChildItem $dest -Recurse -File | Where-Object { $_.Extension -in '.html', '.htm', '.css' }) {
    foreach ($e in (Get-Refs -Path $f.FullName)) { $queue.Enqueue($e) }
}

$tried = New-Object System.Collections.Generic.HashSet[string]
$added = 0
while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    # -CodeOnly 只想要代码，这里同样只补代码类依赖
    if ($CodeOnly) {
        $refExt = [System.IO.Path]::GetExtension($cur.Ref).ToLower()
        if ($CODE_EXT -notcontains $refExt) { continue }
    }
    foreach ($fullLocal in (Get-Candidates -Dir $cur.Dir -Ref $cur.Ref)) {
        $relFromDest = $fullLocal.Substring($dest.Length).TrimStart('\') -replace '\\', '/'
        if (-not $tried.Add($relFromDest)) { continue }
        if (Test-Path $fullLocal) { break }   # 已有，换下一个引用点

        $outDir = Split-Path $fullLocal -Parent
        if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
        if (Save-File -Url ($demoBase + $relFromDest) -Path $fullLocal -Headers $headers -Retry 1) {
            $added++
            if ($relFromDest -match '\.css$') {
                foreach ($e in (Get-Refs -Path $fullLocal)) { $queue.Enqueue($e) }
            }
            break   # 命中即止，不再试兜底路径
        }
        # 未命中：删掉可能留下的空文件，继续试下一个候选路径
        if (Test-Path $fullLocal) { Remove-Item $fullLocal -Force -ErrorAction SilentlyContinue }
    }
}
Write-Ok "补下 $added 个依赖文件（含目录树未列出的 assets/vandor、webfonts 等）"

$all = Get-ChildItem $dest -Recurse -File
$totalMB = ($all | Measure-Object Length -Sum).Sum / 1MB
Write-Ok "镜像共 $($all.Count) 个文件 / $([math]::Round($totalMB,2)) MB"

# ---------------------------------------------------------------- 6. 完整性校验
Write-Step "步骤 6/8  内部引用完整性校验"

$missing = @{}
$checked = 0
foreach ($f in Get-ChildItem $dest -Recurse -File -Include *.html, *.htm, *.css) {
    $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $txt) { continue }
    $dir = Split-Path $f.FullName -Parent
    foreach ($e in (Get-Refs -Path $f.FullName)) {
        # -CodeOnly 模式下图片/字体根本没下，校验它们只会刷屏，这里只看代码类引用
        if ($CodeOnly) {
            $refExt = [System.IO.Path]::GetExtension($e.Ref).ToLower()
            if ($CODE_EXT -notcontains $refExt) { continue }
        }
        $checked++
        $hit = $false
        foreach ($fullLocal in (Get-Candidates -Dir $e.Dir -Ref $e.Ref)) { if (Test-Path $fullLocal) { $hit = $true; break } }
        if (-not $hit) {
            $key = "$($f.Name) -> $($e.Ref)"
            if ($missing.ContainsKey($key)) { $missing[$key]++ } else { $missing[$key] = 1 }
        }
    }
}
if ($CodeOnly) { Write-Warn "-CodeOnly 模式：只校验代码类引用，图片/字体缺失属预期" }
Write-Ok "检查 $checked 处引用，未解析 $($missing.Count) 处（去重后）"
if ($missing.Count) {
    Write-Warn "多为模板自身缺陷：路径写法错误，或图片根本没打包"
    $missing.Keys | Sort-Object | Select-Object -First 10 | ForEach-Object { Write-Warn "  $_" }
    if ($missing.Count -gt 10) { Write-Warn "  ...另有 $($missing.Count - 10) 处，详见 _meta.json" }
}

# ---------------------------------------------------------------- 编码安全读写
# 站点在不同年代注入的模板里混用 UTF-8 和 GBK：直接按 UTF-8 读写成回会毁掉中文注释，
# 所以这里先嗅探编码（含 BOM），改完再按原编码写回。
function Read-TextFile {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return [pscustomobject]@{ Text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3); Enc = 'utf8bom' }
    }
    $strict = New-Object System.Text.UTF8Encoding($false, $true)
    try { return [pscustomobject]@{ Text = $strict.GetString($bytes); Enc = 'utf8' } }
    catch { return [pscustomobject]@{ Text = [System.Text.Encoding]::GetEncoding(936).GetString($bytes); Enc = 'gbk' } }
}
function Write-TextFile {
    param([string]$Path, [string]$Text, [string]$Enc)
    switch ($Enc) {
        'utf8bom' { [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($true))) }
        'gbk'     { [System.IO.File]::WriteAllText($Path, $Text, [System.Text.Encoding]::GetEncoding(936)) }
        default   { [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
    }
}

# ---------------------------------------------------------------- 7. 清理注入
if (-not $NoClean) {
    Write-Step "步骤 7/8  生成干净版（剥离防调试外链与跳转守卫）"

    if (Test-Path $clean) { Remove-Item $clean -Recurse -Force }
    New-Item -ItemType Directory -Path $clean -Force | Out-Null
    $clean = (Get-Item -LiteralPath $clean).FullName
    Copy-Item "$dest\*" $clean -Recurse -Force

    # --- 7.1 HTML：去掉 cdn.bootstrapmb.com 的防调试脚本外链
    $htmlN = 0; $tagN = 0
    foreach ($f in Get-ChildItem $clean -Recurse -File -Include *.html, *.htm) {
        $r = Read-TextFile -Path $f.FullName
        $before = ([regex]::Matches($r.Text, '<script[^>]+cdn\.bootstrapmb\.com[^>]*>\s*</script>')).Count
        if ($before -gt 0) {
            $new = [regex]::Replace($r.Text, '<script[^>]+cdn\.bootstrapmb\.com[^>]*>\s*</script>', '')
            Write-TextFile -Path $f.FullName -Text $new -Enc $r.Enc
            $htmlN++; $tagN += $before
        }
    }

    # --- 7.2 JS：水印 + 强制跳转守卫
    # 各年代注入文案完全不同（"这是演示代码" / "当前为演示代码" / "此代码已混淆"），
    # 只有 bootstrapmb.com 这个域名是恒定的；host 自检串也从 'ot'、'ap' 变到 'stra'，
    # 它们都是 "bootstrapmb" 的子串。所以一律以域名为锚点匹配。
    $rxGuard = ";?\s*console\.log\(\s*(['""])[^'""]*bootstrapmb\.com[^'""]*\1\s*\)\s*;?\s*" +
               "(?:if\s*\(\s*location\.href\.indexOf\(\s*(['""])ile:[^'""]*\2\s*\)\s*<\s*0\s*\)\s*\{\s*" +
               "if\s*\(\s*location\.href\.indexOf\(\s*(['""])[^'""]*\3\s*\)\s*<\s*0\s*\)\s*\{\s*" +
               "(?:top\.location|window\.location|location\.href)\s*=\s*(['""])[^'""]*\4\s*;?\s*\}\s*;?\s*\}\s*;?)?"
    $rxLog = ";?\s*console\.log\(\s*(['""])[^'""]*bootstrapmb\.com[^'""]*\1\s*\)\s*;?"

    $jsN = 0; $snipN = 0
    foreach ($f in Get-ChildItem $clean -Recurse -File -Include *.js) {
        $r = Read-TextFile -Path $f.FullName
        $before = ([regex]::Matches($r.Text, $rxGuard)).Count + ([regex]::Matches($r.Text, $rxLog)).Count
        if ($before -gt 0) {
            $new = [regex]::Replace($r.Text, $rxGuard, '')
            $new = [regex]::Replace($new, $rxLog, '')
            Write-TextFile -Path $f.FullName -Text $new -Enc $r.Enc
            $jsN++; $snipN += $before
        }
    }

    # --- 7.3 CSS：注入的水印注释（各版文案也不同，同样按域名匹配）
    $cssN = 0; $cssSnipN = 0
    foreach ($f in Get-ChildItem $clean -Recurse -File -Include *.css) {
        $r = Read-TextFile -Path $f.FullName
        $before = ([regex]::Matches($r.Text, '/\*[^*]*bootstrapmb\.com[^*]*\*/')).Count
        if ($before -gt 0) {
            $new = [regex]::Replace($r.Text, '/\*[^*]*bootstrapmb\.com[^*]*\*/', '')
            Write-TextFile -Path $f.FullName -Text $new -Enc $r.Enc
            $cssN++; $cssSnipN += $before
        }
    }

    Write-Ok "HTML 清理 $htmlN 个文件 / $tagN 处外链"
    Write-Ok "JS   清理 $jsN 个文件 / $snipN 处水印与跳转守卫"
    Write-Ok "CSS  清理 $cssN 个文件 / $cssSnipN 处水印注释"

    $leftover = @()
    foreach ($f in Get-ChildItem $clean -Recurse -File -Include *.html, *.htm, *.js, *.css) {
        $r = Read-TextFile -Path $f.FullName
        if ($r.Text -match 'console\.log\([^)]*bootstrapmb\.com|cdn\.bootstrapmb\.com|top\.location\s*=\s*[''"]https?%3a') {
            $leftover += $f.FullName.Replace("$clean\", '')
        }
    }
    if ($leftover.Count) { $leftover | ForEach-Object { Write-Warn "  仍有残留: $_" } }
    else { Write-Ok "残留检查通过，干净" }

    # --- 7.4 修复 CSS 里的根相对 url()：写在子目录的 CSS 用了 url(assets/img/x.png)，
    #         浏览器会按「相对本 CSS」解析而 404 —— 改写成正确的相对路径
    if (-not $NoRepairPaths) {
        $fixedFiles = 0; $fixedRefs = 0
        foreach ($f in Get-ChildItem $clean -Recurse -File -Include *.css) {
            $r = Read-TextFile -Path $f.FullName
            $dir = Split-Path $f.FullName -Parent
            $new = [regex]::Replace($r.Text, 'url\(\s*([^''")]+?)\s*\)', {
                param($m)
                $u = $m.Groups[1].Value
                if ($u -match '^(https?:)?//|^data:|^#|^$') { return $m.Value }
                $asLocal = [System.IO.Path]::GetFullPath((Join-Path $dir $u))
                if (Test-Path $asLocal) { return $m.Value }                 # 本来就对
                $asRoot = [System.IO.Path]::GetFullPath((Join-Path $clean $u.TrimStart('/')))
                if (-not (Test-Path $asRoot)) { return $m.Value }           # 哪都找不到，别动
                $rel = [System.IO.Path]::GetRelativePath($dir, $asRoot) -replace '\\', '/'
                $script:fixedRefs++
                return "url($rel)"
            })
            if ($new -ne $r.Text) {
                Write-TextFile -Path $f.FullName -Text $new -Enc $r.Enc
                $fixedFiles++
            }
        }
        if ($fixedRefs -gt 0) { Write-Ok "修复根相对路径: $fixedFiles 个 CSS / $fixedRefs 处 url()（模板原有缺陷）" }
        else { Write-Ok "路径修复: 无需处理" }
    }
}

# ---------------------------------------------------------------- 8. 截图验证
$shot = $null
if (-not $NoShot -and -not $NoClean) {
    Write-Step "步骤 8/8  无头浏览器截图验证"

    $browser = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $browser) {
        Write-Warn "未找到 Edge/Chrome，跳过截图"
    } else {
        $entry = @('index.html', 'index1.html', 'index-1.html', 'home.html', 'default.html') |
            ForEach-Object { Join-Path $clean $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $entry) {
            Write-Warn "干净版里没找到 index.html，跳过截图"
        } else {
            $shot = Join-Path $OutRoot "_preview_$ItemId.png"
            if (Test-Path $shot) { Remove-Item $shot -Force }
            $uri = ([System.Uri]$entry).AbsoluteUri
            & $browser --headless=new --disable-gpu --hide-scrollbars --window-size=1440,2000 `
                --virtual-time-budget=9000 --screenshot="$shot" "$uri" 2>&1 | Out-Null
            if (Test-Path $shot) { Write-Ok "截图: $shot" }
            else { Write-Warn "截图失败"; $shot = $null }
        }
    }

    Write-Warn "注意: demo 里的照片素材可能被「模糊化 + 烧录水印」降级，清晰无水印原图只在付费包内。"
    Write-Warn "      请对照上面的截图确认素材是否可用。"
}

# ---------------------------------------------------------------- 汇总
Write-Step "完成"

$meta = [ordered]@{
    itemId      = $ItemId
    title       = $title
    view        = $view
    demoBase    = $demoBase
    category    = $cate
    declaredSize= $size
    files       = (Get-ChildItem $dest -Recurse -File).Count
    bytes       = ($all | Measure-Object Length -Sum).Sum
    missingRefs = @($missing.Keys | Sort-Object)
    screenshot  = $shot
    downloadedAt= (Get-Date).ToString('s')
    rawDir      = $dest
    cleanDir    = $(if ($NoClean) { $null } else { $clean })
}
$meta | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $dest '_meta.json')

Write-Host ""
Write-Host "  原始镜像 : $dest" -ForegroundColor White
if (-not $NoClean) { Write-Host "  干净版   : $clean" -ForegroundColor White }
if ($shot) { Write-Host "  首页截图 : $shot" -ForegroundColor White }
Write-Host "  打开方式 : 双击 clean 目录里的 index.html（用 file:// 打开，别用 localhost 起服务）" -ForegroundColor DarkGray
Write-Host ""
