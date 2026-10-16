/**
 * The node's HTTP client for the `exec/v1` JSON endpoints. It owns two rules the
 * protocol states for every call: the envelope `code` decides success and not the
 * HTTP status, and every request reports this node's id, so the client holds the
 * id once instead of each caller repeating it. Content endpoints that carry bytes
 * — artifact upload and resource download — are not part of this client.
 * @module @tianma/dsh-mps-exec-core/client
 */

import { createHash } from 'node:crypto'
import { requestRetryDelayMs, retryAfterDelayMs } from './backoff.ts'
import type { PlatformEndpoint } from './endpoint.ts'
import { ExecResponseError } from './errors.ts'
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  ARTIFACT_CHUNK_THRESHOLD_BYTES,
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
  /** HTTP method; the protocol's endpoints are `GET`, `POST`, or a `HEAD` size probe. */
  method: 'GET' | 'POST' | 'HEAD'
  /** Request headers, already including the protocol header. */
  headers: Record<string, string>
  /**
   * Body to send, absent for `GET`. A `FormData` body is sent as multipart, which is
   * how an artifact upload carries a file; the transport leaves its content type to
   * `fetch` so the boundary matches.
   */
  body?: string | FormData | Uint8Array | undefined
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

/** A response whose body is a file rather than an envelope. */
export interface ExecBinaryResponse {
  /** HTTP status. */
  status: number
  /** Response headers, keyed by lower-case name. */
  headers: Record<string, string>
  /** Response body as bytes. */
  bytes: Uint8Array
}

/** Performs one HTTP request whose response is a file. */
export type ExecHttpDownload = (request: ExecHttpRequest) => Promise<ExecBinaryResponse>

/** One task material the node downloaded and verified. */
export interface ExecResource {
  /** The material's contents. */
  bytes: Uint8Array
  /** Digest the node computed and checked against the platform's. */
  sha256: string
}

/** Options for {@link ExecClient}. */
export interface ExecClientOptions {
  /** The resolved platform address. */
  endpoint: PlatformEndpoint
  /** Node id this client reports on every request. */
  nodeId: string
  /** Transport override; defaults to `fetch`. */
  transport?: ExecHttpTransport | undefined
  /** Download override for file responses; defaults to `fetch`. */
  download?: ExecHttpDownload | undefined
  /** Current bearer token, or `undefined` before authentication. */
  token?: (() => string | undefined) | undefined
  /** Budget for ordinary requests. */
  requestTimeoutMs?: number | undefined
  /**
   * Budget for one artifact upload. A file transfer outlasts an ordinary request by
   * orders of magnitude, so it gets its own budget rather than the request one.
   */
  artifactTimeoutMs?: number | undefined
  /**
   * Size of one range this client asks for when a material is too large for one
   * request; defaults to the protocol's chunk size.
   */
  resourceChunkBytes?: number | undefined
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

/** What an artifact is, as the platform's artifact table names it. */
export type ExecArtifactKind = 'screenshot' | 'report' | 'video' | 'log' | 'diff' | 'bundle' | 'other'

/** What one chunked artifact upload states when it opens. */
export interface ExecArtifactUploadInit {
  /** Artifact the node minted, which makes the upload idempotent. */
  artifact_id: string
  /** What the file is. */
  kind: ExecArtifactKind
  /** Size of the whole file in bytes. */
  total_size: number
  /** Size of one chunk in bytes. */
  chunk_size: number
  /** SHA-256 of the whole file, which the platform verifies when the upload closes. */
  sha256: string
  /** JSON the platform keeps beside the artifact. */
  meta?: string | undefined
}

/** One chunked artifact upload the platform opened. */
export interface ExecArtifactUploadSession {
  /** Upload to address the chunks and the completion to. */
  upload_id: string
  /** Chunk indices the platform already holds, so a resumed upload sends only the rest. */
  uploaded_chunks: number[]
}

/** One artifact to upload. */
export interface ExecArtifactUpload {
  /** Idempotency key the node generates. */
  artifact_id: string
  /** What the file is. */
  kind: ExecArtifactKind
  /** File name the platform stores. */
  filename: string
  /** File contents. */
  bytes: Uint8Array
  /** Content SHA-256, which the platform verifies. */
  sha256: string
  /** JSON string the platform keeps beside the artifact. */
  meta?: string | undefined
}

/**
 * Compute the SHA-256 the platform verifies an artifact against.
 * @param bytes - the file contents.
 * @returns the digest as lower-case hex.
 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * How many times one material range is asked for before the refusal is reported. A
 * range that failed arrived with neither bytes nor an explanation of its own, so
 * repeating it is the whole available response.
 */
const MATERIAL_RANGE_ATTEMPTS = 3

/**
 * Check one material's contents against the length and the digest the platform stated.
 * @param artifactId - the material, named in the failure text.
 * @param bytes - the contents.
 * @param stated - the digest the platform stated, empty when it stated none.
 * @param status - the status the contents arrived with, reported with the failure.
 * @param expectedTotal - the length the platform stated, when it stated one.
 * @returns the contents and the digest the node computed.
 * @throws ExecResponseError when the length or the digest does not match.
 */
function verifiedResource(
  artifactId: string,
  bytes: Uint8Array,
  stated: string,
  status: number,
  expectedTotal?: number,
): ExecResource {
  if (expectedTotal !== undefined && bytes.byteLength !== expectedTotal) {
    throw new ExecResponseError(
      `resource ${artifactId} answered ${String(bytes.byteLength)} bytes where the platform stated ${String(expectedTotal)}`,
      { code: 'INTERNAL_ERROR', httpStatus: status },
    )
  }
  const sha256 = sha256Of(bytes)
  // A missing digest is a mismatch: the node must not hand bytes over unverified.
  if (stated !== sha256) {
    throw new ExecResponseError(`resource ${artifactId} did not match the digest the platform stated`, {
      code: 'CHECKSUM_MISMATCH',
      httpStatus: status,
    })
  }
  return { bytes, sha256 }
}

/**
 * Join the pieces of one material into the whole the platform stated the length of.
 * @param parts - the pieces, in the order they were asked for.
 * @param total - the length the platform stated.
 * @returns the assembled contents.
 */
function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const assembled = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    assembled.set(part, offset)
    offset += part.byteLength
  }
  return assembled
}

/**
 * Wait one retry delay.
 * @param ms - milliseconds to wait.
 * @returns a promise that settles after the delay.
 */
async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Wrap `fetch` as the transport, lower-casing response header names so the rest
 * of the client reads them the same way from every implementation.
 * @param fetchImpl - the `fetch` implementation to call; defaults to the global one.
 * @returns the transport.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): ExecHttpTransport {
  return async (request: ExecHttpRequest): Promise<ExecHttpResponse> => {
    const response = await sendFetch(fetchImpl, request)
    const headers = lowerCasedHeaders(response)
    return { status: response.status, headers, text: await response.text() }
  }
}

/**
 * Wrap `fetch` as the download transport, for responses that are files.
 * @param fetchImpl - the `fetch` implementation to call; defaults to the global one.
 * @returns the download transport.
 */
export function createFetchDownload(fetchImpl: typeof fetch = fetch): ExecHttpDownload {
  return async (request: ExecHttpRequest): Promise<ExecBinaryResponse> => {
    const response = await sendFetch(fetchImpl, request)
    const headers = lowerCasedHeaders(response)
    return { status: response.status, headers, bytes: new Uint8Array(await response.arrayBuffer()) }
  }
}

/**
 * Perform one request with the budget and cancellation the caller asked for.
 * @param fetchImpl - the `fetch` implementation.
 * @param request - the request to send.
 * @returns the response, before its body is read.
 */
async function sendFetch(fetchImpl: typeof fetch, request: ExecHttpRequest): Promise<Response> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal])
  const init: RequestInit = { method: request.method, headers: request.headers, signal }
  if (request.body !== undefined) {
    // A chunk travels as bytes; `fetch` takes them as a blob part.
    init.body = request.body instanceof Uint8Array ? new Blob([request.body.slice()]) : request.body
  }
  return await fetchImpl(request.url, init)
}

/**
 * Read a response's header names the way the rest of the client does.
 * @param response - the response.
 * @returns the headers, keyed by lower-case name.
 */
function lowerCasedHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  return headers
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
  readonly #download: ExecHttpDownload
  readonly #token: () => string | undefined
  readonly #requestTimeoutMs: number
  readonly #artifactTimeoutMs: number
  readonly #resourceChunkBytes: number

  /**
   * @param options - the platform address, node id, optional transport and token supplier, and timeout.
   */
  constructor(options: ExecClientOptions) {
    this.#endpoint = options.endpoint
    this.#nodeId = options.nodeId
    this.#transport = options.transport ?? createFetchTransport()
    this.#download = options.download ?? createFetchDownload()
    this.#token = options.token ?? (() => undefined)
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.#artifactTimeoutMs = options.artifactTimeoutMs ?? 15 * 60 * 1000
    this.#resourceChunkBytes = options.resourceChunkBytes ?? ARTIFACT_CHUNK_SIZE_BYTES
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
    query?: Record<string, string>,
  ): Promise<{ status: number; envelope: ExecEnvelope<unknown> | undefined; headers: Record<string, string> }> {
    const headers = this.#requestHeaders()
    const multipart = payload instanceof FormData
    const binary = payload instanceof Uint8Array
    if (binary) headers['content-type'] = 'application/octet-stream'
    else if (payload !== undefined && !multipart) headers['content-type'] = 'application/json; charset=utf-8'
    // The endpoint owns the address; a query is the caller's, because a protocol path
    // is bare and the endpoint refuses anything else.
    const url = query === undefined
      ? this.#endpoint.url(path)
      : `${this.#endpoint.url(path)}?${new URLSearchParams(query).toString()}`
    const response = await this.#transport({
      url,
      method: payload === undefined ? 'GET' : 'POST',
      headers,
      body: payload === undefined || multipart || binary ? payload : JSON.stringify(payload),
      timeoutMs,
      signal,
    })
    return { status: response.status, envelope: this.#envelopeOf(path, response.status, response.text), headers: response.headers }
  }

  /**
   * The headers every request carries.
   * @returns the protocol header and the bearer token once authenticated.
   */
  #requestHeaders(): Record<string, string> {
    const token = this.#token()
    const headers: Record<string, string> = {
      [EXEC_PROTOCOL_HEADER]: EXEC_PROTOCOL_VERSION,
      accept: 'application/json',
    }
    if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`
    return headers
  }

  /**
   * Read the envelope one response carries.
   * @param path - protocol path, for the failure text.
   * @param status - HTTP status.
   * @param text - response body as text.
   * @returns the envelope, or undefined when the status carries no body.
   */
  #envelopeOf(path: string, status: number, text: string): ExecEnvelope<unknown> | undefined {
    if (status === 204) return undefined
    if (text.trim() === '') {
      throw new TypeError(`exec response for ${path} carried no body (HTTP ${String(status)})`)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(text)
    } catch {
      throw new TypeError(`exec response for ${path} was not JSON (HTTP ${String(status)})`)
    }
    return parseExecEnvelope(decoded)
  }

  /**
   * Require a response's envelope to carry success.
   * @param path - protocol path, for the failure text.
   * @param status - HTTP status.
   * @param envelope - the envelope, or undefined when the status carried no body.
   * @returns the payload.
   */
  #requireOk<T>(path: string, status: number, envelope: ExecEnvelope<unknown> | undefined): T {
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
    query?: Record<string, string>,
  ): Promise<T> {
    const { status, envelope } = await this.#send(path, payload, timeoutMs, signal, query)
    return this.#requireOk<T>(path, status, envelope)
  }

  /**
   * Download one task material and check it against the digest the platform states.
   * A material the protocol requires in pieces is asked for as a sequence of byte
   * ranges, so it never has to fit in one request; the digest is verified over the
   * assembled contents either way.
   * @param taskId - task id.
   * @param artifactId - the material, which the platform checks belongs to the task.
   * @param signal - caller cancellation.
   * @returns the verified contents and the digest.
   */
  async resource(taskId: string, artifactId: string, signal?: AbortSignal): Promise<ExecResource> {
    const path = `/tasks/${taskId}/resources/${artifactId}`
    const size = await this.#materialSize(path, signal)
    if (size === undefined || size.total <= ARTIFACT_CHUNK_THRESHOLD_BYTES) {
      return await this.#materialInOneRequest(path, artifactId, signal)
    }
    return await this.#materialInRanges(path, artifactId, size, signal)
  }

  /**
   * Fetch one material whole and verify it against the digest the platform states.
   * @param path - protocol path.
   * @param artifactId - the material, named in the failure text.
   * @param signal - caller cancellation.
   * @returns the verified contents and the digest.
   */
  async #materialInOneRequest(path: string, artifactId: string, signal?: AbortSignal): Promise<ExecResource> {
    const response = await this.#download({
      url: this.#endpoint.url(path),
      method: 'GET',
      headers: this.#requestHeaders(),
      timeoutMs: this.#artifactTimeoutMs,
      signal,
    })
    if (response.status !== 200) {
      // A refusal arrives as the usual envelope rather than as the file itself.
      const envelope = this.#envelopeOf(path, response.status, new TextDecoder().decode(response.bytes))
      this.#requireOk<unknown>(path, response.status, envelope)
    }
    return verifiedResource(artifactId, response.bytes, response.headers['x-artifact-sha256'] ?? '', response.status)
  }

  /**
   * Fetch one material as a sequence of byte ranges, then verify the assembled whole.
   * @param path - protocol path.
   * @param artifactId - the material, named in the failure text.
   * @param size - the length and digest the platform stated.
   * @param signal - caller cancellation.
   * @returns the verified contents and the digest.
   */
  async #materialInRanges(
    path: string,
    artifactId: string,
    size: { total: number; sha256: string },
    signal?: AbortSignal,
  ): Promise<ExecResource> {
    const parts: Uint8Array[] = []
    let stated = size.sha256
    for (let start = 0; start < size.total; start += this.#resourceChunkBytes) {
      const end = Math.min(start + this.#resourceChunkBytes, size.total) - 1
      const chunk = await this.#materialRange(path, start, end, signal)
      // The probe's digest is the whole artifact's and wins; a range states one only
      // when the platform had no length to answer the probe with.
      if (stated === '' && chunk.sha256 !== '') stated = chunk.sha256
      // The platform answered with the whole file, which settles the download.
      if (chunk.whole) return verifiedResource(artifactId, chunk.bytes, stated, chunk.status, size.total)
      const wanted = end - start + 1
      if (chunk.bytes.byteLength !== wanted) {
        throw new ExecResponseError(
          `resource ${artifactId} answered range ${String(start)}-${String(end)} with ${String(chunk.bytes.byteLength)} bytes instead of ${String(wanted)}`,
          { code: 'INTERNAL_ERROR', httpStatus: chunk.status },
        )
      }
      parts.push(chunk.bytes)
    }
    return verifiedResource(artifactId, concatBytes(parts, size.total), stated, 206, size.total)
  }

  /**
   * Ask the platform how long one material is and which digest it states. A platform
   * that will not answer a `HEAD`, or states no length, is asked for the file whole
   * instead — which is what this client did before it could ask.
   * @param path - protocol path.
   * @param signal - caller cancellation.
   * @returns the stated length and digest, or undefined when the platform states neither.
   */
  async #materialSize(path: string, signal?: AbortSignal): Promise<{ total: number; sha256: string } | undefined> {
    let response: ExecBinaryResponse
    try {
      response = await this.#download({
        url: this.#endpoint.url(path),
        method: 'HEAD',
        headers: this.#requestHeaders(),
        timeoutMs: this.#requestTimeoutMs,
        signal,
      })
    } catch {
      // A transport that cannot make the probe is not a failed download: the caller
      // fetches the material whole and reports whatever goes wrong there.
      return undefined
    }
    if (response.status !== 200) return undefined
    const total = Number(response.headers['content-length'])
    if (!Number.isInteger(total) || total <= 0) return undefined
    return { total, sha256: response.headers['x-artifact-sha256'] ?? '' }
  }

  /**
   * Fetch one range of a material, repeating the same range while the platform answers
   * with neither the range nor the file.
   * @param path - protocol path.
   * @param start - first byte wanted.
   * @param end - last byte wanted, inclusive.
   * @param signal - caller cancellation.
   * @returns the bytes, the digest the platform stated, and how the answer arrived.
   */
  async #materialRange(
    path: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sha256: string; whole: boolean; status: number }> {
    const range = `bytes=${String(start)}-${String(end)}`
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.#download({
        url: this.#endpoint.url(path),
        method: 'GET',
        headers: { ...this.#requestHeaders(), range },
        timeoutMs: this.#artifactTimeoutMs,
        signal,
      })
      const sha256 = response.headers['x-artifact-sha256'] ?? ''
      if (response.status === 206) return { bytes: response.bytes, sha256, whole: false, status: response.status }
      // A platform that ignored the range answered with the whole file, which answers
      // a request for part of it.
      if (response.status === 200) return { bytes: response.bytes, sha256, whole: true, status: response.status }
      if (attempt >= MATERIAL_RANGE_ATTEMPTS) {
        const text = new TextDecoder().decode(response.bytes)
        if (text.trim() !== '') {
          this.#requireOk<unknown>(path, response.status, this.#envelopeOf(path, response.status, text))
        }
        throw new ExecResponseError(`resource range ${range} was refused with HTTP ${String(response.status)}`, {
          code: 'INTERNAL_ERROR',
          httpStatus: response.status,
        })
      }
      await delayMs(requestRetryDelayMs(attempt))
    }
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
   * Upload one artifact for an attempt. The platform verifies the digest, so the
   * node computes it rather than letting the transport decide.
   * @param taskId - task id.
   * @param upload - the artifact, its contents, and the digest of those contents.
   * @param signal - caller cancellation.
   * @returns nothing; the platform answers with the artifact it stored.
   */
  async uploadArtifact(taskId: string, upload: ExecArtifactUpload, signal?: AbortSignal): Promise<void> {
    const form = new FormData()
    form.set('artifact_id', upload.artifact_id)
    form.set('kind', upload.kind)
    form.set('sha256', upload.sha256)
    form.set('meta', upload.meta ?? '{}')
    form.append('file', new Blob([upload.bytes.slice()]), upload.filename)
    await this.#sendOk<unknown>(`/tasks/${taskId}/artifacts`, form, this.#artifactTimeoutMs, signal)
  }

  /**
   * Open a chunked upload for an artifact the protocol requires in pieces.
   * @param taskId - the task the artifact belongs to.
   * @param init - what the upload states: the artifact, its size, its digest, and the pieces.
   * @param signal - caller cancellation.
   * @returns the upload the platform opened and the chunks it already holds.
   */
  async initArtifact(
    taskId: string,
    init: ExecArtifactUploadInit,
    signal?: AbortSignal,
  ): Promise<ExecArtifactUploadSession> {
    return await this.#sendOk<ExecArtifactUploadSession>(
      `/tasks/${taskId}/artifacts/init`,
      init,
      this.#artifactTimeoutMs,
      signal,
    )
  }

  /**
   * Send one chunk of an open upload. Chunks may arrive out of order and be resent.
   * @param taskId - the task the artifact belongs to.
   * @param uploadId - the upload the platform opened.
   * @param index - the chunk's index.
   * @param bytes - the chunk's contents.
   * @param signal - caller cancellation.
   */
  async uploadArtifactChunk(
    taskId: string,
    uploadId: string,
    index: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#sendOk<unknown>(
      `/tasks/${taskId}/artifacts/${uploadId}/chunk`,
      bytes,
      this.#artifactTimeoutMs,
      signal,
      { index: String(index) },
    )
  }

  /**
   * Close an upload, which makes the platform verify the whole artifact's digest.
   * @param taskId - the task the artifact belongs to.
   * @param uploadId - the upload the platform opened.
   * @param signal - caller cancellation.
   */
  async completeArtifact(taskId: string, uploadId: string, signal?: AbortSignal): Promise<void> {
    await this.#sendOk<unknown>(
      `/tasks/${taskId}/artifacts/${uploadId}/complete`,
      {},
      this.#artifactTimeoutMs,
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
