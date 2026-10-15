/**
 * Log redaction: the protocol requires the node to strip secret values before a
 * log batch leaves the host, and the platform scans again on arrival. The
 * patterns here cover the credential names the protocol names, in assignment and
 * bearer form, including the JSON form a quoted report line uses.
 * @module @tianma/dsh-mps-exec-core/redact
 */

/** What replaces a secret value. */
export const REDACTION_PLACEHOLDER = '[REDACTED]'

const SECRET_KEY = 'token|password|secret|api[_-]?key|private[_-]?key'

/**
 * `key = value` with the key's own quoting preserved. Four kinds of name carry
 * a secret: the credential words themselves, and any longer identifier that
 * contains one, such as `access_token` or `client_secret`.
 */
const ASSIGNMENT = new RegExp(
  String.raw`(["']?)((?:[A-Za-z0-9_.-]*(?:${SECRET_KEY})[A-Za-z0-9_.-]*))\1(\s*[:=]\s*)(["']?)([^\s"',;&]+)\4`,
  'gi',
)

/** `Bearer <credential>`, the form an authorization header prints in. */
const BEARER = new RegExp(String.raw`(\bBearer\s+)\S+`, 'gi')

/**
 * Replace every secret value in one line, keeping the key and the quoting so the
 * redacted line still reads as the line it was.
 * @param text - one log line or message.
 * @returns the line with secret values replaced.
 */
export function redactSecretText(text: string): string {
  return text
    .replace(ASSIGNMENT, `$1$2$1$3$4${REDACTION_PLACEHOLDER}$4`)
    .replace(BEARER, `$1${REDACTION_PLACEHOLDER}`)
}

/**
 * Redact a batch of lines before it is submitted.
 * @param lines - the log lines.
 * @returns the redacted lines, in order.
 */
export function redactSecretLines(lines: readonly string[]): string[] {
  return lines.map(line => redactSecretText(line))
}

/**
 * Whether a line still carries a secret-shaped assignment. The node uses this to
 * assert its own redaction, and to flag a line that arrived unredacted.
 * @param text - one log line or message.
 * @returns whether any secret assignment or bearer credential remains.
 */
export function containsSecretPattern(text: string): boolean {
  ASSIGNMENT.lastIndex = 0
  BEARER.lastIndex = 0
  return ASSIGNMENT.test(text) || BEARER.test(text)
}
