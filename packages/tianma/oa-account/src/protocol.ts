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
  OaCaptcha,
  OaSignInRequest,
  OaStats,
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

/** Wire shape of one account holder. */
const wireUser = zod.object({
  id: zod.number(),
  account: zod.string(),
  name: zod.string(),
  code: zod.string(),
  phone: zod.string(),
  department: zod.string(),
  position: zod.string(),
  level: zod.string(),
  avatar: zod.string(),
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
  method: 'GET' | 'POST' | 'PUT'
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
  if (!parsed.success) throw new OaAccountError('protocol', 'oa account captcha payload was not understood')
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
  if (!parsed.success) throw new OaAccountError('protocol', 'oa account sign-in payload was not understood')
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
  if (!parsed.success) throw new OaAccountError('protocol', 'oa account refresh payload was not understood')
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
  if (!parsed.success) throw new OaAccountError('protocol', 'oa account profile payload was not understood')
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
  if (!parsed.success) throw new OaAccountError('protocol', 'oa account profile payload was not understood')
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
  if (!parsed.success) throw new OaAccountError('protocol', 'oa account stats payload was not understood')
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
 * Project one wire account holder onto the service vocabulary.
 * @param raw - the validated wire payload.
 * @returns the account holder.
 */
function toUser(raw: zod.infer<typeof wireUser>): OaUser {
  return {
    id: raw.id,
    account: raw.account,
    name: raw.name,
    code: raw.code,
    phone: raw.phone,
    department: raw.department,
    position: raw.position,
    level: raw.level,
    avatar: raw.avatar,
    hireDate: raw.hire_date,
    employmentType: raw.employment_type,
    role: raw.role,
    status: raw.status,
    wxBound: raw.wx_bound,
    createdAt: raw.created_at,
  }
}
