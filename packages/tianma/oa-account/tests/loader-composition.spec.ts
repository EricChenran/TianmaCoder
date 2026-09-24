/**
 * Real-composition proof: a `cordis.yml` booted through the vendored Loader
 * mounts the OA account over the real local credential provider, and the
 * admission check the prompt path reads follows the session it stores.
 *
 * The OA backend is the one external service, and it is a local stub: captcha,
 * sign-in, refresh, logout, profile, and counters all answer from the same
 * three-layer envelope the shipped backend uses.
 */

import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { PromptAdmission } from '@deepseek-ai/dsh-api-session-controller/types'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import OaAccountService from '@tianma/dsh-oa-account'

/** One wire account holder, as the shipped backend spells it. */
const WIRE_USER = {
  id: 7,
  account: 'chenran',
  name: '陈祖豪',
  code: 'A001',
  phone: '15301835458',
  department: '运营部',
  position: '最高管理员',
  level: '一级',
  avatar: '/uploads/avatar.jpg',
  hire_date: '2026-07-01',
  employment_type: 'formal',
  role: 'super_admin',
  status: 'active',
  wx_bound: true,
  created_at: '2026-07-01T15:28:56',
}

let root: string | undefined
let context: Context | undefined
let server: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (server !== undefined) {
    await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
    server = undefined
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('oa-account real Loader composition through cordis.yml', () => {
  it('stores the signed-in session and gates admission on it', async () => {
    // The stub backend starts active and flips to disabled when the spec says so,
    // which is how the shipped backend makes a ban take effect mid-session.
    let disabled = false
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace('/api/v1/', '')
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (path === 'auth/captcha') { send(200, { code: 200, message: 'success', data: { captcha_id: 'fixture-captcha', img: 'data:image/png;base64,AA' } }); return }
      if (path === 'auth/login') {
        send(200, { code: 200, message: '登录成功', data: { token: 'access-1', refresh_token: 'refresh-1', user: WIRE_USER } })
        return
      }
      if (path === 'auth/refresh') {
        send(disabled ? 401 : 200, disabled
          ? { code: 401, message: '账号已被停用', data: null }
          : { code: 200, message: 'Token刷新成功', data: { token: 'access-2' } })
        return
      }
      if (path === 'auth/logout') { send(200, { code: 200, message: '登出成功', data: null }); return }
      if (path === 'users/profile') {
        send(disabled ? 401 : 200, disabled
          ? { code: 401, message: '账号已被停用', data: null }
          : { code: 200, message: 'success', data: WIRE_USER })
        return
      }
      if (path === 'users/stats') {
        send(200, {
          code: 200,
          message: 'success',
          data: {
            user: WIRE_USER,
            approval: { pending: 0, my_applications: 0, rejected: 0 },
            task: { overdue: 0, today: 0, upcoming: 0, work_hours: 0 },
            schedule: { today: 0 },
          },
        })
        return
      }
      send(404, { code: 404, message: 'not found', data: null })
    })
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the stub backend has no port')
    const baseUrl = `http://127.0.0.1:${String(address.port)}/api/v1`

    root = await mkdtemp(join(tmpdir(), 'dsh-oa-loader-'))
    const credentialPath = join(root, 'credentials.yaml')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-credentials-local'",
      '  config:',
      `    path: ${JSON.stringify(credentialPath)}`,
      '    watch: false',
      "- name: '@tianma/dsh-oa-account'",
      '  config:',
      `    baseUrl: ${JSON.stringify(baseUrl)}`,
      '    requireSignIn: true',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-credentials-local') return LocalCredentialProvider
        if (specifier === '@tianma/dsh-oa-account') return OaAccountService
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    // The admission check is a child plugin of the account row, so the spec
    // waits for it the way a consumer does rather than assuming boot order.
    const admission = await new Promise<PromptAdmission>((resolve, reject) => {
      context!.inject(['promptAdmission'], (child) => {
        const mounted = child.promptAdmission
        if (mounted === undefined) reject(new Error('the admission service never mounted'))
        else resolve(mounted)
      })
    })
    // Nothing is signed in yet, so the prompt path is refused before a turn.
    expect(await admission.admitPrompt())
      .toEqual({ code: 'sign-in-required', message: 'sign in to start a conversation' })
    expect((await context.oaAccount.session()).signedIn).toBe(false)

    const captcha = await context.oaAccount.captcha()
    expect(captcha.captchaId).toBe('fixture-captcha')
    const signedIn = await context.oaAccount.signIn({
      account: 'chenran', password: '123456', captchaId: captcha.captchaId, captcha: 'Dxfn',
    })
    expect(signedIn).toMatchObject({ signedIn: true, status: 'active' })
    expect((await context.oaAccount.profile()).name).toBe('陈祖豪')
    expect((await context.oaAccount.stats()).schedule.today).toBe(0)
    // The real provider stored the session, and it holds no plaintext password.
    expect(existsSync(credentialPath)).toBe(true)
    const stored = readFileSync(credentialPath, 'utf8')
    expect(stored).toContain('tianma-oa-account/session')
    expect(stored).not.toContain('123456')
    expect(await admission.admitPrompt()).toBeUndefined()

    // The backend bans the account behind the stored session: the next protected
    // request is refused, the re-sign is refused too, and the session is dropped.
    disabled = true
    await expect(context.oaAccount.profile()).rejects.toThrow('账号已被停用')
    expect((await context.oaAccount.session()).signedIn).toBe(false)
    expect(await admission.admitPrompt())
      .toEqual({ code: 'sign-in-required', message: 'sign in to start a conversation' })
  }, 30_000)
})
