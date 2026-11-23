/**
 * The 演示视频 skill's wechatide driver: locating the CLI, tolerating the CLI's real
 * result envelopes, settling the `pending + taskId` authorization handshake, and
 * mapping failures to the codes `record.cjs` branches on.
 *
 * These cases pin the contract the DevTools CLI actually exposes (checked against
 * v0.3.11): every toolCall may answer `ok: true` with `status: "pending"`, and a
 * failure carries `ok: false` plus `code`/`reason`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface StatusResult {
  loginExpired?: boolean
  versionRelation?: string
  loginUser?: { nickName?: string }
}

interface DriverInstance {
  status(): StatusResult
  ensureReady(): StatusResult
  openWindow(mode?: string): unknown
  closeWindow(): unknown
  tap(selector: string, opts?: { index?: number; waitForSelector?: string }): unknown
  currentPagePath(): string | null
  callMethod(method: string, args?: unknown): unknown
}

interface ShimPage {
  path?: string
  $$(selector: string): Promise<{ tap(): Promise<unknown> }[]>
}

interface Shim {
  currentPage(): Promise<ShimPage>
  reLaunch(url: string): Promise<unknown>
}

interface ExecOutcome {
  status?: number
  stdout?: string
  stderr?: string
  error?: { code?: string }
}

interface DriverModule {
  locateCli(opts: Record<string, unknown>): { path: string; source: string } | null
  readInstalledSkillVersion(root: string): string | null
  parseJsonOutput(stdout: string): unknown
  pickRoute(value: unknown): string | null
  pickArray(value: unknown): unknown[] | null
  createDriver(opts: Record<string, unknown>): DriverInstance
  mpShim(driver: DriverInstance): Shim
}

const require_ = createRequire(import.meta.url)
const driverModule = require_('../skills/demo-video/miniprogram/scripts/wechatide.cjs') as DriverModule

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechatide-driver-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** The `code` a thrown driver error carries, for failure-path assertions. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

/** A driver whose CLI is a scripted `exec`, so no real DevTools is touched. */
function scriptedDriver(handler: (args: string[]) => ExecOutcome, extra: Record<string, unknown> = {}): {
  driver: DriverInstance
  calls: string[][]
} {
  const calls: string[][] = []
  const driver = driverModule.createDriver({
    cliPath: 'wechatide.cmd',
    project: 'C:\\probe',
    sleep: () => {},
    log: () => {},
    exec: (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: '', stderr: '', ...handler(args) }
    },
    ...extra,
  })
  return { driver, calls }
}

const toolOf = (args: string[]): string => args[2] as string

const jsonOut = (payload: object): ExecOutcome => ({ status: 0, stdout: JSON.stringify(payload), stderr: '' })

describe('wechatide driver · locating the CLI', () => {
  it('honours an explicit path, the environment variable, and the install root in that order', () => {
    const root = temporaryDirectory()
    const explicit = join(root, 'explicit.cmd')
    writeFileSync(explicit, '')

    expect(driverModule.locateCli({ explicit, env: {}, lookupPath: () => null })).toEqual({ path: explicit, source: 'config' })

    const fromEnv = join(root, 'from-env.cmd')
    writeFileSync(fromEnv, '')
    expect(driverModule.locateCli({ env: { DSH_WECHATIDE_CMD: fromEnv }, lookupPath: () => null }))
      .toEqual({ path: fromEnv, source: 'env' })

    const install = join(root, '微信web开发者工具')
    mkdirSync(install, { recursive: true })
    const inside = join(install, 'wechatide.cmd')
    writeFileSync(inside, '')
    expect(driverModule.locateCli({ devtools: install, env: {}, platform: 'win32', lookupPath: () => null }))
      .toEqual({ path: inside, source: 'install-root' })
  })

  it('finds the CLI on PATH without shelling out to `where`, so non-ASCII directories survive', () => {
    const root = temporaryDirectory()
    const onPath = join(root, '微信web开发者工具')
    mkdirSync(onPath, { recursive: true })
    const inside = join(onPath, 'wechatide.cmd')
    writeFileSync(inside, '')
    expect(driverModule.locateCli({
      env: { PATH: `${join(root, 'nowhere')};${onPath}` },
      platform: 'win32',
    })).toEqual({ path: inside, source: 'path' })
  })

  it('returns null when no candidate exists, and fails loud on a wrong explicit path', () => {
    // A platform without these install roots keeps the case independent of what this machine has.
    expect(driverModule.locateCli({ env: {}, platform: 'linux', lookupPath: () => null }))
      .toBe(null)
    expect(codeOf(() => driverModule.locateCli({ explicit: join(temporaryDirectory(), 'missing.cmd'), env: {} })))
      .toBe('WECHATIDE_MISSING')
  })

  it('reads the version of the skill that ships inside the install root', () => {
    const root = temporaryDirectory()
    const skill = join(root, 'resources', 'app.asar.unpacked', 'wechatide-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: wechatide-skill\nversion: 0.3.11\n---\n\n# body\n')
    expect(driverModule.readInstalledSkillVersion(root)).toBe('0.3.11')
    expect(driverModule.readInstalledSkillVersion(join(root, 'nowhere'))).toBe(null)
  })
})

describe('wechatide driver · reading the CLI output', () => {
  it('parses a clean payload, a payload behind log noise, and rejects garbage', () => {
    expect(driverModule.parseJsonOutput('{"ok":true}')).toEqual({ ok: true })
    expect(driverModule.parseJsonOutput('[wechatide] skill-call: …\n{"ok":false,"code":"APPID_ERROR"}'))
      .toEqual({ ok: false, code: 'APPID_ERROR' })
    expect(driverModule.parseJsonOutput('')).toBe(null)
    expect(driverModule.parseJsonOutput('not json at all')).toBe(null)
  })

  it('walks nested results for a route and an array', () => {
    expect(driverModule.pickRoute({ result: { currentPage: { route: '/pages/home/index' } } }))
      .toBe('/pages/home/index')
    expect(driverModule.pickRoute({ page: { path: 'no-slash' } })).toBe(null)
    expect(driverModule.pickArray({ result: { rects: [{ left: 0 }, { left: 10 }] } }))
      .toEqual([{ left: 0 }, { left: 10 }])
  })
})

describe('wechatide driver · authorization handshake', () => {
  it('polls a pending auth task until the real status arrives', () => {
    let polls = 0
    const { driver, calls } = scriptedDriver((args) => {
      if (toolOf(args) === 'check_wechatide_status') {
        return jsonOut({ ok: true, result: { success: true, status: 'pending', taskId: 'auth_1', taskType: 'auth' } })
      }
      polls += 1
      if (polls < 2) {
        return jsonOut({ ok: true, result: { success: true, status: 'pending', taskId: 'auth_1', taskType: 'auth' } })
      }
      return jsonOut({
        ok: true,
        result: {
          success: true,
          status: 'success',
          detail: 'authorization_success',
          result: { loginExpired: false, versionRelation: 'equal', loginUser: { nickName: '演示账号' } },
        },
      })
    })

    const status = driver.status()
    expect(status.loginExpired).toBe(false)
    expect(status.versionRelation).toBe('equal')
    expect(polls).toBe(2)
    expect(calls.map(toolOf)).toEqual(['check_wechatide_status', 'polling_task_result', 'polling_task_result'])
  })

  it('reports an expired login instead of recording into the login page', () => {
    const { driver } = scriptedDriver(() => jsonOut({ ok: true, result: { success: true, loginExpired: true } }))
    expect(codeOf(() => driver.ensureReady())).toBe('WECHATIDE_LOGIN_EXPIRED')
  })

  it('treats a pending task that never settles as an authorization timeout', () => {
    const pending = jsonOut({ ok: true, result: { success: true, status: 'pending', taskId: 'auth_2', taskType: 'auth' } })
    const { driver } = scriptedDriver(() => pending, { authTimeoutMs: 0 })
    expect(codeOf(() => driver.status())).toBe('WECHATIDE_AUTH_TIMEOUT')
  })
})

describe('wechatide driver · failures and interactions', () => {
  it('surfaces the CLI failure code and message untouched', () => {
    const { driver } = scriptedDriver(() => jsonOut({
      ok: false,
      errorType: 'MCP_TOOL_ERROR',
      message: '不存在此 AppID 请检查后重新输入',
      code: 'APPID_ERROR',
      reason: 'APPID_ERROR',
    }))
    expect(codeOf(() => driver.openWindow())).toBe('APPID_ERROR')
  })

  it('taps the first match through the selector with an explicit wait', () => {
    const { driver, calls } = scriptedDriver(() => jsonOut({ ok: true, result: { success: true } }))
    driver.tap('.buy')
    expect(calls[0]).toContain('automation_element_action')
    expect(calls[0]).toContain('--wait-for-selector')
    expect(calls[0]).not.toContain('--x')
  })

  it('taps the Nth match by its bounding-box centre, and refuses when it has no coordinates', () => {
    const withRects = scriptedDriver(args => (toolOf(args) === 'automation_evaluate'
      ? jsonOut({
        ok: true,
        result: {
          success: true,
          result: [{ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 20, width: 10, height: 10 }],
        },
      })
      : jsonOut({ ok: true, result: { success: true } })))
    withRects.driver.tap('.spec-pill', { index: 1 })
    const tapCall = withRects.calls.find(args => toolOf(args) === 'automation_element_action')
    expect(tapCall).toBeDefined()
    expect(tapCall).toEqual(expect.arrayContaining(['--x', '5', '--y', '25']))

    const noRects = scriptedDriver(() => jsonOut({ ok: false, code: 'WECHATIDE_TOOL_FAILED', message: 'nope' }))
    expect(codeOf(() => noRects.driver.tap('.spec-pill', { index: 1 }))).toBe('WECHATIDE_INDEX_UNSUPPORTED')
  })

  it('keeps the automator-shaped mp facade working on top of the CLI', async () => {
    const { driver, calls } = scriptedDriver((args) => {
      if (toolOf(args) === 'automation_runtime_info') {
        return jsonOut({ ok: true, result: { success: true, result: { route: '/pages/home/index' } } })
      }
      if (toolOf(args) === 'automation_page_action') {
        return jsonOut({ ok: true, result: { success: true, result: [{ selector: '.item' }, { selector: '.item' }] } })
      }
      return jsonOut({ ok: true, result: { success: true } })
    })
    const mp = driverModule.mpShim(driver)

    const page = await mp.currentPage()
    expect(page.path).toBe('/pages/home/index')

    await mp.reLaunch('/pages/login/index')
    const navigateCall = calls.find(args => toolOf(args) === 'automation_navigate')
    expect(navigateCall).toEqual(expect.arrayContaining(['--action', 'reLaunch', '--url', '/pages/login/index']))

    const handles = await page.$$('.item')
    expect(handles).toHaveLength(2)
    await handles[0]?.tap()
    expect(calls.some(args => toolOf(args) === 'automation_element_action')).toBe(true)
  })
})
