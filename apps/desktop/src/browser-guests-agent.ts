/** Main-owned browser guests driven by the Host browser control seam. */

import { WebContentsView, app, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { BrowserControlBounds } from './browser-control-main.ts'
import type { ShellBrowserAcquireRequest, ShellBrowserExecuteRequest, ShellBrowserJson } from './browser-control-main.ts'
import { ShellBrowserControlError, type ShellBrowserCommandHandler } from './browser-control-main.ts'

/** The slice of an Electron window the carrier needs to host one guest view. */
export interface AgentGuestHostWindow {
  readonly contentView: {
    addChildView(view: AgentGuestElectronView): void
    removeChildView(view: AgentGuestElectronView): void
  }
  isDestroyed(): boolean
}

/** The slice of a compositor-attachable view the carrier needs. */
export interface AgentGuestElectronView {
  setBounds(bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void
}

/** The slice of a captured page image the screenshot command uses. */
export interface AgentGuestCapture {
  isEmpty(): boolean
  toPNG(): Buffer
}

/** One navigable guest the service drives. */
export interface AgentGuestView {
  readonly webContents: Pick<WebContents, 'loadURL' | 'getURL' | 'getTitle' | 'close' | 'isDestroyed' | 'insertText' | 'sendInputEvent'> & {
    capturePage(): Promise<AgentGuestCapture>
  }
  /** Attach to the window with the requested on-screen rectangle (placeholder 1×1 when absent). */
  attach(window: AgentGuestHostWindow, bounds: BrowserControlBounds): void
  /** Detach from its window and close the underlying contents. */
  destroy(): void
}

/** Default deadline for one guest navigation. */
export const AGENT_NAVIGATE_TIMEOUT_MS = 10_000

/**
 * Shell-side command handler over main-owned guests. Leases reuse the sidebar
 * browser's per-workspace storage partition, so the agent operates with the same
 * login state the human browser holds; URL policy matches the human sidebar.
 */
export class AgentBrowserGuests implements ShellBrowserCommandHandler {
  readonly #leases = new Map<string, { readonly workspaceKey: string; readonly view: AgentGuestView }>()

  /**
   * @param options - Collaborators: the application-host URL guard, the primary
   *   window accessor, workspace partition resolution, and an optional view
   *   factory for tests. Guests attach with placeholder bounds until the
   *   sidebar-integrated carrier replaces this one.
   */
  constructor(private readonly options: {
    readonly hostUrl: () => string | undefined
    readonly getWindow: () => AgentGuestHostWindow | undefined
    readonly partitionFor: (workspaceKey: string) => string
    readonly createView?: (partition: string) => AgentGuestView
    readonly navigateTimeoutMs?: number
  }) {}

  /** @returns The guest navigation surface for one request. */
  guest(leaseId: string): AgentGuestView {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) throw new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown')
    return lease.view
  }

  acquire(request: ShellBrowserAcquireRequest): Promise<ShellBrowserJson> {
    const leaseId = randomUUID()
    const view = (this.options.createView ?? createWebContentsViewGuest)(this.options.partitionFor(request.workspaceKey))
    this.#leases.set(leaseId, { workspaceKey: request.workspaceKey, view })
    const window = this.options.getWindow()
    if (window !== undefined && !window.isDestroyed()) {
      view.attach(window, request.bounds ?? { x: 0, y: 0, width: 1, height: 1 })
    }
    return Promise.resolve({ leaseId })
  }

  async execute(request: ShellBrowserExecuteRequest): Promise<ShellBrowserJson> {
    const view = this.guest(request.leaseId)
    switch (request.command) {
      case 'navigate': return this.navigate(view, request.args)
      case 'screenshot': return this.screenshot(view)
      case 'getState': return this.state(view)
      case 'type': return this.type(view, request.args)
      case 'press': return this.press(view, request.args)
      case 'scroll': return this.scroll(view, request.args)
      default:
        throw new ShellBrowserControlError(`desktop browser: command "${request.command}" is not implemented`, 'browser_unknown_command')
    }
  }

  /** Current page facts without navigating. */
  private state(view: AgentGuestView): ShellBrowserJson {
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
  }

  /** Insert trusted text into the focused element of the guest page. */
  private async type(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const text = argsObject(args).text
    if (typeof text !== 'string' || text.length === 0) {
      throw new ShellBrowserControlError('desktop browser: type requires a non-empty text', 'browser_invalid_args')
    }
    await view.webContents.insertText(text)
    return { typed: text.length }
  }

  /** Send one trusted key press (rawKeyDown + keyUp) with the given key code. */
  private press(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const key = argsObject(args).key
    if (typeof key !== 'string' || key.length === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: press requires a key code', 'browser_invalid_args'))
    }
    view.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: key })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    return Promise.resolve({ pressed: key })
  }

  /** Scroll the guest page by the given deltas around the viewport center. */
  private scroll(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const deltaX = typeof parsed.deltaX === 'number' ? parsed.deltaX : 0
    const deltaY = typeof parsed.deltaY === 'number' ? parsed.deltaY : 0
    if (deltaX === 0 && deltaY === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: scroll requires a non-zero delta', 'browser_invalid_args'))
    }
    view.webContents.sendInputEvent({ type: 'mouseWheel', x: 40, y: 40, deltaX, deltaY })
    return Promise.resolve({ scrolled: { deltaX, deltaY } })
  }

  /** Navigate to one allowlisted URL and report the settled page facts. */
  private async navigate(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const url = requestArgsUrl(args)
    if (url === undefined || !isAgentNavigableUrl(url, this.options.hostUrl())) {
      throw new ShellBrowserControlError('desktop browser: navigation target is not allowed', 'browser_url_rejected')
    }
    const timeoutMs = this.options.navigateTimeoutMs ?? AGENT_NAVIGATE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        view.webContents.loadURL(url),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ShellBrowserControlError('desktop browser: navigation timed out', 'browser_timeout'))
          }, timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest closed during navigation', 'browser_guest_closed')
    return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
  }

  /** Capture the guest page as PNG for durable model-visible attachment. */
  private async screenshot(view: AgentGuestView): Promise<ShellBrowserJson> {
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    const image = await view.webContents.capturePage()
    if (image.isEmpty()) throw new ShellBrowserControlError('desktop browser: captured an empty page image', 'browser_empty_capture')
    return { base64: image.toPNG().toString('base64'), mimeType: 'image/png', url: view.webContents.getURL() }
  }

  release(request: { readonly leaseId: string }): Promise<ShellBrowserJson> {
    const lease = this.#leases.get(request.leaseId)
    if (lease === undefined) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown'))
    }
    this.#leases.delete(request.leaseId)
    lease.view.destroy()
    return Promise.resolve(null)
  }
}

/** Production carrier: one hardened offscreen `WebContentsView` per guest. */
export function createWebContentsViewGuest(partition: string): AgentGuestView {
  const view = new WebContentsView({
    webPreferences: {
      partition, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, plugins: false, navigateOnDragDrop: false, backgroundThrottling: false,
      devTools: !app.isPackaged,
    },
  })
  let window: AgentGuestHostWindow | undefined
  return {
    webContents: view.webContents,
    attach(target, bounds) {
      window = target
      window.contentView.addChildView(view)
      view.setBounds(bounds)
    },
    destroy() {
      if (window !== undefined && !window.isDestroyed()) window.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    },
  }
}

/** Navigation policy for agent guests; mirrors the human sidebar allowlist. */
export function isAgentNavigableUrl(value: string, hostUrl: string | undefined): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
    && !isApplicationHost(url, hostUrl)
}

function isApplicationHost(url: URL, hostUrl: string | undefined): boolean {
  if (hostUrl === undefined) return false
  const host = new URL(hostUrl)
  return url.port === host.port
    && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
}

function requestArgsUrl(args: ShellBrowserJson): string | undefined {
  const url = argsObject(args).url
  return typeof url === 'string' ? url : undefined
}

function argsObject(args: ShellBrowserJson): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  return args as Record<string, unknown>
}
