<#
.SYNOPSIS
  按检索词取真实照片：抓取、并发下载、比例与尺寸过滤、去重，落本地图库。

.DESCRIPTION
  技术部配图取用。图片库放在用户数据目录，不在技能目录内——技能目录会被重复发布覆盖，
  安装在只读位置时也不可写；把抓到的图存进去等于丢数据。

  图源只用 Pexels 检索页：其实测可直接抓取（单页约 40 条直链），Unsplash 检索页返回 401、
  Pixabay 返回 403。图片直链靠 ID 猜不可行（实测命中约六分之一），必须从检索页取。

  预算与降级：候选封顶 Count*5，单张 15 秒超时、最多 2 次尝试、并发默认 6。
  成功数不足一半时退出码非 0，调用方据此降级到库内已有图或本地绘制的占位图。

.PARAMETER Query
  检索词。Pexels 英文检索质量最好；传中文会先查内置对照表转英文。

.PARAMETER Count
  需要张数，默认 8。

.PARAMETER CopyTo
  把入选图复制到目标工程目录。运行时禁止外链，图必须落进工程。

.PARAMETER Orientation
  比例过滤：landscape 用于横幅与首屏大图，portrait 用于竖版专题，square 用于头像位，any 不过滤。

.PARAMETER MinWidth
  最小宽度像素，用于挡掉缩略图尺寸的原图。

.PARAMETER StoreRoot
  图片库根目录。默认取 DSH_IMAGE_STORE 环境变量，其次用户本地数据目录。

.PARAMETER LibraryOnly
  不联网，只从本地库按检索词或文件名取图。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/Get-Image.ps1 -Query "coffee shop" -Count 6 -Orientation landscape -CopyTo <工程>\Frontend\web\src\assets

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/Get-Image.ps1 -Query "咖啡" -Count 4 -LibraryOnly
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Query,

  [int]$Count = 8,
  [string]$CopyTo,
  [int]$Width = 1600,
  [int]$MinBytes = 20000,
  [int]$BudgetSec = 90,
  [int]$Throttle = 6,

  [ValidateSet('any', 'landscape', 'portrait', 'square')]
  [string]$Orientation = 'any',

  [int]$MinWidth = 0,
  [string]$StoreRoot,
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$Ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
$sw = [Diagnostics.Stopwatch]::StartNew()
$HasCurl = [bool](Get-Command curl.exe -ErrorAction SilentlyContinue)

# 图库位置：技能目录会被重复发布覆盖，安装位置可能只读，用户数据必须另存。
if (-not $StoreRoot) {
  if ($env:DSH_IMAGE_STORE) {
    $StoreRoot = $env:DSH_IMAGE_STORE
  } elseif ($env:LOCALAPPDATA) {
    $StoreRoot = Join-Path $env:LOCALAPPDATA 'TianmaCoder\image-library'
  } elseif ($env:HOME) {
    $StoreRoot = Join-Path $env:HOME '.tianma/image-library'
  } else {
    $StoreRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'tianma-image-library'
  }
}
$StoreDir  = Join-Path $StoreRoot 'store'
$IndexPath = Join-Path $StoreRoot 'index.json'
New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null

# Pexels 对中文检索支持差，常见类目先转英文
$ZhMap = @{
  '办公室'='office'; '办公'='office desk'; '咖啡'='coffee'; '咖啡馆'='coffee shop'; '餐厅'='restaurant'
  '美食'='food'; '中餐'='chinese food'; '火锅'='hot pot'; '烘焙'='bakery'; '茶'='tea'
  '科技'='technology'; '电脑'='laptop'; '手机'='smartphone'; '代码'='coding'; '团队'='team meeting'
  '服装'='clothing'; '鞋'='shoes'; '化妆'='cosmetics'; '护肤'='skincare'; '母婴'='baby'
  '家'='home interior'; '家具'='furniture'; '植物'='plant'; '城市'='city'; '自然'='nature'
  '酒店'='hotel'; '旅行'='travel'; '汽车'='car'; '健身'='fitness'; '头像'='portrait'
  '人像'='portrait'; '人物'='people'; '学生'='student'; '医疗'='medical'; '物流'='logistics'
  '工厂'='factory'; '建筑'='architecture'; '蔬菜'='vegetables'; '水果'='fruit'
}

function ConvertTo-Slug([string]$s) {
  $t = $s -replace '[^\w\-]+', '-'
  $t = $t.Trim('-').ToLower()
  if ([string]::IsNullOrWhiteSpace($t)) { $t = 'img' }
  return $t
}

# PS 5.1 的 ConvertFrom-Json 把整组数组当单个对象输出，@() 不会拆开；
# 必须显式枚举，否则每轮运行都会把索引套成嵌套数组、去重随之失效。
$Index = New-Object System.Collections.ArrayList
if (Test-Path $IndexPath) {
  try {
    $raw = Get-Content $IndexPath -Raw -Encoding UTF8
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $parsed = $raw | ConvertFrom-Json
      foreach ($e in $parsed) { [void]$Index.Add($e) }
    }
  } catch { }
}
$knownHashes = @{}
foreach ($e in $Index) { if ($e.sha256) { $knownHashes[$e.sha256] = $e.file } }

$slug = ConvertTo-Slug $Query

# 中文到英文的映射要在库检索之前：索引里存的是英文检索词。
$effective = $Query
if ($Query -match '[\u4e00-\u9fa5]') {
  $mapped0 = $ZhMap[$Query]
  if (-not $mapped0) {
    foreach ($k in $ZhMap.Keys) { if ($Query.Contains($k)) { $mapped0 = $ZhMap[$k]; break } }
  }
  if ($mapped0) { $effective = $mapped0 }
}
$slugEff = ConvertTo-Slug $effective

if ($LibraryOnly) {
  $hit = @($Index | Where-Object {
    $_.query -like "*$effective*" -or $_.query -like "*$Query*" -or
    $_.file -like "*$slugEff*" -or $_.file -like "*$slug*"
  })
  if ($hit.Count -eq 0) {
    [pscustomobject]@{
      ok = $false; mode = 'library'; reason = 'no-match'; query = $Query
      storeDir = $StoreDir; files = @(); elapsedMs = [int]$sw.ElapsedMilliseconds
    } | ConvertTo-Json -Depth 5
    exit 2
  }
  $files = @()
  foreach ($e in ($hit | Select-Object -First $Count)) {
    $p = Join-Path $StoreDir $e.file
    if (Test-Path $p) { $files += $p }
  }
  [pscustomobject]@{
    ok = ($files.Count -gt 0); mode = 'library'; query = $Query
    saved = $files.Count; storeDir = $StoreDir; files = $files
    elapsedMs = [int]$sw.ElapsedMilliseconds
  } | ConvertTo-Json -Depth 5
  if ($files.Count -gt 0) { exit 0 } else { exit 2 }
}

if ($effective -eq $Query -and $Query -match '[\u4e00-\u9fa5]') {
  Write-Warning "「$Query」无内置英文对照，Pexels 中文检索命中率低，建议改用英文关键词。"
}
$enc = [uri]::EscapeDataString($effective)

# 没有 curl 就取不到检索页：Invoke-WebRequest 实测被图源站点以 403 拒绝（加自定义头同样不行），
# 因此不做无效回退，直接给出可执行的替代方案。
if (-not $HasCurl) {
  [pscustomobject]@{
    ok = $false; mode = 'fetch'; reason = 'curl-missing'
    query = $Query; storeDir = $StoreDir
    hint = '需要 curl.exe（Windows 10 1803 起随系统提供）；或用 -LibraryOnly 从本地库复用已有图片'
    elapsedMs = [int]$sw.ElapsedMilliseconds
  } | ConvertTo-Json -Depth 5
  exit 5
}

$candidates = @()
$pagesTried = 0
foreach ($page in 1..4) {
  if ($sw.Elapsed.TotalSeconds -gt $BudgetSec) { break }
  $pagesTried++
  $url = "https://www.pexels.com/search/$enc/"
  if ($page -gt 1) { $url += "?page=$page" }
  $tmpHtml = Join-Path ([System.IO.Path]::GetTempPath()) ("pexels-" + [guid]::NewGuid().ToString('N') + ".html")
  try {
    $code = & curl.exe -s -L --max-time 20 -A $Ua -o $tmpHtml -w "%{http_code}" $url
  } catch {
    Write-Warning ("检索页抓取失败：" + $_.Exception.Message)
    $code = 'error'
  }
  if ($code -eq '200' -and (Test-Path $tmpHtml)) {
    $txt = Get-Content $tmpHtml -Raw -Encoding UTF8
    $found = [regex]::Matches($txt, 'https://images\.pexels\.com/photos/\d+/[a-z0-9\-]+\.(?:jpe?g|png)') |
             ForEach-Object { $_.Value } | Select-Object -Unique
    $candidates += $found
  }
  if (Test-Path $tmpHtml) { Remove-Item $tmpHtml -Force -ErrorAction SilentlyContinue }
  if ($candidates.Count -ge ($Count * 6)) { break }
}
$candidates = @($candidates | Select-Object -Unique)

if ($candidates.Count -eq 0) {
  [pscustomobject]@{
    ok = $false; mode = 'fetch'; reason = 'no-candidates'
    query = $Query; effectiveQuery = $effective; storeDir = $StoreDir
    hint = '检索词可能过于生僻，换更通用的英文词，或先用 -LibraryOnly 查库内可复用图'
    elapsedMs = [int]$sw.ElapsedMilliseconds
  } | ConvertTo-Json -Depth 5
  exit 3
}

# 打散后取候选，避免每次都拿到同一批头部图。
# 开了比例或尺寸过滤时按 5 倍取样：Pexels 结果里竖图占比高，只取 2 倍会被过滤到数量不够。
$factor = if ($Orientation -ne 'any' -or $MinWidth -gt 0) { 5 } else { 2 }
$poolUrls = @($candidates | Get-Random -Count ([Math]::Min($candidates.Count, $Count * $factor)))
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("imgdl-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

$dlScript = {
  $u = $args[0]; $tmpDir = $args[1]; $ua = $args[2]; $w = $args[3]; $minB = $args[4]
  $minW = $args[5]; $orient = $args[6]

  function Get-JpegSize([string]$path) {
    try {
      $fs = [System.IO.File]::OpenRead($path)
      $ms = New-Object System.IO.MemoryStream
      $fs.CopyTo($ms)
      $fs.Close()
      $d = $ms.ToArray()
      $ms.Dispose()
      $i = 2
      while ($i -lt ($d.Length - 9)) {
        if ($d[$i] -ne 0xFF) { $i++; continue }
        $m = $d[$i + 1]
        if ($m -eq 0xD8 -or $m -eq 0xD9 -or ($m -ge 0xD0 -and $m -le 0xD7) -or $m -eq 0x01) { $i += 2; continue }
        # PowerShell 对 byte 做 -shl 会按 byte 截断（0x08 -shl 8 得 0），必须先用 [int] 提升
        $len = ([int]$d[$i + 2] * 256) + [int]$d[$i + 3]
        if ($m -eq 0xC0 -or $m -eq 0xC1 -or $m -eq 0xC2) {
          $h = ([int]$d[$i + 5] * 256) + [int]$d[$i + 6]
          $wd = ([int]$d[$i + 7] * 256) + [int]$d[$i + 8]
          return [pscustomobject]@{ Width = $wd; Height = $h }
        }
        $i += 2 + $len
      }
      return $null
    } catch { return $null }
  }

  $n = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $f = Join-Path $tmpDir "t-$n.jpg"
  $sep = '?'
  if ($u.Contains('?')) { $sep = '&' }
  $full = "$u$sep" + "auto=compress&cs=tinysrgb&w=$w"
  for ($a = 1; $a -le 2; $a++) {
    try {
      $code = & curl.exe -s --max-time 15 -A $ua -o $f -w "%{http_code}" $full 2>$null
    } catch {
      $code = 'error'
    }
    if ($code -eq '200' -and (Test-Path $f) -and (Get-Item $f).Length -ge $minB) {
      $fs = [System.IO.File]::OpenRead($f)
      $b = New-Object byte[] 3
      [void]$fs.Read($b, 0, 3)
      $fs.Close()
      if ($b[0] -eq 0xFF -and $b[1] -eq 0xD8 -and $b[2] -eq 0xFF) {
        $dim = Get-JpegSize $f
        $pass = $true
        if ($dim) {
          if ($minW -gt 0 -and $dim.Width -lt $minW) { $pass = $false }
          if ($orient -eq 'landscape' -and $dim.Width -le $dim.Height) { $pass = $false }
          if ($orient -eq 'portrait' -and $dim.Height -le $dim.Width) { $pass = $false }
          if ($orient -eq 'square' -and [Math]::Abs($dim.Width - $dim.Height) -gt ([Math]::Max($dim.Width, $dim.Height) * 0.05)) { $pass = $false }
        }
        if ($pass) {
          [pscustomobject]@{
            ok = $true; url = $u; tmp = $f; bytes = (Get-Item $f).Length
            width = $(if ($dim) { $dim.Width } else { 0 })
            height = $(if ($dim) { $dim.Height } else { 0 })
          }
          return
        }
        # 比例不合适，重试同一条也不会有别的比例，直接放弃
        break
      }
    }
    Start-Sleep -Milliseconds (250 * $a)
  }
  if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
  [pscustomobject]@{ ok = $false; url = $u }
}

$rsPool = [runspacefactory]::CreateRunspacePool(1, [Math]::Max(1, $Throttle))
$rsPool.Open()
$handles = @()
foreach ($u in $poolUrls) {
  $ps = [powershell]::Create()
  $ps.RunspacePool = $rsPool
  [void]$ps.AddScript($dlScript.ToString()).AddArgument($u).AddArgument($TmpDir).AddArgument($Ua).AddArgument($Width).AddArgument($MinBytes).AddArgument($MinWidth).AddArgument($Orientation)
  $handles += New-Object PSObject -Property @{ Ps = $ps; Handle = $ps.BeginInvoke() }
}
$results = @()
foreach ($h in $handles) {
  try { $results += $h.Ps.EndInvoke($h.Handle) } catch { }
  $h.Ps.Dispose()
}
$rsPool.Close()
$rsPool.Dispose()

$okResults = @($results | Where-Object { $_ -and $_.ok })
$failCount = @($results | Where-Object { $_ -and (-not $_.ok) }).Count

$saved = @()
$dup = 0
foreach ($r in $okResults) {
  if ($saved.Count -ge $Count) { Remove-Item $r.tmp -Force -ErrorAction SilentlyContinue; continue }
  $hash = (Get-FileHash -Path $r.tmp -Algorithm SHA256).Hash.ToLower()
  if ($knownHashes.ContainsKey($hash)) {
    $dup++
    Remove-Item $r.tmp -Force -ErrorAction SilentlyContinue
    $existing = Join-Path $StoreDir $knownHashes[$hash]
    if (Test-Path $existing) { $saved += $existing }
    continue
  }
  $name = "{0}-{1}.jpg" -f $slug, $hash.Substring(0, 8)
  $dest = Join-Path $StoreDir $name
  Move-Item -Path $r.tmp -Destination $dest -Force
  $knownHashes[$hash] = $name
  $entry = [pscustomobject]@{
    file      = $name
    query     = $effective
    sourceUrl = $r.url
    license   = 'Pexels License (free for commercial use, no attribution required)'
    sha256    = $hash
    bytes     = $r.bytes
    width     = $r.width
    height    = $r.height
    fetchedAt = (Get-Date).ToString('s')
  }
  [void]$Index.Add($entry)
  $saved += $dest
}

# PS 5.1 下单元素数组会被序列化成对象，手工保证数组形态
$json = if ($Index.Count -eq 0) { '[]' }
        elseif ($Index.Count -eq 1) { '[' + ($Index[0] | ConvertTo-Json -Depth 5) + ']' }
        else { ConvertTo-Json -InputObject $Index.ToArray() -Depth 5 }
Set-Content -Path $IndexPath -Value $json -Encoding UTF8

$copied = @()
if ($CopyTo -and $saved.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $CopyTo | Out-Null
  foreach ($p in $saved) {
    $d = Join-Path $CopyTo (Split-Path $p -Leaf)
    Copy-Item -Path $p -Destination $d -Force
    $copied += $d
  }
}

[pscustomobject]@{
  ok             = ($saved.Count -gt 0)
  mode           = 'fetch'
  query          = $Query
  effectiveQuery = $effective
  orientation    = $Orientation
  requested      = $Count
  saved          = $saved.Count
  duplicates     = $dup
  failed         = $failCount
  pagesTried     = $pagesTried
  candidates     = $candidates.Count
  files          = $saved
  copiedTo       = $CopyTo
  copied         = $copied
  storeDir       = $StoreDir
  license        = 'Pexels License'
  elapsedMs      = [int]$sw.ElapsedMilliseconds
} | ConvertTo-Json -Depth 5

Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
if ($saved.Count -ge [Math]::Max(1, [Math]::Ceiling($Count / 2))) { exit 0 } else { exit 4 }
