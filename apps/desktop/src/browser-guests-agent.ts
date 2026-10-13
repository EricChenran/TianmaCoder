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

/** The slice of session history the history command drives (reload lives on WebContents). */
export interface AgentGuestHistory {
  goBack(): void
  goForward(): void
}

/** The slice of a captured page image the screenshot command uses. */
export interface AgentGuestCapture {
  isEmpty(): boolean
  toPNG(): Buffer
}

/** One navigable guest the service drives. */
export interface AgentGuestView {
  readonly webContents: Pick<WebContents, 'loadURL' | 'getURL' | 'getTitle' | 'close' | 'isDestroyed' | 'insertText' | 'sendInputEvent' | 'executeJavaScript' | 'reload'> & {
    /** Electron marks goBack/goForward on WebContents deprecated in favor of the history member. */
    readonly navigationHistory: AgentGuestHistory
    capturePage(): Promise<AgentGuestCapture>
  }
  /** Attach to the window with the requested on-screen rectangle (placeholder 1×1 when absent). */
  attach(window: AgentGuestHostWindow, bounds: BrowserControlBounds): void
  /** Detach from its window and close the underlying contents. */
  destroy(): void
}

/** Default deadline for one guest navigation. */
export const AGENT_NAVIGATE_TIMEOUT_MS = 10_000

/** Collects visible interactive elements with stable refs and viewport-center points. */
const SNAPSHOT_SCRIPT = `(() => {
  const nodes = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]'));
  const elements = [];
  for (const el of nodes) {
    if (elements.length >= 80) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (elements.length + 1);
    const name = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? (el.tagName === 'INPUT' ? el.getAttribute('value') : null) ?? undefined;
    const text = ((el.innerText ?? '') + '').slice(0, 80) || undefined;
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      name,
      text,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    });
  }
  return { url: location.href, title: document.title, elements };
})()`

/**
 * Shell-side command handler over main-owned guests. Leases reuse the sidebar
 * browser's per-workspace storage partition, so the agent operates with the same
 * login state the human browser holds; URL policy matches the human sidebar.
 */
export class AgentBrowserGuests implements ShellBrowserCommandHandler {
  readonly #leases = new Map<string, {
    readonly workspaceKey: string
    readonly view: AgentGuestView
    /** Element refs from the most recent snapshot, mapping ref id to viewport point. */
    readonly refs: Map<string, { x: number; y: number }>
  }>()

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
    this.#leases.set(leaseId, { workspaceKey: request.workspaceKey, view, refs: new Map() })
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
      case 'back': return this.history(view, 'goBack')
      case 'forward': return this.history(view, 'goForward')
      case 'reload': return this.history(view, 'reload')
      case 'select': return this.selectOption(view, request.args)
      case 'screenshot': return this.screenshot(view)
      case 'getState': return this.state(view)
      case 'type': return this.type(view, request.args)
      case 'fill': return this.fill(view, request.args)
      case 'check': return this.check(view, request.args)
      case 'press': return this.press(view, request.args)
      case 'scroll': return this.scroll(view, request.args)
      case 'click': return this.click(view, request.args, true, request.leaseId)
      case 'hover': return this.click(view, request.args, false, request.leaseId)
      case 'snapshot': return this.snapshot(view, request.leaseId)
      default:
        throw new ShellBrowserControlError(`desktop browser: command "${request.command}" is not implemented`, 'browser_unknown_command')
    }
  }

  /** Current page facts without navigating. */
  private state(view: AgentGuestView): ShellBrowserJson {
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
  }

  /** Walk session history or reload, reporting the page facts after issuing the action. */
  private history(view: AgentGuestView, action: 'goBack' | 'goForward' | 'reload'): ShellBrowserJson {
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    if (action === 'reload') {
      view.webContents.reload()
    } else {
      view.webContents.navigationHistory[action]()
    }
    return this.state(view)
  }

  /** Select one option of a dropdown by CSS selector and value or visible label. */
  private async selectOption(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    const value = typeof parsed.value === 'string' ? parsed.value : undefined
    const label = typeof parsed.label === 'string' ? parsed.label : undefined
    if (selector === undefined || selector.length === 0 || (value === undefined && label === undefined)) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: select requires a selector and value or label', 'browser_invalid_args'))
    }
    const result = await view.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return { found: false };
        const wanted = ${JSON.stringify(value)} ?? null;
        const wantedLabel = ${JSON.stringify(label)} ?? null;
        for (const option of el.options) {
          if ((wanted !== null && option.value === wanted) || (wantedLabel !== null && option.text === wantedLabel)) {
            el.value = option.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, value: el.value, label: option.text };
          }
        }
        return { found: true, matched: false };
      })()`,
    ) as { found: boolean; matched?: boolean; value?: string; label?: string }
    if (!result.found) {
      return Promise.reject(new ShellBrowserControlError(`desktop browser: element not found or not a select for ${JSON.stringify(selector)}`, 'browser_element_not_found'))
    }
    if (result.matched === false) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: no matching option', 'browser_option_not_found'))
    }
    return { selected: result.value ?? '', label: result.label ?? '' }
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

  /** Set one input/textarea value by selector, firing input and change events like a real edit. */
  private async fill(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    const text = typeof parsed.text === 'string' ? parsed.text : undefined
    if (selector === undefined || selector.length === 0 || text === undefined || text.length === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: fill requires a selector and text', 'browser_invalid_args'))
    }
    const result = await view.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: el.value };
      })()`,
    ) as { found: boolean; value?: string }
    if (!result.found) {
      return Promise.reject(new ShellBrowserControlError(`desktop browser: element not found for ${JSON.stringify(selector)}`, 'browser_element_not_found'))
    }
    return { filled: selector, value: result.value ?? '' }
  }

  /** Check (or report the checked state of) one checkbox/radio by selector, clicking with trusted input when needed. */
  private async check(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const selector = argsObject(args).selector
    if (typeof selector !== 'string' || selector.length === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: check requires a CSS selector', 'browser_invalid_args'))
    }
    const probed = await view.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center' });
        return { found: true, checked: el.checked === true };
      })()`,
    ) as { found: boolean; checked?: boolean }
    if (!probed.found) {
      return Promise.reject(new ShellBrowserControlError(`desktop browser: element not found for ${JSON.stringify(selector)}`, 'browser_element_not_found'))
    }
    if (probed.checked === true) return { checked: true, changed: false }
    await this.click(view, { selector }, true)
    const after = await view.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return { found: el !== null, checked: el !== null && el.checked === true }; })()`,
    ) as { found: boolean; checked?: boolean }
    return { checked: after.found && after.checked === true, changed: true }
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

  /** Enumerate interactive elements with stable refs and cache their points for ref-based actions. */
  private async snapshot(view: AgentGuestView, leaseId: string): Promise<ShellBrowserJson> {
    const probed = await view.webContents.executeJavaScript(SNAPSHOT_SCRIPT) as {
      url?: string
      title?: string
      elements?: Array<{ ref: string; x: number; y: number; tag: string; name?: string; text?: string }>
    }
    const elements = probed.elements ?? []
    const lease = this.#leases.get(leaseId)
    if (lease !== undefined) {
      lease.refs.clear()
      for (const element of elements) lease.refs.set(element.ref, { x: element.x, y: element.y })
    }
    return { url: probed.url ?? view.webContents.getURL(), title: probed.title ?? view.webContents.getTitle(), elements }
  }

  /** Resolve a ref (from the last snapshot) or a CSS selector to viewport coordinates, then hover or click with trusted input. */
  private async click(view: AgentGuestView, args: ShellBrowserJson, click: boolean, leaseId = ''): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    let point: { x: number; y: number }
    if (ref !== undefined) {
      const cached = this.#leases.get(leaseId)?.refs.get(ref)
      if (cached === undefined) {
        return Promise.reject(new ShellBrowserControlError(`desktop browser: ref ${JSON.stringify(ref)} is stale or unknown; run snapshot again`, 'browser_element_not_found'))
      }
      point = cached
    } else {
      if (selector === undefined || selector.length === 0) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: click requires a ref or CSS selector', 'browser_invalid_args'))
      }
      const probed = await view.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found: false };
          el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
          return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ) as { found: boolean; x?: number; y?: number }
      if (!probed.found || typeof probed.x !== 'number' || typeof probed.y !== 'number') {
        return Promise.reject(new ShellBrowserControlError(`desktop browser: element not found for ${JSON.stringify(selector)}`, 'browser_element_not_found'))
      }
      point = { x: Math.round(probed.x), y: Math.round(probed.y) }
    }
    view.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    if (click) {
      view.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      view.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }
    return Promise.resolve({ ...point, clicked: click })
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
