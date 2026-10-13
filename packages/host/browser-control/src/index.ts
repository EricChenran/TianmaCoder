/**
 * Wire contract shared by the Host browser control seam and the Electron shell:
 * request, result, and event shapes plus the narrow guards both sides compile against.
 * @module @deepseek-ai/dsh-host-browser-control
 */

/** JSON values that survive structured clone across the Host IPC channel. */
export type BrowserControlJson =
  | string | number | boolean | null
  | readonly BrowserControlJson[]
  | { readonly [key: string]: BrowserControlJson }

/** Operations the Electron shell executes against its embedded browser guests. */
export type BrowserControlOp = 'acquire' | 'execute' | 'release'

/**
 * One plugin-initiated request to the shell. `command` and `args` stay opaque at
 * this seam: the shell owns the browser command vocabulary and validates it there.
 */
export type BrowserControlRequest = {
  readonly type: 'browser'
  readonly requestId: number
  readonly op: 'acquire'
  /** Workspace storage identity the lease belongs to; mirrors the sidebar browser lease key. */
  readonly workspaceKey: string
} | {
  readonly type: 'browser'
  readonly requestId: number
  readonly op: 'execute'
  readonly leaseId: string
  readonly command: string
  readonly args: BrowserControlJson
} | {
  readonly type: 'browser'
  readonly requestId: number
  readonly op: 'release'
  readonly leaseId: string
}

/** Omit that distributes over a union so each operation keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Request shape without the wire envelope fields, one variant per operation. */
export type BrowserControlRequestInput = DistributiveOmit<BrowserControlRequest, 'type' | 'requestId'>

/** The shell's correlated answer to one {@link BrowserControlRequest}. */
export type BrowserControlResult = {
  readonly type: 'browser-result'
  readonly requestId: number
  readonly ok: true
  readonly result: BrowserControlJson
} | {
  readonly type: 'browser-result'
  readonly requestId: number
  readonly ok: false
  readonly error: string
  /** Stable failure family (for example `browser_unsupported`) the caller can branch on. */
  readonly code?: string
}

/** Unsolicited shell fact about a leased guest (crash, user-driven close). */
export interface BrowserControlEvent {
  readonly type: 'browser-event'
  readonly name: string
  readonly leaseId?: string
  readonly payload: BrowserControlJson
}

/** Every message the shell sends to the Host over this seam. */
export type BrowserControlMessage = BrowserControlResult | BrowserControlEvent

/** Narrow a Host IPC message to the browser control seam. */
export function isBrowserControlRequest(message: unknown): message is BrowserControlRequest {
  if (typeof message !== 'object' || message === null) return false
  const candidate = message as Record<string, unknown>
  if (candidate.type !== 'browser' || !Number.isSafeInteger(candidate.requestId)) return false
  switch (candidate.op) {
    case 'acquire':
      return typeof candidate.workspaceKey === 'string' && candidate.workspaceKey.length > 0
    case 'execute':
      return typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0
        && typeof candidate.command === 'string' && candidate.command.length > 0
    case 'release':
      return typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0
    default:
      return false
  }
}

/** Narrow a Host IPC message to a shell-originated answer or event on this seam. */
export function isBrowserControlMessage(message: unknown): message is BrowserControlMessage {
  if (typeof message !== 'object' || message === null) return false
  const candidate = message as Record<string, unknown>
  if (candidate.type === 'browser-result') {
    if (!Number.isSafeInteger(candidate.requestId) || typeof candidate.ok !== 'boolean') return false
    if (candidate.ok) return true
    return typeof candidate.error === 'string' && (candidate.code === undefined || typeof candidate.code === 'string')
  }
  if (candidate.type === 'browser-event') {
    return typeof candidate.name === 'string' && candidate.name.length > 0
      && (candidate.leaseId === undefined || typeof candidate.leaseId === 'string')
  }
  return false
}

/** Default deadline for one browser control round trip. */
export const BROWSER_CONTROL_TIMEOUT_MS = 10_000

/**
 * Plugin-facing client for the shell's embedded browser. Requests serialize per
 * client; the shell owns ordering, guest lifetime, and the command vocabulary.
 */
export interface DesktopBrowserControl {
  /** Send one request and await the shell's correlated answer; rejects on deadline, abort, or `ok: false`. */
  request<T extends BrowserControlJson>(request: BrowserControlRequestInput, options?: {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }): Promise<T>
  /** Subscribe to unsolicited shell events; the disposer removes this listener. */
  onEvent(listener: (event: BrowserControlEvent) => void): () => void
}

/** Failure reported by the shell with a stable code the caller can branch on. */
export class BrowserControlError extends Error {
  /** Stable failure family from the shell; `undefined` when the shell did not classify the failure. */
  readonly code: string | undefined

  /**
   * @param message - Shell-provided failure description.
   * @param code - Stable failure family, when the shell classified the failure.
   */
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}
