# 用 Windows SAPI 生成逐场景旁白（默认 Huihui 中文、2 倍速）
# 用法：powershell -File tts.ps1 -Scenes scenes.json -Audio audio [-Rate 2] [-Voice "Microsoft Huihui Desktop"]
# 说明：脚本本体保持纯 ASCII（Windows PowerShell 5.1 按 ANSI 解析无 BOM 文件），中文只从 JSON 读入。
param(
  [string]$Scenes = "scenes.json",
  [string]$Audio = "audio",
  [int]$Rate = 2,
  [string]$Voice = "Microsoft Huihui Desktop"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$data = Get-Content $Scenes -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Audio | Out-Null

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  44100,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

$i = 0
$rows = @()
foreach ($s in $data.scenes) {
  $i++
  $name = "{0:d2}-{1}.wav" -f $i, $s.id
  $file = Join-Path $Audio $name
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $synth.SelectVoice($Voice) } catch { Write-Output "voice fallback: $($_.Exception.Message)" }
  $synth.Rate = $Rate
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($s.caption)
  $synth.Dispose()

  # 用 WAV 头的 byteRate（偏移 28）算真实时长，别再拿文件大小估
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $byteRate = [System.BitConverter]::ToUInt32($bytes, 28)
  $sec = [math]::Round(($bytes.Length - 44) / $byteRate, 2)
  $rows += [pscustomobject]@{ id = $s.id; file = $name; sec = $sec }
  Write-Output ("{0}  {1}s" -f $name, $sec)
}
$rows | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $Audio "durations.json")
$total = ($rows | Measure-Object -Property sec -Sum).Sum
Write-Output ("done: {0} scenes, {1}s -> {2}" -f $rows.Count, [math]::Round($total,1), $Audio)
