/**
 * OA account behavior: the stored session, the single silent re-sign, the
 * account-status gate, and the refusal codes the prompt path reports.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
} from '@deepseek-ai/dsh-credentials'
import OaAccountService, { isActiveStatus } from '@tianma/dsh-oa-account'
import { OaAccountError, oaBaseUrl } from '../src/protocol.ts'

/** The deployment the specs pretend to talk to. */
const BASE = 'https://oa.example.test/api/v1'

/** The one record this plugin owns. */
const SESSION_KEY = credentialKey('tianma-oa-account', 'session')

/** One wire account holder, as the backend spells it. */
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

/** The stored projection of {@link WIRE_USER}: the service's own vocabulary. */
const STORED_USER = {
  id: 7,
  account: 'chenran',
  name: '陈祖豪',
  code: 'A001',
  phone: '15301835458',
  department: '运营部',
  position: '最高管理员',
  level: '一级',
  avatar: '/uploads/avatar.jpg',
  hireDate: '2026-07-01',
  employmentType: 'formal',
  role: 'super_admin',
  status: 'active',
  wxBound: true,
  createdAt: '2026-07-01T15:28:56',
}

/** In-memory credential seam: the account service owns one grant record. */
class FakeCredentials extends CredentialProvider {
  private readonly records = new Map<string, CredentialRecord>()

  /** @returns the stored record count, so a spec can assert a wipe. */
  get size(): number { return this.records.size }

  async resolve(): Promise<undefined> { return undefined }
  async describe(): Promise<CredentialInfo> { return { configured: false, writable: true } }
  async set(): Promise<void> { throw new Error('the account service writes records, never references') }
  async unset(): Promise<void> { throw new Error('the account service writes records, never references') }
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return this.records.get(String(key)) }
  async describeRecord(): Promise<CredentialRecordInfo> { throw new Error('the account service never describes a record') }
  async listRecords(): Promise<readonly CredentialRecordEntry[]> { return [] }
  async deleteRecord(key: CredentialKey): Promise<void> { this.records.delete(String(key)) }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(String(key)))
    if (next !== undefined) this.records.set(String(key), next)
    return next
  }
}

/** One recorded request, so a spec can assert the re-sign sequence. */
interface Call {
  /** Request path below the API prefix. */
  path: string
  /** HTTP method. */
  method: string
  /** Bearer token the caller sent, when it sent one. */
  token: string | undefined
}

/** Successful three-layer envelope. */
function ok(data: unknown, status = 200, message = 'success'): Response {
  return Response.json({ code: status, message, data }, { status })
}

/** Failing three-layer envelope. */
function fail(status: number, message: string): Response {
  return Response.json({ code: status, message, data: null }, { status })
}

/**
 * Stub `fetch` with one handler per `METHOD /path`, recording every call.
 * @param routes - handler per request key.
 * @returns the recorded calls.
 */
function stubFetch(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.href)
    const path = url.pathname.replace('/api/v1/', '')
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ path, method, token: headers.authorization?.replace('Bearer ', '') })
    const handler = routes[`${method} ${path}`]
    if (handler === undefined) return Promise.reject(new Error(`unexpected request ${method} ${path}`))
    return Promise.resolve(handler())
  }))
  return calls
}

/** A mounted service and the fake seam its records land in. */
interface Mounted {
  /** The service under test. */
  service: OaAccountService
  /** The fake credential seam. */
  seam: FakeCredentials
  /** The Host context, for plucking optional services. */
  ctx: Context
}

/**
 * Mount the service over the fake credential seam.
 * @param options - gate switch and base URL overrides.
 * @returns the mounted pieces.
 */
async function mounted(options: { requireSignIn?: boolean; baseUrl?: string } = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(FakeCredentials)
  await ctx.plugin(OaAccountService, {
    baseUrl: options.baseUrl ?? BASE,
    requireSignIn: options.requireSignIn ?? true,
    requestTimeoutMs: 1000,
  })
  // The fake is the only provider this context mounts, so the lookup is exact.
  return { service: ctx.oaAccount, seam: ctx.get('credentials') as FakeCredentials, ctx }
}

/**
 * Sign one session in over stubbed routes.
 * @param service - the mounted service.
 * @param status - account state the backend reports for this attempt.
 */
async function signIn(service: OaAccountService, status = 'active'): Promise<void> {
  stubFetch({
    'GET auth/captcha': () => ok({ captcha_id: 'c1', img: 'data:image/png;base64,AA' }),
    'POST auth/login': () => ok({
      token: 'access-1', refresh_token: 'refresh-1', user: { ...WIRE_USER, status },
    }),
  })
  const captcha = await service.captcha()
  await service.signIn({ account: 'chenran', password: '123456', captchaId: captcha.captchaId, captcha: 'Dxfn' })
  vi.unstubAllGlobals()
}

afterEach(() => { vi.unstubAllGlobals() })

describe('oaBaseUrl', () => {
  it('keeps the version prefix and refuses an origin that cannot carry credentials', () => {
    expect(oaBaseUrl(BASE).href).toBe('https://oa.example.test/api/v1/')
    expect(() => oaBaseUrl('http://oa.example.test/api/v1')).toThrow(OaAccountError)
    // Loopback HTTP stays addressable for a local deployment.
    expect(oaBaseUrl('http://127.0.0.1:8080/api/v1').href).toBe('http://127.0.0.1:8080/api/v1/')
    expect(() => oaBaseUrl('not a url')).toThrow(OaAccountError)
    expect(() => oaBaseUrl('https://oa.example.test/api/v1?a=1')).toThrow(OaAccountError)
    expect(() => oaBaseUrl('https://user:secret@oa.example.test/api/v1')).toThrow(OaAccountError)
  })
})

describe('isActiveStatus', () => {
  it('admits only the active state, so an unknown one cannot widen access', () => {
    expect(isActiveStatus('active')).toBe(true)
    expect(isActiveStatus('disabled')).toBe(false)
    expect(isActiveStatus('banned')).toBe(false)
    expect(isActiveStatus(null)).toBe(false)
    expect(isActiveStatus('active-ish')).toBe(false)
  })
})

describe('OaAccountService', () => {
  it('reports signed out and refuses a conversation before any sign-in', async () => {
    const { service } = await mounted()
    const session = await service.session()
    expect(session.signedIn).toBe(false)
    expect(session.user).toBeNull()
    expect(session.assetOrigin).toBe('https://oa.example.test')
    expect(await service.gate()).toEqual({ allowed: false, reason: 'signed-out' })
    await expect(service.assertMayStartConversation()).rejects.toThrow(/signed-out/)
  })

  it('stores the session, then reads the profile and counters with its access token', async () => {
    const { service, seam } = await mounted()
    await signIn(service)
    expect(seam.size).toBe(1)
    const calls = stubFetch({
      'GET users/profile': () => ok(WIRE_USER),
      'GET users/stats': () => ok({
        user: WIRE_USER,
        approval: { pending: 1, my_applications: 2, rejected: 0 },
        task: { overdue: 3, today: 4, upcoming: 5, work_hours: 6 },
        schedule: { today: 7 },
      }),
    })
    const profile = await service.profile()
    expect(profile.name).toBe('陈祖豪')
    expect(profile.hireDate).toBe('2026-07-01')
    const stats = await service.stats()
    expect(stats.approval.myApplications).toBe(2)
    expect(stats.task.workHours).toBe(6)
    expect(stats.schedule.today).toBe(7)
    expect(calls.every(call => call.token === 'access-1')).toBe(true)
    expect(await service.gate()).toEqual({ allowed: true })
  })

  it('re-signs once on 401 and retries the request with the fresh token', async () => {
    const { service } = await mounted()
    await signIn(service)
    const calls = stubFetch({
      'GET users/profile': () => calls.filter(call => call.path === 'users/profile').length === 1
        ? fail(401, 'Token已过期')
        : ok(WIRE_USER),
      'POST auth/refresh': () => ok({ token: 'access-2' }, 200, 'Token刷新成功'),
    })
    const profile = await service.profile()
    expect(profile.account).toBe('chenran')
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET users/profile', 'POST auth/refresh', 'GET users/profile',
    ])
    expect(calls[2]?.token).toBe('access-2')
  })

  it('clears the session when the re-sign is refused, reporting the backend reason', async () => {
    const { service, seam } = await mounted()
    await signIn(service)
    stubFetch({
      'GET users/profile': () => fail(401, '账号已被停用'),
      'POST auth/refresh': () => fail(401, '账号已被停用'),
    })
    await expect(service.profile()).rejects.toThrow('账号已被停用')
    expect(seam.size).toBe(0)
    expect((await service.session()).signedIn).toBe(false)
  })

  it('refuses to store a session for an account the backend does not mark active', async () => {
    const { service, seam } = await mounted()
    stubFetch({
      'POST auth/login': () => ok({
        token: 'access-1', refresh_token: 'refresh-1', user: { ...WIRE_USER, status: 'disabled' },
      }),
    })
    await expect(service.signIn({ account: 'chenran', password: 'x', captchaId: 'c1', captcha: 'y' }))
      .rejects.toThrow(/disabled/)
    expect(seam.size).toBe(0)
  })

  it('refuses a conversation while the stored account is not active', async () => {
    const { service, seam } = await mounted()
    // The backend can flip the status behind a stored session; this is what the
    // gate reads before the next conversation starts.
    await seam.modifyRecord(SESSION_KEY, () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 1,
        token: 'access-1',
        refreshToken: 'refresh-1',
        user: { ...STORED_USER, status: 'banned' },
      },
    }))
    const payload = await seam.readRecord(SESSION_KEY)
    expect(payload).toBeDefined()
    expect(await service.gate()).toEqual({ allowed: false, reason: 'inactive-account' })
    await expect(service.assertMayStartConversation()).rejects.toThrow(/inactive-account/)
  })

  it('writes the changed profile fields and keeps the newest holder', async () => {
    const { service } = await mounted()
    await signIn(service)
    stubFetch({ 'PUT users/profile': () => ok({ ...WIRE_USER, name: '新名字', phone: '13800000000' }) })
    const updated = await service.updateProfile({ name: '新名字', phone: '13800000000' })
    expect(updated.name).toBe('新名字')
    expect((await service.session()).user?.name).toBe('新名字')
  })

  it('signs out locally even when the backend refuses the advisory call', async () => {
    const { service, seam } = await mounted()
    await signIn(service)
    stubFetch({ 'POST auth/logout': () => fail(500, 'boom') })
    const session = await service.signOut()
    expect(session.signedIn).toBe(false)
    expect(seam.size).toBe(0)
  })

  it('reports a signed-out session when a stored record is not this plugin\'s shape', async () => {
    const { service, seam } = await mounted()
    await seam.modifyRecord(SESSION_KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 9 } }))
    expect((await service.session()).signedIn).toBe(false)
    // A record that is not a grant is equally unreadable.
    await seam.modifyRecord(SESSION_KEY, () => Promise.resolve({ kind: 'api-key', key: 'x' }))
    expect((await service.session()).signedIn).toBe(false)
  })

  it('admits every conversation while the gate is switched off', async () => {
    const { service } = await mounted({ requireSignIn: false })
    expect(await service.gate()).toEqual({ allowed: true })
    await expect(service.assertMayStartConversation()).resolves.toBeUndefined()
  })

  it('surfaces a backend refusal outside the envelope with its own message', async () => {
    const { service } = await mounted()
    stubFetch({ 'POST auth/login': () => Response.json({ message: '请输入验证码' }, { status: 400 }) })
    await expect(service.signIn({ account: 'a', password: 'b', captchaId: 'c', captcha: 'd' }))
      .rejects.toThrow('请输入验证码')
  })

  it('reports a transport failure as a network error and a refused envelope as protocol', async () => {
    const { service } = await mounted()
    stubFetch({ 'GET users/profile': () => ok(WIRE_USER) })
    await expect(service.profile()).rejects.toThrow(/not signed in/)
    await signIn(service)
    stubFetch({ 'GET users/profile': () => ok({ unexpected: true }) })
    await expect(service.profile()).rejects.toThrow(/profile payload was not understood/)
  })

  it('streams the current session and then every change', async () => {
    const { service } = await mounted()
    const controller = new AbortController()
    const frames: boolean[] = []
    const reader = (async () => {
      for await (const frame of service.watch(controller.signal)) {
        frames.push(frame.signedIn)
        if (frames.length === 2) controller.abort()
      }
    })()
    await vi.waitFor(() => { expect(frames).toEqual([false]) })
    await signIn(service)
    await reader
    expect(frames).toEqual([false, true])
  })
})

describe('OaPromptAdmission', () => {
  it('names why a conversation was refused', async () => {
    // The account service mounts the admission check itself, so this reads the
    // service the composition actually gets.
    const { ctx } = await mounted()
    const admission = ctx.get('promptAdmission')
    expect(admission).toBeDefined()
    expect(await admission?.admitPrompt())
      .toEqual({ code: 'sign-in-required', message: 'sign in to start a conversation' })
  })

  it('admits once the account is signed in', async () => {
    const { ctx, service } = await mounted()
    await signIn(service)
    expect(await ctx.get('promptAdmission')?.admitPrompt()).toBeUndefined()
  })
})
