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

/* ────────────────────────── 工作台 ────────────────────────── */

/** One wire approval, as the employee side spells it. */
const WIRE_APPROVAL = {
  id: 18,
  title: '请假申请',
  type: '请假申请',
  department: '技术部',
  project_name: null,
  project_no: null,
  created_at: '2026年11月23日 09:30',
  applicant_name: '张三',
  applicant_avatar: null,
  arrivalTime: '2小时前到达',
  status: 'pending',
  content: { start_date: '2026-11-24', reason: '事假', days: 2, special_comp_leave: false, attachments: ['/uploads/a.png'] },
  current_level: 1,
  total_levels: 2,
  nodes: [{ id: 30, level: 1, status: 'pending', comment: null, approver_name: '陈祖豪', approver_avatar: null, approved_at: null }],
  cc_users: [{ id: 5, user_id: 9, user_name: '王五', user_avatar: null, department: '技术部', read_at: null, created_at: '2026年11月23日 09:30' }],
}

/** One recorded request with the body the service sent, so a spec can assert the wire contract. */
interface RecordedRequest {
  /** HTTP method. */
  method: string
  /** Absolute request URL. */
  url: string
  /** Parsed JSON body, when the request carried one. */
  body: unknown
}

/**
 * Stub `fetch` with one handler for every request, recording the URL and body.
 * @param respond - builds the response for one request.
 * @returns the recorded requests.
 */
function recordFetch(respond: () => Response): RecordedRequest[] {
  const seen: RecordedRequest[] = []
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.href)
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    seen.push({ method: init?.method ?? 'GET', url: url.href, body })
    return Promise.resolve(respond())
  }))
  return seen
}

describe('workbench: messages and notification preferences', () => {
  it('reads one tab and projects the closed kind plus the jump fields', async () => {
    const { service } = await mounted()
    await signIn(service)
    const seen = recordFetch(() => ok({
      messages: [
        {
          id: 31, system: '审批待办', summary: '张三 提交了《请假申请》审批，请处理', time: '09:30', unread: true,
          payload: { type: 'approval_request', approval_id: 18, approval_title: '请假申请', applicant_name: '张三' },
        },
        { id: 32, system: '工资条', summary: '2026-10 工资条已发放', time: '昨天 10:00', unread: false, payload: { salary_slip_id: 4, period: '2026-10', net_pay: 12480.5 } },
        { id: 33, system: '本构建没见过的类型', summary: '系统通知', time: '11-01', unread: false, payload: {} },
      ],
    }))
    const messages = await service.messages('unread')
    expect(seen[0]?.url).toContain('/messages?tab=unread')
    expect(seen[0]?.method).toBe('GET')
    expect(messages.map(message => message.kind)).toEqual(['approval-request', 'salary-slip', 'other'])
    expect(messages[0]?.payload).toEqual({ approvalId: 18, approvalTitle: '请假申请', applicantName: '张三' })
    // A numeric net pay is carried as text, which is how the surfaces print it.
    expect(messages[1]?.payload.netPay).toBe('12480.5')
    expect(messages[2]?.payload).toEqual({})
  })

  it('marks one message, then every message, read', async () => {
    const { service } = await mounted()
    await signIn(service)
    const seen = recordFetch(() => ok(null))
    await service.readMessage(31)
    await service.readAllMessages()
    expect(seen.map(request => `${request.method} ${new URL(request.url).pathname.replace('/api/v1/', '')}`))
      .toEqual(['PUT messages/31/read', 'PUT messages/read-all'])
  })

  it('reads and writes the switches by their two documented keys', async () => {
    const { service } = await mounted()
    await signIn(service)
    const pref = { external_message_enabled: true, approval_request_enabled: false, wx_bound: true, template_configured: true }
    const seen = recordFetch(() => ok(pref))
    expect(await service.notificationPreference()).toEqual({
      externalMessageEnabled: true, approvalRequestEnabled: false, wxBound: true, templateConfigured: true,
    })
    await service.setNotificationPreference({ approvalRequestEnabled: true })
    expect(seen[1]?.method).toBe('POST')
    // Only the switch the caller named is sent, so an untouched switch keeps its stored value.
    expect(seen[1]?.body).toEqual({ approval_request_enabled: true })
  })
})

describe('workbench: to-dos', () => {
  it('lists, creates, toggles, and removes items on their documented routes', async () => {
    const { service } = await mounted()
    await signIn(service)
    const todo = { id: 7, text: '提交周报', done: false, time: '今天 09:12' }
    const seen = recordFetch(() => ok(todo))
    await service.createTodo('提交周报')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.body).toEqual({ content: '提交周报' })

    await service.toggleTodo(7)
    expect(seen[1]?.method).toBe('PUT')
    expect(seen[1]?.url).toContain('/todos/7/toggle')

    recordFetch(() => ok({ todos: [todo] }))
    expect(await service.todos()).toEqual([todo])

    const removal = recordFetch(() => ok(null))
    await service.removeTodo(7)
    expect(removal[0]?.method).toBe('DELETE')
    expect(removal[0]?.url).toContain('/todos/7')
  })
})

describe('workbench: approvals', () => {
  it('reads one list, projecting status, nodes, copies, and category content', async () => {
    const { service } = await mounted()
    await signIn(service)
    const seen = recordFetch(() => ok({ approvals: [WIRE_APPROVAL] }))
    const approvals = await service.approvals('pending')
    expect(seen[0]?.url).toContain('/approvals?tab=pending')
    expect(approvals).toHaveLength(1)
    const [approval] = approvals
    expect(approval?.status).toBe('pending')
    expect(approval?.nodes[0]?.state).toBe('pending')
    expect(approval?.ccUsers[0]?.userName).toBe('王五')
    // Category content round-trips unchanged: the draft write needs the same object back.
    expect(approval?.content).toEqual(WIRE_APPROVAL.content)
    expect(approval?.totalLevels).toBe(2)
  })

  it('reads a row that omits its empty columns and spells the arrival column the documented way', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => ok({
      approvals: [{
        id: 19,
        title: '报销申请',
        type: '报销申请',
        created_at: '2026年11月23日 10:00',
        applicant_name: '李四',
        status: 'pending',
        arrival_time: '刚刚到达',
      }],
    }))
    const [approval] = await service.approvals('pending')
    expect(approval?.arrivalTime).toBe('刚刚到达')
    expect(approval?.department).toBe('')
    expect(approval?.projectName).toBeNull()
    expect(approval?.applicantAvatar).toBe('')
    expect(approval?.nodes).toEqual([])
    expect(approval?.ccUsers).toEqual([])
    expect(approval?.content).toEqual({})
    expect(approval?.currentLevel).toBe(0)
    expect(approval?.totalLevels).toBe(0)
  })

  it('names the field when a row cannot be read at all', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => ok({ approvals: [{ ...WIRE_APPROVAL, id: 'not-a-number' }] }))
    await expect(service.approvals('pending')).rejects.toThrow(/not understood \(approvals\.0\.id/)
  })

  it('reads a detail whose decision flags the backend left out', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => ok(WIRE_APPROVAL))
    const detail = await service.approval(18)
    expect(detail.canApprove).toBe(false)
    expect(detail.isCc).toBe(false)
    expect(detail.canCancel).toBe(false)
    expect(detail.cancelDisabledReason).toBeNull()
  })

  it('reads a detail with its decision flags, then posts one decision', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => ok({
      ...WIRE_APPROVAL, can_approve: true, is_cc: false, can_cancel: true, cancel_disabled_reason: null,
    }))
    const detail = await service.approval(18)
    expect(detail.canApprove).toBe(true)
    expect(detail.canCancel).toBe(true)
    expect(detail.cancelDisabledReason).toBeNull()

    const seen = recordFetch(() => ok(null))
    await service.approvalAction({ id: 18, action: 'reject', comment: '缺验收单' })
    expect(seen[0]?.method).toBe('POST')
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/v1/approvals/18/action')
    expect(seen[0]?.body).toEqual({ action: 'reject', comment: '缺验收单' })
  })

  it('surfaces a refused decision as the backend phrased it', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => fail(400, '无审批权限或已审批'))
    await expect(service.approvalAction({ id: 18, action: 'approve', comment: '' }))
      .rejects.toThrow('无审批权限或已审批')
  })

  it('maps categories and sends approvers only for a real submission', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => ok({
      types: [{
        id: 1, name: '请假申请', group: 'attendance',
        requires_project: false, requires_amount: false, requires_attachment: false,
        requires_date_range: true, default_approver_ids: [7, 8],
      }],
    }))
    expect(await service.approvalTypes()).toEqual([{
      id: 1, name: '请假申请', group: 'attendance',
      requiresProject: false, requiresAmount: false, requiresAttachment: false,
      requiresDateRange: true, requiresFlexibleTime: false, defaultApproverIds: [7, 8],
    }])

    const submit = recordFetch(() => ok(WIRE_APPROVAL, 201))
    const request = {
      type: '请假申请', title: '请假申请', content: { start_date: '2026-11-24' },
      approverIds: [7, 8], ccUserIds: [9],
    }
    await service.submitApproval(request)
    expect(new URL(submit[0]?.url ?? '').pathname).toBe('/api/v1/approvals')
    expect(submit[0]?.body).toMatchObject({ approver_ids: [7, 8], cc_user_ids: [9] })

    const draft = recordFetch(() => ok(WIRE_APPROVAL))
    await service.saveApprovalDraft(request)
    expect(new URL(draft[0]?.url ?? '').pathname).toBe('/api/v1/approvals/draft')
    // A draft resolves no approvers, so the request must not carry them.
    expect(draft[0]?.body).not.toHaveProperty('approver_ids')
  })
})

describe('workbench: schedules, tasks, and attendance', () => {
  it('reads today, separating a real event from a leave line derived from an approval', async () => {
    const { service } = await mounted()
    await signIn(service)
    recordFetch(() => ok({
      schedules: [
        {
          id: 21, title: '项目评审会', date: '2026-11-23', startTime: '14:00:00', endTime: '15:30:00',
          location: '3 楼会议室', status: 'active', inviteStatus: 'accepted', creator: { id: 3, name: '张三' },
        },
        {
          id: 'approval-55-2026-11-23', approval_id: 55, kind: 'approval', title: '王五 调休', text: '王五调休',
          startTime: null, endTime: null, location: '调休', status: 'active', can_view_detail: false, inviteStatus: null,
        },
      ],
    }))
    const [review, leave] = await service.todaySchedules()
    expect(review?.id).toBe('21')
    expect(review?.kind).toBe('event')
    expect(review?.mine).toBe(true)
    expect(review?.myInvite).toBe('accepted')
    // A colleague's leave line is readable as context but not openable.
    expect(leave?.kind).toBe('leave')
    expect(leave?.mine).toBe(false)
    expect(leave?.title).toBe('王五 调休')
    expect(leave?.startTime).toBeNull()
  })

  it('reads the task board and completes one task on its documented route', async () => {
    const { service } = await mounted()
    await signIn(service)
    const task = {
      id: 12, title: '整理报价单', type: 'system', typeLabel: '系统任务', deadline: '11月23日 18:00',
      overdue: false, status: 'ongoing', hasWorkHours: true, estimatedHours: 4, actualHours: 0,
      description: '……', avatars: [], assignees: [{ id: 3, name: '张三', avatar: null }],
    }
    recordFetch(() => ok({ groups: [{ name: '今天', count: 1, expanded: true, tasks: [task] }] }))
    const groups = await service.taskBoard()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('今天')
    expect(groups[0]?.tasks[0]?.status).toBe('ongoing')
    expect(groups[0]?.tasks[0]?.estimatedHours).toBe(4)
    expect(groups[0]?.tasks[0]?.assignees[0]?.avatar).toBe('')

    const seen = recordFetch(() => ok({ ...task, status: 'completed' }))
    const completed = await service.completeTask(12)
    expect(seen[0]?.method).toBe('PUT')
    expect(seen[0]?.url).toContain('/tasks/12/complete')
    expect(completed.status).toBe('completed')
  })

  it('reads the day, then punches in and out with a real boolean on the wire', async () => {
    const { service } = await mounted()
    await signIn(service)
    const record = {
      id: 1, work_date: '2026-11-23', clock_in_at: '2026-11-23 09:02:11', clock_in_status: 'normal',
      clock_out_at: null, clock_out_status: null, day_status: 'normal', source: 'app', remark: null,
      work_plan: { required_checkout_at: '2026-11-23 19:02:11', remaining_minutes: 598, checkin_window: { text: '白班 07:00-11:30' } },
    }
    recordFetch(() => ok({
      date: '2026-11-23',
      shift: { name: '白班', work_start: '09:00', work_end: '18:00', late_grace_minutes: 0, early_grace_minutes: 0, is_flexible: false },
      shifts: [],
      record,
      work_plan: { required_checkout_at: '2026-11-23 19:02:11', remaining_minutes: 598, checkin_window: { text: '白班 07:00-11:30' } },
      checked_in: true, checked_out: false, no_clock_required: false,
      no_clock_reason: '', no_clock_text: '', no_clock_type: '',
    }))
    const today = await service.attendanceToday()
    expect(today.shiftName).toBe('白班')
    expect(today.checkedIn).toBe(true)
    expect(today.remainingMinutes).toBe(598)
    expect(today.record?.dayStatus).toBe('normal')
    expect(today.checkinWindowText).toBe('白班 07:00-11:30')

    const seen = recordFetch(() => ok(record))
    await service.checkIn(false)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url).toContain('/attendance/checkin')
    // A string here would count as "with lunch" on the backend, so the wire carries a boolean.
    expect(seen[0]?.body).toEqual({ lunch_break: false })

    const out = recordFetch(() => ok({ ...record, clock_out_at: '2026-11-23 19:05:00' }))
    await service.checkOut()
    expect(out[0]?.url).toContain('/attendance/checkout')
  })

  it('reads one month summary, keeping the backend-formatted penalty as text', async () => {
    const { service } = await mounted()
    await signIn(service)
    const seen = recordFetch(() => ok({
      period: '2026-11', work_days: 20, actual_days: 19, late_count: 2, early_count: 0,
      absent_count: 0, leave_count: 1, full_attendance: false, penalty_total: '10.00', comp_leave_days: 0.5,
    }))
    const summary = await service.attendanceSummary('2026-11')
    expect(seen[0]?.url).toContain('/attendance/summary?period=2026-11')
    expect(summary.penaltyTotal).toBe('10.00')
    expect(summary.compLeaveDays).toBe(0.5)
    expect(summary.fullAttendance).toBe(false)
  })
})
