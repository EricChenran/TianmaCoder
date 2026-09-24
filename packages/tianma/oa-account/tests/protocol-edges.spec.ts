/**
 * Protocol edges the happy path never reaches: transport failures, the response
 * size cap, bodies outside the documented envelope, every classified status, and
 * the caller-lifetime signal every request accepts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OaAccountError,
  fetchCaptcha,
  fetchProfile,
  fetchStats,
  oaBaseUrl,
  postRefresh,
  postSignIn,
  postSignOut,
  putProfile,
} from '../src/protocol.ts'

/** The deployment these specs pretend to talk to. */
const BASE = oaBaseUrl('https://oa.example.test/api/v1')

/** The wire account holder, complete enough to pass validation. */
const WIRE_USER = {
  id: 7, account: 'chenran', name: '陈祖豪', code: 'A001', phone: '15301835458',
  department: '运营部', position: '最高管理员', level: '一级', avatar: '/uploads/a.jpg',
  hire_date: '2026-07-01', employment_type: 'formal', role: 'super_admin', status: 'active',
  wx_bound: true, created_at: '2026-07-01T15:28:56',
}

/** Stub `fetch` with one handler per call. */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => handler(String(input), init)))
}

/** One envelope answer. */
function envelope(status: number, body: unknown): Response {
  return Response.json(body, { status })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('base URL validation', () => {
  it('refuses every shape that cannot carry credentials, and keeps the ones that can', () => {
    expect(oaBaseUrl('https://oa.example.test').href).toBe('https://oa.example.test/')
    expect(() => oaBaseUrl('https://user:secret@oa.example.test/api/v1')).toThrow(/userinfo/)
    expect(() => oaBaseUrl('https://oa.example.test/api/v1?x=1')).toThrow(/query or fragment/)
    expect(() => oaBaseUrl('https://oa.example.test/api/v1#frag')).toThrow(/query or fragment/)
    expect(() => oaBaseUrl('http://oa.example.test/api/v1')).toThrow(/loopback/)
    expect(oaBaseUrl('http://localhost:8080/api/v1').href).toBe('http://localhost:8080/api/v1/')
  })
})

describe('transport failures', () => {
  it('reports its own deadline as a timeout', async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by the deadline')) })
    }))
    await expect(fetchCaptcha(BASE, 5)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('reports a withdrawn caller as a network failure, not a timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    // A real fetch rejects at once for a signal that is already aborted.
    stubFetch((_url, init) => {
      const signal = init?.signal
      if (signal?.aborted === true) return Promise.reject(new Error('aborted by the caller'))
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('aborted by the caller')) })
      })
    })
    await expect(fetchCaptcha(BASE, 5_000, controller.signal)).rejects.toMatchObject({ code: 'network' })
  })

  it('reports a rejected fetch as a network failure naming the error', async () => {
    stubFetch(() => Promise.reject(new TypeError('connection refused')))
    await expect(fetchCaptcha(BASE, 5_000)).rejects.toThrow(/TypeError/)
    stubFetch(() => Promise.reject('not an Error'))
    await expect(fetchCaptcha(BASE, 5_000)).rejects.toThrow(/unknown/)
  })
})

describe('response decoding', () => {
  it('refuses a body larger than the readable cap', async () => {
    stubFetch(() => Promise.resolve(new Response('x'.repeat(262_145), { status: 200 })))
    await expect(fetchCaptcha(BASE, 5_000)).rejects.toMatchObject({ code: 'protocol' })
  })

  it('treats an empty or non-JSON success body as outside the envelope', async () => {
    stubFetch(() => Promise.resolve(new Response('', { status: 200 })))
    await expect(fetchCaptcha(BASE, 5_000)).rejects.toThrow(/outside the documented envelope/)
    stubFetch(() => Promise.resolve(new Response('<html>', { status: 200 })))
    await expect(fetchCaptcha(BASE, 5_000)).rejects.toThrow(/outside the documented envelope/)
  })

  it('classifies each documented status, with and without a message', async () => {
    const cases: readonly [number, string][] = [[400, 'rejected'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'rejected'], [429, 'rate-limited']]
    for (const [status, code] of cases) {
      stubFetch(() => Promise.resolve(envelope(status, { code: status, message: 'backend says no', data: null })))
      await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toMatchObject({ code, message: 'backend says no' })
      // A non-envelope body still yields the code; the message falls back.
      stubFetch(() => Promise.resolve(Response.json({}, { status })))
      await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toThrow(/oa account request was refused/)
    }
  })

  it('reports an envelope success code on a failing HTTP status as that status', async () => {
    stubFetch(() => Promise.resolve(envelope(500, { code: 200, message: 'success', data: {} })))
    await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toMatchObject({ code: 'protocol' })
  })

  it('reports an unknown status as protocol', async () => {
    stubFetch(() => Promise.resolve(envelope(503, { code: 503, message: 'busy', data: null })))
    await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toMatchObject({ code: 'protocol' })
    // A non-object body carries no message to fall back to.
    stubFetch(() => Promise.resolve(Response.json('plain', { status: 400 })))
    await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toThrow(/refused/)
    // An empty message is no message.
    stubFetch(() => Promise.resolve(Response.json({ message: '' }, { status: 400 })))
    await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toThrow(/refused/)
  })
})

describe('payload validation', () => {
  it('accepts either captcha image spelling and refuses a payload with neither', async () => {
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'success', data: { captcha_id: 'c1', image: 'data:image/png;base64,BB' } })))
    expect(await fetchCaptcha(BASE, 5_000)).toEqual({ captchaId: 'c1', image: 'data:image/png;base64,BB' })
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'success', data: { captcha_id: 'c1' } })))
    await expect(fetchCaptcha(BASE, 5_000)).rejects.toThrow(/was not understood/)
  })

  it('refuses a sign-in payload missing its token pair or a user field', async () => {
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'ok', data: { token: 'a', user: WIRE_USER } })))
    await expect(postSignIn(BASE, { account: 'a', password: 'b', captchaId: 'c', captcha: 'd' }, 5_000))
      .rejects.toThrow(/sign-in payload was not understood/)
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'ok', data: { token: 'a', refresh_token: 'r', user: { ...WIRE_USER, wx_bound: 'yes' } } })))
    await expect(postSignIn(BASE, { account: 'a', password: 'b', captchaId: 'c', captcha: 'd' }, 5_000))
      .rejects.toThrow(/sign-in payload was not understood/)
  })

  it('refuses a refresh payload with an empty token', async () => {
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'ok', data: { token: '' } })))
    await expect(postRefresh(BASE, 'refresh', 5_000)).rejects.toThrow(/refresh payload was not understood/)
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'ok', data: { token: 'fresh' } })))
    expect(await postRefresh(BASE, 'refresh', 5_000)).toBe('fresh')
  })

  it('refuses profile, write, and counter payloads it cannot read', async () => {
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'ok', data: { id: 'not-a-number' } })))
    await expect(fetchProfile(BASE, 'token', 5_000)).rejects.toThrow(/profile payload was not understood/)
    await expect(putProfile(BASE, 'token', { name: 'x' }, 5_000)).rejects.toThrow(/profile payload was not understood/)
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: 'ok', data: { approval: {} } })))
    await expect(fetchStats(BASE, 'token', 5_000)).rejects.toThrow(/stats payload was not understood/)
  })

  it('reads counters the backend actually sends', async () => {
    stubFetch(() => Promise.resolve(envelope(200, {
      code: 200,
      message: 'ok',
      data: {
        user: WIRE_USER,
        approval: { pending: 1, my_applications: 2, rejected: 3 },
        task: { overdue: 4, today: 5, upcoming: 6, work_hours: 7 },
        schedule: { today: 8 },
      },
    })))
    expect(await fetchStats(BASE, 'token', 5_000)).toEqual({
      approval: { pending: 1, myApplications: 2, rejected: 3 },
      task: { overdue: 4, today: 5, upcoming: 6, workHours: 7 },
      schedule: { today: 8 },
    })
  })

  it('refuses a sign-out answer outside the envelope', async () => {
    stubFetch(() => Promise.resolve(new Response('', { status: 200 })))
    await expect(postSignOut(BASE, 'token', 5_000)).rejects.toThrow(/outside the documented envelope/)
    stubFetch(() => Promise.resolve(envelope(200, { code: 200, message: '登出成功', data: null })))
    await expect(postSignOut(BASE, 'token', 5_000)).resolves.toBeUndefined()
  })
})

describe('caller lifetime', () => {
  it('carries a live signal into every request', async () => {
    const controller = new AbortController()
    stubFetch((url) => Promise.resolve(url.endsWith('/auth/captcha')
      ? envelope(200, { code: 200, message: 'ok', data: { captcha_id: 'c1', img: 'data:image/png;base64,AA' } })
      : url.endsWith('/auth/login')
        ? envelope(200, { code: 200, message: 'ok', data: { token: 'a', refresh_token: 'r', user: WIRE_USER } })
        : url.endsWith('/auth/refresh')
          ? envelope(200, { code: 200, message: 'ok', data: { token: 'a2' } })
          : envelope(200, { code: 200, message: 'ok', data: WIRE_USER })))
    expect((await fetchCaptcha(BASE, 5_000, controller.signal)).captchaId).toBe('c1')
    expect((await postSignIn(BASE, { account: 'a', password: 'b', captchaId: 'c', captcha: 'd' }, 5_000, controller.signal)).token).toBe('a')
    expect(await postRefresh(BASE, 'r', 5_000, controller.signal)).toBe('a2')
    expect((await fetchProfile(BASE, 'a', 5_000, controller.signal)).account).toBe('chenran')
    expect((await putProfile(BASE, 'a', { name: 'x' }, 5_000, controller.signal)).account).toBe('chenran')
    expect(await postSignOut(BASE, 'a', 5_000, controller.signal)).toBeUndefined()
  })

  it('classifies a failure it cannot name', () => {
    const error = new OaAccountError('network', 'boom')
    expect(error.name).toBe('OaAccountError')
    expect(error).toBeInstanceOf(Error)
  })
})
