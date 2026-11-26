/**
 * The OA HTTP wire face: base-URL validation, the documented three-layer
 * envelope, snake-case to camel-case projection, and the closed error
 * vocabulary. Request bodies, tokens, and captcha answers never reach a log.
 *
 * @module @tianma/dsh-oa-account/protocol
 */
import { z as zod } from 'zod'
import type {
  OaAccountErrorCode,
  OaApproval,
  OaApprovalAction,
  OaApprovalContent,
  OaApprovalContentValue,
  OaApprovalDetail,
  OaApprovalNodeState,
  OaApprovalStatus,
  OaApprovalSubmitRequest,
  OaApprovalTab,
  OaApprovalType,
  OaAttendanceDayStatus,
  OaAttendanceRecord,
  OaAttendanceSummary,
  OaAttendanceToday,
  OaCaptcha,
  OaMessage,
  OaMessageKind,
  OaMessageTab,
  OaNotificationPreference,
  OaNotificationPreferencePatch,
  OaSchedule,
  OaSignInRequest,
  OaStats,
  OaTask,
  OaTaskGroup,
  OaTaskStatus,
  OaTodo,
  OaUser,
} from './types.ts'

/** Largest response body this client reads, in bytes; larger answers are treated as protocol failures. */
const MAX_RESPONSE_BYTES = 262_144

/** The documented success codes of the three-layer envelope. */
const SUCCESS_CODES = new Set([200, 201])

/** Failure of one OA request, carrying the closed code callers branch on. */
export class OaAccountError extends Error {
  /** Closed failure code; the backend text rides {@link Error.message} only for `rejected`, `forbidden`, and `rate-limited`. */
  readonly code: OaAccountErrorCode

  /**
   * @param code - closed failure code.
   * @param message - human-readable reason; the backend's own text when it supplied one.
   */
  constructor(code: OaAccountErrorCode, message: string) {
    super(message)
    this.name = 'OaAccountError'
    this.code = code
  }
}

/**
 * Validate and normalize the configured API base URL.
 *
 * The URL keeps its path prefix (the shipped deployment uses `/api/v1`) and is
 * normalized to a trailing slash so relative endpoint paths resolve under it.
 * @param raw - configured base URL.
 * @returns the normalized base URL.
 * @throws {OaAccountError} code `rejected` when the value is not an absolute HTTPS URL, or a loopback HTTP URL.
 */
export function oaBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OaAccountError('rejected', `oa account base URL "${raw}" is not an absolute URL`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new OaAccountError('rejected', 'oa account base URL must not carry userinfo')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new OaAccountError('rejected', 'oa account base URL must not carry a query or fragment')
  }
  if (url.protocol !== 'https:') {
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
    if (url.protocol !== 'http:' || !loopback) {
      throw new OaAccountError('rejected', 'oa account base URL must use HTTPS unless it addresses loopback')
    }
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url
}

/** Wire shape of the documented envelope; extra keys are ignored. */
const envelope = zod.object({
  code: zod.number(),
  message: zod.string(),
  data: zod.unknown(),
})

/**
 * One profile column the shipped backend answers with `null` until its holder
 * fills it in, read as text-or-null and projected to an empty string.
 */
const optionalText = zod.string().nullable()

/** Wire shape of one account holder. */
const wireUser = zod.object({
  id: zod.number(),
  account: zod.string(),
  name: zod.string(),
  code: zod.string(),
  phone: optionalText,
  department: optionalText,
  position: optionalText,
  level: optionalText,
  avatar: optionalText,
  hire_date: zod.string(),
  employment_type: zod.string(),
  role: zod.string(),
  status: zod.string(),
  wx_bound: zod.boolean(),
  created_at: zod.string(),
})

/** Wire shape of the sign-in success payload. */
const wireSignIn = zod.object({
  token: zod.string().min(1),
  refresh_token: zod.string().min(1),
  user: wireUser,
})

/** Wire shape of the refresh success payload: the shipped backend returns the access token alone. */
const wireRefresh = zod.object({ token: zod.string().min(1) })

/** Wire shape of the captcha payload. */
const wireCaptcha = zod.object({
  captcha_id: zod.string().min(1),
  img: zod.string().min(1).optional(),
  image: zod.string().min(1).optional(),
}).refine(value => value.img !== undefined || value.image !== undefined, {
  message: 'captcha payload carries neither "img" nor "image"',
})

/** Wire shape of the personal counters payload. */
const wireStats = zod.object({
  approval: zod.object({ pending: zod.number(), my_applications: zod.number(), rejected: zod.number() }),
  task: zod.object({ overdue: zod.number(), today: zod.number(), upcoming: zod.number(), work_hours: zod.number() }),
  schedule: zod.object({ today: zod.number() }),
})

/** One decoded response body read under the size cap. */
interface OaResponse {
  /** HTTP status code. */
  status: number
  /** Parsed JSON body, or undefined when the body was empty or not JSON. */
  body: unknown
}

/** One request this client issues. */
export interface OaRequest {
  /** Absolute request URL. */
  url: string
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Bearer token to send, when the endpoint is protected. */
  token?: string
  /** JSON request body. */
  body?: unknown
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Caller lifetime; aborting withdraws the request. */
  signal?: AbortSignal
}

/**
 * Send one request and decode its body under the size cap.
 *
 * Redirects are refused before they are followed, so a credential-bearing
 * request never reaches a location the configured origin did not name.
 * @param request - the request to send.
 * @returns the HTTP status and the parsed body.
 * @throws {OaAccountError} code `timeout` or `network` when the request never produced a response.
 */
async function send(request: OaRequest): Promise<OaResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  const headers: Record<string, string> = { accept: 'application/json' }
  if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    const init: RequestInit = { method: request.method, headers, redirect: 'error', signal }
    if (request.body !== undefined) init.body = JSON.stringify(request.body)
    response = await fetch(request.url, init)
  } catch (error: unknown) {
    if (timeout.aborted) throw new OaAccountError('timeout', 'oa account request exceeded its deadline')
    if (request.signal?.aborted === true) throw new OaAccountError('network', 'oa account request was withdrawn')
    throw new OaAccountError('network', `oa account request failed: ${error instanceof Error ? error.name : 'unknown'}`)
  }
  const text = await readBounded(response)
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  console.info(`oa-account: ${request.method} ${new URL(request.url).pathname} -> ${String(response.status)}`)
  return { status: response.status, body }
}

/**
 * Read at most {@link MAX_RESPONSE_BYTES} of a response body.
 * @param response - the response to read.
 * @returns the decoded UTF-8 body.
 * @throws {OaAccountError} code `protocol` when the body exceeds the cap.
 */
async function readBounded(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new OaAccountError('protocol', 'oa account response exceeded the readable size')
  }
  return new TextDecoder().decode(buffer)
}

/**
 * Classify one response into the documented failure vocabulary.
 *
 * A body outside the envelope still yields a usable code: the shipped backend
 * answers framework-level rejections with `{"message": "..."}` alone.
 * @param response - the decoded response.
 * @returns the failure raised for this response.
 */
function failureOf(response: OaResponse): OaAccountError {
  const parsed = envelope.safeParse(response.body)
  const message = parsed.success ? parsed.data.message : ''
  const fallback = messageOf(response.body) ?? 'oa account request was refused'
  switch (response.status) {
    case 400: return new OaAccountError('rejected', message === '' ? fallback : message)
    case 401: return new OaAccountError('unauthenticated', message === '' ? fallback : message)
    case 403: return new OaAccountError('forbidden', message === '' ? fallback : message)
    case 404: return new OaAccountError('rejected', message === '' ? fallback : message)
    case 429: return new OaAccountError('rate-limited', message === '' ? fallback : message)
    default: return new OaAccountError('protocol', `oa account answered HTTP ${String(response.status)}`)
  }
}

/**
 * Read a bare `message` field from a non-envelope body.
 * @param body - the parsed body.
 * @returns the message, or undefined when the body carries none.
 */
function messageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * Unwrap one envelope, refusing every non-success answer.
 * @param response - the decoded response.
 * @returns the envelope payload.
 * @throws {OaAccountError} the classified failure of this response.
 */
function unwrap(response: OaResponse): unknown {
  const parsed = envelope.safeParse(response.body)
  if (!parsed.success) {
    if (response.status >= 200 && response.status < 300) {
      throw new OaAccountError('protocol', 'oa account answered outside the documented envelope')
    }
    throw failureOf(response)
  }
  if (response.status < 200 || response.status >= 300 || !SUCCESS_CODES.has(parsed.data.code)) {
    throw failureOf(response)
  }
  return parsed.data.data
}

/**
 * Name the field a payload failed on, so a read that cannot be understood says
 * which key disagreed instead of only that something did.
 * @param error - the validation failure.
 * @returns the first issue's path and message, or an empty string when it carries none.
 */
function issueSuffix(error: zod.ZodError): string {
  const [issue] = error.issues
  if (issue === undefined) return ''
  const path = issue.path.join('.')
  return ` (${path === '' ? 'value' : path}: ${issue.message})`
}

/**
 * Read the current captcha challenge.
 * @param base - normalized API base URL.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the challenge id and its renderable image.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchCaptcha(base: URL, timeoutMs: number, signal?: AbortSignal): Promise<OaCaptcha> {
  const response = await send({ url: new URL('auth/captcha', base).href, method: 'GET', timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireCaptcha.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account captcha payload was not understood${issueSuffix(parsed.error)}`)
  // The shipped backend names the image `img`; the specification names it
  // `image`. Either spelling is accepted so a backend that adopts the
  // documented name keeps working.
  const image = parsed.data.img ?? parsed.data.image
  if (image === undefined) throw new OaAccountError('protocol', 'oa account captcha payload carried no image')
  return { captchaId: parsed.data.captcha_id, image }
}

/**
 * Exchange credentials and a solved challenge for a token pair.
 * @param base - normalized API base URL.
 * @param request - the submitted credentials.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the access token, refresh token, and account holder.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function postSignIn(
  base: URL,
  request: OaSignInRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ token: string; refreshToken: string; user: OaUser }> {
  const response = await send({
    url: new URL('auth/login', base).href,
    method: 'POST',
    // The shipped backend reads the answer as `captcha`; the specification
    // names it `captcha_code`. Both spellings are sent so either contract
    // authenticates the same request.
    body: {
      account: request.account,
      password: request.password,
      captcha_id: request.captchaId,
      captcha: request.captcha,
      captcha_code: request.captcha,
    },
    timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireSignIn.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account sign-in payload was not understood${issueSuffix(parsed.error)}`)
  return {
    token: parsed.data.token,
    refreshToken: parsed.data.refresh_token,
    user: toUser(parsed.data.user),
  }
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The shipped backend returns the access token alone and does not rotate the
 * refresh token, so the caller keeps the stored refresh token.
 * @param base - normalized API base URL.
 * @param refreshToken - the stored refresh token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the new access token.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function postRefresh(
  base: URL,
  refreshToken: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const response = await send({
    url: new URL('auth/refresh', base).href,
    method: 'POST',
    body: { refresh_token: refreshToken },
    timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireRefresh.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account refresh payload was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.token
}

/**
 * Ask the backend to end the session. The backend keeps no revocation list, so
 * this call is advisory: discarding the local tokens is what signs the user out.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function postSignOut(base: URL, token: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const response = await send({ url: new URL('auth/logout', base).href, method: 'POST', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  unwrap(response)
}

/**
 * Read the account holder behind a token.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the account holder.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchProfile(base: URL, token: string, timeoutMs: number, signal?: AbortSignal): Promise<OaUser> {
  const response = await send({ url: new URL('users/profile', base).href, method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireUser.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account profile payload was not understood${issueSuffix(parsed.error)}`)
  return toUser(parsed.data)
}

/**
 * Write the fields a user may change on their own profile.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param patch - the fields to change.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the account holder after the write.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function putProfile(
  base: URL,
  token: string,
  patch: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OaUser> {
  const response = await send({ url: new URL('users/profile', base).href, method: 'PUT', token, body: patch, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireUser.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account profile payload was not understood${issueSuffix(parsed.error)}`)
  return toUser(parsed.data)
}

/**
 * Read the personal workbench counters.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the counters.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchStats(base: URL, token: string, timeoutMs: number, signal?: AbortSignal): Promise<OaStats> {
  const response = await send({ url: new URL('users/stats', base).href, method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireStats.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account stats payload was not understood${issueSuffix(parsed.error)}`)
  return {
    approval: {
      pending: parsed.data.approval.pending,
      myApplications: parsed.data.approval.my_applications,
      rejected: parsed.data.approval.rejected,
    },
    task: {
      overdue: parsed.data.task.overdue,
      today: parsed.data.task.today,
      upcoming: parsed.data.task.upcoming,
      workHours: parsed.data.task.work_hours,
    },
    schedule: { today: parsed.data.schedule.today },
  }
}

/**
 * Project one wire account holder onto the service vocabulary. An optional
 * profile column the backend left `null` becomes an empty string, which is how
 * the surfaces already read a value their holder never set.
 * @param raw - the validated wire payload.
 * @returns the account holder.
 */
/* ────────────────────── 工作台：消息与通知偏好 ────────────────────── */

/** Backend `system` names, mapped onto the client's closed kind vocabulary. */
const MESSAGE_KIND_BY_SYSTEM: Readonly<Record<string, OaMessageKind>> = {
  工资条: 'salary-slip',
  审批待办: 'approval-request',
  审批通过: 'approval-approved',
  审批驳回: 'approval-rejected',
  审批抄送: 'approval-copy',
  日程共享: 'schedule-share',
  日程回复: 'schedule-reply',
  任务指派: 'task-assigned',
  云传文件: 'cloud-file',
}

/** Wire shape of one message payload; any subset of the jump fields may be absent. */
const wireMessagePayload = zod.object({
  approval_id: zod.number().optional(),
  approval_title: zod.string().optional(),
  applicant_name: zod.string().optional(),
  salary_slip_id: zod.number().optional(),
  period: zod.string().optional(),
  net_pay: zod.union([zod.string(), zod.number()]).optional(),
  file_name: zod.string().optional(),
  file_path: zod.string().optional(),
  file_type: zod.string().optional(),
  file_size: zod.number().optional(),
  download_url: zod.string().optional(),
})

/** Wire shape of one station message. */
const wireMessage = zod.object({
  id: zod.number(),
  system: zod.string(),
  summary: zod.string(),
  time: zod.string(),
  unread: zod.boolean(),
  payload: wireMessagePayload.optional(),
})

/** Wire shape of the message list payload. */
const wireMessages = zod.object({ messages: zod.array(wireMessage) })

/** Wire shape of the notification-preference payload. */
const wirePreference = zod.object({
  external_message_enabled: zod.boolean(),
  approval_request_enabled: zod.boolean(),
  wx_bound: zod.boolean(),
  template_configured: zod.boolean(),
})

/**
 * Read the station messages of one tab.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param tab - `all` for every message, `unread` for the unread ones.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the messages, unread flag included.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchMessages(
  base: URL, token: string, tab: OaMessageTab, timeoutMs: number, signal?: AbortSignal,
): Promise<OaMessage[]> {
  const url = new URL('messages', base)
  url.searchParams.set('tab', tab)
  const response = await send({ url: url.href, method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireMessages.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account message list was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.messages.map(toMessage)
}

/**
 * Mark one message read.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param id - the message id.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function putMessageRead(
  base: URL, token: string, id: number, timeoutMs: number, signal?: AbortSignal,
): Promise<void> {
  const response = await send({
    url: new URL(`messages/${String(id)}/read`, base).href,
    method: 'PUT', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  unwrap(response)
}

/**
 * Mark every unread message of this account read.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function putMessagesReadAll(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<void> {
  const response = await send({
    url: new URL('messages/read-all', base).href,
    method: 'PUT', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  unwrap(response)
}

/**
 * Read the notification switches.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the switches and the two backend-side capability flags.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchNotificationPreference(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaNotificationPreference> {
  const response = await send({
    url: new URL('notifications/preference', base).href,
    method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  const parsed = wirePreference.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account notification preference was not understood${issueSuffix(parsed.error)}`)
  return {
    externalMessageEnabled: parsed.data.external_message_enabled,
    approvalRequestEnabled: parsed.data.approval_request_enabled,
    wxBound: parsed.data.wx_bound,
    templateConfigured: parsed.data.template_configured,
  }
}

/**
 * Write the notification switches. The backend only reads the two documented keys.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param patch - the switches to change; an absent switch is left as it is.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the switches after the write.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function postNotificationPreference(
  base: URL, token: string, patch: OaNotificationPreferencePatch, timeoutMs: number, signal?: AbortSignal,
): Promise<OaNotificationPreference> {
  const body: Record<string, boolean> = {}
  if (patch.externalMessageEnabled !== undefined) body.external_message_enabled = patch.externalMessageEnabled
  if (patch.approvalRequestEnabled !== undefined) body.approval_request_enabled = patch.approvalRequestEnabled
  const response = await send({
    url: new URL('notifications/preference', base).href,
    method: 'POST', token, body, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  const parsed = wirePreference.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account notification preference was not understood${issueSuffix(parsed.error)}`)
  return {
    externalMessageEnabled: parsed.data.external_message_enabled,
    approvalRequestEnabled: parsed.data.approval_request_enabled,
    wxBound: parsed.data.wx_bound,
    templateConfigured: parsed.data.template_configured,
  }
}

/* ────────────────────────── 工作台：待办 ────────────────────────── */

/** Wire shape of one to-do item: the employee side names these keys conversationally. */
const wireTodo = zod.object({
  id: zod.number(),
  text: zod.string(),
  done: zod.boolean(),
  time: zod.string(),
})

/** Wire shape of the to-do list payload. */
const wireTodos = zod.object({ todos: zod.array(wireTodo) })

/**
 * Read this account's to-do list.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the items, unfinished first, newest first within one state.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchTodos(base: URL, token: string, timeoutMs: number, signal?: AbortSignal): Promise<OaTodo[]> {
  const response = await send({ url: new URL('todos', base).href, method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireTodos.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account todo list was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.todos.map(todo => ({ id: todo.id, text: todo.text, done: todo.done, time: todo.time }))
}

/**
 * Create one to-do item.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param content - the item text; the backend trims it and refuses an empty one.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the created item.
 * @throws {OaAccountError} code `rejected` when the backend refuses the text.
 */
export async function postTodo(
  base: URL, token: string, content: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaTodo> {
  const response = await send({
    url: new URL('todos', base).href, method: 'POST', token, body: { content }, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireTodo.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account created todo was not understood${issueSuffix(parsed.error)}`)
  return { id: parsed.data.id, text: parsed.data.text, done: parsed.data.done, time: parsed.data.time }
}

/**
 * Flip one item's done flag.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param id - the item id.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the item after the flip.
 * @throws {OaAccountError} code `rejected` when the item is not this account's.
 */
export async function putTodoToggle(
  base: URL, token: string, id: number, timeoutMs: number, signal?: AbortSignal,
): Promise<OaTodo> {
  const response = await send({
    url: new URL(`todos/${String(id)}/toggle`, base).href,
    method: 'PUT', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  const parsed = wireTodo.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account toggled todo was not understood${issueSuffix(parsed.error)}`)
  return { id: parsed.data.id, text: parsed.data.text, done: parsed.data.done, time: parsed.data.time }
}

/**
 * Delete one item. The backend deletes it physically, so this cannot be undone.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param id - the item id.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function deleteTodo(
  base: URL, token: string, id: number, timeoutMs: number, signal?: AbortSignal,
): Promise<void> {
  const response = await send({
    url: new URL(`todos/${String(id)}`, base).href,
    method: 'DELETE', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  unwrap(response)
}

/* ────────────────────────── 工作台：审批 ────────────────────────── */

/** Documented approval states; anything else reads as `unknown` rather than failing the list. */
const APPROVAL_STATUSES = new Set<string>(['pending', 'approved', 'rejected', 'cancelled', 'draft'])

/** Documented node states; `transferred` exists on reads only. */
const APPROVAL_NODE_STATES = new Set<string>(['pending', 'approved', 'rejected', 'cancelled', 'transferred'])

/**
 * One category-defined content value, read as whatever the backend sent.
 *
 * Categories define their own fields, so a configured file list arrives as
 * objects the client never writes. Narrowing this union to scalars made one
 * such field fail the whole approval list, so the raw value is accepted here
 * and reduced to display text by `toContentView`.
 */
const wireContentValue = zod.unknown()

/** Wire shape of one approval level. */
const wireApprovalNode = zod.object({
  id: zod.number(),
  level: zod.number(),
  status: zod.string(),
  approver_name: zod.string(),
  comment: zod.string().nullable().optional(),
  approver_avatar: zod.string().nullable().optional(),
  approved_at: zod.string().nullable().optional(),
})

/**
 * Wire shape of one copied user. The department and avatar columns ride along
 * only when the copier has them, so their absence reads as empty.
 */
const wireApprovalCopy = zod.object({
  id: zod.number(),
  user_id: zod.number(),
  user_name: zod.string(),
  user_avatar: zod.string().nullable().optional(),
  department: zod.string().nullable().optional(),
  read_at: zod.string().nullable().optional(),
  created_at: zod.string(),
})

/**
 * Wire shape of one approval.
 *
 * Only the identity and lifecycle keys are required: the backend leaves the
 * display-only columns out of rows it never populated, and one such row must not
 * cost the whole list. `arrivalTime` is the shipped backend's spelling while
 * `arrival_time` is the documented one, so a row may carry either.
 */
const wireApproval = zod.object({
  id: zod.number(),
  title: zod.string(),
  type: zod.string(),
  created_at: zod.string(),
  applicant_name: zod.string(),
  status: zod.string(),
  department: zod.string().nullable().optional(),
  project_name: zod.string().nullable().optional(),
  project_no: zod.string().nullable().optional(),
  applicant_avatar: zod.string().nullable().optional(),
  arrivalTime: zod.string().optional(),
  arrival_time: zod.string().optional(),
  content: zod.record(zod.string(), wireContentValue).optional(),
  current_level: zod.number().optional(),
  total_levels: zod.number().optional(),
  nodes: zod.array(wireApprovalNode).optional(),
  cc_users: zod.array(wireApprovalCopy).optional(),
})

/** Wire shape of one approval detail: the approval plus what the reader may do. */
const wireApprovalDetail = wireApproval.extend({
  can_approve: zod.boolean().optional(),
  is_cc: zod.boolean().optional(),
  can_cancel: zod.boolean().optional(),
  cancel_disabled_reason: zod.string().nullable().optional(),
})

/** Wire shape of the approval list payload. */
const wireApprovals = zod.object({ approvals: zod.array(wireApproval) })

/** Wire shape of one approval category. */
const wireApprovalType = zod.object({
  id: zod.number(),
  name: zod.string(),
  group: zod.string(),
  requires_project: zod.boolean(),
  requires_amount: zod.boolean(),
  requires_attachment: zod.boolean(),
  requires_date_range: zod.boolean(),
  requires_flexible_time: zod.boolean().optional(),
  default_approver_ids: zod.array(zod.number()).optional(),
})

/** Wire shape of the approval category list payload. */
const wireApprovalTypes = zod.object({ types: zod.array(wireApprovalType) })

/**
 * Read one approval list.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param tab - which list: pending, handled, copied, or submitted.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the approvals, newest first.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchApprovals(
  base: URL, token: string, tab: OaApprovalTab, timeoutMs: number, signal?: AbortSignal,
): Promise<OaApproval[]> {
  const url = new URL('approvals', base)
  // The backend treats any other value as "submitted", so `submitted` is sent
  // explicitly rather than relying on its default.
  url.searchParams.set('tab', tab)
  const response = await send({ url: url.href, method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireApprovals.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account approval list was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.approvals.map(toApproval)
}

/**
 * Read one approval with what the reader may do with it. A copier's first read
 * writes their `read_at`, so callers fetch this on demand.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param id - the approval id.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the approval detail.
 * @throws {OaAccountError} code `rejected` when the reader may not see it.
 */
export async function fetchApprovalDetail(
  base: URL, token: string, id: number, timeoutMs: number, signal?: AbortSignal,
): Promise<OaApprovalDetail> {
  const response = await send({
    url: new URL(`approvals/${String(id)}`, base).href,
    method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  const parsed = wireApprovalDetail.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account approval detail was not understood${issueSuffix(parsed.error)}`)
  return {
    ...toApproval(parsed.data),
    canApprove: parsed.data.can_approve ?? false,
    isCc: parsed.data.is_cc ?? false,
    canCancel: parsed.data.can_cancel ?? false,
    cancelDisabledReason: parsed.data.cancel_disabled_reason ?? null,
  }
}

/**
 * Apply one approval decision.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param id - the approval id.
 * @param action - approve, reject, or cancel.
 * @param comment - the decision comment; the backend records `申请人撤销` for an empty cancel reason.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @throws {OaAccountError} code `rejected` with the backend's own reason, such as `无审批权限或已审批`.
 */
export async function postApprovalAction(
  base: URL, token: string, id: number, action: OaApprovalAction, comment: string,
  timeoutMs: number, signal?: AbortSignal,
): Promise<void> {
  const response = await send({
    url: new URL(`approvals/${String(id)}/action`, base).href,
    method: 'POST', token, body: { action, comment }, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  unwrap(response)
}

/**
 * Read the approval categories the submit form offers.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the active categories, in the backend's sort order.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchApprovalTypes(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaApprovalType[]> {
  const response = await send({
    url: new URL('approvals/types', base).href,
    method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  const parsed = wireApprovalTypes.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account approval category list was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.types.map(type => ({
    id: type.id,
    name: type.name,
    group: type.group,
    requiresProject: type.requires_project,
    requiresAmount: type.requires_amount,
    requiresAttachment: type.requires_attachment,
    requiresDateRange: type.requires_date_range,
    requiresFlexibleTime: type.requires_flexible_time ?? false,
    defaultApproverIds: type.default_approver_ids ?? [],
  }))
}

/**
 * Submit one approval, or keep it as a draft.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param request - the approval to submit.
 * @param draft - true to keep it as a draft, which skips approver resolution and validation.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the created approval.
 * @throws {OaAccountError} code `rejected` with the backend's validation reason.
 */
export async function postApproval(
  base: URL, token: string, request: OaApprovalSubmitRequest, draft: boolean,
  timeoutMs: number, signal?: AbortSignal,
): Promise<OaApproval> {
  const body: Record<string, unknown> = {
    type: request.type,
    title: request.title,
    content: request.content,
  }
  if (request.department !== undefined) body.department = request.department
  if (request.projectNo !== undefined) body.project_no = request.projectNo
  if (!draft) {
    if (request.approverIds !== undefined) body.approver_ids = [...request.approverIds]
    if (request.ccUserIds !== undefined) body.cc_user_ids = [...request.ccUserIds]
  }
  const response = await send({
    url: new URL(draft ? 'approvals/draft' : 'approvals', base).href,
    method: 'POST', token, body, timeoutMs, ...signal === undefined ? {} : { signal },
  })
  const parsed = wireApproval.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account submitted approval was not understood${issueSuffix(parsed.error)}`)
  return toApproval(parsed.data)
}

/* ────────────────────────── 工作台：日程 ────────────────────────── */

/** Wire shape of one today entry: a real event, or a leave line derived from an approval. */
const wireSchedule = zod.object({
  id: zod.union([zod.number(), zod.string()]),
  kind: zod.string().optional(),
  title: zod.string().optional(),
  text: zod.string().optional(),
  startTime: zod.string().nullable().optional(),
  endTime: zod.string().nullable().optional(),
  location: zod.string().nullable().optional(),
  inviteStatus: zod.string().nullable().optional(),
  can_view_detail: zod.boolean().optional(),
})

/** Wire shape of the today payload. */
const wireSchedules = zod.object({ schedules: zod.array(wireSchedule) })

/**
 * Read today's schedule.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the entries, start time ascending, leave lines mixed in.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchTodaySchedules(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaSchedule[]> {
  const response = await send({
    url: new URL('schedules/today', base).href, method: 'GET', token, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireSchedules.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account schedule list was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.schedules.map(schedule => ({
    id: String(schedule.id),
    kind: schedule.kind === 'approval' ? 'leave' : 'event',
    title: schedule.title ?? schedule.text ?? '',
    text: schedule.text ?? schedule.title ?? '',
    startTime: schedule.startTime ?? null,
    endTime: schedule.endTime ?? null,
    location: schedule.location ?? '',
    myInvite: schedule.inviteStatus ?? null,
    // A derived leave line states whether the reader may open it; a real event
    // this account can see is always openable.
    mine: schedule.can_view_detail ?? true,
  }))
}

/* ────────────────────────── 工作台：任务 ────────────────────────── */

/** Documented task states; anything else reads as `unknown`. */
const TASK_STATUSES = new Set<string>(['ongoing', 'completed', 'deleted'])

/** Wire shape of one assignee. */
const wireTaskAssignee = zod.object({
  id: zod.number(),
  name: zod.string(),
  avatar: zod.string().nullable().optional(),
})

/** Wire shape of one task. */
const wireTask = zod.object({
  id: zod.number(),
  title: zod.string(),
  typeLabel: zod.string(),
  deadline: zod.string().nullable().optional(),
  overdue: zod.boolean(),
  status: zod.string(),
  estimatedHours: zod.number().nullable().optional(),
  actualHours: zod.number().nullable().optional(),
  description: zod.string().nullable().optional(),
  assignees: zod.array(wireTaskAssignee).optional(),
})

/** Wire shape of one task bucket. */
const wireTaskGroup = zod.object({
  name: zod.string(),
  count: zod.number(),
  tasks: zod.array(wireTask),
})

/** Wire shape of the task board payload. */
const wireTaskBoard = zod.object({ groups: zod.array(wireTaskGroup) })

/**
 * Read this account's task board.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the groups the backend actually populated.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchTaskBoard(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaTaskGroup[]> {
  const response = await send({
    url: new URL('tasks', base).href, method: 'GET', token, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireTaskBoard.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account task board was not understood${issueSuffix(parsed.error)}`)
  return parsed.data.groups.map(group => ({
    name: group.name,
    count: group.count,
    tasks: group.tasks.map(toTask),
  }))
}

/**
 * Mark one task complete.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param id - the task id.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the task after the write.
 * @throws {OaAccountError} code `rejected` when this account does not execute the task.
 */
export async function putTaskComplete(
  base: URL, token: string, id: number, timeoutMs: number, signal?: AbortSignal,
): Promise<OaTask> {
  const response = await send({
    url: new URL(`tasks/${String(id)}/complete`, base).href, method: 'PUT', token, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireTask.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account completed task was not understood${issueSuffix(parsed.error)}`)
  return toTask(parsed.data)
}

/* ────────────────────────── 工作台：考勤 ────────────────────────── */

/** Documented day statuses; anything else reads as `unknown`. */
const DAY_STATUSES = new Set<string>(['normal', 'late', 'early', 'absent', 'makeup', 'leave', 'rest'])

/** Wire shape of one shift. */
const wireShift = zod.object({
  name: zod.string(),
  work_start: zod.string(),
  work_end: zod.string(),
  late_grace_minutes: zod.number(),
  early_grace_minutes: zod.number(),
  is_flexible: zod.boolean().optional(),
})

/**
 * Wire shape of a work plan. The backend sends `{}` for the highest
 * administrator's exempt day, so every member is optional.
 */
const wireWorkPlan = zod.object({
  required_checkout_at: zod.string().nullable().optional(),
  remaining_minutes: zod.number().nullable().optional(),
  checkin_window: zod.object({ text: zod.string().optional() }).optional(),
})

/** Wire shape of one attendance record. */
const wireAttendanceRecord = zod.object({
  id: zod.number(),
  work_date: zod.string(),
  clock_in_at: zod.string().nullable(),
  clock_in_status: zod.string().nullable(),
  clock_out_at: zod.string().nullable(),
  clock_out_status: zod.string().nullable(),
  day_status: zod.string(),
  source: zod.string(),
  remark: zod.string().nullable(),
  work_plan: wireWorkPlan.optional(),
})

/** Wire shape of today's attendance. */
const wireAttendanceToday = zod.object({
  date: zod.string(),
  shift: wireShift.nullable().optional(),
  record: wireAttendanceRecord.nullable().optional(),
  work_plan: wireWorkPlan.optional(),
  checked_in: zod.boolean(),
  checked_out: zod.boolean(),
  no_clock_required: zod.boolean(),
  no_clock_text: zod.string().optional(),
})

/** Wire shape of the monthly summary; the corrected variant adds keys this projection ignores. */
const wireAttendanceSummary = zod.object({
  period: zod.string(),
  work_days: zod.number(),
  actual_days: zod.number(),
  late_count: zod.number(),
  early_count: zod.number(),
  absent_count: zod.number(),
  leave_count: zod.number(),
  full_attendance: zod.boolean(),
  penalty_total: zod.union([zod.string(), zod.number()]).optional(),
  comp_leave_days: zod.number().optional(),
})

/**
 * Read today's attendance.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the shift, the punches, and the remaining work.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchAttendanceToday(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaAttendanceToday> {
  const response = await send({
    url: new URL('attendance/today', base).href, method: 'GET', token, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireAttendanceToday.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account attendance day was not understood${issueSuffix(parsed.error)}`)
  const plan = parsed.data.record?.work_plan ?? parsed.data.work_plan
  return {
    date: parsed.data.date,
    shiftName: parsed.data.shift?.name ?? '',
    workStart: parsed.data.shift?.work_start ?? '',
    workEnd: parsed.data.shift?.work_end ?? '',
    checkedIn: parsed.data.checked_in,
    checkedOut: parsed.data.checked_out,
    noClockRequired: parsed.data.no_clock_required,
    noClockText: parsed.data.no_clock_text ?? '',
    record: parsed.data.record === null || parsed.data.record === undefined ? null : toAttendanceRecord(parsed.data.record),
    requiredCheckoutAt: plan?.required_checkout_at ?? null,
    remainingMinutes: plan?.remaining_minutes ?? null,
    checkinWindowText: plan?.checkin_window?.text ?? '',
  }
}

/**
 * Punch in for today.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param lunchBreak - whether the lunch break counts toward the day's required hours.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the record after the punch.
 * @throws {OaAccountError} code `rejected` with the backend's reason, such as an off-network address or a closed window.
 */
export async function postCheckIn(
  base: URL, token: string, lunchBreak: boolean, timeoutMs: number, signal?: AbortSignal,
): Promise<OaAttendanceRecord> {
  const response = await send({
    url: new URL('attendance/checkin', base).href, method: 'POST', token,
    // The backend reads a real boolean; a string "false" would count as lunch.
    body: { lunch_break: lunchBreak }, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireAttendanceRecord.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account check-in record was not understood${issueSuffix(parsed.error)}`)
  return toAttendanceRecord(parsed.data)
}

/**
 * Punch out for today. The backend refuses a punch within one hour of the clock-in.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the record after the punch.
 * @throws {OaAccountError} code `rejected` with the backend's reason.
 */
export async function postCheckOut(
  base: URL, token: string, timeoutMs: number, signal?: AbortSignal,
): Promise<OaAttendanceRecord> {
  const response = await send({
    url: new URL('attendance/checkout', base).href, method: 'POST', token, timeoutMs,
    ...signal === undefined ? {} : { signal },
  })
  const parsed = wireAttendanceRecord.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account check-out record was not understood${issueSuffix(parsed.error)}`)
  return toAttendanceRecord(parsed.data)
}

/**
 * Read one month's attendance summary.
 * @param base - normalized API base URL.
 * @param token - the access token.
 * @param period - `YYYY-MM`; absent reads the current month.
 * @param timeoutMs - per-request deadline.
 * @param signal - caller lifetime.
 * @returns the summary the backend computed.
 * @throws {OaAccountError} the classified failure of this request.
 */
export async function fetchAttendanceSummary(
  base: URL, token: string, period: string | undefined, timeoutMs: number, signal?: AbortSignal,
): Promise<OaAttendanceSummary> {
  const url = new URL('attendance/summary', base)
  if (period !== undefined) url.searchParams.set('period', period)
  const response = await send({ url: url.href, method: 'GET', token, timeoutMs, ...signal === undefined ? {} : { signal } })
  const parsed = wireAttendanceSummary.safeParse(unwrap(response))
  if (!parsed.success) throw new OaAccountError('protocol', `oa account attendance summary was not understood${issueSuffix(parsed.error)}`)
  return {
    period: parsed.data.period,
    workDays: parsed.data.work_days,
    actualDays: parsed.data.actual_days,
    lateCount: parsed.data.late_count,
    earlyCount: parsed.data.early_count,
    absentCount: parsed.data.absent_count,
    leaveCount: parsed.data.leave_count,
    fullAttendance: parsed.data.full_attendance,
    penaltyTotal: parsed.data.penalty_total === undefined ? '0.00' : String(parsed.data.penalty_total),
    compLeaveDays: parsed.data.comp_leave_days ?? 0,
  }
}

/* ─────────────────────── 投影：wire → service 词汇 ─────────────────────── */
/**
 * Project one message onto the service vocabulary.
 * @param raw - the validated wire payload.
 * @returns the message with its kind resolved and payload camel-cased.
 */
function toMessage(raw: zod.infer<typeof wireMessage>): OaMessage {
  const payload = raw.payload ?? {}
  const message: OaMessage = {
    id: raw.id,
    kind: MESSAGE_KIND_BY_SYSTEM[raw.system] ?? 'other',
    summary: raw.summary,
    time: raw.time,
    unread: raw.unread,
    payload: {},
  }
  // Only fields the backend actually sent are carried, so `undefined` never
  // reaches the browser as a present-but-empty jump target.
  const target: { -readonly [K in keyof OaMessage['payload']]: OaMessage['payload'][K] } = {}
  if (payload.approval_id !== undefined) target.approvalId = payload.approval_id
  if (payload.approval_title !== undefined) target.approvalTitle = payload.approval_title
  if (payload.applicant_name !== undefined) target.applicantName = payload.applicant_name
  if (payload.salary_slip_id !== undefined) target.salarySlipId = payload.salary_slip_id
  if (payload.period !== undefined) target.period = payload.period
  if (payload.net_pay !== undefined) target.netPay = String(payload.net_pay)
  if (payload.file_name !== undefined) target.fileName = payload.file_name
  if (payload.file_path !== undefined) target.filePath = payload.file_path
  if (payload.file_type !== undefined) target.fileType = payload.file_type
  if (payload.file_size !== undefined) target.fileSize = payload.file_size
  if (payload.download_url !== undefined) target.downloadUrl = payload.download_url
  return { ...message, payload: target }
}

/**
 * Project one approval node onto the service vocabulary.
 * @param raw - the validated wire node.
 * @returns the node.
 */
function toApprovalNode(raw: zod.infer<typeof wireApprovalNode>): OaApproval['nodes'][number] {
  return {
    id: raw.id,
    level: raw.level,
    state: APPROVAL_NODE_STATES.has(raw.status) ? raw.status as OaApprovalNodeState : 'unknown',
    comment: raw.comment ?? null,
    approverName: raw.approver_name,
    approverAvatar: raw.approver_avatar ?? '',
    approvedAt: raw.approved_at ?? null,
  }
}

/**
 * Reduce one arbitrary content value to the text the client renders.
 *
 * A file list carries objects (`{ name, url, size }`) rather than strings; the
 * label the user recognises is the name, and the URL is only a fallback.
 * @param value - any value the backend placed in a category field.
 * @returns display text, empty when nothing readable exists.
 */
function contentText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['name', 'file_name', 'filename', 'title', 'url', 'path']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return typeof value === 'bigint' || typeof value === 'symbol' ? value.toString() : ''
}

/**
 * Project one category-defined content object onto the service vocabulary.
 * @param raw - the validated wire content, or undefined when absent.
 * @returns scalar fields unchanged and every other value as display text.
 */
function toContent(raw: Record<string, unknown> | undefined): OaApprovalContent {
  const content: Record<string, OaApprovalContentValue> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      content[key] = value
      continue
    }
    if (Array.isArray(value)) {
      content[key] = value.map(item => contentText(item)).filter(text => text !== '')
      continue
    }
    content[key] = contentText(value)
  }
  return content
}

/**
 * Project one approval onto the service vocabulary.
 * @param raw - the validated wire approval.
 * @returns the approval with its status closed to the documented set.
 */
function toApproval(raw: zod.infer<typeof wireApproval>): OaApproval {
  return {
    id: raw.id,
    title: raw.title,
    type: raw.type,
    department: raw.department ?? '',
    projectName: raw.project_name ?? null,
    projectNo: raw.project_no ?? null,
    createdAt: raw.created_at,
    applicantName: raw.applicant_name,
    applicantAvatar: raw.applicant_avatar ?? '',
    // Either spelling the backend used, empty when it populated neither.
    arrivalTime: raw.arrivalTime ?? raw.arrival_time ?? '',
    status: APPROVAL_STATUSES.has(raw.status) ? raw.status as OaApprovalStatus : 'unknown',
    content: toContent(raw.content),
    currentLevel: raw.current_level ?? 0,
    totalLevels: raw.total_levels ?? 0,
    nodes: (raw.nodes ?? []).map(toApprovalNode),
    ccUsers: (raw.cc_users ?? []).map(copy => ({
      id: copy.id,
      userName: copy.user_name,
      department: copy.department ?? '',
      readAt: copy.read_at ?? null,
      createdAt: copy.created_at,
    })),
  }
}

/**
 * Project one task onto the service vocabulary.
 * @param raw - the validated wire task.
 * @returns the task with its status closed to the documented set.
 */
function toTask(raw: zod.infer<typeof wireTask>): OaTask {
  return {
    id: raw.id,
    title: raw.title,
    typeLabel: raw.typeLabel,
    deadline: raw.deadline ?? null,
    overdue: raw.overdue,
    status: TASK_STATUSES.has(raw.status) ? raw.status as OaTaskStatus : 'unknown',
    estimatedHours: raw.estimatedHours ?? null,
    actualHours: raw.actualHours ?? null,
    description: raw.description ?? '',
    assignees: (raw.assignees ?? []).map(assignee => ({
      id: assignee.id,
      name: assignee.name,
      avatar: assignee.avatar ?? '',
    })),
  }
}

/**
 * Project one attendance record onto the service vocabulary.
 * @param raw - the validated wire record.
 * @returns the record with its day status closed to the documented set.
 */
function toAttendanceRecord(raw: zod.infer<typeof wireAttendanceRecord>): OaAttendanceRecord {
  return {
    id: raw.id,
    workDate: raw.work_date,
    clockInAt: raw.clock_in_at,
    clockOutAt: raw.clock_out_at,
    clockInStatus: raw.clock_in_status,
    clockOutStatus: raw.clock_out_status,
    dayStatus: DAY_STATUSES.has(raw.day_status) ? raw.day_status as OaAttendanceDayStatus : 'unknown',
    source: raw.source,
    remark: raw.remark,
    requiredCheckoutAt: raw.work_plan?.required_checkout_at ?? null,
    remainingMinutes: raw.work_plan?.remaining_minutes ?? null,
  }
}

function toUser(raw: zod.infer<typeof wireUser>): OaUser {
  return {
    id: raw.id,
    account: raw.account,
    name: raw.name,
    code: raw.code,
    phone: raw.phone ?? '',
    department: raw.department ?? '',
    position: raw.position ?? '',
    level: raw.level ?? '',
    avatar: raw.avatar ?? '',
    hireDate: raw.hire_date,
    employmentType: raw.employment_type,
    role: raw.role,
    status: raw.status,
    wxBound: raw.wx_bound,
    createdAt: raw.created_at,
  }
}
