/** Shell endpoint for the Host plugin browser control seam on the shared Host IPC. */

/**
 * JSON values that survive structured clone across the Host IPC channel. Kept
 * structurally identical to the Host-side declaration; the contract spec pins
 * both sides to the same wire shapes until the protocol moves to its permanent
 * shared home.
 */
export type ShellBrowserJson =
  | string | number | boolean | null
  | readonly ShellBrowserJson[]
  | { readonly [key: string]: ShellBrowserJson }

/** Reserve one agent lease in a workspace storage partition. */
export interface ShellBrowserAcquireRequest {
  readonly type: 'browser'
  readonly requestId: number
  readonly op: 'acquire'
  /** Workspace storage identity the lease belongs to; mirrors the sidebar browser lease key. */
  readonly workspaceKey: string
}

/** Execute one browser command against the leased guest. */
export interface ShellBrowserExecuteRequest {
  readonly type: 'browser'
  readonly requestId: number
  readonly op: 'execute'
  readonly leaseId: string
  /** Opaque at this seam: the shell owns the browser command vocabulary and validates it here. */
  readonly command: string
  readonly args: ShellBrowserJson
}

/** Release one agent lease and close its guest. */
export interface ShellBrowserReleaseRequest {
  readonly type: 'browser'
  readonly requestId: number
  readonly op: 'release'
  readonly leaseId: string
}

/** One plugin-initiated request to the shell. */
export type ShellBrowserRequest = ShellBrowserAcquireRequest | ShellBrowserExecuteRequest | ShellBrowserReleaseRequest

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
