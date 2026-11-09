/**
 * 浏览器进程管理 + 极简 CDP 客户端（零依赖）
 *
 * 跨环境要点：
 *   - 调试端口用 0，从 <user-data-dir>/DevToolsActivePort 读实际端口 → 多任务/CI 不会撞端口
 *   - stderr 重定向到文件而不是管道：受限沙箱下用管道 stdio 捕获子进程输出会 EPERM
 *   - --headless=new 失败自动降级 --headless（旧内核）
 *   - 启动失败时把浏览器日志尾部回吐，便于远程排查
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserLaunchArgs, browserLaunchArgsLegacy } from './env.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ CDP 客户端 */

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        return
      }
      if (msg.method) {
        const fns = this.listeners.get(msg.method)
        if (fns) for (const fn of fns) fn(msg.params)
      }
    })
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node 无内置 WebSocket。请升级到 Node ≥ 22，或在本技能 scripts 目录执行 npm i ws')
    }
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时（${timeoutMs}ms）：${wsUrl}`)), timeoutMs)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('CDP 连接失败'))
        },
        { once: true },
      )
    })
    return new CDP(ws)
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
    })
  }

  /** 求值；页面抛异常时返回 {__err} 而不是静默 null */
  async ev(expression, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) {
      return { __err: r.exceptionDetails.text || '页面执行异常', __exception: r.exceptionDetails.exception?.description || '' }
    }
    return r.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------------- 浏览器进程 */

/**
 * 启动无头浏览器并返回 { proc, port, browserWsUrl, kill(), logFile, diag() }
 * @param opts.browserPath 浏览器可执行文件
 * @param opts.userDataDir 一次性 profile 目录
 * @param opts.logFile     浏览器 stderr 落盘位置（便于排查）
 * @param opts.initialUrl  首个页面（默认 about:blank，保证 /json/list 里有 page target）
 */
export async function launchBrowser(opts) {
  const { browserPath, userDataDir, width = 1600, height = 900, logFile, initialUrl = 'about:blank', timeoutMs = 30000 } = opts

  // 每次尝试都换一个 profile 目录：上一次尝试若留下未退干净的浏览器（Edge/Chrome 会把
  // 已经存在的实例接管过去），同一目录会直接撞 ProcessSingleton，报出
  // "Lock file can not be created / 未产出 DevToolsActivePort" 这类看不懂的错，把重试也一起带死。
  const attempts = [
    { label: 'headless=new', dir: userDataDir, args: browserLaunchArgs({ userDataDir, width, height }) },
    { label: 'headless(legacy)', dir: `${userDataDir}-r1`, args: browserLaunchArgsLegacy({ userDataDir: `${userDataDir}-r1`, width, height }) },
    {
      label: 'headless=new +no-sandbox',
      dir: `${userDataDir}-r2`,
      args: browserLaunchArgs({ userDataDir: `${userDataDir}-r2`, width, height, extra: ['--no-sandbox', '--disable-dev-shm-usage'] }),
    },
  ]

  const errors = []
  for (const attempt of attempts) {
    for (const f of ['DevToolsActivePort', 'SingletonLock']) {
      // 上一轮残留会让新实例直接退出
      const p = join(attempt.dir, f)
      try {
        if (existsSync(p)) rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    }

    let stderrFd = null
    const stdio = ['ignore', 'ignore', 'ignore']
    if (logFile) {
      try {
        stderrFd = openSync(logFile, 'a')
        stdio[2] = stderrFd
      } catch {
        /* 落盘失败则退化为丢弃 */
      }
    }

    const proc = spawn(browserPath, [...attempt.args, initialUrl], { stdio, windowsHide: true })
    let exitedAt = 0
    proc.on('exit', () => {
      exitedAt = Date.now()
    })

    const portFile = join(attempt.dir, 'DevToolsActivePort')
    const deadline = Date.now() + timeoutMs
    let port = 0
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        try {
          const [line] = readFileSync(portFile, 'utf8').split('\n')
          const n = Number(line.trim())
          if (Number.isInteger(n) && n > 0) {
            port = n
            break
          }
        } catch {
          /* 文件可能刚创建，重试 */
        }
      }
      // 关键：启动进程「退出」不等于启动失败——Edge/Chrome 的启动器会把控制权转交给真正的
      // 浏览器进程后自己退出，端口文件随后才写出来。所以给一段宽限期，别一退出就判死。
      if (exitedAt && Date.now() - exitedAt > EXIT_GRACE_MS) break
      await sleep(200)
    }

    if (stderrFd !== null) {
      try {
        closeSync(stderrFd)
      } catch {
        /* ignore */
      }
    }

    if (port > 0) {
      return {
        proc,
        port,
        userDataDir: attempt.dir,
        logFile,
        attempt: attempt.label,
        kill: () => killTree(proc),
        diag: () => tailFile(logFile, 20),
      }
    }

    killTree(proc)
    errors.push(`${attempt.label}: ${exitedAt ? '进程已退出' : '未产出 DevToolsActivePort'}${logFile ? ' | ' + (tailFile(logFile, 3) || '') : ''}`)
  }

  throw new Error(
    '无头浏览器启动失败（已尝试 3 组参数）。\n  ' +
      errors.join('\n  ') +
      '\n排查建议：1) 手动执行该浏览器看是否可启动；2) Linux/容器内确保有 --no-sandbox（本技能已自动加）；' +
      '3) 确认 --user-data-dir 目录可写；4) 精简版容器可能缺 libnss3/libatk 等依赖，需 apt-get install -y 对应包；' +
      '5) 若上次运行异常中断，先删掉 <workDir> 下的 browser-profile* 目录与残留浏览器进程再重试。',
  )
}

/** 启动器退出后仍继续等端口文件的宽限期（Edge/Chrome 会先转交控制权再退出） */
const EXIT_GRACE_MS = 5000

/**
 * 结束浏览器：必须连子进程一起杀。
 * Windows 上 Edge/Chrome 是「启动器 + 真正的浏览器进程」两段式，只 kill 启动器会留下
 * 占着 profile 锁与调试端口的孤儿进程，导致下一次运行必然启动失败——所以用 taskkill /T /F。
 */
function killTree(proc) {
  if (!proc) return
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
      return
    } catch {
      /* 退回单进程 kill */
    }
  }
  if (proc.killed) return
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
}

function tailFile(file, lines) {
  if (!file || !existsSync(file)) return ''
  try {
    const all = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return all.slice(-lines).join(' | ')
  } catch {
    return ''
  }
}

/** 取一个 page target；没有就尝试创建（新版 Chrome 的 /json/new 需要 PUT） */
export async function getPageTarget(port, timeoutMs = 15000) {
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await fetchJson(`${base}/json/list`)
    const page = (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) return page
    // 尝试显式创建
    try {
      await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })
    } catch {
      /* ignore */
    }
    await sleep(300)
  }
  throw new Error('未找到可用的页面调试目标（page target）。请确认启动参数里带了初始页面。')
}

async function fetchJson(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * 打开页面并等待可用，返回已 enable 各域的 CDP 客户端。
 * 统一处理：视口锁定、下载目录、导航后重新注入辅助库由调用方负责。
 */
export async function openPage({ port, url, width = 1600, height = 900, downloadDir, deviceScaleFactor = 1 }) {
  const target = await getPageTarget(port)
  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
  if (downloadDir) {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true })
  }
  if (url) {
    await cdp.send('Page.navigate', { url })
  }
  return cdp
}
