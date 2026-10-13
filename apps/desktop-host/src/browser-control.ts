/** Browser control seam between Host plugins and the Electron shell, carried on the shared Host IPC. */

import type { Context } from '@deepseek-ai/cordis'

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

/** Omit that distributes over a union so each operation keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Request shape without the wire envelope fields, one variant per operation. */
export type BrowserControlRequestInput = DistributiveOmit<BrowserControlRequest, 'type' | 'requestId'>

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

/**
 * Register the browser control client on the owning Host context and route shell answers to it.
 * @param ctx - Booted Desktop profile context; disposal rejects in-flight and future requests.
 * @param send - Transport that delivers one message object to the Electron shell.
 * @returns Router for `browser-result` and `browser-event` messages arriving from the shell;
 *   `false` means the message was not a browser control message.
 */
export function installDesktopBrowserControl(ctx: Context, send: (message: object) => Promise<void>): (message: unknown) => boolean {
  let stopped = false
  let nextRequestId = 1
  const pending = new Map<number, {
    resolve: (result: BrowserControlJson) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout> | undefined
  }>()
  const listeners = new Set<(event: BrowserControlEvent) => void>()
  ctx.effect(() => () => {
    stopped = true
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer)
      request.reject(new Error('desktop browser: Host is stopping'))
    }
    pending.clear()
    listeners.clear()
  })
  declareDesktopBrowserControl(ctx, {
    async request<T extends BrowserControlJson>(request: BrowserControlRequestInput,
      options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<T> {
      const deadlineMs = options.timeoutMs ?? BROWSER_CONTROL_TIMEOUT_MS
      if (stopped) throw new Error('desktop browser: Host is stopping')
      options.signal?.throwIfAborted()
      const requestId = nextRequestId++
      const answer = await new Promise<BrowserControlJson>((resolve, reject) => {
        const abort = (): void => { reject(new Error('desktop browser: request aborted')) }
        const entry = {
          resolve: (result: BrowserControlJson) => { resolve(result) },
          reject: (error: Error) => { reject(error) },
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
        }
        pending.set(requestId, entry)
        const timer = setTimeout(() => { reject(new Error('desktop browser: shell did not answer in time')) }, deadlineMs)
        entry.timer = timer
        options.signal?.addEventListener('abort', abort, { once: true })
        void send({ type: 'browser', requestId, ...request }).catch((error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      }).finally(() => {
        const entry = pending.get(requestId)
        if (entry?.timer !== undefined) clearTimeout(entry.timer)
        pending.delete(requestId)
      })
      return answer as T
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return (message: unknown): boolean => {
    if (!isBrowserControlMessage(message)) return false
    if (message.type === 'browser-event') {
      for (const listener of listeners) {
        try { listener(message) } catch (error) { console.error('desktop browser: event listener failed', error) }
      }
      return true
    }
    const request = pending.get(message.requestId)
    if (request === undefined) return true
    if (message.ok) request.resolve(message.result)
    else request.reject(new BrowserControlError(message.error, message.code))
    return true
  }
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

/** Service key under which the client is exposed to Host plugins. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopBrowserControl: DesktopBrowserControl
  }
}

function declareDesktopBrowserControl(ctx: Context, client: DesktopBrowserControl): void {
  ctx.provide('desktopBrowserControl', client)
}
