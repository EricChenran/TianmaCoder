/**
 * The `exec/v1` response envelope and error-code vocabulary. Every protocol
 * response carries a `code` the node must read before its HTTP status, so the
 * envelope parser here never consults the status and never rejects an unknown
 * field or code — a newer platform stays readable to an older node.
 * @module @tianma/dsh-mps-exec-core/protocol
 */

/** The protocol version this package speaks. */
export const EXEC_PROTOCOL_VERSION = 'exec/v1'

/** Request header naming the protocol version. */
export const EXEC_PROTOCOL_HEADER = 'X-Exec-Protocol'

/**
 * Request header carrying an id the node mints for one request. The platform echoes it as
 * the envelope's `requestId`, which is how a node's own record of a failure is joined to
 * the platform's access log.
 */
export const EXEC_REQUEST_ID_HEADER = 'X-Request-Id'

/** The envelope code every successful response carries. */
export const EXEC_OK_CODE = 'OK'

/** Size above which the protocol requires a chunked transfer rather than one request. */
export const ARTIFACT_CHUNK_THRESHOLD_BYTES = 100 * 1024 * 1024

/**
 * Size of one chunk in a chunked transfer, in either direction. Small enough for one
 * request's budget, and the unit a resumed transfer is measured in.
 */
export const ARTIFACT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024

/** Every envelope code the protocol defines, including the success code. */
export const EXEC_ERROR_CODES = [
  'OK',
  'NODE_SECRET_INVALID',
  'NODE_TOKEN_EXPIRED',
  'NODE_DISABLED',
  'NODE_NOT_REGISTERED',
  'PROTOCOL_UNSUPPORTED',
  'TASK_NOT_FOUND',
  'TASK_NOT_LEASED_BY_YOU',
  'LEASE_EXPIRED',
  'ALREADY_FINAL',
  'CHECKSUM_MISMATCH',
  'ARTIFACT_TOO_LARGE',
  'INVALID_CHANGED_FILES',
  'BASE_COMMIT_MISMATCH',
  'SLOT_OVERSELL',
  'RATE_LIMITED',
  'DB_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

/** One envelope code the protocol defines. */
export type ExecErrorCode = typeof EXEC_ERROR_CODES[number]

/** The parsed `exec/v1` response envelope. */
export interface ExecEnvelope<T> {
  /** Envelope code; `OK` marks success and any other value an error. */
  code: string
  /** Human-readable message; empty when the platform sends none. */
  msg: string
  /** Endpoint-specific payload. */
  data: T
  /** Platform request id, empty when the platform sends none. */
  requestId: string
  /** Platform time as an RFC 3339 string, empty when the platform sends none. */
  serverTime: string
}

/** Whether a value is a plain object indexable by key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one optional string field, mapping absent and blank values to `''`. */
function optionalString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Parse one response body into the envelope, keeping unknown fields out of the
 * result rather than failing on them.
 * @param payload - the decoded JSON body.
 * @returns the envelope with `data` typed by the caller.
 * @throws TypeError when the body is not an object or carries no string code.
 */
export function parseExecEnvelope<T>(payload: unknown): ExecEnvelope<T> {
  if (!isRecord(payload)) {
    throw new TypeError('exec envelope must be a JSON object')
  }
  const code = payload.code
  if (typeof code !== 'string' || code === '') {
    throw new TypeError('exec envelope must carry a non-empty string code')
  }
  return {
    code,
    msg: optionalString(payload, 'msg'),
    data: payload.data as T,
    requestId: optionalString(payload, 'requestId'),
    serverTime: optionalString(payload, 'serverTime'),
  }
}

/**
 * Whether a code reports that a submission had already reached its final state,
 * which the node treats as its own success.
 * @param code - the envelope code.
 * @returns whether the code is `ALREADY_FINAL`.
 */
export function isAlreadyFinal(code: string): boolean {
  return code === 'ALREADY_FINAL'
}
