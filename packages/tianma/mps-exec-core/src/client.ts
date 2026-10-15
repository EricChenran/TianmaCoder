/**
 * The node's HTTP client for the `exec/v1` JSON endpoints. It owns two rules the
 * protocol states for every call: the envelope `code` decides success and not the
 * HTTP status, and every request reports this node's id, so the client holds the
 * id once instead of each caller repeating it. Content endpoints that carry bytes
 * — artifact upload and resource download — are not part of this client.
 * @module @tianma/dsh-mps-exec-core/client
 */

import { retryAfterDelayMs } from './backoff.ts'
import type { PlatformEndpoint } from './endpoint.ts'
import { ExecResponseError } from './errors.ts'
import {
  EXEC_OK_CODE,
  EXEC_PROTOCOL_HEADER,
  EXEC_PROTOCOL_VERSION,
  isAlreadyFinal,
  parseExecEnvelope,
} from './protocol.ts'
import type { ExecEnvelope } from './protocol.ts'

/** One HTTP request the transport performs. */
export interface ExecHttpRequest {
  /** Absolute request URL. */
  url: string
  /** HTTP method; every `exec/v1` endpoint is `GET` or `POST`. */
  method: 'GET' | 'POST'
  /** Request headers, already including the protocol header. */
  headers: Record<string, string>
  /** Encoded JSON body, absent for `GET`. */
  body?: string | undefined
  /** Budget for this one request. */
  timeoutMs: number
  /** Caller cancellation, combined with the timeout. */
  signal?: AbortSignal | undefined
}

/** One HTTP response as the transport returns it. */
export interface ExecHttpResponse {
  /** HTTP status. */
  status: number
  /** Response headers, keyed by lower-case name. */
  headers: Record<string, string>
  /** Response body as text; empty when the status carries no body. */
  text: string
}

/** Performs one HTTP request and returns its response. */
export type ExecHttpTransport = (request: ExecHttpRequest) => Promise<ExecHttpResponse>

/** Options for {@link ExecClient}. */
export interface ExecClientOptions {
  /** The resolved platform address. */
  endpoint: PlatformEndpoint
  /** Node id this client reports on every request. */
  nodeId: string
  /** Transport override; defaults to `fetch`. */
  transport?: ExecHttpTransport | undefined
  /** Current bearer token, or `undefined` before authentication. */
  token?: (() => string | undefined) | undefined
  /** Budget for ordinary requests. */
  requestTimeoutMs?: number | undefined
}

/** Which slot capacity a registering or heartbeating node reports. */
export interface ExecSlots {
  /** Configured slot count. */
  total: number
  /** Slots currently running a task. */
  running: number
  /** Slots free for a new task. */
  available: number
}

/** The capability promise a node registers. */
export interface ExecCapabilities {
  /** Work kinds the node accepts. */
  lanes: string[]
  /** Toolchain names the node detected. */
  tools: string[]
  /** Platform name the node runs on. */
  os: string
  /** Code access modes the node supports. */
  access_modes: string[]
  /** Largest single artifact the node uploads without chunking. */
  max_artifact_bytes: number
  /** Protocol versions the node speaks. */
  supported_protocols: string[]
}

/** Body of `POST /auth/token`, without the node id the client injects. */
export interface ExecAuthTokenRequest {
  /** Pre-shared secret. */
  secret: string
  /** Protocol version. */
  protocol_version: string
  /** Agent identity the node runs. */
  agent_info: { name: string; version: string }
}

/** Result of `POST /auth/token`. */
export interface ExecAuthTokenResult {
  /** Bearer token. */
  token: string
  /** Token expiry as an RFC 3339 string. */
  expires_at: string
  /** Node id the token belongs to. */
  node_id: string
}

/** Body of `POST /register`, without the node id the client injects. */
export interface ExecRegisterRequest {
  /** Display name. */
  name: string
  /** Host address the node reports. */
  host: string
  /** Protocol version. */
  protocol_version: string
  /** Agent version the node detected. */
  agent_version: string
  /** Slot capacity. */
  slots: ExecSlots
  /** Detected capabilities. */
  capabilities: ExecCapabilities
  /** Root directory the node works under. */
  workspace_root: string
  /** Node time as an RFC 3339 string. */
  node_time: string
  /** Operator labels. */
  labels?: Record<string, string> | undefined
}

/** Result of `POST /register` and the timing knobs it returns. */
export interface ExecRegisterResult {
  /** Node id. */
  node_id: string
  /** Node status after registration. */
  status: string
  /** Heartbeat period. */
  heartbeat_interval_seconds: number
  /** Claim long-poll budget. */
  claim_long_poll_seconds: number
  /** Lease lifetime. */
  lease_ttl_seconds: number
  /** Lease renewal period. */
  lease_renew_seconds: number
  /** Configuration revision. */
  config_revision: number
  /** Platform time. */
  server_time: string
}

/** One task the node is running, as reported in a heartbeat. */
export interface ExecRunningTask {
  /** Protocol task id. */
  task_id: string
  /** Attempt number. */
  attempt: number
  /** Start time as an RFC 3339 string. */
  started_at: string
  /** Percent complete, an estimate. */
  progress: number
  /** Current stage. */
  stage: string
}

/** Resource readings a heartbeat reports. */
export interface ExecResources {
  /** CPU load percentage. */
  cpu_percent: number
  /** Memory usage percentage. */
  mem_percent: number
  /** Free disk space in gigabytes. */
  disk_free_gb: number
}

/** Body of `POST /heartbeat`, without the node id the client injects. */
export interface ExecHeartbeatRequest {
  /** Tasks running right now; every one of these has its lease renewed. */
  running_tasks: ExecRunningTask[]
  /** Slot capacity. */
  slots: ExecSlots
  /** Resource readings. */
  resources: ExecResources
  /** Node time as an RFC 3339 string. */
  node_time: string
  /** Agent version. */
  agent_version: string
}

/** One command the platform sends down in a heartbeat response. */
export interface ExecCommand {
  /** Command name, such as `abort` or `release_workspace`. */
  command: string
  /** Task the command applies to, when it names one. */
  task_id?: string | undefined
  /** Workspace the command applies to, when it names one. */
  workspace_id?: string | undefined
  /** Operator-visible reason. */
  reason?: string | undefined
  /** Issue time. */
  issued_at?: string | undefined
}

/** Result of `POST /heartbeat`. */
export interface ExecHeartbeatResult {
  /** Node status. */
  node_status: string
  /** Commands to apply. */
  commands: ExecCommand[]
  /** Lease notices for running tasks. */
  lease_notices: { task_id: string; lease_expire_at: string }[]
  /** Configuration revision. */
  config_revision: number
  /** Platform time. */
  server_time: string
}

/** The task payload a claim returns. */
export interface ExecTaskAssignment {
  /** Protocol task id, which is the platform's work-item id. */
  task_id: string
  /** Work item id. */
  work_item_id: string
  /** Attempt number. */
  attempt: number
  /** Attempt ceiling. */
  max_attempts: number
  /** Work item kind. */
  kind: string
  /** Queue priority. */
  priority: number
  /** Lease expiry. */
  lease_expire_at: string
  /** Lease renewal period. */
  lease_renew_seconds: number
  /** Task payload, kept as the platform sent it. */
  payload: Record<string, unknown>
}

/** Body of `POST /claim`, without the node id the client injects. */
export interface ExecClaimRequest {
  /** Slots free for a new task. */
  available_slots: number
  /** Capabilities the node offers for matching. */
  capabilities: Pick<ExecCapabilities, 'lanes' | 'tools'>
  /** Long-poll budget in seconds. */
  max_wait_seconds: number
}

/** Result of `POST /tasks/{id}/lease`. */
export interface ExecLeaseResult {
  /** Extended lease expiry. */
  lease_expire_at: string
  /** Whether the node still holds the task; `false` forbids submitting a result. */
  should_continue: boolean
}

/** Body of `POST /tasks/{id}/progress`, without the node id the client injects. */
export interface ExecProgressRequest {
  /** Attempt number. */
  attempt: number
  /** Percent complete, an estimate. */
  progress: number
  /** Current stage. */
  stage: string
  /** Operator-visible note. */
  message: string
  /** Estimated seconds to completion. */
  eta_seconds?: number | undefined
}

/** One log line. */
export interface ExecLogLine {
  /** Time as an RFC 3339 string. */
  at: string
  /** Severity. */
  level: string
  /** Line text, already redacted. */
  text: string
}

/** Body of `POST /tasks/{id}/log`, without the node id the client injects. */
export interface ExecLogRequest {
  /** Idempotency key for this batch. */
  batch_id: string
  /** Stream the lines came from. */
  stream: string
  /** Lines in this batch. */
  lines: ExecLogLine[]
  /** Whether any line was cut to the per-line limit. */
  truncated: boolean
}

/** Build, test, and end-to-end results carried as evidence. */
export interface ExecResultEvidence {
  /** Changed files, relative to the workspace root. */
  changed_files: string[]
  /** Branch the node pushed. */
  branch: string
  /** Baseline commit from the task payload. */
  base_commit: string
  /** Commit the node pushed. */
  head_commit: string
  /** Whether the push happened. */
  pushed: boolean
  /** Build result. */
  build?: Record<string, unknown> | undefined
  /** End-to-end result. */
  e2e?: Record<string, unknown> | undefined
  /** Screenshot references. */
  screenshots?: Record<string, unknown>[] | undefined
  /** Report artifact id. */
  report_artifact_id?: string | undefined
  /** Diff artifact id. */
  patch_artifact_id?: string | undefined
}

/** Body of `POST /tasks/{id}/result`, without the node id the client injects. */
export interface ExecResultRequest {
  /** Attempt number. */
  attempt: number
  /** Terminal outcome the node reports. */
  outcome: 'success' | 'failed' | 'blocked' | 'cancelled'
  /** Task start time. */
  started_at: string
  /** Task end time. */
  finished_at: string
  /** Operator-visible summary. */
  summary: string
  /** Evidence for the outcome. */
  evidence: ExecResultEvidence
  /** Free-form notes. */
  notes?: string | undefined
}

/** Result of `POST /tasks/{id}/result`. */
export interface ExecResultResponse {
  /** Task id. */
  task_id: string
  /** Whether the platform accepted this submission. */
  accepted: boolean
  /** Whether the task had already reached a final state. */
  already_final: boolean
  /** Work-item state after the submission. */
  work_item_state: string
  /** Next work the platform will queue. */
  next: string
}

/** Body of `POST /tasks/{id}/abort-ack`, without the node id the client injects. */
export interface ExecAbortAckRequest {
  /** Attempt number. */
  attempt: number
  /** Abort time as an RFC 3339 string. */
  aborted_at: string
  /** Operator-visible note. */
  note: string
}

/** Body of `POST /workspaces/{id}/session`, without the node id the client injects. */
export interface ExecSessionReportRequest {
  /** Session reference the node keeps for this workspace. */
  session_ref: string
  /** Coding directory the node keeps for this workspace. */
  coding_path: string
  /** Baseline commit the directory holds. */
  base_commit: string
  /** Last task run in this workspace. */
  last_task_id: string
}

/** Payload of `GET /config`: the revision plus whatever else the platform sends. */
export type ExecConfigResult = { config_revision: number } & Record<string, unknown>

/** Payload of `GET /capabilities`. */
export type ExecCapabilitiesResult = Record<string, unknown>

/**
 * Wrap `fetch` as the transport, lower-casing response header names so the rest
 * of the client reads them the same way from every implementation.
 * @param fetchImpl - the `fetch` implementation to call; defaults to the global one.
 * @returns the transport.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): ExecHttpTransport {
  return async (request: ExecHttpRequest): Promise<ExecHttpResponse> => {
    const timeout = AbortSignal.timeout(request.timeoutMs)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal])
    const init: RequestInit = { method: request.method, headers: request.headers, signal }
    if (request.body !== undefined) init.body = request.body
    const response = await fetchImpl(request.url, init)
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    return { status: response.status, headers, text: await response.text() }
  }
}

/**
 * The node's protocol client. Every method resolves to the envelope payload and
 * throws {@link ExecResponseError} for a non-`OK` code, so a caller never reads a
 * status code to decide an outcome.
 */
export class ExecClient {
  readonly #endpoint: PlatformEndpoint
  readonly #nodeId: string
  readonly #transport: ExecHttpTransport
  readonly #token: () => string | undefined
  readonly #requestTimeoutMs: number

  /**
   * @param options - the platform address, node id, optional transport and token supplier, and timeout.
   */
  constructor(options: ExecClientOptions) {
    this.#endpoint = options.endpoint
    this.#nodeId = options.nodeId
    this.#transport = options.transport ?? createFetchTransport()
    this.#token = options.token ?? (() => undefined)
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  }

  /** The platform address this client dials. */
  get endpoint(): PlatformEndpoint {
    return this.#endpoint
  }

  /** The node id every request reports. */
  get nodeId(): string {
    return this.#nodeId
  }

  /**
   * Perform one request and parse its envelope.
   * @param path - protocol path such as `/register`.
   * @param payload - JSON body, absent for `GET`.
   * @param timeoutMs - request budget; defaults to the client's ordinary timeout.
   * @param signal - caller cancellation.
   * @returns the status, the parsed envelope, and the response headers.
   */
  async #send(
    path: string,
    payload: unknown,
    timeoutMs: number = this.#requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<{ status: number; envelope: ExecEnvelope<unknown> | undefined; headers: Record<string, string> }> {
    const token = this.#token()
    const headers: Record<string, string> = {
      [EXEC_PROTOCOL_HEADER]: EXEC_PROTOCOL_VERSION,
      accept: 'application/json',
    }
    if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`
    if (payload !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    const response = await this.#transport({
      url: this.#endpoint.url(path),
      method: payload === undefined ? 'GET' : 'POST',
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      timeoutMs,
      signal,
    })
    if (response.status === 204) return { status: response.status, envelope: undefined, headers: response.headers }
    if (response.text.trim() === '') {
      throw new TypeError(`exec response for ${path} carried no body (HTTP ${String(response.status)})`)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(response.text)
    } catch {
      throw new TypeError(`exec response for ${path} was not JSON (HTTP ${String(response.status)})`)
    }
    return { status: response.status, envelope: parseExecEnvelope(decoded), headers: response.headers }
  }

  /**
   * Perform one request and require its envelope code to be `OK` or the
   * already-final marker.
   * @param path - protocol path.
   * @param payload - JSON body, absent for `GET`.
   * @param timeoutMs - request budget.
   * @param signal - caller cancellation.
   * @returns the envelope payload.
   */
  async #sendOk<T>(
    path: string,
    payload: unknown,
    timeoutMs: number = this.#requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> {
    const { status, envelope } = await this.#send(path, payload, timeoutMs, signal)
    if (envelope === undefined) {
      throw new ExecResponseError(`exec response for ${path} carried no envelope`, {
        code: 'INTERNAL_ERROR',
        httpStatus: status,
      })
    }
    if (envelope.code !== EXEC_OK_CODE && !isAlreadyFinal(envelope.code)) {
      const detail = envelope.msg === '' ? '' : `: ${envelope.msg}`
      throw new ExecResponseError(`${envelope.code}${detail}`, {
        code: envelope.code,
        httpStatus: status,
        requestId: envelope.requestId,
      })
    }
    return envelope.data as T
  }

  /**
   * Exchange the pre-shared secret for a bearer token.
   * @param body - the secret, protocol version, and agent identity.
   * @param signal - caller cancellation.
   * @returns the token and its expiry.
   */
  async authToken(body: ExecAuthTokenRequest, signal?: AbortSignal): Promise<ExecAuthTokenResult> {
    return await this.#sendOk<ExecAuthTokenResult>(
      '/auth/token',
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Register or re-register this node.
   * @param body - the node's identity, capacity, and capabilities.
   * @param signal - caller cancellation.
   * @returns the timing knobs the platform assigned.
   */
  async register(body: ExecRegisterRequest, signal?: AbortSignal): Promise<ExecRegisterResult> {
    return await this.#sendOk<ExecRegisterResult>(
      '/register',
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Report state, receive commands, and renew the leases of running tasks.
   * @param body - running tasks, slots, resources, and node time.
   * @param signal - caller cancellation.
   * @returns the commands and lease notices for this period.
   */
  async heartbeat(body: ExecHeartbeatRequest, signal?: AbortSignal): Promise<ExecHeartbeatResult> {
    return await this.#sendOk<ExecHeartbeatResult>(
      '/heartbeat',
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Long-poll for one task.
   * @param body - free slots, capabilities, and the poll budget.
   * @param signal - caller cancellation.
   * @returns the assignment, or `undefined` when the platform returned no content.
   */
  async claim(body: ExecClaimRequest, signal?: AbortSignal): Promise<ExecTaskAssignment | undefined> {
    const timeoutMs = (body.max_wait_seconds + 5) * 1000
    const { status, envelope } = await this.#send('/claim', { node_id: this.#nodeId, ...body }, timeoutMs, signal)
    if (envelope === undefined) return undefined
    if (envelope.code !== EXEC_OK_CODE) {
      throw new ExecResponseError(envelope.msg === '' ? envelope.code : envelope.msg, {
        code: envelope.code,
        httpStatus: status,
        requestId: envelope.requestId,
      })
    }
    return (envelope.data as { task: ExecTaskAssignment }).task
  }

  /**
   * Renew one task's lease and learn whether this node still owns it.
   * @param taskId - protocol task id.
   * @param attempt - attempt number.
   * @param signal - caller cancellation.
   * @returns the extension and the continue flag.
   */
  async lease(taskId: string, attempt: number, signal?: AbortSignal): Promise<ExecLeaseResult> {
    return await this.#sendOk<ExecLeaseResult>(
      `/tasks/${taskId}/lease`,
      { node_id: this.#nodeId, attempt },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Report progress for one task. The percentage is an estimate.
   * @param taskId - protocol task id.
   * @param body - progress, stage, and note.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with an empty payload.
   */
  async progress(taskId: string, body: ExecProgressRequest, signal?: AbortSignal): Promise<void> {
    await this.#sendOk<unknown>(
      `/tasks/${taskId}/progress`,
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Submit one redacted log batch.
   * @param taskId - protocol task id.
   * @param body - batch id, stream, and lines.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with an empty payload.
   */
  async log(taskId: string, body: ExecLogRequest, signal?: AbortSignal): Promise<void> {
    await this.#sendOk<unknown>(
      `/tasks/${taskId}/log`,
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Submit one task's terminal outcome.
   * @param taskId - protocol task id.
   * @param body - outcome, times, summary, and evidence.
   * @param signal - caller cancellation.
   * @returns the acceptance record, including whether the task was already final.
   */
  async result(taskId: string, body: ExecResultRequest, signal?: AbortSignal): Promise<ExecResultResponse> {
    return await this.#sendOk<ExecResultResponse>(
      `/tasks/${taskId}/result`,
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Confirm that an abort was applied.
   * @param taskId - protocol task id.
   * @param body - attempt, abort time, and note.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with an empty payload.
   */
  async abortAck(taskId: string, body: ExecAbortAckRequest, signal?: AbortSignal): Promise<void> {
    await this.#sendOk<unknown>(
      `/tasks/${taskId}/abort-ack`,
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * Enter maintenance mode: the platform stops dispatching new tasks here.
   * @param reason - operator-visible reason.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with an empty payload.
   */
  async drain(reason: string, signal?: AbortSignal): Promise<void> {
    await this.#sendOk<unknown>('/drain', { node_id: this.#nodeId, reason }, this.#requestTimeoutMs, signal)
  }

  /**
   * Leave maintenance mode.
   * @param reason - operator-visible reason.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with an empty payload.
   */
  async resume(reason: string, signal?: AbortSignal): Promise<void> {
    await this.#sendOk<unknown>('/resume', { node_id: this.#nodeId, reason }, this.#requestTimeoutMs, signal)
  }

  /**
   * Read the platform's timing and limit configuration.
   * @param signal - caller cancellation.
   * @returns the configuration payload.
   */
  async configuration(signal?: AbortSignal): Promise<ExecConfigResult> {
    return await this.#sendOk<ExecConfigResult>('/config', undefined, this.#requestTimeoutMs, signal)
  }

  /**
   * Read the capability dictionary, for handshake self-checks.
   * @param signal - caller cancellation.
   * @returns the dictionary payload.
   */
  async capabilities(signal?: AbortSignal): Promise<ExecCapabilitiesResult> {
    return await this.#sendOk<ExecCapabilitiesResult>('/capabilities', undefined, this.#requestTimeoutMs, signal)
  }

  /**
   * Report the session and coding path this node keeps for one workspace.
   * @param workspaceId - workspace id.
   * @param body - session reference, coding path, baseline commit, and last task.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with an empty payload.
   */
  async reportSession(
    workspaceId: string,
    body: ExecSessionReportRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#sendOk<unknown>(
      `/workspaces/${workspaceId}/session`,
      { node_id: this.#nodeId, ...body },
      this.#requestTimeoutMs,
      signal,
    )
  }

  /**
   * The retry delay one response demands, if it demanded one.
   * @param headers - the response headers, keyed by lower-case name.
   * @param nowMs - current time, used for the HTTP-date form.
   * @returns the delay in milliseconds, or `undefined`.
   */
  static retryAfter(headers: Record<string, string>, nowMs?: number): number | undefined {
    return retryAfterDelayMs(headers['retry-after'], nowMs)
  }
}
