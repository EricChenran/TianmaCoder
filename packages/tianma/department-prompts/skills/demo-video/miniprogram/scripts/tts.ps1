# Generate one narration WAV per scene with Windows SAPI (Huihui Chinese voice, 2x rate).
# Usage: powershell -File tts.ps1 -Scenes scenes.json -Audio audio [-Rate 2] [-Voice "Microsoft Huihui Desktop"]
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less scripts with the ANSI code page,
# so one non-ASCII byte in a comment already breaks the param block below. Chinese text comes from the JSON.
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

  # Duration from the WAV header byteRate at offset 28; never estimate it from the file size.
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $byteRate = [System.BitConverter]::ToUInt32($bytes, 28)
  $sec = [math]::Round(($bytes.Length - 44) / $byteRate, 2)
  $rows += [pscustomobject]@{ id = $s.id; file = $name; sec = $sec }
  Write-Output ("{0}  {1}s" -f $name, $sec)
}
$rows | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $Audio "durations.json")
$total = ($rows | Measure-Object -Property sec -Sum).Sum
Write-Output ("done: {0} scenes, {1}s -> {2}" -f $rows.Count, [math]::Round($total,1), $Audio)
