/**
 * 媒体处理：配音合成（多平台适配）+ 成片（拼帧/烧字幕/铺配音/合流）
 *
 * 跨环境要点：
 *   - 文本一律走「文件」而不是命令行参数：Windows 下 argv 传非 ASCII 极易乱码
 *   - 配音引擎按平台自动选择，找不到就降级为「仅字幕」，绝不让整个流程失败
 *   - ffmpeg 调用全部 argv 数组、无 shell；日志落文件便于远程排查
 *   - 滤镜用 -vf 单参数传入：部分构建不支持 -filter_script:v，且 Windows 引号易被拆坏
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IS_MAC, IS_WIN } from './env.mjs'

/* ------------------------------------------------------------------ 进程执行 */

export function run(bin, args, { logFile, timeoutMs = 600000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let fd = null
    const stdio = ['ignore', 'ignore', 'ignore']
    if (logFile) {
      try {
        fd = openSync(logFile, 'a')
        stdio[2] = fd
      } catch {
        /* 落盘失败则丢弃 */
      }
    }
    const proc = spawn(bin, args, { stdio, windowsHide: true, cwd })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`执行超时（${timeoutMs}ms）：${bin} ${args.slice(0, 4).join(' ')} …`))
    }, timeoutMs)
    proc.on('error', (e) => {
      clearTimeout(timer)
      if (fd !== null) closeSync(fd)
      reject(new Error(`无法执行 ${bin}：${e.message}`))
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (fd !== null) closeSync(fd)
      code === 0 ? resolve({ code }) : reject(new Error(`${bin} 退出码 ${code}${logFile ? `（日志：${logFile}）` : ''}`))
    })
  })
}

export async function probeDuration(ffprobe, file) {
  const out = await new Promise((resolve, reject) => {
    let buf = ''
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', file], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    p.stdout.on('data', (d) => (buf += d))
    p.on('error', reject)
    p.on('exit', () => resolve(buf))
  })
  try {
    const j = JSON.parse(out)
    return { durationSec: Number(j.format?.duration || 0), sizeBytes: Number(j.format?.size || 0) }
  } catch {
    return { durationSec: 0, sizeBytes: 0 }
  }
}

/* ------------------------------------------------------------------- 配音 */

/**
 * 逐句合成配音。返回 { ok, files[], durations[], engine, warnings[] }
 * 无可用引擎时返回 ok:false，由调用方降级为「仅字幕」。
 */
export async function synthesizeNarration({ tts, segments, audioDir, ffmpeg, ffprobe, logFile, rate = 0 }) {
  mkdirSync(audioDir, { recursive: true })
  const files = []
  const durations = []
  const warnings = []

  if (!tts || !tts.ok) {
    return { ok: false, files, durations, engine: null, warnings: ['未检测到可用 TTS 引擎，本次将只烧录字幕（无配音）'] }
  }

  const engine = tts.chosen
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const idx = i + 1
    const textFile = join(audioDir, `n${String(idx).padStart(2, '0')}.txt`)
    writeFileSync(textFile, seg.text, 'utf8')

    if (engine.engine === 'sapi') {
      const wav = join(audioDir, `n${String(idx).padStart(2, '0')}.wav`)
      const ps1 = join(audioDir, `tts-${idx}.ps1`)
      writeFileSync(
        ps1,
        [
          'param([string]$TextFile,[string]$Out,[string]$VoiceMatch,[int]$Rate)',
          '$ErrorActionPreference = "Stop"',
          '$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8',
          '$v = New-Object -ComObject SAPI.SpVoice',
          '$vs = $v.GetVoices()',
          'for ($i = 0; $i -lt $vs.Count; $i++) { if ($vs.Item($i).GetDescription() -match $VoiceMatch) { $v.Voice = $vs.Item($i) } }',
          '$v.Rate = $Rate',
          '$s = New-Object -ComObject SAPI.SpFileStream',
          '$s.Open($Out, 3, $false)',
          '$v.AudioOutputStream = $s',
          '$v.Speak($text) | Out-Null',
          '$s.Close()',
        ].join('\n'),
        'utf8',
      )
      await run(engine.command, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-TextFile', textFile, '-Out', wav, '-VoiceMatch', engine.voice || 'Chinese', '-Rate', String(rate)], { logFile })
      files.push(wav)
    } else if (engine.engine === 'say') {
      const aiff = join(audioDir, `n${String(idx).padStart(2, '0')}.aiff`)
      const wav = join(audioDir, `n${String(idx).padStart(2, '0')}.wav`)
      await run(engine.command, ['-v', engine.voice || 'Tingting', '-f', textFile, '-o', aiff], { logFile })
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '22050', '-ac', '1', wav], { logFile })
      files.push(wav)
    } else {
      const wav = join(audioDir, `n${String(idx).padStart(2, '0')}.wav`)
      const args = engine.engine === 'pico2wave' ? ['-l', engine.voice || 'zh-CN', '-w', wav, seg.text] : ['-v', engine.voice || 'zh', '-w', wav, '-f', textFile]
      await run(engine.command, args, { logFile })
      files.push(wav)
    }

    const d = await probeDuration(ffprobe, files[i])
    durations.push({ index: idx, text: seg.text, audioMs: Math.round(d.durationSec * 1000) })
  }

  return { ok: true, files, durations, engine: engine.engine, warnings }
}

/* ------------------------------------------------------------------- 成片 */

/**
 * 拼帧 → 烧字幕 → 铺配音 → 合流。
 * 字幕滤镜路径用相对路径（调用方需把 cwd 设为工作目录），避免 Windows 盘符转义问题。
 */
export async function buildVideo({
  ffmpeg,
  ffprobe,
  workDir,
  framesList, // 'frames.txt'
  srtFile, // 'subs.srt'
  assFile, // 'captions.ass'（给了就用它，忽略 srtFile+force_style）
  captions, // [{startSec,text}]
  audioFiles, // 与 captions 一一对应；为空则不出音轨
  fontName,
  fontOk = true,
  outFile,
  logFile,
  fps = 25,
  baseName = 'demo',
  coverAssFile = null,
  coverDurationSec = 0,
  coverBgColor = '0x1F3A33',
  videoWidth = 1600,
  videoHeight = 900,
}) {
  const warnings = []
  const silent = join(workDir, `${baseName}.silent.mp4`)
  const hasCover = Boolean(coverAssFile) && coverDurationSec > 0

  const style = [
    `FontName=${fontName || 'sans-serif'}`,
    'FontSize=17',
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    'Outline=3',
    'Shadow=0',
    'MarginV=32',
  ].join(',')
  // ASS 自带完整样式（圆角容器/水印），不要再叠加 force_style，否则会覆盖 Container 样式
  const subFilter = assFile ? `subtitles=${assFile}` : `subtitles=${srtFile}:force_style='${style}'`
  if (!fontOk) warnings.push(`未检测到中文字体，字幕可能显示为方块；请安装中文字体后重试（可指定 fontName 覆盖）`)

  // 有封面时：封面（lavfi 纯色 + ASS 排版）与正片在同一次编码里 concat，避免二次转码
  const commonTail = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent]
  if (hasCover) {
    const fc = [
      `[0:v]fps=${fps},subtitles=${coverAssFile},format=yuv420p[cov]`,
      `[1:v]fps=${fps},${subFilter},format=yuv420p[main]`,
      '[cov][main]concat=n=2:v=1:a=0[v]',
    ].join(';')
    await run(
      ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-t', String(coverDurationSec), '-i', `color=c=${coverBgColor}:s=${videoWidth}x${videoHeight}:r=${fps}`,
        '-f', 'concat', '-safe', '0', '-i', framesList,
        '-filter_complex', fc, '-map', '[v]',
        ...commonTail,
      ],
      { logFile, cwd: workDir },
    )
  } else {
    await run(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', framesList, '-vf', `fps=${fps},${subFilter}`, ...commonTail],
      { logFile, cwd: workDir },
    )
  }

  const hasAudio = Array.isArray(audioFiles) && audioFiles.length > 0 && audioFiles.length === captions.length
  if (!hasAudio) {
    if (audioFiles && audioFiles.length) warnings.push('配音数量与字幕不一致，已跳过音轨（仅出画面+字幕）')
    if (outFile !== silent) {
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', silent, '-c', 'copy', outFile], { logFile, cwd: workDir })
    }
    const info = await probeDuration(ffprobe, outFile)
    return { output: outFile, ...info, hasAudio: false, warnings }
  }

  const inputs = []
  const chains = []
  const labels = []
  audioFiles.forEach((f, i) => {
    inputs.push('-i', f)
    const ms = Math.max(0, Math.round(Number(captions[i].startSec || 0) * 1000))
    chains.push(`[${i}:a]adelay=delays=${ms}:all=1[a${i}]`)
    labels.push(`[a${i}]`)
  })
  const filter = `${chains.join(';')};${labels.join('')}amix=inputs=${audioFiles.length}:normalize=0:dropout_transition=0[mix]`
  const mixed = join(workDir, `${baseName}.audio.m4a`)
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[mix]', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', mixed], { logFile, cwd: workDir })

  // 关键：音轨总长通常短于画面（最后一句配音结束后还有画面停留）。
  // 若直接 -shortest，会把视频截到音轨长度，成片比时间轴短一截
  // （实测恒定短约 0.9s，容易误判为「抓帧丢了」）。
  // 正确做法：用 apad 把音轨补静音到视频长度，再 -shortest。
  await run(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', silent, '-i', mixed, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-af', 'apad', '-shortest', outFile],
    { logFile, cwd: workDir },
  )

  const info = await probeDuration(ffprobe, outFile)
  return { output: outFile, ...info, hasAudio: true, warnings }
}

/* --------------------------------------------------- 字幕样式：圆角容器 / 水印 */

/**
 * 字幕排版（ASS）：把每句讲解放进「矩形圆角容器」，并可选叠加常驻水印。
 *
 * 为什么不用 force_style 描边：描边字幕压在浅色后台上很难看，也不专业；
 * 行业惯例是「深色半透明圆角容器 + 白字」。libass 的 BorderStyle=3 只能出直角框，
 * 所以这里用绘图指令（\p1 + 三次贝塞尔圆角）自绘容器。
 *
 * 已验证：\p1 的绘图坐标在 PlayRes 分辨率下是 1:1 像素（与 FontSize 无关），
 * 因此容器尺寸可以按像素直接算；文本宽度用字宽估算（CJK 全角≈1em），
 * 单侧偏差只表现为左右内边距不绝对相等，肉眼不可辨。
 */
const ASS_SCRIPT_INFO = (w, h) =>
  [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
  ].join('\n')

const ASS_STYLE_FORMAT =
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'

const ASS_EVENT_FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'

function assTime(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100))
  const total = Math.floor(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const ss = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/**
 * 反查 libass 的 Fontsize → 像素倍率与字宽系数。
 *
 * 为什么需要：libass 在不同 ffmpeg 构建下渲染出来的字号并不等于脚本里的 Fontsize
 * （本机实测 Fontsize=38 只出 28px，倍率 0.747），而且 CJK/数字/字母字宽也不同。
 * 圆角容器要「贴着文字」，必须先知道这些系数，否则容器不是过宽就是文字溢出。
 *
 * 做法：黑底白字渲染 6 条标尺（CJK/数字/字母 各 10 字与 5 字），
 * 直接取 rawvideo(gray) 字节量墨迹；同一字符 10 字与 5 字的墨迹宽之差 / 5
 * 就是精确的单字步进，不依赖任何字体侧边距假设。
 */
export async function calibrateCaptionMetrics({ ffmpeg, workDir, fontName = 'sans-serif', calFontSize = 100, logFile }) {
  const W = 1600
  const bandH = 130
  const bands = [
    ['cjk', '国', 10],
    ['cjk', '国', 5],
    ['digit', '0', 10],
    ['digit', '0', 5],
    ['letter', 'x', 10],
    ['letter', 'x', 5],
  ]
  const H = bandH * bands.length
  const assFile = 'calib.ass'
  const rawFile = 'calib.raw'
  const styleFormat =
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    styleFormat,
    `Style: C,${fontName},${calFontSize},&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  bands.forEach(([, ch, n], i) => {
    lines.push(`Dialogue: 0,0:00:00.00,0:00:01.00,C,,0,0,0,,{\\an5\\pos(${W / 2},${i * bandH + Math.round(bandH / 2)})}${ch.repeat(n)}`)
  })
  writeFileSync(join(workDir, assFile), lines.join('\n') + '\n', 'utf8')

  try {
    await run(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1`, '-vf', `subtitles=${assFile}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', rawFile],
      { logFile, cwd: workDir, timeoutMs: 120000 },
    )
    const buf = readFileSync(join(workDir, rawFile))
    if (buf.length !== W * H) throw new Error(`标尺帧尺寸异常：${buf.length} != ${W * H}`)
    const measured = {}
    bands.forEach(([key, , n], i) => {
      let minX = W
      let maxX = -1
      let minY = H
      let maxY = -1
      for (let y = i * bandH; y < (i + 1) * bandH; y++) {
        for (let x = 0; x < W; x++) {
          if (buf[y * W + x] > 128) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX >= 0) measured[`${key}${n}`] = { w: maxX - minX + 1, h: maxY - minY + 1 }
    })
    const perUnit = (key) => {
      const a = measured[`${key}10`]
      const b = measured[`${key}5`]
      if (!a || !b || a.w <= b.w) return null
      return (a.w - b.w) / 5 / calFontSize
    }
    const cjk = perUnit('cjk')
    if (!cjk) throw new Error('标尺未测到 CJK 墨迹（字体可能缺失）')
    return {
      cjk,
      digit: perUnit('digit') || cjk * 0.56,
      letter: perUnit('letter') || cjk * 0.62,
      inkHeight: measured.cjk10 ? measured.cjk10.h / calFontSize : 0.7,
    }
  } catch {
    return null
  } finally {
    rmSync(join(workDir, assFile), { force: true })
    rmSync(join(workDir, rawFile), { force: true })
  }
}

/** 单字宽度系数（未标定时按经验值兜底） */
const FALLBACK_METRICS = { cjk: 0.75, digit: 0.42, letter: 0.47, inkHeight: 0.68 }

/** 按标定系数估算一行文本的像素宽度 */
function estimateTextWidth(text, fontSize, metrics) {
  const M = metrics || FALLBACK_METRICS
  let units = 0
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0)
    if (c >= 0x2e80 && c <= 0xffef) units += M.cjk
    else if (ch >= '0' && ch <= '9') units += M.digit
    else if (/[A-Za-z]/.test(ch)) units += M.letter
    else if (ch === ' ') units += M.letter * 0.55
    else units += M.letter * 0.9
  }
  return units * fontSize
}

/** 圆角矩形绘图路径（三次贝塞尔近似四分之一圆，k = 0.5523） */
function roundedRectPath(w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  const k = rad * 0.5523
  const n = (v) => Math.round(v * 10) / 10
  return [
    `m ${n(rad)} 0`,
    `l ${n(w - rad)} 0`,
    `b ${n(w - rad + k)} 0 ${n(w)} ${n(rad - k)} ${n(w)} ${n(rad)}`,
    `l ${n(w)} ${n(h - rad)}`,
    `b ${n(w)} ${n(h - rad + k)} ${n(w - rad + k)} ${n(h)} ${n(w - rad)} ${n(h)}`,
    `l ${n(rad)} ${n(h)}`,
    `b ${n(rad - k)} ${n(h)} 0 ${n(h - rad + k)} 0 ${n(h - rad)}`,
    `l 0 ${n(rad)}`,
    `b 0 ${n(rad - k)} ${n(rad - k)} 0 ${n(rad)} 0`,
  ].join(' ')
}

/** ASS 文本转义：花括号会开覆盖块，反斜杠是转义符 */
function escapeAssText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N')
}

/**
 * 生成字幕 ASS。style 支持：
 *   style: 'box'(默认) | 'plain'   —— plain 只出白字（无描边无容器）
 *   fontSize / radius / paddingX / paddingY / marginBottom
 *   bgColor(&HBBGGRR&) / bgAlpha(&HAA&) / textColor / bold
 * metrics：calibrateCaptionMetrics() 的结果；缺省用经验系数兜底。
 * watermark 支持：{ text, fontSize, color, alpha, position, marginX, marginY }
 */
export function writeCaptionsAss({ captions, outFile, width = 1600, height = 900, fontName = 'sans-serif', style = {}, watermark = null, metrics = null }) {
  const M = metrics || FALLBACK_METRICS
  const st = {
    mode: 'box',
    fontSize: 50,
    radius: 16,
    paddingX: 34,
    paddingY: 18,
    marginBottom: 52,
    bgColor: '&H1C1A19&',
    bgAlpha: '&H28&',
    textColor: '&H00FFFFFF&',
    bold: 0,
    ...style,
  }
  // 容器高度 = 实测字墨高度 + 上下内边距（libass 的 Fontsize 与实际像素不成 1:1，必须按实测算）
  const boxH = Math.round(st.fontSize * (M.inkHeight || 0.68) + st.paddingY * 2)
  const cy = Math.round(height - st.marginBottom - boxH / 2)
  const wm = watermark && (watermark.text || (Array.isArray(watermark.lines) && watermark.lines.length)) ? watermark : null
  const wmLines = wm ? (Array.isArray(wm.lines) && wm.lines.length ? wm.lines : [{ text: wm.text }]) : []
  const wmFirst = wmLines[0] || {}
  const wmSize = wm ? wmFirst.fontSize || wm.fontSize || 32 : 0
  const wmColor = wmFirst.color || (wm && wm.color) || '&H005A5A5A&'
  const wmAlpha = wmFirst.alpha || (wm && wm.alpha) || '&H3C&'

  const lines = [
    ASS_SCRIPT_INFO(width, height),
    '',
    '[V4+ Styles]',
    ASS_STYLE_FORMAT,
    `Style: Caption,${fontName},${st.fontSize},${st.textColor},&H00000000,&H00000000,&H00000000,${st.bold},0,0,0,100,100,0.3,0,1,0,0,5,0,0,0,1`,
    `Style: Box,${fontName},${st.fontSize},&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
  ]
  if (wm) {
    lines.push(`Style: WM,${fontName},${wmSize},${wmColor},&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0.6,0,1,0,0,3,0,0,0,1`)
  }
  lines.push('', '[Events]', ASS_EVENT_FORMAT)

  // 水印先入队：同图层按书写顺序绘制，字幕容器后画即可盖住任何重叠（水印永不压字）
  if (wm) {
    const endOf = captions.reduce((m, c) => Math.max(m, Number(c.endSec) || 0), 0)
    const mx = wm.marginX ?? 28
    const my = wm.marginY ?? 18
    const pos = wm.position || 'bottom-right'
    const x = pos.endsWith('left') ? mx : width - mx
    const y = pos.startsWith('top') ? my : height - my
    const an = pos.endsWith('left') ? (pos.startsWith('top') ? 7 : 1) : pos.startsWith('top') ? 9 : 3
    // 多行水印：第 1 行用 WM 样式，其余行用行内覆盖（可各自不同字号/深浅）
    const body = wmLines
      .map((l, i) => {
        const esc = escapeAssText(l.text)
        if (i === 0) return esc
        const ov = []
        if (l.fontSize || wm.fontSize) ov.push(`\\fs${l.fontSize || wm.fontSize}`)
        if (l.color || wm.color) ov.push(`\\c${l.color || wm.color}`)
        if (l.alpha || wm.alpha) ov.push(`\\alpha${l.alpha || wm.alpha}`)
        return (ov.length ? `{${ov.join('')}}` : '') + esc
      })
      .join('\\N')
    lines.push(`Dialogue: 0,${assTime(0)},${assTime((endOf || 1) + 700)},WM,,0,0,0,,{\\an${an}\\pos(${x},${y})\\c${wmColor}\\alpha${wmAlpha}}${body}`)
  }

  for (const c of captions) {
    const text = String(c.text || '').trim()
    if (!text) continue
    const t0 = assTime(c.startSec)
    const t1 = assTime(c.endSec)
    if (st.mode === 'box') {
      // 行尾若是全角标点（，。：、；！？），其墨迹只占左半格，右内边距会显得偏大，故回收半格
      const trimmed = /[，。：、；！？]$/.test(text) ? text.slice(0, -1) : text
      const tailPad = trimmed === text ? 0 : (M.cjk * st.fontSize) / 2
      const boxW = Math.round(estimateTextWidth(text, st.fontSize, M) - tailPad + st.paddingX * 2)
      const left = Math.round((width - boxW) / 2)
      const top = cy - Math.round(boxH / 2)
      lines.push(
        `Dialogue: 0,${t0},${t1},Box,,0,0,0,,{\\an7\\pos(${left},${top})\\p1\\c${st.bgColor}\\alpha${st.bgAlpha}}${roundedRectPath(boxW, boxH, st.radius)}`,
      )
    }
    lines.push(`Dialogue: 1,${t0},${t1},Caption,,0,0,0,,{\\an5\\pos(${Math.round(width / 2)},${cy})}${escapeAssText(text)}`)
  }

  writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')
  return { outFile, captions: captions.length, boxHeight: boxH, centerY: cy, watermark: wmLines.map((l) => l.text).filter(Boolean) }
}

/**
 * 生成片头封面（标题卡）的 ASS。
 *
 * 只出一帧即可，时长由调用方用 -t 裁：封面用 libass 排版渲染到品牌底色上，
 * 与正片在同一次 ffmpeg 编码里 concat，避免二次转码。
 * cover 支持：{ title, subtitle, footer, attribution, titleSize, subtitleSize,
 *               footerSize, bgColor, titleColor, subtitleColor, accentColor, footerColor }
 */
export function writeCoverAss({ outFile, width = 1600, height = 900, fontName = 'sans-serif', cover = {}, metrics = null }) {
  const M = metrics || FALLBACK_METRICS
  const cv = {
    title: '项目名称',
    subtitle: '演示视频',
    footer: '',
    attribution: '',
    titleSize: 76,
    subtitleSize: 34,
    footerSize: 22,
    attributionSize: 18,
    titleColor: '&H00FFFFFF&',
    subtitleColor: '&H00D6E2DC&',
    accentColor: '&H00AFC9B8&',
    footerColor: '&H00AEBAB4&',
    attributionAlpha: '&H55&',
    ...cover,
  }
  const styleFormat = ASS_STYLE_FORMAT
  const style = (name, size, color, spacing = 0, bold = 0) =>
    `Style: ${name},${fontName},${size},${color},&H00000000,&H00000000,&H00000000,${bold},0,0,0,100,100,${spacing},0,1,0,0,5,0,0,0,1`
  const lines = [
    ASS_SCRIPT_INFO(width, height),
    '',
    '[V4+ Styles]',
    styleFormat,
    style('CoverTitle', cv.titleSize, cv.titleColor, 2, 1),
    style('CoverSub', cv.subtitleSize, cv.subtitleColor, 6),
    style('CoverFoot', cv.footerSize, cv.footerColor, 1.5),
    style('CoverAttr', cv.attributionSize, cv.footerColor, 1),
    style('CoverBar', 1, cv.accentColor),
    '',
    '[Events]',
    ASS_EVENT_FORMAT,
  ]
  const mid = Math.round(width / 2)
  const titleY = Math.round(height * 0.41)
  const barW = Math.round(cv.titleSize * 1.3)
  const barH = 5
  const barY = titleY + Math.round(cv.titleSize * M.inkHeight * 0.5) + 44
  const subY = barY + 64
  const footY = Math.round(height * 0.9)
  const attrY = footY + 34
  const t0 = '0:00:00.00'
  const t1 = '0:00:10.00'
  lines.push(
    `Dialogue: 0,${t0},${t1},CoverTitle,,0,0,0,,{\\an5\\pos(${mid},${titleY})}${escapeAssText(cv.title)}`,
    `Dialogue: 0,${t0},${t1},CoverBar,,0,0,0,,{\\an7\\pos(${mid - Math.round(barW / 2)},${barY})\\p1\\c${cv.accentColor}}${roundedRectPath(barW, barH, 2)}`,
    `Dialogue: 0,${t0},${t1},CoverSub,,0,0,0,,{\\an5\\pos(${mid},${subY})}${escapeAssText(cv.subtitle)}`,
  )
  if (cv.footer) lines.push(`Dialogue: 0,${t0},${t1},CoverFoot,,0,0,0,,{\\an5\\pos(${mid},${footY})}${escapeAssText(cv.footer)}`)
  if (cv.attribution) lines.push(`Dialogue: 0,${t0},${t1},CoverAttr,,0,0,0,,{\\an5\\pos(${mid},${attrY})\\alpha${cv.attributionAlpha}}${escapeAssText(cv.attribution)}`)
  writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')
  return { outFile, title: cv.title, subtitle: cv.subtitle, footer: cv.footer, attribution: cv.attribution, barY, subY, footY }
}

/** 音轨电平自检：判断是否真的有声、是否削波 */
export async function audioLevel(ffmpeg, file) {
  return new Promise((resolve) => {
    let buf = ''
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    p.stderr.on('data', (d) => (buf += d))
    p.on('error', () => resolve({ ok: false }))
    p.on('exit', () => {
      const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(buf)
      const max = /max_volume:\s*(-?[\d.]+) dB/.exec(buf)
      resolve({
        ok: !!mean,
        meanDb: mean ? Number(mean[1]) : null,
        maxDb: max ? Number(max[1]) : null,
        silent: max ? Number(max[1]) < -60 : true,
      })
    })
  })
}

export { IS_MAC, IS_WIN }
