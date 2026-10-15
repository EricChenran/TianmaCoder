/**
 * exec/v1 wire behavior: the configured host and port resolve into request
 * addresses, the envelope code decides success ahead of the HTTP status, each
 * code maps to the recovery the node must apply, redaction removes secret values,
 * and identifiers and timestamps take the forms the protocol names.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLATFORM_BASE_PATH,
  DEFAULT_PLATFORM_PORT,
  EXEC_PROTOCOL_HEADER,
  EXEC_PROTOCOL_VERSION,
  ExecClient,
  ExecResponseError,
  artifactId,
  containsSecretPattern,
  createFetchTransport,
  formatRfc3339,
  isAlreadyFinal,
  logBatchId,
  parseExecEnvelope,
  platformEndpointFromUrl,
  recoveryForCode,
  redactSecretLines,
  redactSecretText,
  requestRetryDelayMs,
  resolvePlatformEndpoint,
  retryAfterDelayMs,
  strongerOutcome,
  taskAttemptDelayMs,
  taskRepository,
  taskRuntimeLimitMs,
  taskWorkspaceId,
  ulid,
} from '@tianma/dsh-mps-exec-core'
import type { ExecHttpRequest, ExecHttpResponse, ExecHttpTransport } from '@tianma/dsh-mps-exec-core'

/** One recorded transport call plus the response it returned. */
interface RecordedCall {
  request: ExecHttpRequest
}

/** What the fake `fetch` observed during one transport call. */
interface FetchObservation {
  url: string | undefined
  method: string | undefined
  body: string | null | undefined
  signal: AbortSignal | null | undefined
}

/**
 * Build a transport that answers from a script and records every call.
 * @param responses - one response per call, or a function deriving it from the request.
 * @returns the transport and the recorded calls.
 */
function scripted(responses: (ExecHttpResponse | ((request: ExecHttpRequest) => ExecHttpResponse))[]): {
  transport: ExecHttpTransport
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let index = 0
  const transport: ExecHttpTransport = async (request) => {
    calls.push({ request })
    const scriptedResponse = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (scriptedResponse === undefined) throw new Error('scripted transport ran out of responses')
    return typeof scriptedResponse === 'function' ? scriptedResponse(request) : scriptedResponse
  }
  return { transport, calls }
}

/**
 * Build one OK envelope response.
 * @param data - payload to carry.
 * @param extra - extra envelope fields.
 * @returns the response.
 */
function ok(data: unknown, extra: Record<string, unknown> = {}): ExecHttpResponse {
  return {
    status: 200,
    headers: {},
    text: JSON.stringify({ code: 'OK', msg: '', data, requestId: 'req_1', serverTime: 't', ...extra }),
  }
}

/**
 * Build one error-envelope response.
 * @param code - envelope code.
 * @param status - HTTP status.
 * @param msg - message text.
 * @returns the response.
 */
function failure(code: string, status = 409, msg = ''): ExecHttpResponse {
  return { status, headers: {}, text: JSON.stringify({ code, msg, data: null, requestId: 'req_2' }) }
}

describe('platform endpoint', () => {
  it('resolves a configured host and port into request addresses', () => {
    const endpoint = resolvePlatformEndpoint({ host: '192.168.1.10', port: 8791 })
    expect(endpoint.origin).toBe('http://192.168.1.10:8791')
    expect(endpoint.baseUrl).toBe(`http://192.168.1.10:8791${DEFAULT_PLATFORM_BASE_PATH}`)
    expect(endpoint.url('/auth/token')).toBe('http://192.168.1.10:8791/exec/v1/auth/token')
    expect(endpoint.url('auth/token')).toBe('http://192.168.1.10:8791/exec/v1/auth/token')
    expect(endpoint.url('//tasks/t1/lease')).toBe('http://192.168.1.10:8791/exec/v1/tasks/t1/lease')
    expect(endpoint.scheme).toBe('http')
    expect(endpoint.port).toBe(DEFAULT_PLATFORM_PORT)
    expect(endpoint.host).toBe('192.168.1.10')
  })

  it('applies the default port and base path when the deployment states none', () => {
    const endpoint = resolvePlatformEndpoint({ host: 'platform.internal' })
    expect(endpoint.port).toBe(DEFAULT_PLATFORM_PORT)
    expect(endpoint.basePath).toBe(DEFAULT_PLATFORM_BASE_PATH)
  })

  it('accepts https, a custom port, and a custom base path', () => {
    const endpoint = resolvePlatformEndpoint({
      host: 'mps.example.com',
      port: 9443,
      scheme: 'https',
      basePath: '/exec/v1/',
    })
    expect(endpoint.origin).toBe('https://mps.example.com:9443')
    expect(endpoint.basePath).toBe('/exec/v1')
    expect(endpoint.url('/register')).toBe('https://mps.example.com:9443/exec/v1/register')
  })

  it('brackets a bare IPv6 address and keeps brackets already present', () => {
    expect(resolvePlatformEndpoint({ host: 'fe80::1' }).origin).toBe('http://[fe80::1]:8791')
    expect(resolvePlatformEndpoint({ host: '[fe80::1]' }).origin).toBe('http://[fe80::1]:8791')
  })

  it('rejects a host that is not a bare host', () => {
    expect(() => resolvePlatformEndpoint({ host: '  ' })).toThrow(/must not be empty/)
    expect(() => resolvePlatformEndpoint({ host: 'http://10.0.0.1' })).toThrow(/must not carry a scheme/)
    expect(() => resolvePlatformEndpoint({ host: '10.0.0.1/exec' })).toThrow(/bare host/)
    expect(() => resolvePlatformEndpoint({ host: '10.0.0.1 8791' })).toThrow(/bare host/)
  })

  it('rejects a malformed IPv6 bracket', () => {
    expect(() => resolvePlatformEndpoint({ host: '[fe80::1' })).toThrow(/unterminated/)
    expect(() => resolvePlatformEndpoint({ host: '[]' })).toThrow(/unterminated/)
    expect(() => resolvePlatformEndpoint({ host: '[host]' })).toThrow(/not an IPv6 address/)
    expect(() => resolvePlatformEndpoint({ host: 'fe80::1]' })).toThrow(/without an opening one/)
  })

  it('rejects a port outside the TCP range', () => {
    expect(() => resolvePlatformEndpoint({ host: 'h', port: 0 })).toThrow(/between 1 and 65535/)
    expect(() => resolvePlatformEndpoint({ host: 'h', port: 65_536 })).toThrow(/between 1 and 65535/)
    expect(resolvePlatformEndpoint({ host: 'h', port: 1 }).port).toBe(1)
    expect(resolvePlatformEndpoint({ host: 'h', port: 65_535 }).port).toBe(65_535)
  })

  it('rejects a scheme and base path outside the accepted forms', () => {
    expect(() => resolvePlatformEndpoint({ host: 'h', scheme: 'ftp' as 'http' })).toThrow(/http.*https/)
    expect(() => resolvePlatformEndpoint({ host: 'h', basePath: 'exec/v1' })).toThrow(/must start with/)
    expect(() => resolvePlatformEndpoint({ host: 'h', basePath: '/exec?v=1' })).toThrow(/query or fragment/)
    expect(resolvePlatformEndpoint({ host: 'h', basePath: '/' }).baseUrl).toBe('http://h:8791')
  })

  it('rejects a request path that is not a bare path', () => {
    const endpoint = resolvePlatformEndpoint({ host: 'h' })
    expect(() => endpoint.url('   ')).toThrow(/must not be empty/)
    expect(() => endpoint.url('http://other/x')).toThrow(/bare path/)
    expect(() => endpoint.url('/x?y=1')).toThrow(/bare path/)
  })

  it('reads a full platform URL back into address parts', () => {
    expect(platformEndpointFromUrl('https://10.0.0.5:9443/exec/v1')).toEqual({
      scheme: 'https',
      host: '10.0.0.5',
      port: 9443,
      basePath: '/exec/v1',
    })
    expect(platformEndpointFromUrl('http://platform.internal')).toEqual({
      scheme: 'http',
      host: 'platform.internal',
      port: DEFAULT_PLATFORM_PORT,
      basePath: DEFAULT_PLATFORM_BASE_PATH,
    })
    expect(platformEndpointFromUrl('http://platform.internal/').basePath).toBe(DEFAULT_PLATFORM_BASE_PATH)
  })

  it('rejects a platform URL it cannot use', () => {
    expect(() => platformEndpointFromUrl('not a url')).toThrow(/not a valid absolute URL/)
    expect(() => platformEndpointFromUrl('ftp://host/')).toThrow(/must be http or https/)
    expect(() => platformEndpointFromUrl('http://user:pw@host/')).toThrow(/must not carry credentials/)
    expect(() => platformEndpointFromUrl('http://host/x?a=1')).toThrow(/query or fragment/)
  })
})

describe('response envelope', () => {
  it('parses an envelope and keeps unknown fields out', () => {
    const envelope = parseExecEnvelope<{ n: number }>({
      code: 'OK',
      msg: 'done',
      data: { n: 1 },
      requestId: 'req_9',
      serverTime: '2026-10-15T12:00:00.000+08:00',
      surprise: true,
    })
    expect(envelope).toEqual({
      code: 'OK',
      msg: 'done',
      data: { n: 1 },
      requestId: 'req_9',
      serverTime: '2026-10-15T12:00:00.000+08:00',
    })
  })

  it('defaults the optional envelope fields', () => {
    expect(parseExecEnvelope({ code: 'OK' })).toEqual({ code: 'OK', msg: '', data: undefined, requestId: '', serverTime: '' })
  })

  it('rejects a body that is not an envelope', () => {
    expect(() => parseExecEnvelope([])).toThrow(/must be a JSON object/)
    expect(() => parseExecEnvelope(null)).toThrow(/must be a JSON object/)
    expect(() => parseExecEnvelope('{}')).toThrow(/must be a JSON object/)
    expect(() => parseExecEnvelope({})).toThrow(/non-empty string code/)
    expect(() => parseExecEnvelope({ code: '' })).toThrow(/non-empty string code/)
    expect(() => parseExecEnvelope({ code: 7 })).toThrow(/non-empty string code/)
  })

  it('recognizes the already-final code', () => {
    expect(isAlreadyFinal('ALREADY_FINAL')).toBe(true)
    expect(isAlreadyFinal('OK')).toBe(false)
  })
})

describe('error recovery', () => {
  it('maps each protocol code to the recovery it requires', () => {
    expect(recoveryForCode('NODE_SECRET_INVALID')).toBe('halt-node')
    expect(recoveryForCode('NODE_DISABLED')).toBe('halt-node')
    expect(recoveryForCode('PROTOCOL_UNSUPPORTED')).toBe('halt-node')
    expect(recoveryForCode('NODE_TOKEN_EXPIRED')).toBe('reauthenticate')
    expect(recoveryForCode('NODE_NOT_REGISTERED')).toBe('reregister')
    expect(recoveryForCode('TASK_NOT_FOUND')).toBe('abandon-task')
    expect(recoveryForCode('TASK_NOT_LEASED_BY_YOU')).toBe('discard-result')
    expect(recoveryForCode('LEASE_EXPIRED')).toBe('discard-result')
    expect(recoveryForCode('BASE_COMMIT_MISMATCH')).toBe('abandon-task')
    expect(recoveryForCode('ARTIFACT_TOO_LARGE')).toBe('abandon-task')
    expect(recoveryForCode('CHECKSUM_MISMATCH')).toBe('retry')
    expect(recoveryForCode('INVALID_CHANGED_FILES')).toBe('retry')
    expect(recoveryForCode('SLOT_OVERSELL')).toBe('retry')
    expect(recoveryForCode('RATE_LIMITED')).toBe('retry')
    expect(recoveryForCode('DB_UNAVAILABLE')).toBe('retry')
    expect(recoveryForCode('INTERNAL_ERROR')).toBe('retry')
  })

  it('retries a code that postdates this node', () => {
    expect(recoveryForCode('SOMETHING_NEW')).toBe('retry')
  })

  it('carries the code, status, request id, and recovery', () => {
    const error = new ExecResponseError('LEASE_EXPIRED', { code: 'LEASE_EXPIRED', httpStatus: 409, requestId: 'req_3' })
    expect(error.name).toBe('ExecResponseError')
    expect(error.message).toBe('LEASE_EXPIRED')
    expect(error.code).toBe('LEASE_EXPIRED')
    expect(error.httpStatus).toBe(409)
    expect(error.requestId).toBe('req_3')
    expect(error.recovery).toBe('discard-result')
    expect(new ExecResponseError('x', { code: 'INTERNAL_ERROR', httpStatus: 500 }).requestId).toBe('')
  })
})

describe('retry schedules', () => {
  it('schedules task attempts at one, five, and thirty minutes', () => {
    expect(taskAttemptDelayMs(1)).toBe(60_000)
    expect(taskAttemptDelayMs(2)).toBe(300_000)
    expect(taskAttemptDelayMs(3)).toBe(1_800_000)
    expect(taskAttemptDelayMs(4)).toBe(1_800_000)
    expect(taskAttemptDelayMs(0)).toBe(60_000)
    expect(taskAttemptDelayMs(2.7)).toBe(300_000)
  })

  it('backs off requests within the floor and ceiling of each attempt', () => {
    expect(requestRetryDelayMs(1, () => 0)).toBe(250)
    expect(requestRetryDelayMs(1, () => 0.999)).toBe(500)
    expect(requestRetryDelayMs(0, () => 0)).toBe(250)
    expect(requestRetryDelayMs(2, () => 0)).toBe(500)
    expect(requestRetryDelayMs(20, () => 0)).toBe(15_000)
    expect(requestRetryDelayMs(20, () => 0.5)).toBe(22_500)
    expect(requestRetryDelayMs(20, () => 0.999)).toBeLessThanOrEqual(30_000)
  })

  it('reads the retry delay a response demands', () => {
    expect(retryAfterDelayMs('7')).toBe(7000)
    expect(retryAfterDelayMs(' 7 ')).toBe(7000)
    expect(retryAfterDelayMs(undefined)).toBeUndefined()
    expect(retryAfterDelayMs(null)).toBeUndefined()
    expect(retryAfterDelayMs('')).toBeUndefined()
    expect(retryAfterDelayMs('soon')).toBeUndefined()
    const future = new Date(1_000_000).toUTCString()
    expect(retryAfterDelayMs(future, 999_000)).toBe(1000)
    expect(retryAfterDelayMs(future, 2_000_000)).toBe(0)
  })
})

describe('log redaction', () => {
  it('replaces secret values in assignment form', () => {
    expect(redactSecretText('secret=abc123 rest')).toBe('secret=[REDACTED] rest')
    expect(redactSecretText('api_key: abc123')).toBe('api_key: [REDACTED]')
    expect(redactSecretText('private_key = abc123')).toBe('private_key = [REDACTED]')
    expect(redactSecretText('password=abc123')).toBe('password=[REDACTED]')
    expect(redactSecretText('access_token=abc123')).toBe('access_token=[REDACTED]')
  })

  it('replaces a quoted JSON value without moving the quotes', () => {
    expect(redactSecretText('{"api_key":"abc123"}')).toBe('{"api_key":"[REDACTED]"}')
    expect(redactSecretText("{'client_secret': 'abc123'}")).toBe("{'client_secret': '[REDACTED]'}")
  })

  it('replaces a bearer credential', () => {
    expect(redactSecretText('Authorization: Bearer eyJhbGciOi.abc-123')).toBe('Authorization: Bearer [REDACTED]')
  })

  it('leaves ordinary lines alone', () => {
    expect(redactSecretText('building project now')).toBe('building project now')
    expect(redactSecretLines(['ok', 'secret=x'])).toEqual(['ok', 'secret=[REDACTED]'])
  })

  it('detects a secret that a line still carries', () => {
    expect(containsSecretPattern('secret=x')).toBe(true)
    expect(containsSecretPattern('Bearer abc')).toBe(true)
    expect(containsSecretPattern('no secrets here')).toBe(false)
  })
})

describe('identifiers', () => {
  const zeros = () => new Uint8Array(10)

  it('mints a 26-character identifier with a sortable time prefix', () => {
    const early = ulid(1_000, zeros)
    const late = ulid(2_000, zeros)
    expect(early).toHaveLength(26)
    expect(late).toHaveLength(26)
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true)
    expect(early.slice(10)).toBe('0000000000000000')
  })

  it('spends the supplied randomness across the suffix', () => {
    expect(ulid(0, () => new Uint8Array(10).fill(255)).slice(10)).toBe('ZZZZZZZZZZZZZZZZ')
    expect(ulid(0, zeros)).toBe(ulid(0, zeros))
  })

  it('rejects a timestamp and a randomness length outside the format', () => {
    expect(() => ulid(-1, zeros)).toThrow(/within 48 bits/)
    expect(() => ulid(1.5, zeros)).toThrow(/within 48 bits/)
    expect(() => ulid(0x1_0000_0000_0000, zeros)).toThrow(/within 48 bits/)
    expect(() => ulid(0, () => new Uint8Array(4))).toThrow(/must be 10 bytes/)
  })

  it('prefixes batch and artifact ids by their role', () => {
    expect(logBatchId(0, zeros)).toBe('log-00000000000000000000000000')
    expect(artifactId(0, zeros)).toBe('art-00000000000000000000000000')
    expect(logBatchId()).toHaveLength(30)
  })
})

describe('timestamp formatting', () => {
  it('keeps millisecond precision and writes a numeric offset', () => {
    const date = new Date('2026-10-15T04:03:55.123Z')
    expect(formatRfc3339(date, 480)).toBe('2026-10-15T12:03:55.123+08:00')
    expect(formatRfc3339(date, -330)).toBe('2026-10-14T22:33:55.123-05:30')
    expect(formatRfc3339(date, 0)).toBe('2026-10-15T04:03:55.123+00:00')
    expect(formatRfc3339(date)).toMatch(/^2026-10-15T\d{2}:03:55\.123[+-]\d{2}:\d{2}$/)
  })

  it('rejects an unusable instant and offset', () => {
    expect(() => formatRfc3339(new Date('nope'))).toThrow(/valid date/)
    expect(() => formatRfc3339(new Date(0), 1.5)).toThrow(/whole minutes/)
    expect(() => formatRfc3339(new Date(0), 14 * 60 + 1)).toThrow(/whole minutes/)
  })
})

describe('protocol client', () => {
  const endpoint = resolvePlatformEndpoint({ host: '10.0.0.7', port: 8791 })

  /**
   * Build a client over a scripted transport.
   * @param responses - the script.
   * @param token - the token the client reports.
   * @returns the client, its calls, and a setter for the token.
   */
  function client(
    responses: (ExecHttpResponse | ((request: ExecHttpRequest) => ExecHttpResponse))[],
    token?: string,
  ): { client: ExecClient; calls: RecordedCall[]; setToken: (value: string | undefined) => void } {
    const script = scripted(responses)
    let current = token
    const instance = new ExecClient({
      endpoint,
      nodeId: 'node-3f2a',
      transport: script.transport,
      token: () => current,
    })
    return { client: instance, calls: script.calls, setToken: (value) => { current = value } }
  }

  it('exposes the address and node id it was built with', () => {
    const { client: instance } = client([])
    expect(instance.endpoint.origin).toBe('http://10.0.0.7:8791')
    expect(instance.nodeId).toBe('node-3f2a')
  })

  it('authenticates without a bearer token and sends the protocol header', async () => {
    const { client: instance, calls } = client([ok({ token: 't', expires_at: 'e', node_id: 'node-3f2a' })])
    const result = await instance.authToken({
      secret: 's',
      protocol_version: EXEC_PROTOCOL_VERSION,
      agent_info: { name: 'tianmacoder', version: '1' },
    })
    expect(result.token).toBe('t')
    expect(calls[0]?.request.url).toBe('http://10.0.0.7:8791/exec/v1/auth/token')
    expect(calls[0]?.request.method).toBe('POST')
    expect(calls[0]?.request.headers[EXEC_PROTOCOL_HEADER]).toBe(EXEC_PROTOCOL_VERSION)
    expect(calls[0]?.request.headers.authorization).toBeUndefined()
    expect(JSON.parse(calls[0]?.request.body ?? '{}')).toMatchObject({ node_id: 'node-3f2a', secret: 's' })
  })

  it('carries the bearer token on authenticated requests', async () => {
    const { client: instance, calls } = client([ok({ node_id: 'node-3f2a' })], 'tok')
    await instance.register({
      name: 'n',
      host: 'h',
      protocol_version: EXEC_PROTOCOL_VERSION,
      agent_version: '1',
      slots: { total: 1, running: 0, available: 1 },
      capabilities: {
        lanes: [],
        tools: [],
        os: 'windows',
        access_modes: ['read_write'],
        max_artifact_bytes: 1,
        supported_protocols: [EXEC_PROTOCOL_VERSION],
      },
      workspace_root: 'D:\\mps',
      node_time: 't',
    })
    expect(calls[0]?.request.headers.authorization).toBe('Bearer tok')
  })

  it('sends a task-scoped request and reads its payload', async () => {
    const { client: instance, calls } = client([ok({ lease_expire_at: 'e', should_continue: true })])
    const result = await instance.lease('tsk_1', 2)
    expect(result.should_continue).toBe(true)
    expect(calls[0]?.request.url).toBe('http://10.0.0.7:8791/exec/v1/tasks/tsk_1/lease')
    expect(JSON.parse(calls[0]?.request.body ?? '{}')).toEqual({ node_id: 'node-3f2a', attempt: 2 })
  })

  it('reports progress and logs without reading a payload', async () => {
    const { client: instance, calls } = client([ok(null), ok(null)])
    await instance.progress('tsk_1', { attempt: 1, progress: 40, stage: 'coding', message: 'm' })
    await instance.log('tsk_1', { batch_id: 'b', stream: 'stdout', lines: [{ at: 't', level: 'info', text: 'x' }], truncated: false })
    expect(calls[0]?.request.url.endsWith('/tasks/tsk_1/progress')).toBe(true)
    expect(calls[1]?.request.url.endsWith('/tasks/tsk_1/log')).toBe(true)
  })

  it('submits a result and confirms an abort', async () => {
    const { client: instance, calls } = client([
      ok({ task_id: 'tsk_1', accepted: true, already_final: false, work_item_state: 'done', next: 'verify' }),
      ok(null),
    ])
    const result = await instance.result('tsk_1', {
      attempt: 1,
      outcome: 'success',
      started_at: 'a',
      finished_at: 'b',
      summary: 's',
      evidence: { changed_files: ['a.ts'], branch: 'feature/1', base_commit: 'c1', head_commit: 'c2', pushed: true },
    })
    await instance.abortAck('tsk_1', { attempt: 1, aborted_at: 't', note: 'n' })
    expect(result.work_item_state).toBe('done')
    expect(calls[1]?.request.url.endsWith('/tasks/tsk_1/abort-ack')).toBe(true)
  })

  it('enters and leaves maintenance mode', async () => {
    const { client: instance, calls } = client([ok(null), ok(null)])
    await instance.drain('upgrade')
    await instance.resume('done')
    expect(calls[0]?.request.url.endsWith('/drain')).toBe(true)
    expect(calls[1]?.request.url.endsWith('/resume')).toBe(true)
  })

  it('reads configuration and capabilities over GET without a body', async () => {
    const { client: instance, calls } = client([ok({ config_revision: 7 }), ok({ protocol: 'exec/v1' })])
    expect((await instance.configuration()).config_revision).toBe(7)
    expect(await instance.capabilities()).toEqual({ protocol: 'exec/v1' })
    expect(calls[0]?.request.method).toBe('GET')
    expect(calls[0]?.request.body).toBeUndefined()
  })

  it('reports the workspace session', async () => {
    const { client: instance, calls } = client([ok(null)])
    await instance.reportSession('ws_1', { session_ref: 'session-1', coding_path: 'D:\\mps\\ws_1', base_commit: 'c', last_task_id: 'tsk_1' })
    expect(calls[0]?.request.url).toBe('http://10.0.0.7:8791/exec/v1/workspaces/ws_1/session')
  })

  it('returns no task when the claim long-poll answers with no content', async () => {
    const { client: instance, calls } = client([{ status: 204, headers: {}, text: '' }])
    expect(await instance.claim({ available_slots: 1, capabilities: { lanes: [], tools: [] }, max_wait_seconds: 25 })).toBeUndefined()
    expect(calls[0]?.request.timeoutMs).toBe(30_000)
  })

  it('returns the claimed task when the platform has one', async () => {
    const assignment = { task_id: 'tsk_1', work_item_id: 'wi_1', attempt: 1, max_attempts: 3, kind: 'coding', priority: 400, lease_expire_at: 'e', lease_renew_seconds: 30, payload: {} }
    const { client: instance } = client([ok({ task: assignment })])
    expect(await instance.claim({ available_slots: 1, capabilities: { lanes: [], tools: [] }, max_wait_seconds: 25 })).toEqual(assignment)
  })

  it('rejects a claim whose envelope carries an error code', async () => {
    const { client: instance } = client([failure('SLOT_OVERSELL', 409, 'too many')])
    await expect(instance.claim({ available_slots: 9, capabilities: { lanes: [], tools: [] }, max_wait_seconds: 25 }))
      .rejects.toThrow('too many')
  })

  it('treats the already-final marker as success', async () => {
    const { client: instance } = client([ok({ task_id: 'tsk_1', accepted: true, already_final: true, work_item_state: 'done', next: '' }, { code: 'ALREADY_FINAL' })])
    const result = await instance.result('tsk_1', {
      attempt: 1,
      outcome: 'success',
      started_at: 'a',
      finished_at: 'b',
      summary: 's',
      evidence: { changed_files: [], branch: 'b', base_commit: 'c1', head_commit: 'c2', pushed: true },
    })
    expect(result.already_final).toBe(true)
  })

  it('raises the envelope error with its recovery and request id', async () => {
    const { client: instance } = client([failure('LEASE_EXPIRED', 409)])
    const error = await instance.lease('tsk_1', 1).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ExecResponseError)
    expect((error as ExecResponseError).recovery).toBe('discard-result')
    expect((error as ExecResponseError).requestId).toBe('req_2')
    expect((error as ExecResponseError).message).toBe('LEASE_EXPIRED')
  })

  it('rejects a response with no envelope where one is required', async () => {
    const { client: instance } = client([{ status: 204, headers: {}, text: '' }])
    const error = await instance.lease('tsk_1', 1).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ExecResponseError)
    expect((error as ExecResponseError).code).toBe('INTERNAL_ERROR')
  })

  it('rejects a body that is empty or not JSON', async () => {
    const empty = client([{ status: 200, headers: {}, text: '  ' }])
    await expect(empty.client.lease('tsk_1', 1)).rejects.toThrow(/carried no body/)
    const broken = client([{ status: 200, headers: {}, text: '{oops' }])
    await expect(broken.client.lease('tsk_1', 1)).rejects.toThrow(/was not JSON/)
  })

  it('reads a retry delay from the response headers', () => {
    expect(ExecClient.retryAfter({ 'retry-after': '5' })).toBe(5000)
    expect(ExecClient.retryAfter({})).toBeUndefined()
  })

  it('wraps fetch as a transport and lower-cases header names', async () => {
    const seen: FetchObservation = { url: undefined, method: undefined, body: undefined, signal: undefined }
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.method = init?.method
      seen.body = typeof init?.body === 'string' ? init.body : null
      seen.signal = init?.signal ?? null
      return new Response('{"code":"OK"}', { status: 200, headers: { 'Content-Type': 'application/json', 'Retry-After': '9' } })
    }
    const transport = createFetchTransport(fakeFetch)
    const response = await transport({
      url: 'http://h/exec/v1/config',
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 5000,
    })
    expect(seen.url).toBe('http://h/exec/v1/config')
    expect(seen.method).toBe('GET')
    expect(seen.body).toBeNull()
    expect(seen.signal).toBeInstanceOf(AbortSignal)
    expect(response.status).toBe(200)
    expect(response.headers['retry-after']).toBe('9')
    expect(response.text).toBe('{"code":"OK"}')
  })

  it('combines a caller signal with the request timeout', async () => {
    const controller = new AbortController()
    let observed: AbortSignal | null | undefined
    const fakeFetch: typeof fetch = async (_input, init) => {
      observed = init?.signal
      return new Response('{"code":"OK"}', { status: 200 })
    }
    await createFetchTransport(fakeFetch)({
      url: 'http://h/x',
      method: 'POST',
      headers: {},
      body: '{}',
      timeoutMs: 5000,
      signal: controller.signal,
    })
    expect(observed).toBeInstanceOf(AbortSignal)
    expect(observed?.aborted).toBe(false)
    controller.abort()
    expect(observed?.aborted).toBe(true)
  })

  it('falls back to the envelope code when a claim failure carries no message', async () => {
    const { client: instance } = client([failure('SLOT_OVERSELL', 409, '')])
    await expect(instance.claim({ available_slots: 1, capabilities: { lanes: [], tools: [] }, max_wait_seconds: 25 }))
      .rejects.toThrow('SLOT_OVERSELL')
  })

  it('supplies the transport, token supplier, and timeout when the caller states none', async () => {
    const bare = new ExecClient({ endpoint, nodeId: 'node-1' })
    expect(bare.nodeId).toBe('node-1')
    expect(bare.endpoint.origin).toBe('http://10.0.0.7:8791')
    const withoutToken = new ExecClient({ endpoint, nodeId: 'node-1', transport: scripted([ok(null)]).transport })
    await withoutToken.drain('maintenance')
  })

  it('omits the authorization header for an empty token', async () => {
    const { client: instance, calls } = client([ok(null)], '')
    await instance.drain('maintenance')
    expect(calls[0]?.request.headers.authorization).toBeUndefined()
  })
})

describe('task vocabulary', () => {
  const payload = {
    limits: { max_runtime_seconds: 10_800 },
    workspace: {
      workspace_id: 'ws_1',
      repo: { url: 'https://example.invalid/r.git', base_branch: 'main', base_commit: 'a1b2c3d', work_branch: 'feature/x' },
    },
  }

  it('resolves two outcomes by the protocol precedence', () => {
    expect(strongerOutcome('success', 'failed')).toBe('failed')
    expect(strongerOutcome('failed', 'success')).toBe('failed')
    expect(strongerOutcome('failed', 'blocked')).toBe('blocked')
    expect(strongerOutcome('blocked', 'blocked')).toBe('blocked')
    expect(strongerOutcome('blocked', 'cancelled')).toBe('cancelled')
    expect(strongerOutcome('cancelled', 'success')).toBe('cancelled')
    expect(strongerOutcome('success', 'success')).toBe('success')
  })

  it('reads the runtime ceiling a payload states', () => {
    expect(taskRuntimeLimitMs(payload)).toBe(10_800_000)
    expect(taskRuntimeLimitMs({})).toBeUndefined()
    expect(taskRuntimeLimitMs({ limits: { max_runtime_seconds: 0 } })).toBeUndefined()
    expect(taskRuntimeLimitMs({ limits: { max_runtime_seconds: Number.NaN } })).toBeUndefined()
    expect(taskRuntimeLimitMs({ limits: 'ten hours' })).toBeUndefined()
  })

  it('reads the workspace id a payload states', () => {
    expect(taskWorkspaceId(payload)).toBe('ws_1')
    expect(taskWorkspaceId({ workspace: {} })).toBeUndefined()
    expect(taskWorkspaceId({ workspace: { workspace_id: '' } })).toBeUndefined()
    expect(taskWorkspaceId({})).toBeUndefined()
  })

  it('reads the repository a payload states', () => {
    expect(taskRepository(payload)).toEqual({
      url: 'https://example.invalid/r.git',
      base_branch: 'main',
      base_commit: 'a1b2c3d',
      work_branch: 'feature/x',
    })
    expect(taskRepository({ workspace: { repo: { url: '' } } })).toEqual({
      url: undefined,
      base_branch: undefined,
      base_commit: undefined,
      work_branch: undefined,
    })
    expect(taskRepository({ workspace: { repo: 'https://example.invalid/r.git' } })).toBeUndefined()
    expect(taskRepository({ workspace: {} })).toBeUndefined()
    expect(taskRepository({})).toBeUndefined()
  })
})
