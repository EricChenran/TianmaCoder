/**
 * 抓帧 + 时间轴 + 字幕文件
 *
 * 两个致命坑的固化实现：
 *   ① 单次抓帧必须给硬超时：曾出现 captureScreenshot 无限挂起 30 秒，
 *      阻塞抓帧循环期间演示继续走完，导致整段漏录、成片时长缩短。
 *   ② 时间轴必须按「演示真实时长」均匀重采样，而不是用帧间隔拼：
 *      帧间隔会把空档压缩掉，导致字幕/配音与画面对不上。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { sleep } from './page.mjs'

/**
 * 启动后台抓帧循环。
 * @returns { stop, frames, errors, stats }
 */
export async function startCapture(cdp, opts) {
  const { framesDir, fps = 5, quality = 82, timeoutMs = 4000 } = opts
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })

  const frames = []
  const errors = []
  let capturing = true
  const interval = Math.max(60, Math.round(1000 / Math.max(1, fps)))

  const loop = (async () => {
    while (capturing) {
      const started = Date.now()
      try {
        const shot = await cdp.send(
          'Page.captureScreenshot',
          { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false },
          timeoutMs,
        )
        const file = join(framesDir, `f${String(frames.length).padStart(5, '0')}.jpg`)
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        frames.push({ file, t: (started + Date.now()) / 2 })
      } catch (e) {
        errors.push(String(e.message || e))
      }
      const wait = interval - (Date.now() - started)
      if (wait > 0) await sleep(wait)
    }
  })()

  return {
    frames,
    errors,
    stats: () => {
      let maxGap = 0
      for (let i = 1; i < frames.length; i++) maxGap = Math.max(maxGap, (frames[i].t - frames[i - 1].t) / 1000)
      const span = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0
      return {
        frameCount: frames.length,
        spanSec: Number(span.toFixed(2)),
        fpsActual: span > 0 ? Number((frames.length / span).toFixed(2)) : 0,
        maxGapSec: Number(maxGap.toFixed(2)),
        errors: errors.slice(0, 5),
        errorCount: errors.length,
      }
    },
    async stop() {
      capturing = false
      await loop.catch(() => {})
    },
  }
}

/**
 * 均匀重采样并生成 ffmpeg concat 清单。
 * 每个输出帧取「不晚于该时刻的最近一帧」；空档处画面静止，但总时长严格等于演示时长。
 */
export function buildTimeline({ frames, t0, totalSec, fps = 25, outFile, relPrefix = '' }) {
  if (!frames.length) throw new Error('没有任何抓帧，无法生成时间轴')
  const slotCount = Math.max(1, Math.round(totalSec * fps))
  const lines = []
  let cursor = 0
  let heldSlots = 0
  for (let k = 0; k < slotCount; k++) {
    const target = t0 + (k / fps) * 1000
    while (cursor + 1 < frames.length && frames[cursor + 1].t <= target) cursor++
    const chosen = frames[cursor]
    if (target - chosen.t > 1000) heldSlots++
    lines.push(`file '${relPrefix}${basename(chosen.file)}'`, `duration ${(1 / fps).toFixed(4)}`)
  }
  // concat 语法要求：末行必须再补一条 file
  lines.push(`file '${relPrefix}${basename(frames[Math.min(cursor, frames.length - 1)].file)}'`)
  writeFileSync(outFile, lines.join('\n'), 'utf8')
  return {
    slotCount,
    durationSec: Number((slotCount / fps).toFixed(2)),
    heldSlots,
    heldRatio: Number((heldSlots / slotCount).toFixed(4)),
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`
}

export function writeSrt(captions, file) {
  const body = captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')
  writeFileSync(file, body, 'utf8')
  return file
}

export function writeCaptionsJson(captions, file) {
  writeFileSync(
    file,
    JSON.stringify(
      captions.map((c, i) => ({ index: i + 1, text: c.text, startSec: Number(c.start.toFixed(3)), endSec: Number(c.end.toFixed(3)) })),
      null,
      2,
    ),
    'utf8',
  )
  return file
}
