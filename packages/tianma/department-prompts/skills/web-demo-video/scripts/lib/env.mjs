/**
 * 跨环境能力探测 —— 本技能能否运行的地基
 *
 * 设计原则：
 *   1. 只依赖 Node 标准库（不引入任何 npm 依赖），Node ≥ 21.7 可用内置 WebSocket
 *   2. 每一项能力都给出「探测结果 + 备选路径 + 缺失时的可执行修复命令」
 *   3. 探测失败不抛异常，返回结构化结果，由调用方决定降级策略
 *
 * 覆盖平台：Windows / macOS / Linux（含 root、CI、无显示器、容器等常见差异）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, homedir, platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const require = createRequire(import.meta.url)

export const IS_WIN = platform() === 'win32'
export const IS_MAC = platform() === 'darwin'
export const IS_LINUX = platform() === 'linux'
export const IS_ROOT = (() => {
  try {
    return typeof process.getuid === 'function' && process.getuid() === 0
  } catch {
    return false
  }
})()

/* ------------------------------------------------------------------ 工具 */

/** 在 PATH 上找可执行文件（跨平台，不依赖 which/where 是否存在） */
export function which(cmd) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      try {
        if (existsSync(p) && statSync(p).isFile()) return p
      } catch {
        /* 跳过不可读目录 */
      }
    }
  }
  return null
}

/** 跑一条命令拿 stdout（失败返回 null，不抛） */
export function tryRun(cmd, args, timeoutMs = 8000) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim()
  } catch {
    return null
  }
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return null
}

/* ---------------------------------------------------------- 浏览器探测 */

/**
 * 浏览器候选路径（按平台）。
 * 顺序即优先级：Chromium 系皆可（CDP 协议一致），优先 Edge（Windows 自带）。
 */
export function browserCandidates() {
  const home = homedir()
  if (IS_WIN) {
    return [
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env.LOCALAPPDATA || join(home, 'AppData\\Local'), 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env.LOCALAPPDATA || join(home, 'AppData\\Local'), 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    ]
  }
  if (IS_MAC) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ]
}

export function detectBrowser(explicitPath) {
  const candidates = []
  if (explicitPath) candidates.push(explicitPath)
  if (process.env.DSH_WEBDEMO_BROWSER) candidates.push(process.env.DSH_WEBDEMO_BROWSER)
  candidates.push(...browserCandidates())
  // 退路：PATH 上的名字
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge', 'chrome', 'brave-browser']) {
    const p = which(name)
    if (p) candidates.push(p)
  }

  const found = firstExisting(candidates)
  if (!found) {
    return {
      ok: false,
      path: null,
      reason: '未找到任何 Chromium 系浏览器',
      fix: IS_WIN
        ? '安装 Microsoft Edge（系统自带）或 Google Chrome：winget install Google.Chrome'
        : IS_MAC
          ? '安装 Google Chrome，或 brew install --cask google-chrome'
          : '安装 Chromium：apt-get install -y chromium  或  dnf install -y chromium',
    }
  }

  const version = detectBrowserVersion(found)

  return { ok: true, path: found, name: browserNameOf(found), version: version || '未知' }
}

/**
 * 取浏览器版本。
 * 注意：Windows 上 Edge/Chrome 的 `--version` 不会把版本打到 stdout，
 * 因此 Windows 走文件版本信息（PowerShell），非 Windows 走 --version。
 */
function detectBrowserVersion(exePath) {
  if (IS_WIN) {
    const ps = which('pwsh') || which('powershell')
    if (ps) {
      const out = tryRun(ps, ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`], 10000)
      if (out) return out.trim()
    }
    return null
  }
  const raw = tryRun(exePath, ['--version'])
  return raw ? raw.trim() : null
}

function browserNameOf(p) {
  const s = p.toLowerCase()
  if (s.includes('edge')) return 'Edge'
  if (s.includes('chrome')) return 'Chrome'
  if (s.includes('chromium')) return 'Chromium'
  if (s.includes('brave')) return 'Brave'
  return 'Chromium-based'
}

/**
 * 启动参数（按环境自适应）。
 * 关键：端口用 0 让系统分配，避免固定端口在多任务/CI 上撞车。
 */
export function browserLaunchArgs({ userDataDir, width, height, extra = [] }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    // 目标通常是 localhost：绕开系统代理，避免代理拦截 127.0.0.1
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    ...extra,
  ]
  // 容器 / root / 小内存场景的常见加固
  if (IS_LINUX && (IS_ROOT || process.env.CI)) args.push('--no-sandbox', '--disable-dev-shm-usage')
  else if (IS_LINUX && !existsSync('/dev/shm')) args.push('--disable-dev-shm-usage')
  return args
}

/** 旧内核不支持 --headless=new 时的降级参数 */
export function browserLaunchArgsLegacy(opts) {
  return browserLaunchArgs(opts).map((a) => (a === '--headless=new' ? '--headless' : a))
}

/* ------------------------------------------------------------ ffmpeg 探测 */

export function ffmpegCandidates() {
  const home = homedir()
  const names = IS_WIN ? ['ffmpeg.exe'] : ['ffmpeg']
  const out = []
  if (IS_WIN) {
    // winget / chocolatey / scoop / 手动解压的常见位置
    const base = join(process.env.LOCALAPPDATA || join(home, 'AppData\\Local'), 'Microsoft', 'WinGet', 'Packages')
    if (existsSync(base)) {
      try {
        for (const dir of readdirSync(base)) {
          if (!dir.toLowerCase().includes('ffmpeg')) continue
          for (const sub of readdirSync(join(base, dir))) {
            for (const bin of ['bin']) {
              for (const n of names) out.push(join(base, dir, sub, bin, n))
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    out.push('C:\\ffmpeg\\bin\\ffmpeg.exe', join(home, 'scoop\\shims\\ffmpeg.exe'))
  } else {
    out.push(
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      '/snap/bin/ffmpeg',
      join(home, '.local/bin/ffmpeg'),
    )
  }
  return out
}

export function detectFfmpeg(explicitFfmpeg, explicitFfprobe) {
  const find = (name, explicit, envKey, cands) => {
    const order = [explicit, process.env[envKey], which(name), ...cands].filter(Boolean)
    return firstExisting(order)
  }
  const cands = ffmpegCandidates()
  const ffmpeg = find('ffmpeg', explicitFfmpeg, 'DSH_FFMPEG_PATH', cands)
  const ffprobe = find('ffprobe', explicitFfprobe, 'DSH_FFPROBE_PATH', cands.map((p) => p.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')))

  const version = ffmpeg ? (tryRun(ffmpeg, ['-version']) || '').split('\n')[0] : null
  return {
    ok: !!(ffmpeg && ffprobe),
    ffmpeg,
    ffprobe,
    version,
    fix: IS_WIN
      ? 'winget install Gyan.FFmpeg   或   choco install ffmpeg'
      : IS_MAC
        ? 'brew install ffmpeg'
        : 'apt-get install -y ffmpeg   或   dnf install -y ffmpeg',
  }
}

/* --------------------------------------------------------------- 字体探测 */

/**
 * 中文字体探测：字幕烧录（libass）找不到中文字体会渲染成方块。
 * 返回可用的 FontName 与依据；找不到时给出安装命令。
 */
export function detectCjkFont() {
  const winFonts = [
    { file: 'C:\\Windows\\Fonts\\msyh.ttc', name: 'Microsoft YaHei' },
    { file: 'C:\\Windows\\Fonts\\msyhbd.ttc', name: 'Microsoft YaHei' },
    { file: 'C:\\Windows\\Fonts\\simhei.ttf', name: 'SimHei' },
    { file: 'C:\\Windows\\Fonts\\simsun.ttc', name: 'SimSun' },
  ]
  const macFonts = [
    { file: '/System/Library/Fonts/PingFang.ttc', name: 'PingFang SC' },
    { file: '/System/Library/Fonts/Hiragino Sans GB.ttc', name: 'Hiragino Sans GB' },
    { file: '/Library/Fonts/Arial Unicode.ttf', name: 'Arial Unicode MS' },
  ]
  const linuxFonts = [
    { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', name: 'Noto Sans CJK SC' },
    { file: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', name: 'Noto Sans CJK SC' },
    { file: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', name: 'WenQuanYi Zen Hei' },
    { file: '/usr/share/fonts/truetype/arphic/uming.ttc', name: 'AR PL UMing CN' },
  ]

  const list = IS_WIN ? winFonts : IS_MAC ? macFonts : linuxFonts
  for (const f of list) {
    if (existsSync(f.file)) return { ok: true, name: f.name, file: f.file }
  }

  // Linux/mac 再问一次 fontconfig（能发现装在非标准路径的字体）
  if (!IS_WIN) {
    const fcList = which('fc-list')
    if (fcList) {
      const out = tryRun(fcList, [':lang=zh', 'family']) || ''
      const family = out.split('\n')[0]?.split(',')[0]?.trim()
      if (family) return { ok: true, name: family, file: '(fontconfig)' }
    }
  }

  return {
    ok: false,
    name: IS_WIN ? 'Microsoft YaHei' : IS_MAC ? 'PingFang SC' : 'Noto Sans CJK SC',
    file: null,
    fix: IS_WIN
      ? '系统应自带中文字体；若为 Server 精简版，请在「设置 → 语言」安装中文语言包'
      : IS_MAC
        ? '系统自带苹方字体，通常无需处理'
        : 'apt-get install -y fonts-noto-cjk   或   dnf install -y google-noto-sans-cjk-fonts',
  }
}

/* ---------------------------------------------------------------- TTS 探测 */

/**
 * 讲解配音引擎探测。返回按优先级排列的可用引擎列表——
 * 这是「降级阶梯」的第一环：Windows SAPI → macOS say → Linux espeak/pico → 无（仅字幕）。
 */
export function detectTts() {
  const engines = []

  if (IS_WIN) {
    const ps = which('pwsh') || which('powershell')
    if (ps) {
      // SAPI 中文语音存在性探测（只在 doctor 里做一次，避免每次合成都慢）
      const probe = tryRun(ps, [
        '-NoProfile',
        '-Command',
        "try { $v=New-Object -ComObject SAPI.SpVoice; ($v.GetVoices() | ForEach-Object { $_.GetDescription() }) -join '|' } catch { '' }",
      ], 15000)
      const voices = (probe || '').split('|').filter(Boolean)
      const zh = voices.find((v) => /chinese|中文|huihui|kangkang|yaoyao|xiaoxiao/i.test(v))
      if (zh) engines.push({ engine: 'sapi', command: ps, voice: zh, voices })
      else engines.push({ engine: 'sapi-novoice', command: ps, voice: null, voices })
    }
  }

  if (IS_MAC) {
    const say = which('say')
    if (say) {
      const voices = (tryRun(say, ['-v', '?']) || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const zh = voices.find((l) => /zh_CN|zh-CN|Tingting|Meijia|Sinji/i.test(l))
      engines.push({ engine: 'say', command: say, voice: zh ? zh.split(/\s{2,}/)[0] : 'Tingting', voices })
    }
  }

  if (IS_LINUX) {
    for (const [cmd, args, voice] of [
      ['espeak-ng', ['-v', 'zh'], 'zh'],
      ['espeak', ['-v', 'zh'], 'zh'],
      ['pico2wave', ['-l', 'zh-CN'], 'zh-CN'],
    ]) {
      const p = which(cmd)
      if (p) engines.push({ engine: cmd, command: p, voice, args })
    }
  }

  const usable = engines.find((e) => e.engine !== 'sapi-novoice')
  return {
    ok: !!usable,
    engines,
    chosen: usable || null,
    fix: IS_WIN
      ? '在「设置 → 时间和语言 → 语音」添加中文语音包（通常已内置 Microsoft Huihui）'
      : IS_MAC
        ? '系统自带 say 命令与中文语音，通常无需处理'
        : 'apt-get install -y espeak-ng   或   apt-get install -y libttspico-utils',
    fallback: '无可用 TTS 时将只烧录字幕（不含配音），视频仍然可用',
  }
}

/* ------------------------------------------------------------ Node 能力探测 */

export function detectNodeRuntime() {
  const major = Number(process.versions.node.split('.')[0])
  const hasGlobalWs = typeof WebSocket === 'function'
  let wsModule = null
  if (!hasGlobalWs) {
    try {
      // 仅供提示：不强制依赖
      require.resolve('ws')
      wsModule = 'ws'
    } catch {
      wsModule = null
    }
  }
  return {
    ok: hasGlobalWs || !!wsModule,
    node: process.versions.node,
    major,
    hasGlobalWebSocket: hasGlobalWs,
    wsModule,
    fix:
      major < 21
        ? '升级 Node 到 22 LTS 或更高（内置 WebSocket），或在本技能目录 npm i ws'
        : 'Node 版本正常；若仍报缺少 WebSocket，请在本技能 scripts 目录执行 npm i ws',
  }
}

/* ------------------------------------------------------------------ 汇总 */

export function detectAll(overrides = {}) {
  const browser = detectBrowser(overrides.browserPath)
  const media = detectFfmpeg(overrides.ffmpegPath, overrides.ffprobePath)
  const font = detectCjkFont()
  const tts = detectTts()
  const node = detectNodeRuntime()

  // 磁盘：抓帧是磁盘大户（1600×900 JPEG 约 120–200KB/帧，5fps × 60s ≈ 60MB）
  const tmp = tmpdir()
  let tmpWritable = false
  try {
    const probeFile = join(tmp, `.webdemo-probe-${process.pid}`)
    writeFileSync(probeFile, 'ok')
    rmSync(probeFile, { force: true })
    tmpWritable = true
  } catch {
    tmpWritable = false
  }

  const required = {
    node: node.ok,
    browser: browser.ok,
    ffmpeg: media.ok,
    tempWritable: tmpWritable,
  }
  const optional = { tts: tts.ok, cjkFont: font.ok }

  return {
    platform: { os: platform(), arch: arch(), release: tryRun(IS_WIN ? 'cmd' : 'uname', IS_WIN ? ['/c', 'ver'] : ['-a']) || '', isRoot: IS_ROOT, ci: !!process.env.CI },
    node,
    browser,
    media,
    font,
    tts,
    temp: { dir: tmp, writable: tmpWritable },
    required,
    optional,
    ready: Object.values(required).every(Boolean),
    degraded: !Object.values(optional).every(Boolean),
  }
}
