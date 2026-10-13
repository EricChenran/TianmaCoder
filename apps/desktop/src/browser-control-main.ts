/** Shell endpoint for the Host plugin browser control seam on the shared Host IPC. */

import type {
  BrowserControlBounds,
  BrowserControlJson as ShellBrowserJson,
  BrowserControlRequest as ShellBrowserRequest,
} from '@deepseek-ai/dsh-host-browser-control'

export type { ShellBrowserJson, ShellBrowserRequest, BrowserControlBounds }

/** Reserve one agent lease in a workspace storage partition. */
export type ShellBrowserAcquireRequest = Extract<ShellBrowserRequest, { readonly op: 'acquire' }>

/** Execute one browser command against the leased guest. */
export type ShellBrowserExecuteRequest = Extract<ShellBrowserRequest, { readonly op: 'execute' }>

/** Release one agent lease and close its guest. */
export type ShellBrowserReleaseRequest = Extract<ShellBrowserRequest, { readonly op: 'release' }>

/**
 * Narrow a Host IPC message to a browser control request. The shell validates
 * with its own guard rather than trusting Host-side code: this boundary decides
 * which messages may reach guest handling.
 */
export function isShellBrowserControlRequest(message: unknown): message is ShellBrowserRequest {
  if (typeof message !== 'object' || message === null) return false
  const candidate = message as Record<string, unknown>
  if (candidate.type !== 'browser' || !Number.isSafeInteger(candidate.requestId)) return false
  switch (candidate.op) {
    case 'acquire': {
      if (typeof candidate.workspaceKey !== 'string' || candidate.workspaceKey.length === 0) return false
      const bounds = candidate.bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined
      if (bounds === undefined) return true
      return Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
        && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    }
    case 'execute':
      return typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0
        && typeof candidate.command === 'string' && candidate.command.length > 0
    case 'release':
      return typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0
    default:
      return false
  }
}

/** Handler that executes validated browser operations against the shell's guests. */
export interface ShellBrowserCommandHandler {
  /** Reserve one agent lease in the workspace storage partition. */
  acquire(request: ShellBrowserAcquireRequest): Promise<ShellBrowserJson>
  /** Execute one browser command against the leased guest. */
  execute(request: ShellBrowserExecuteRequest): Promise<ShellBrowserJson>
  /** Release one agent lease and close its guest. */
  release(request: ShellBrowserReleaseRequest): Promise<ShellBrowserJson>
}

/**
 * Placeholder handler for the seam before guest handling ships: every operation
 * fails loudly with a stable code instead of timing out on the Host side.
 */
export class UnsupportedShellBrowserHandler implements ShellBrowserCommandHandler {
  acquire(): Promise<never> { return Promise.reject(refuse()) }
  execute(): Promise<never> { return Promise.reject(refuse()) }
  release(): Promise<never> { return Promise.reject(refuse()) }
}

function refuse(): ShellBrowserControlError {
  return new ShellBrowserControlError('desktop browser control is not enabled on this shell', 'browser_unsupported')
}

/** Handler failure carrying the stable code the Host-side caller can branch on. */
export class ShellBrowserControlError extends Error {
  /** Stable failure family. */
  readonly code: string

  /**
   * @param message - Failure description for the Host-side caller.
   * @param code - Stable failure family.
   */
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/**
 * Routes validated Host browser requests to the command handler and answers the
 * Host with one correlated `browser-result`. Unknown messages are ignored so the
 * shared IPC channel stays forward compatible.
 */
export class ShellBrowserControlEndpoint {
  /**
   * @param send - Transport delivering one message object to the Host child.
   * @param handler - Handler executing validated operations.
   */
  constructor(private readonly send: (message: object) => void, private readonly handler: ShellBrowserCommandHandler) {}

  /**
   * Handle one Host IPC message.
   * @returns Whether the message belonged to this seam; `false` leaves other routing untouched.
   */
  handle(message: unknown): boolean {
    if (!isShellBrowserControlRequest(message)) return false
    void this.dispatch(message)
    return true
  }

  private async dispatch(request: ShellBrowserRequest): Promise<void> {
    try {
      const result = request.op === 'acquire'
        ? await this.handler.acquire(request)
        : request.op === 'execute'
          ? await this.handler.execute(request)
          : await this.handler.release(request)
      this.send({ type: 'browser-result', requestId: request.requestId, ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof ShellBrowserControlError ? error.code : undefined
      this.send({ type: 'browser-result', requestId: request.requestId, ok: false, error: message,
        ...(code === undefined ? {} : { code }) })
    }
  }
}
