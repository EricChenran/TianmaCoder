#!/usr/bin/env node
/**
 * webdemo —— 通用「无头 Web 演示视频」命令行（零依赖，跨平台）
 *
 * 抽象层次：本工具不认识任何具体网站。它只认一份 plan.json：
 *   地址 + 视口 + 登录配方 + 步骤（每步一句话讲解 + 一串声明式动作）
 * 因此同一套脚本可复用于任意 Web 应用（后台、官网、H5、管理端）。
 *
 * 语音播报默认关闭：成片只烧字幕，节奏由每步 minSec 决定；
 * 需要配音时在 plan 顶层写 "narration": true，并额外跑一次 tts（demo 已包含）。
 *
 * 子命令：
 *   doctor                     环境体检：浏览器 / ffmpeg / TTS / 中文字体 / Node
 *   probe   --plan p.json      侦察：登录后逐页采集真实可点元素，输出 JSON
 *   tts     --plan p.json      只做配音，产出 durations.json（需 narration: true）
 *   record  --plan p.json      按步骤驱动并抓帧（--dry-run 为不抓帧的快速校验）
 *   build   --plan p.json      拼帧 → 烧字幕 →（开启播报时）铺配音 → 成片
 *   demo    --plan p.json      tts + record + build 一把跑完
 *   open    <file>             用系统 shell 打开产物
 *
 * 环境自适应见 lib/env.mjs；交互层见 lib/page.mjs；两个致命坑的修法见 lib/capture.mjs。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTimeline, startCapture, writeCaptionsJson, writeSrt } from './lib/capture.mjs'
import { getPageTarget, launchBrowser, openPage } from './lib/cdp.mjs'
import { detectAll, detectBrowser, detectCjkFont, detectFfmpeg, detectTts, IS_WIN } from './lib/env.mjs'
import { audioLevel, buildVideo, calibrateCaptionMetrics, probeDuration, run, synthesizeNarration, writeCaptionsAss, writeCoverAss } from './lib/media.mjs'
import { injectHelpers, performLogin, resolveSelectors, restrictedAssert, runAction, sleep, waitFor } from './lib/page.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ 参数解析 */

/** --kebab-case 统一转成 camelCase，并把常见「连写」写法收编，避免同一参数各写各的 */
const KEY_ALIASES = {
  workdir: 'workDir',
  dryrun: 'dryRun',
  uikit: 'uiKit',
  readonly: 'readOnly',
  alloweval: 'allowEval',
  fontname: 'fontName',
  continueonerror: 'continueOnError',
}

function normalizeKey(k) {
  const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  return KEY_ALIASES[camel] || camel
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = normalizeKey(a.slice(2))
      const next = argv[i + 1]
      const repeated = out[key] !== undefined
      if (!next || next.startsWith('--')) out[key] = true
      else {
        out[key] = repeated ? [].concat(out[key], next) : next
        i++
      }
    } else out._.push(a)
  }
  return out
}

/** 支持的动作类型（与 runAction 的 switch 一一对应；写错类型必须在这里就被拒绝） */
const ACTION_TYPES = new Set([
  'nav', 'click', 'fill', 'pick', 'confirm', 'closeTop', 'overlayTitle',
  'checkRow', 'rowAction', 'rowActionAny', 'seg', 'toggleBox', 'scroll',
  'toast', 'wait', 'waitText', 'waitPath', 'assert', 'eval',
])

/** 每个动作的必填字段：缺了就报错，而不是等录到中途才失败 */
const ACTION_REQUIRED = {
  nav: ['text'],
  click: ['text|selector'],
  fill: ['match', 'value'],
  pick: ['option'],
  wait: ['ms'],
  waitText: ['text'],
  waitPath: ['startsWith'],
  assert: ['expr'],
  rowAction: ['text'],
  rowActionAny: ['texts'],
  seg: ['text'],
  toggleBox: ['label'],
  eval: ['js'],
}

/**
 * 载入期校验：把「录到一半才发现」的错误提前到「读文件时发现」。
 * 未知动作类型 / 断言语法非法 / 缺必填字段 → 致命；minSec 过短 → 仅告警（节奏问题，不是错误）。
 * 一次性汇总所有问题再抛出，避免改一个报一个。
 */
function validatePlan(plan) {
  const errors = []
  const warnings = []
  plan.steps.forEach((step, i) => {
    const at = `steps[${i}]`
    if (typeof step.caption !== 'string' || !step.caption.trim()) errors.push(`${at}.caption 必填（一句话讲解，用于字幕）`)
    if (!Array.isArray(step.actions) || step.actions.length === 0) errors.push(`${at}.actions 必填且不能为空`)

    const minSec = Number(step.minSec)
    if (!Number.isFinite(minSec) || minSec <= 0) {
      warnings.push(`${at}.minSec 未设置或非正数：该步时长将按 3 秒兜底`)
    } else if (!plan.narration && minSec < 3.5) {
      // 只有不开播报时 minSec 才是实际步长；开着播报时它只是个下限（配音更长以配音为准），
      // 对这类 plan 报「字幕一闪而过」是误报，会淹没真问题。
      const suggest = Math.max(3.5, Math.round(((step.caption || '').length / 6) * 10) / 10)
      warnings.push(`${at}.minSec=${minSec}s 偏短（「${String(step.caption).slice(0, 12)}…」${(step.caption || '').length} 字，建议 ≥${suggest}s）；未开启语音播报时它就是实际步长，字幕可能一闪而过`)
    }

    for (const [j, action] of (step.actions || []).entries()) {
      const where = `${at}.actions[${j}]`
      const type = typeof action === 'string' ? 'click' : action?.type
      if (!ACTION_TYPES.has(type)) {
        errors.push(`${where} 未知动作类型 "${type}"；可用：${[...ACTION_TYPES].join(' / ')}`)
        continue
      }
      for (const field of ACTION_REQUIRED[type] || []) {
        const ok = field.includes('|')
          ? field.split('|').some((f) => action[f] !== undefined && action[f] !== '')
          : action[field] !== undefined && action[field] !== ''
        if (!ok) errors.push(`${where}（${type}）缺少必填字段 ${field.replace('|', ' 或 ')}`)
      }
      if (type === 'assert') {
        try {
          restrictedAssert(action.expr)
        } catch (e) {
          errors.push(`${where} assert 表达式非法：${e.message}`)
        }
      }
    }
  })
  if (errors.length) {
    // 把告警一起挂上去：否则用户先改完 6 个错误、再跑一次才看到 minSec 告警，白跑一轮
    const err = new Error(`plan 校验未通过（${errors.length} 项）：\n  - ${errors.join('\n  - ')}`)
    err.planWarnings = warnings
    throw err
  }
  return warnings
}

function loadPlan(file) {
  if (!file) throw new Error('缺少 --plan 参数（示例见 references/plan-example.json）')
  const p = isAbsolute(file) ? file : resolve(process.cwd(), file)
  if (!existsSync(p)) throw new Error(`找不到计划文件：${p}`)
  const plan = JSON.parse(readFileSync(p, 'utf8'))
  if (!plan.url) throw new Error('plan.url 必填')
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error('plan.steps 必填且不能为空')
  plan.viewport = { width: 1600, height: 900, ...(plan.viewport || {}) }
  plan.capture = { fps: 5, jpegQuality: 82, screenshotTimeoutMs: 4000, ...(plan.capture || {}) }
  plan.timelineFps = plan.timelineFps || 25
  plan.uiKit = plan.uiKit || 'auto'
  plan.workDir = plan.workDir || null
  // 语音播报（TTS）默认关闭：成片默认只烧字幕，节奏由 minSec 决定。
  // 需要配音时在 plan 顶层显式写 "narration": true（仅接受布尔 true，避免字符串 "false" 被当真的坑）。
  plan.narration = plan.narration === true
  plan.planFile = p
  plan.warnings = validatePlan(plan)
  return plan
}

function workDirOf(plan, override) {
  const dir = override || plan.workDir || join(process.cwd(), `${plan.name || 'webdemo'}-work`)
  // 必须绝对化：这个路径会作为 --user-data-dir 交给浏览器原生进程，相对路径会被
  // Edge/Chrome 解析到别处，表现为「profile 目录空的、未产出 DevToolsActivePort」，
  // 且日志里只有一堆 extension sync 噪声，极难定位。凡是要交给原生 exe 的路径都先绝对化。
  const abs = resolve(dir)
  mkdirSync(abs, { recursive: true })
  return abs
}

/* -------------------------------------------------------------------- doctor */

async function cmdDoctor(args) {
  const env = detectAll({})
  const lines = []
  const mark = (ok) => (ok ? 'OK  ' : 'FAIL')
  lines.push('=== webdemo 环境体检 ===')
  lines.push(`平台      : ${env.platform.os} ${env.platform.arch}${env.platform.isRoot ? ' (root)' : ''}${env.platform.ci ? ' [CI]' : ''}`)
  lines.push(`Node      : ${mark(env.node.ok)} v${env.node.node} 内置WebSocket=${env.node.hasGlobalWebSocket}${env.node.wsModule ? ' (回退 ws 可用)' : ''}`)
  if (!env.node.ok) lines.push(`           修复：${env.node.fix}`)
  lines.push(`浏览器    : ${mark(env.browser.ok)} ${env.browser.ok ? `${env.browser.name} · ${env.browser.path}` : env.browser.reason}`)
  if (env.browser.ok) lines.push(`           版本：${env.browser.version}`)
  else lines.push(`           修复：${env.browser.fix}`)
  lines.push(`ffmpeg    : ${mark(env.media.ok)} ${env.media.ffmpeg || ''}`)
  if (env.media.ok) lines.push(`           ${env.media.version}`)
  else lines.push(`           修复：${env.media.fix}`)
  lines.push(`中文字体  : ${mark(env.font.ok)} ${env.font.name}${env.font.file ? ` (${env.font.file})` : ''}`)
  if (!env.font.ok) lines.push(`           修复：${env.font.fix}（缺失时字幕可能显示为方块）`)
  lines.push(`配音引擎  : ${mark(env.tts.ok)} ${env.tts.chosen ? env.tts.chosen.engine + (env.tts.chosen.voice ? ' / ' + env.tts.chosen.voice : '') : '未找到可用引擎'}`)
  lines.push('           （语音播报默认关闭；仅当 plan 里写 "narration": true 时才需要它）')
  if (!env.tts.ok) lines.push(`           修复：${env.tts.fix}\n           降级：${env.tts.fallback}`)
  lines.push(`临时目录  : ${mark(env.temp.writable)} ${env.temp.dir}`)

  lines.push('')
  lines.push(`结论      : 必需项 ${env.required ? '' : ''}${Object.entries(env.required).map(([k, v]) => `${k}=${v ? 'OK' : 'FAIL'}`).join('  ')}`)
  lines.push(`           可选能力 ${Object.entries(env.optional).map(([k, v]) => `${k}=${v ? 'OK' : '降级'}`).join('  ')}`)
  lines.push(`           可以运行：${env.ready ? '是' : '否'}${env.degraded ? '（有降级项，成片仍可用）' : ''}`)

  const text = lines.join('\n')
  if (args.json) console.log(JSON.stringify(env, null, 2))
  else console.log(text)
  return env.ready ? 0 : 2
}

/* --------------------------------------------------------------------- 通用启动 */

async function withBrowser(plan, extra, fn) {
  const overrides = { browserPath: plan.browserPath, ffmpegPath: plan.ffmpegPath, ffprobePath: plan.ffprobePath }
  const browser = detectBrowser(overrides.browserPath)
  if (!browser.ok) throw new Error(`${browser.reason}\n修复：${browser.fix}`)

  const workDir = workDirOf(plan, extra.workDir)
  const profileDir = join(workDir, 'browser-profile')
  const logFile = join(workDir, 'browser.log')
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  const bp = await launchBrowser({
    browserPath: browser.path,
    userDataDir: profileDir,
    width: plan.viewport.width,
    height: plan.viewport.height,
    logFile,
    initialUrl: 'about:blank',
    timeoutMs: plan.browserTimeoutMs || 30000,
  })

  let cdp = null
  try {
    // 下载目录每次运行都清空，否则报告里的 downloads 会把上一次的产物也算进来（幂等性）
    const downloadDir = extra.downloadDir || join(workDir, 'downloads')
    rmSync(downloadDir, { recursive: true, force: true })
    mkdirSync(downloadDir, { recursive: true })
    cdp = await openPage({
      port: bp.port,
      url: plan.url,
      width: plan.viewport.width,
      height: plan.viewport.height,
      downloadDir,
    })
    return await fn({ cdp, browser, bp, workDir, overrides })
  } finally {
    try {
      cdp?.close()
    } catch {
      /* ignore */
    }
    bp.kill()
  }
}

async function ensureSite(url) {
  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) throw new Error(String(res.status))
  } catch (e) {
    throw new Error(
      `目标站点不可访问：${url}（${e.message}）\n` +
        '排查建议：1) 确认被测服务已启动；2) 若是 Vite/Next 等 dev server，注意端口被占会自动换端口；' +
        '3) 容器内注意容器与服务的网络可见性。',
    )
  }
}

/**
 * 下载计数：轮询下载目录并写入页面的 window.__demoDownloads。
 *
 * 为什么不是监听 CDP 事件：`Browser.downloadWillBegin` 是 browser 域事件，而本工具连的是
 * page target 的会话，事件未必送达；轮询下载目录与事件语义无关，且天然区分「文件真落盘了没」。
 * 只有文件列表发生变化时才求值一次，避免与抓帧循环抢 CDP 连接。
 */
function startDownloadWatcher(cdp, downloadDir, intervalMs = 400) {
  let running = true
  let last = null
  const read = () => {
    try {
      return existsSync(downloadDir)
        ? readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'))
        : []
    } catch {
      return []
    }
  }
  const loop = (async () => {
    while (running) {
      const files = read()
      const key = files.join('|')
      if (key !== last) {
        last = key
        try {
          await cdp.ev(`window.__demoDownloads = ${JSON.stringify(files)}`)
        } catch {
          /* 页面正在导航/关闭时求值失败不应中断录制 */
        }
      }
      await sleep(intervalMs)
    }
  })()
  return {
    files: read,
    async stop() {
      running = false
      await loop.catch(() => {})
      return read()
    },
  }
}

/* ---------------------------------------------------------------------- probe */

async function cmdProbe(plan, args) {
  await ensureSite(plan.url)
  const routes = args.route ? [].concat(args.route) : plan.probeRoutes || []
  const inventory = await withBrowser(plan, args, async ({ cdp, workDir }) => {
    const selectors = resolveSelectors(plan.uiKit)
    await waitFor(cdp, `document.readyState === 'complete'`, 20000, '页面加载').catch(() => {})
    await injectHelpers(cdp, selectors, { readOnly: plan.readOnly })
    if (plan.login) await performLogin(cdp, plan.login, { selectors, readOnly: plan.readOnly, allowEval: false })
    await injectHelpers(cdp, selectors, { readOnly: plan.readOnly })

    const pages = []
    const snap = async (label) => {
      await injectHelpers(cdp, selectors, { readOnly: plan.readOnly })
      const inv = await cdp.ev('window.__demo.inventory()')
      pages.push({ label, ...(inv && !inv.__err ? inv : { error: String(inv?.__err || inv) }) })
    }
    await snap('(当前页)')
    for (const r of routes) {
      const res = await runAction(cdp, { type: 'nav', text: r }, { selectors, readOnly: plan.readOnly })
      if (res !== 'ok') {
        pages.push({ label: r, error: res })
        continue
      }
      await sleep(1200)
      await snap(r)
    }
    const outFile = join(workDir, 'inventory.json')
    writeFileSync(outFile, JSON.stringify({ url: plan.url, uiKit: plan.uiKit, pages }, null, 2), 'utf8')
    return { outFile, pages }
  })

  if (args.json) console.log(JSON.stringify(inventory.pages, null, 2))
  else {
    console.log(`侦察完成，${inventory.pages.length} 个页面 → ${inventory.outFile}\n`)
    for (const p of inventory.pages) {
      if (p.error) {
        console.log(`【${p.label}】失败：${p.error}\n`)
        continue
      }
      console.log(`【${p.label}】${p.path}`)
      console.log(`  按钮 : ${(p.buttons || []).join(' | ')}`)
      console.log(`  导航 : ${(p.nav || []).join(' | ')}`)
      if ((p.selects || []).length) console.log(`  下拉 : ${p.selects.join(' | ')}`)
      if ((p.segments || []).length) console.log(`  分段 : ${p.segments.join(' | ')}`)
      console.log(`  表格 : ${p.rowCount} 行；首行 ${JSON.stringify(p.firstRow)}`)
      console.log('')
    }
  }
  return 0
}

/* ----------------------------------------------------------------------- tts */

async function cmdTts(plan, args) {
  const workDir = workDirOf(plan, args.workDir)
  if (!plan.narration) {
    console.log('未开启语音播报（plan.narration 默认 false）：跳过 TTS，成片只出字幕，步骤时长按 minSec 走；需要配音请设 "narration": true')
    return 0
  }
  const media = detectFfmpeg(plan.ffmpegPath, plan.ffprobePath)
  if (!media.ok) throw new Error(`未找到 ffmpeg/ffprobe。修复：${media.fix}`)
  const tts = detectTts()
  const segments = plan.steps.map((s) => ({ text: s.caption, minSec: s.minSec || 3 }))
  const res = await synthesizeNarration({
    tts,
    segments,
    audioDir: join(workDir, 'audio'),
    ffmpeg: media.ffmpeg,
    ffprobe: media.ffprobe,
    logFile: join(workDir, 'tts.log'),
    rate: plan.tts?.rate ?? 0,
  })
  writeFileSync(join(workDir, 'durations.json'), JSON.stringify(res.durations, null, 2), 'utf8')
  console.log(res.ok ? `配音完成：${res.durations.length} 段（引擎 ${res.engine}）→ ${join(workDir, 'durations.json')}` : res.warnings.join('\n'))
  return 0
}

/* -------------------------------------------------------------------- record */

async function cmdRecord(plan, args) {
  const dryRun = !!args['dry-run'] || !!args.dryRun
  if (!dryRun) await ensureSite(plan.url)
  else await ensureSite(plan.url)

  const workDir = workDirOf(plan, args.workDir)
  // 读取配音时长（仅开启 narration 时）；否则步骤时长按 minSec 走
  let durations = []
  const durFile = join(workDir, 'durations.json')
  if (plan.narration && existsSync(durFile)) {
    try {
      durations = JSON.parse(readFileSync(durFile, 'utf8'))
    } catch {
      durations = []
    }
  }

  const stepMs = (i) => {
    if (dryRun) return 500
    const min = (plan.steps[i].minSec || 3) * 1000
    const audio = durations[i]?.audioMs ? durations[i].audioMs + 900 : 0
    return Math.max(min, audio)
  }

  const report = await withBrowser(plan, args, async ({ cdp, browser, bp, workDir }) => {
    const selectors = resolveSelectors(plan.uiKit)
    const ctx = { selectors, readOnly: !!plan.readOnly, allowEval: !!plan.allowEval }
    const captions = []
    const stepReports = []
    const failures = []

    await waitFor(cdp, `document.readyState === 'complete'`, 30000, '首屏加载').catch(() => {})
    await injectHelpers(cdp, selectors, { readOnly: ctx.readOnly })
    if (plan.login) await performLogin(cdp, plan.login, ctx)
    await injectHelpers(cdp, selectors, { readOnly: ctx.readOnly })

    // 抓帧循环（dry-run 不抓）
    const cap = dryRun ? null : await startCapture(cdp, {
      framesDir: join(workDir, 'frames'),
      fps: plan.capture.fps,
      quality: plan.capture.jpegQuality,
      timeoutMs: plan.capture.screenshotTimeoutMs,
    })
    // 下载计数：让断言探针 downloadCount() 有真实数据源（dry-run 也要，导出断言同样要校验）
    const dlWatch = startDownloadWatcher(cdp, join(workDir, 'downloads'))

    const t0 = Date.now()
    const elapsed = () => (Date.now() - t0) / 1000

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      const start = elapsed()
      captions.push({ text: step.caption, start, end: start })
      let failed = 0
      const actionResults = []
      for (const action of step.actions || []) {
        let r
        try {
          r = await runAction(cdp, action, ctx)
        } catch (e) {
          r = `E_EXCEPTION:${e.message}`
        }
        actionResults.push({ action, result: r })
        const ok = r === 'ok' || String(r).startsWith('ok')
        if (!ok) {
          failed++
          failures.push({ step: i + 1, caption: step.caption, action, result: String(r) })
          console.log(`      ! [${i + 1}] ${JSON.stringify(action)} → ${r}`)
          if (!plan.continueOnError) break
        } else if (dryRun) {
          console.log(`        [${i + 1}] ${action.type} ok`)
        }
      }
      const rest = stepMs(i) / 1000 - (elapsed() - start)
      if (rest > 0) await sleep(rest * 1000)
      captions[captions.length - 1].end = elapsed()
      stepReports.push({ index: i + 1, caption: step.caption, actions: actionResults.length, failed, startSec: Number(start.toFixed(2)), endSec: Number(captions[captions.length - 1].end.toFixed(2)) })
      console.log(`  · [${String(i + 1).padStart(2)}/${plan.steps.length}] ${step.caption}  (${elapsed().toFixed(1)}s)`)
      if (failed > 0 && !plan.continueOnError) break
    }

    const totalSec = elapsed()
    const downloads = await dlWatch.stop()
    let capture = null
    if (cap) {
      await cap.stop()
      capture = cap.stats()
    }

    writeSrt(captions, join(workDir, 'subs.srt'))
    writeCaptionsJson(captions, join(workDir, 'captions.json'))

    let timeline = null
    if (cap && capture.frameCount > 0) {
      timeline = buildTimeline({
        frames: cap.frames,
        t0,
        totalSec,
        fps: plan.timelineFps,
        outFile: join(workDir, 'frames.txt'),
        relPrefix: 'frames/',
      })
    }

    return {
      startedAt: new Date(t0).toISOString(),
      url: plan.url,
      browser: { name: browser.name, path: browser.path, cdpPort: bp.port, launch: bp.attempt },
      steps: stepReports,
      failures,
      capture,
      timeline,
      captions: captions.length,
      durationSec: Number(totalSec.toFixed(2)),
      downloads,
      degraded: !!(timeline && (timeline.heldRatio > 0.05 || (capture.maxGapSec || 0) > 1)),
    }
  })

  const reportFile = join(workDir, 'record-report.json')
  writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n录制完成：${report.captions} 步 / ${report.durationSec}s；导出文件 ${report.downloads.length} 个`)
  if (report.capture) console.log(`抓帧：${report.capture.frameCount} 帧，最大空档 ${report.capture.maxGapSec}s，抓帧错误 ${report.capture.errorCount} 次`)
  if (report.timeline) console.log(`时间轴：${report.timeline.slotCount} 帧 @${plan.timelineFps}fps = ${report.timeline.durationSec}s，静止补足 ${report.timeline.heldSlots} 帧`)
  console.log(`报告：${reportFile}`)
  if (report.failures.length) {
    console.log(`\n有 ${report.failures.length} 个动作未成功：`)
    for (const f of report.failures.slice(0, 10)) console.log(`  - [${f.step}] ${f.action.type} → ${f.result}`)
  }
  return report.failures.length ? 1 : 0
}

/* --------------------------------------------------------------------- build */

async function cmdBuild(plan, args) {
  const workDir = workDirOf(plan, args.workDir)
  const media = detectFfmpeg(plan.ffmpegPath, plan.ffprobePath)
  if (!media.ok) throw new Error(`未找到 ffmpeg/ffprobe。修复：${media.fix}`)
  const font = detectCjkFont()

  const captionsFile = join(workDir, 'captions.json')
  if (!existsSync(captionsFile)) throw new Error(`缺少 ${captionsFile}，请先执行 record`)
  const captionsRaw = JSON.parse(readFileSync(captionsFile, 'utf8'))
  // 封面：正片整体后移封面时长。
  // 注意两套时间轴不能混：
  //   · ASS 字幕挂在「正片段」上，取的是段内局部 PTS（concat 之后才整体后移），所以要用未偏移的时间；
  //   · 音轨延时发生 concat 之后的成片上，必须用偏移后的全局时间；
  //     外挂字幕同理（要跟最终成片对齐），所以另出一份 subs.with-cover.srt。
  const cover = plan.cover && Number(plan.cover.durationSec ?? 4) > 0 ? plan.cover : null
  const coverSec = cover ? Number(cover.durationSec ?? 4) : 0
  const captions = coverSec
    ? captionsRaw.map((c) => ({ ...c, startSec: Number((c.startSec + coverSec).toFixed(3)), endSec: Number((c.endSec + coverSec).toFixed(3)) }))
    : captionsRaw
  if (coverSec) writeSrt(captions, join(workDir, 'subs.with-cover.srt'))
  const audioDir = join(workDir, 'audio')
  const audioFiles = captions.map((c) => join(audioDir, `n${String(c.index).padStart(2, '0')}.wav`))
  // 配音：默认不出音轨（narration 未开启）；开启时缺任一文件同样不出，降级为仅字幕
  const allAudio = plan.narration && audioFiles.every((f) => existsSync(f))

  // 字幕排版：plan.captions 存在时走自绘 ASS（圆角容器 / 水印），否则沿用 SRT + 描边
  let assFile = null
  let assInfo = null
  let metrics = null
  if (plan.captions || cover) {
    metrics = await calibrateCaptionMetrics({
      ffmpeg: media.ffmpeg,
      workDir,
      fontName: plan.fontName || font.name,
      logFile: join(workDir, 'ffmpeg.log'),
    })
    if (!metrics) console.log('提示：字幕排版标定失败，容器尺寸按经验系数估算（可能略有偏差）')
    else console.log(`字幕标定：CJK 字宽 ${metrics.cjk.toFixed(3)}em（Fontsize 实际像素倍率）、墨高 ${metrics.inkHeight.toFixed(3)}em`)
  }
  if (plan.captions) {
    assInfo = writeCaptionsAss({
      captions: captionsRaw,
      outFile: join(workDir, 'captions.ass'),
      width: plan.viewport?.width || 1600,
      height: plan.viewport?.height || 900,
      fontName: plan.fontName || font.name,
      style: plan.captions,
      watermark: plan.watermark || null,
      metrics,
    })
    assFile = 'captions.ass'
  }
  let coverInfo = null
  if (cover) {
    coverInfo = writeCoverAss({
      outFile: join(workDir, 'cover.ass'),
      width: plan.viewport?.width || 1600,
      height: plan.viewport?.height || 900,
      fontName: plan.fontName || font.name,
      cover,
      metrics,
    })
  }

  const outName = `${plan.name || 'webdemo'}.mp4`
  const outAscii = join(workDir, `out-${Date.now()}.mp4`)
  const res = await buildVideo({
    ffmpeg: media.ffmpeg,
    ffprobe: media.ffprobe,
    workDir,
    framesList: 'frames.txt',
    srtFile: 'subs.srt',
    assFile,
    captions,
    audioFiles: allAudio ? audioFiles : [],
    fontName: plan.fontName || font.name,
    fontOk: font.ok,
    outFile: outAscii,
    logFile: join(workDir, 'ffmpeg.log'),
    fps: plan.timelineFps,
    baseName: plan.name || 'demo',
    coverAssFile: coverInfo ? 'cover.ass' : null,
    coverDurationSec: coverSec,
    coverBgColor: cover?.bgColor || '0x1F3A33',
    videoWidth: plan.viewport?.width || 1600,
    videoHeight: plan.viewport?.height || 900,
  })

  // 中文文件名统一由 Node 改名（不要把非 ASCII 交给原生 exe）
  const finalName = join(workDir, outName)
  rmSync(finalName, { force: true })
  renameSync(outAscii, finalName)

  const level = res.hasAudio ? await audioLevel(media.ffmpeg, finalName) : null
  const timelineDurationSec = JSON.parse(readFileSync(join(workDir, 'record-report.json'), 'utf8')).timeline?.durationSec ?? null
  const report = {
    output: finalName,
    narration: !!plan.narration,
    durationSec: res.durationSec,
    sizeBytes: res.sizeBytes,
    hasAudio: res.hasAudio,
    audio: level,
    timelineDurationSec,
    expectedDurationSec: timelineDurationSec === null ? null : Number((timelineDurationSec + coverSec).toFixed(2)),
    cover: coverInfo
      ? { durationSec: coverSec, title: coverInfo.title, subtitle: coverInfo.subtitle, footer: coverInfo.footer, attribution: coverInfo.attribution, bgColor: cover?.bgColor || '0x1F3A33' }
      : null,
    font: { name: plan.fontName || font.name, ok: font.ok },
    captions: assInfo
      ? { file: assInfo.outFile, mode: plan.captions.mode || 'box', boxHeight: assInfo.boxHeight, centerY: assInfo.centerY, watermark: assInfo.watermark }
      : { mode: 'srt-outline' },
    warnings: res.warnings,
  }
  writeFileSync(join(workDir, 'build-report.json'), JSON.stringify(report, null, 2), 'utf8')

  console.log(`成片：${finalName}`)
  const audioLabel = res.hasAudio ? '有' : plan.narration ? '无（配音缺失，已降级为仅字幕）' : '无（未开启语音播报）'
  console.log(`时长 ${res.durationSec.toFixed(2)}s ｜ 体积 ${(res.sizeBytes / 1024 / 1024).toFixed(2)} MB ｜ 音轨 ${audioLabel}`)
  if (coverInfo) console.log(`封面：${coverSec}s 标题卡「${coverInfo.title} / ${coverInfo.subtitle}」${coverInfo.footer ? `｜页脚「${coverInfo.footer}」` : ''}（正片与字幕整体后移 ${coverSec}s）`)
  if (assInfo) console.log(`字幕：圆角容器排版（${plan.captions.mode || 'box'}，容器高 ${assInfo.boxHeight}px，基线 y=${assInfo.centerY}）${assInfo.watermark ? `；水印「${assInfo.watermark}」` : ''}`)
  if (level) console.log(`音轨电平 mean ${level.meanDb} dB / max ${level.maxDb} dB${level.silent ? '（疑似静音！）' : ''}`)
  for (const w of res.warnings) console.log(`提示：${w}`)
  return 0
}

/* ------------------------------------------------------------------ open/demo */

async function cmdOpen(args) {
  const target = args._[1]
  if (!target) throw new Error('用法：webdemo open <文件>')
  const abs = isAbsolute(target) ? target : resolve(process.cwd(), target)
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  // Start-Process 无法可靠唤起 AppX/Store 默认应用（会静默失败），统一交给系统 shell
  const cmd = IS_WIN ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  await run(cmd, [abs], { timeoutMs: 15000 }).catch(() => {})
  console.log(`已请求系统默认程序打开：${abs}`)
  return 0
}

async function cmdDemo(plan, args) {
  // demo = tts + record + build（未开启 narration 时 tts 自动跳过），
  // 与文档里「一条命令跑完」的承诺一致：开启播报时也能一条命令出带配音的成片。
  const code0 = await cmdTts(plan, args)
  if (code0 !== 0) return code0
  const code1 = await cmdRecord(plan, args)
  if (code1 !== 0 && !plan.continueOnError) return code1
  return cmdBuild(plan, args)
}

/* -------------------------------------------------------------------- 入口 */

const HELP = `webdemo —— 通用无头 Web 演示视频工具（零依赖）

用法：
  node webdemo.mjs doctor [--json]
  node webdemo.mjs probe  --plan plan.json [--route "营地管理" ...]
  node webdemo.mjs tts    --plan plan.json
  node webdemo.mjs record --plan plan.json [--dry-run]
  node webdemo.mjs build  --plan plan.json
  node webdemo.mjs demo   --plan plan.json
  node webdemo.mjs open   <文件>

说明：plan.json 结构见 references/plan-example.json。
      语音播报默认关闭（只出字幕）；需要配音时在 plan 顶层写 "narration": true。
      demo = tts + record + build，未开启播报时自动跳过 tts。
      --dry-run 走同一套步骤但不抓帧，用于快速校验交互是否都能点到。`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (!cmd || cmd === 'help' || args.help) {
    console.log(HELP)
    return 0
  }
  if (cmd === 'doctor') return cmdDoctor(args)
  if (cmd === 'open') return cmdOpen(args)

  const plan = loadPlan(args.plan)
  for (const w of plan.warnings || []) console.log(`⚠ plan 提示：${w}`)
  switch (cmd) {
    case 'probe':
      return cmdProbe(plan, args)
    case 'tts':
      return cmdTts(plan, args)
    case 'record':
      return cmdRecord(plan, args)
    case 'build':
      return cmdBuild(plan, args)
    case 'demo':
      return cmdDemo(plan, args)
    default:
      console.log(HELP)
      return 1
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error(`\n失败：${e.message}`)
    for (const w of e.planWarnings || []) console.error(`⚠ plan 提示：${w}`)
    process.exit(1)
  })
