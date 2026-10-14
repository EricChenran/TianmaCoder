/** Main-owned browser guests driven by the Host browser control seam. */

import { WebContentsView, app, clipboard, type WebContents } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAriaInjectedScriptSource } from './aria-injected-script.ts'
import { AGENT_TAB_LIMIT, selectAgentTabVictim, type AgentTabResidencyCandidate } from './browser-tab-residency.ts'
import {
  AGENT_RECORD_FRAME_INTERVAL_MS, agentRecordingsDir, createCanvasRecorder, pruneRecordings,
  type AgentRecorderPort, type AgentRecordingResult,
} from './agent-recorder.ts'
import {
  downloadSummary, isDownloadRunning, type AgentDownloadRecord, type AgentDownloadWatcher,
} from './agent-downloads.ts'
import {
  DIALOG_ANSWER_METHOD, DIALOG_CLOSED_METHOD, DIALOG_OPENED_METHOD, dialogSummary, readDialogOpening,
  type AgentDialogEvent, type AgentDialogRecord,
} from './agent-dialogs.ts'
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

/** One attached surface: the rectangle the view occupies and the page scale inside it. */
export interface AgentGuestSurface {
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Page scale; the layout viewport is the rectangle divided by this factor. */
  readonly zoom: number
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
  readonly webContents: Pick<WebContents, 'loadURL' | 'getURL' | 'getTitle' | 'close' | 'isDestroyed' | 'insertText' | 'sendInputEvent' | 'reload' | 'copy' | 'paste' | 'isLoading' | 'isCurrentlyAudible'> & {
    /** Electron marks goBack/goForward on WebContents deprecated in favor of the history member. */
    readonly navigationHistory: AgentGuestHistory
    /** Runs one page script in the isolated world the page cannot observe or tamper with. */
    evaluateInIsolatedWorld(script: string): Promise<unknown>
    capturePage(): Promise<AgentGuestCapture>
  }
  /** Attach to the window with the requested on-screen rectangle (placeholder 1×1 when absent). */
  attach(window: AgentGuestHostWindow, bounds: BrowserControlBounds): void
  /**
   * Scale the page, so the layout viewport becomes the attached rectangle divided by
   * the factor. Absent when the carrier cannot zoom, which leaves the page at 1:1.
   * @param factor - page scale, at most 1.
   */
  setZoom?(factor: number): void
  /**
   * Page scale in force; input coordinates multiply by it, because a point read from
   * the page is a layout viewport coordinate. Absent means 1:1.
   * @returns The scale last applied by {@link setZoom}.
   */
  zoom?(): number
  /** Detach from its window and close the underlying contents. */
  destroy(): void
  /**
   * Follow the JavaScript dialogs this guest opens. Absent when the carrier cannot
   * observe them, so a tab without it simply never reports a dialog.
   * @param listener - receives each dialog while the page waits for an answer.
   * @returns unsubscribe callback.
   */
  watchDialogs?(listener: (event: AgentDialogEvent) => void): () => void
  /**
   * Follow this guest's renderer process. Absent when the carrier cannot observe it,
   * so a tab without it simply never reports a crash.
   * @param listener - receives each renderer death.
   * @returns unsubscribe callback.
   */
  watchCrashes?(listener: (event: AgentCrashEvent) => void): () => void
  /**
   * Follow whether this guest is playing media, which keeps it out of the victim set.
   * Absent when the carrier cannot observe the page's media state.
   * @param listener - receives the new state each time the page starts or pauses media.
   * @returns unsubscribe callback.
   */
  watchMedia?(listener: (active: boolean) => void): () => void
  /**
   * Answer one open dialog.
   * @param id - id the listener reported.
   * @param accept - whether to accept the dialog.
   * @param promptText - text a prompt should return instead of its default.
   * @returns Whether a waiting dialog was answered.
   */
  answerDialog?(id: string, accept: boolean, promptText?: string): Promise<boolean>
}

/** One dead renderer process, as the guest carrier reports it. */
export interface AgentCrashEvent {
  /** Electron's reason, such as `crashed`, `oom`, or `killed`. */
  readonly reason: string
  /** Process exit code, or 0 when Electron reports none. */
  readonly exitCode: number
  /** Page URL the guest had loaded when its renderer died. */
  readonly url: string
}

/** Reserved world id so the page's own isolated worlds never collide with ours. */
export const AGENT_ISOLATED_WORLD_ID = 999

/** One-paint settle before a screenshot so freshly delivered input is visible. */
export const SCREENSHOT_SETTLE_MS = 120

/** Empty captures a screenshot retries before reporting the failure. */
export const AGENT_CAPTURE_ATTEMPTS = 3

/** Default deadline for waiting on the lease's running downloads. */
export const AGENT_DOWNLOAD_WAIT_MS = 30_000

/** How often the download wait re-reads the lease's running downloads. */
export const AGENT_DOWNLOAD_POLL_MS = 100

/** Downloads tracked per lease before the oldest finished ones are dropped. */
export const AGENT_DOWNLOAD_MAX_RECORDS = 50

/** Default deadline for one guest navigation. */
export const AGENT_NAVIGATE_TIMEOUT_MS = 10_000

/** Smallest page viewport the viewport command accepts. */
export const AGENT_VIEWPORT_MIN = { width: 320, height: 320 }

/** Largest page viewport the viewport command accepts. */
export const AGENT_VIEWPORT_MAX = { width: 3840, height: 2160 }

/** Viewport the automation gets when it asks for one without dimensions. */
export const AGENT_VIEWPORT_DEFAULT = { width: 1280, height: 720 }

/** Collects visible interactive elements with stable refs, ARIA roles, and viewport-center points. */
const SNAPSHOT_SCRIPT = `(() => {
  const nodes = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]'));
  const implicitRole = (el) => {
    if (el.tagName === 'A' && el.hasAttribute('href')) return 'link';
    if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY') return 'button';
    if (el.tagName === 'SELECT') return 'combobox';
    if (el.tagName === 'TEXTAREA') return 'textbox';
    if (el.tagName === 'IMG') return 'img';
    if (/^H[1-6]$/.test(el.tagName)) return 'heading';
    if (el.tagName === 'INPUT') {
      return { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton' }[el.type] ?? 'textbox';
    }
    return null;
  };
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
      role: el.getAttribute('role') ?? implicitRole(el) ?? undefined,
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
/** One unsolicited fact about an agent lease, published for the Host and the window. */
export interface ShellBrowserGuestEvent {
  /** `browser-state` carries the tab list; `browser-activity` carries one command's in-flight state. */
  readonly name: 'browser-state' | 'browser-activity'
  readonly leaseId: string
  readonly payload: ShellBrowserJson
}

/** One element address captured by the last snapshot: its click point and the semantics read at capture time. */
interface AgentRef {
  readonly x: number
  readonly y: number
  readonly tag?: string
  readonly role?: string
  readonly name?: string
  readonly text?: string
}

/** One agent tab: its carrier, the ref cache, and the residency facts the limit reads. */
interface AgentTab {
  readonly view: AgentGuestView
  readonly refs: Map<string, AgentRef>
  readonly openedAt: number
  lastActivityAt: number
  lastSelectedAt: number | null
  /** A suspended tab keeps its logical slot and live guest but leaves the protected
   * set, so the residency limit may close it before a tab the human can see.
   */
  suspended: boolean
  operationActive: boolean
  captureActive: boolean
  /** True when this tab wraps a guest the window owns; the pool never closes that guest. */
  readonly claimed?: boolean
  /** True once the renderer process died and before the next command reloads the page. */
  crashed: boolean
  /** True while the page plays media, which keeps it out of the victim set. */
  mediaActive: boolean
  /** Ends this tab's subscriptions; absent when its carrier offers none. */
  readonly dispose?: () => void
}

/** One lease: a tab set with an active pointer, all sharing one workspace partition. */
interface GuestLease {
  readonly workspaceKey: string
  /** Session this lease belongs to; a pane presenting it must match. */
  readonly sessionKey?: string
  readonly tabs: Map<string, AgentTab>
  activeTabId: string
  bounds: { x: number; y: number; width: number; height: number }
  /** Pane rectangle the window last reported for this lease; absent means nothing is showing it. */
  pane?: { x: number; y: number; width: number; height: number }
  /** Page viewport size in force; the automation's request once it makes one. */
  viewport: { width: number; height: number }
  /**
   * True once the automation asked for a viewport. Only then does the request govern
   * the page's layout size; until then the surface a human sees decides it.
   */
  explicitViewport: boolean
  /** Page scale of the last attached surface; input coordinates scale by it. */
  zoom: number
  /** True once a usable pane presented this lease, so a later signal would fight a human close. */
  presentedOnce: boolean
  /** When this lease last asked its pane to open; bounds the retry rate. */
  revealAt: number
  /** Whether this lease placed its view on screen at acquire time. */
  readonly visible: boolean
  /** Virtual clipboard text held per lease so agent copy/paste never bleeds across sessions. */
  clipboard?: string
}

/** One running recording: its carrier, its frame pump, and the frames it has drawn. */
interface AgentRecording {
  readonly port: AgentRecorderPort
  readonly tab: AgentTab
  readonly startedAt: number
  readonly intervalMs: number
  timer?: ReturnType<typeof setInterval>
  frames: number
  pumping: boolean
  failure?: string
}

export class AgentBrowserGuests implements ShellBrowserCommandHandler {
  readonly #leases = new Map<string, GuestLease>()
  /** One in-flight capture per lease; a second request joins the running one instead of stacking. */
  readonly #captures = new Map<string, Promise<ShellBrowserJson>>()
  /** The running recording, when one exists; at most one per shell. */
  #recording: AgentRecording | undefined
  /** Last finished recording, so the model can report its path after stopping. */
  #lastRecording?: { path: string; bytes: number; frames: number; durationMs: number }
  /** Downloads observed per lease, oldest first. */
  readonly #downloads = new Map<string, AgentDownloadRecord[]>()
  /** Download subscriptions held per lease, released with it. */
  readonly #downloadWatchers = new Map<string, () => void>()
  /** Page dialogs this lease's tabs opened and have not answered yet. */
  readonly #dialogs = new Map<string, AgentDialogRecord[]>()
  /**
   * The latest pane rectangle each Session reported. A pane renders before the first
   * tool call creates its lease, so the report is held here and applied to the lease
   * that later claims the Session.
   */
  readonly #panes = new Map<string, { x: number; y: number; width: number; height: number }>()

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
    readonly ariaMaxChars?: number
    /** Receives lease state and activity facts for the Host seam and the window that presents them. */
    readonly emit?: (event: ShellBrowserGuestEvent) => void
    /** Read-only view of the guests the window opened, for listUserTabs and claim. */
    readonly humanTabs?: {
      readonly list: () => Array<{ tabId: string; url: string; title: string }>
      readonly guest: (tabId: string) => AgentClaimedWebContents | undefined
    }
    /** Recorder carrier; the default draws guest frames onto a canvas and encodes WebM. */
    readonly createRecorder?: () => AgentRecorderPort
    /** Directory finished recordings are written to; defaults under the application data directory. */
    readonly recordingsDir?: string
    /** Display scale factor captured pixels carry; defaults to one device-independent pixel per pixel. */
    readonly deviceScaleFactor?: () => number
    /** Source of guest download facts; absent means downloads are neither tracked nor protected. */
    readonly downloads?: AgentDownloadWatcher
    /** Asks the window to open this Session's pane; absent leaves the tab as the human left it. */
    readonly revealPane?: (sessionKey: string) => void
  }) {}

  /** @returns The scale factor captured pixels are measured in; one when the shell does not report one. */
  private scaleFactor(): number {
    const read = this.options.deviceScaleFactor
    const value = read === undefined ? 1 : read()
    return Number.isFinite(value) && value > 0 ? value : 1
  }

  /** Upper bound for one ARIA snapshot result, applied to the complete emitted value. */
  private ariaLimit(): number {
    return this.options.ariaMaxChars ?? 20_000
  }

  /** @returns The active tab of one lease: its navigation surface and ref cache. */
  tab(leaseId: string): AgentTab {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) throw new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown')
    const tab = lease.tabs.get(lease.activeTabId)
    if (tab === undefined) throw new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown')
    return tab
  }

  acquire(request: ShellBrowserAcquireRequest): Promise<ShellBrowserJson> {
    const leaseId = randomUUID()
    const tabId = randomUUID()
    const view = (this.options.createView ?? createWebContentsViewGuest)(this.options.partitionFor(request.workspaceKey))
    // A request without bounds leaves the guest off screen, not unsized: the page
    // still needs a viewport, and the parked surface uses it for captures.
    const bounds = request.bounds ?? { x: 0, y: 0, ...AGENT_VIEWPORT_DEFAULT }
    const now = Date.now()
    const lease: GuestLease = {
      workspaceKey: request.workspaceKey,
      ...(request.sessionKey === undefined ? {} : { sessionKey: request.sessionKey }),
      tabs: new Map([[tabId, this.newTab(leaseId, view, now)]]),
      activeTabId: tabId,
      bounds,
      viewport: { width: bounds.width, height: bounds.height },
      explicitViewport: false,
      zoom: 1,
      presentedOnce: false,
      revealAt: 0,
      visible: request.bounds !== undefined,
    }
    this.#leases.set(leaseId, lease)
    // A pane that already reported this Session presents the new lease immediately.
    const reported = request.sessionKey === undefined ? undefined : this.#panes.get(request.sessionKey)
    if (reported !== undefined) lease.pane = reported
    this.attachActive(lease)
    this.publishState(leaseId, lease)
    this.watchDownloads(leaseId, lease)
    // The human watches the pane the agent drives, and a guest nothing presents has no
    // usable surface, so the Session's pane is asked to open.
    this.requestReveal(lease)
    return Promise.resolve({ leaseId, tabId })
  }

  /**
   * Ask the Session's pane to open while nothing has presented this lease yet. The
   * first request is the acquisition's own; the retries cover a pane that could not
   * open at that moment — a collapsed column, another Session on screen, or a renderer
   * that reloaded — because an unopened pane leaves the guest without a usable surface.
   * Once a pane has presented the lease the human owns the tab, so no later request
   * reopens it after they close it.
   * @param lease - lease whose pane should show it.
   */
  private requestReveal(lease: GuestLease): void {
    const sessionKey = lease.sessionKey
    if (sessionKey === undefined || lease.presentedOnce) return
    const now = Date.now()
    if (now - lease.revealAt < AGENT_REVEAL_RETRY_MS) return
    lease.revealAt = now
    this.options.revealPane?.(sessionKey)
  }

  /**
   * Follow the downloads this lease's partition starts, so the model can report
   * them and the residency limit never closes a tab mid-download.
   */
  private watchDownloads(leaseId: string, lease: GuestLease): void {
    const watcher = this.options.downloads
    if (watcher === undefined) return
    const partition = this.options.partitionFor(lease.workspaceKey)
    this.#downloadWatchers.set(leaseId, watcher.watch(partition, (event) => {
      const current = this.#leases.get(leaseId)
      if (current === undefined) return
      const records = this.#downloads.get(leaseId) ?? []
      const existing = records.find(record => record.event.id === event.id)
      if (existing === undefined) records.push({ event, tabId: current.activeTabId, startedAt: Date.now() })
      else existing.event = event
      // Keep the newest records and drop the oldest finished ones first.
      while (records.length > AGENT_DOWNLOAD_MAX_RECORDS) {
        const settled = records.findIndex(record => !isDownloadRunning(record.event))
        if (settled === -1) break
        records.splice(settled, 1)
      }
      this.#downloads.set(leaseId, records)
    }))
  }

  /**
   * Bind a Sidebar pane to the lease acquired for one Session.
   * @param sessionKey - Session the pane reports; must equal the lease's acquire key.
   * @param pane - pane rectangle in window coordinates, or `null` to stop presenting.
   * @returns Whether a lease of that Session is present there now.
   */
  present(sessionKey: string, pane: { x: number; y: number; width: number; height: number } | null): boolean {
    if (pane === null) this.#panes.delete(sessionKey)
    else this.#panes.set(sessionKey, pane)
    return this.applyPane(sessionKey)
  }

  /**
   * Attach every lease of one Session at its current pane rectangle.
   * @param sessionKey - Session whose leases should present.
   * @returns Whether any lease belongs to that Session.
   */
  private applyPane(sessionKey: string): boolean {
    const pane = this.#panes.get(sessionKey)
    let matched = false
    for (const [leaseId, lease] of this.#leases) {
      if (lease.sessionKey !== sessionKey) continue
      if (pane === undefined) delete lease.pane
      else lease.pane = pane
      this.attachActive(lease)
      this.publishState(leaseId, lease)
      matched = true
    }
    return matched
  }

  /** @returns The rectangle the active tab attaches at: the reported pane, the configured watch rect, or offscreen. */
  private attachTarget(lease: GuestLease): { x: number; y: number; width: number; height: number } {
    return this.surfaceFor(lease).bounds
  }

  /**
   * Resolve the surface one lease attaches at, and the page scale inside it.
   *
   * A surface a human can see is the reference rectangle: the pane when one presents
   * the lease, otherwise the configured watch rectangle. The automation's requested
   * viewport then governs the *layout* size by scaling the page inside that rectangle,
   * because the page lays out in the view's size divided by its scale — so a viewport
   * narrower than the surface draws 1:1, and one wider is scaled down to fit rather
   * than clipped. Before the automation asks for a viewport the surface alone decides,
   * which keeps the human's pane the natural default.
   * @param lease - lease whose active tab is being attached.
   * @returns The rectangle and the scale to apply there.
   */
  private surfaceFor(lease: GuestLease): AgentGuestSurface {
    const pane = this.presentingPane(lease)
    const reference = pane ?? (lease.visible ? lease.bounds : undefined)
    if (reference === undefined) return { bounds: parkedSurface(), zoom: 1 }
    // A borrowed page the window owns is never scaled: its carrier has no zoom, so the
    // reference rectangle alone decides, exactly as it does without a requested viewport.
    const zoomable = lease.tabs.get(lease.activeTabId)?.view.setZoom !== undefined
    if (!lease.explicitViewport || !zoomable) return { bounds: reference, zoom: 1 }
    const zoom = viewportZoom(reference, lease.viewport)
    return { bounds: centeredSurface(reference, lease.viewport, zoom), zoom }
  }

  /**
   * A pane that measured no area is not a surface: the shell clamps such a report to a
   * single pixel, and a page laid out in one pixel answers no interaction. Every reader
   * of the pane — attachment, capture comparison, and the on-screen facts the Host and
   * the pane strip see — therefore agrees on the same test.
   * @returns The pane rectangle when it measured area, or undefined when nothing usable was reported.
   */
  private presentingPane(lease: GuestLease): { x: number; y: number; width: number; height: number } | undefined {
    const pane = lease.pane
    if (pane === undefined || pane.width < AGENT_PANE_MIN_SIDE || pane.height < AGENT_PANE_MIN_SIDE) return undefined
    return pane
  }

  /** Attach the active tab at its resolved surface when a window can host it. */
  private attachActive(lease: GuestLease): void {
    const window = this.options.getWindow()
    const active = lease.tabs.get(lease.activeTabId)
    if (window === undefined || window.isDestroyed() || active === undefined) return
    const surface = this.surfaceFor(lease)
    // A usable pane is the fact the reveal retry stops on: the human now owns the tab.
    if (this.presentingPane(lease) !== undefined) lease.presentedOnce = true
    lease.zoom = surface.zoom
    active.view.attach(window, surface.bounds)
    active.view.setZoom?.(surface.zoom)
  }

  /** Publish the tab list of one lease for the Host seam and the pane that presents it. */
  private publishState(leaseId: string, lease: GuestLease): void {
    this.options.emit?.({
      name: 'browser-state',
      leaseId,
      payload: {
        leaseId,
        sessionKey: lease.sessionKey ?? null,
        closed: false,
        activeTabId: lease.activeTabId,
        presented: this.presentingPane(lease) !== undefined,
        tabs: [...lease.tabs.entries()].map(([tabId, tab]) => ({
          tabId,
          url: tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL(),
          title: tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getTitle(),
          active: tabId === lease.activeTabId,
          suspended: tab.suspended,
          crashed: tab.crashed,
        })),
      },
    })
  }

  /** Publish one command's in-flight state so a pane can light up while the automation acts. */
  private publishActivity(leaseId: string, active: boolean, command?: string): void {
    const lease = this.#leases.get(leaseId)
    this.options.emit?.({
      name: 'browser-activity',
      leaseId,
      payload: {
        leaseId,
        sessionKey: lease?.sessionKey ?? null,
        active,
        ...(command === undefined ? {} : { command }),
      },
    })
  }

  async execute(request: ShellBrowserExecuteRequest): Promise<ShellBrowserJson> {
    const tab = this.tab(request.leaseId)
    // A dead renderer is brought back before the command runs, so no command ever
    // talks to a process that is gone. Listing tabs is exempt: it is how the model
    // learns the tab died, and it reads nothing from the renderer.
    if (tab.crashed && request.command !== 'tabs') this.recoverTab(tab)
    // A guest no pane presents has no usable surface, so every command keeps asking
    // its Session for one until a pane has shown this lease.
    this.requestReveal(this.lease(request.leaseId))
    tab.operationActive = true
    this.publishActivity(request.leaseId, true, request.command)
    try {
      const result = await this.dispatch(request, tab)
      tab.lastActivityAt = Date.now()
      return result
    } finally {
      tab.operationActive = false
      this.publishActivity(request.leaseId, false)
      const lease = this.#leases.get(request.leaseId)
      if (lease !== undefined) this.publishState(request.leaseId, lease)
    }
  }

  /**
   * Run one command on the lease a Session's pane is showing, for the pane's own
   * controls. The window drives the same commands the automation does, so its back,
   * forward, reload, and address controls need no second implementation.
   * @param sessionKey - Session whose pane asks; the lease was acquired for it.
   * @param command - command name, as the command handler dispatches it.
   * @param args - command arguments.
   * @returns The command result, or `undefined` when that Session holds no lease.
   */
  async commandForSession(sessionKey: string, command: string, args: ShellBrowserJson): Promise<ShellBrowserJson | undefined> {
    for (const [leaseId, lease] of this.#leases) {
      if (lease.sessionKey !== sessionKey) continue
      // The request id is correlation for the Host channel, which this local call does not use.
      return this.execute({ type: 'browser', requestId: 0, op: 'execute', leaseId, command, args })
    }
    return undefined
  }

  /** Run one command against the active tab's carrier. */
  private dispatch(request: ShellBrowserExecuteRequest, tab: AgentTab): Promise<ShellBrowserJson> | ShellBrowserJson {
    const { view, refs } = tab
    switch (request.command) {
      case 'navigate': return this.navigate(view, request.args)
      case 'back': return this.history(view, 'goBack')
      case 'forward': return this.history(view, 'goForward')
      case 'reload': return this.history(view, 'reload')
      case 'select': return this.selectOption(view, request.args)
      case 'screenshot': return this.screenshot(request.leaseId, tab)
      case 'getState': return this.state(view)
      case 'type': return this.type(view, request.args, refs)
      case 'fill': return this.fill(view, request.args)
      case 'check': return this.check(view, request.args)
      case 'press': return this.press(view, request.args)
      case 'scroll': return this.scroll(view, request.args)
      case 'cuaKeypress': return this.cuaKeypress(view, request.args, refs)
      case 'cuaScroll': return this.cuaScroll(view, request.args, refs)
      case 'cuaDrag': return this.cuaDrag(view, request.args, refs)
      case 'click': return this.click(view, request.args, true, refs)
      case 'hover': return this.click(view, request.args, false, refs)
      case 'snapshot': return this.snapshot(view, refs)
      case 'elementInfo': return this.elementInfo(view, request.args, refs)
      case 'aria': return this.ariaSnapshot(view)
      case 'viewport': return this.setViewport(request.leaseId, request.args)
      case 'wait': return this.waitFor(view, request.args)
      case 'copy': return this.copySelection(view, request.leaseId)
      case 'paste': return this.pasteClipboard(view, request.leaseId)
      case 'tabs': return this.tabsOp(request.leaseId, request.args)
      case 'record': return this.recordOp(request.leaseId, request.args)
      case 'downloads': return this.downloadsOp(request.leaseId, request.args)
      case 'dialog': return this.dialogOp(request.leaseId, request.args)
      default:
        throw new ShellBrowserControlError(`desktop browser: command "${request.command}" is not implemented`, 'browser_unknown_command')
    }
  }

  /** List, open, activate, close, suspend, or resume guest tabs; every other command runs on the active tab. */
  private async tabsOp(leaseId: string, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) throw new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown')
    const parsed = argsObject(args)
    const action = typeof parsed.action === 'string' ? parsed.action : undefined
    const tabId = typeof parsed.tabId === 'string' ? parsed.tabId : undefined
    const window = this.options.getWindow()
    const list = () => ({
      tabs: [...lease.tabs.entries()].map(([id, tab]) => ({
        tabId: id,
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
        active: id === lease.activeTabId,
        suspended: tab.suspended,
        crashed: tab.crashed,
      })),
      activeTabId: lease.activeTabId,
    })
    const known = tabId !== undefined && lease.tabs.has(tabId)
    if (action === 'list') return list()
    if (action === 'new') {
      const created = randomUUID()
      const view = (this.options.createView ?? createWebContentsViewGuest)(this.options.partitionFor(lease.workspaceKey))
      lease.tabs.set(created, this.newTab(leaseId, view, Date.now()))
      this.activateTab(lease, created, window)
      const evicted = this.enforceLimit(leaseId, lease)
      return { ...list(), tabId: created, ...(evicted.length === 0 ? {} : { evicted }) }
    }
    if (action === 'close') {
      if (!known) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: close requires a known tabId', 'browser_invalid_args'))
      }
      if (lease.tabs.size === 1) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: cannot close the last tab', 'browser_invalid_args'))
      }
      this.closeTab(lease, tabId)
      if (lease.activeTabId === tabId) {
        this.activateTab(lease, [...lease.tabs.keys()].at(-1) ?? '', window)
      }
      return { closed: tabId, ...list() }
    }
    if (action === 'activate') {
      if (!known) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: activate requires a known tabId', 'browser_invalid_args'))
      }
      this.activateTab(lease, tabId, window)
      return { ...list(), tabId }
    }
    if (action === 'suspend' || action === 'resume') {
      if (!known) {
        return Promise.reject(new ShellBrowserControlError(`desktop browser: ${action} requires a known tabId`, 'browser_invalid_args'))
      }
      if (action === 'suspend' && tabId === lease.activeTabId) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: cannot suspend the active tab', 'browser_invalid_args'))
      }
      const tab = lease.tabs.get(tabId)
      if (tab !== undefined) {
        tab.suspended = action === 'suspend'
        tab.lastActivityAt = Date.now()
      }
      return { ...list(), tabId, suspended: action === 'suspend' }
    }
    if (action === 'listUserTabs') {
      return { userTabs: this.options.humanTabs?.list() ?? [] }
    }
    if (action === 'claim') {
      const guest = tabId === undefined ? undefined : this.options.humanTabs?.guest(tabId)
      if (tabId === undefined || guest === undefined) {
        return Promise.reject(new ShellBrowserControlError(
          'desktop browser: claim requires a live tab the human opened', 'browser_element_not_found'))
      }
      const created = randomUUID()
      lease.tabs.set(created, this.newTab(leaseId, wrapClaimedGuest(guest), Date.now(), true))
      this.activateTab(lease, created, window)
      const evicted = this.enforceLimit(leaseId, lease)
      return { ...list(), tabId: created, claimed: tabId, ...(evicted.length === 0 ? {} : { evicted }) }
    }
    if (action === 'finalize') {
      if (!known) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: finalize requires a known tabId', 'browser_invalid_args'))
      }
      if (lease.tabs.size === 1) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: cannot finalize the last tab', 'browser_invalid_args'))
      }
      const finalized = lease.tabs.get(tabId)
      this.closeTab(lease, tabId)
      if (lease.activeTabId === tabId) {
        this.activateTab(lease, [...lease.tabs.keys()].at(-1) ?? '', window)
      }
      return { finalized: tabId, claimed: finalized?.claimed === true, ...list() }
    }
    return Promise.reject(new ShellBrowserControlError(
      'desktop browser: tabs requires action list/new/close/activate/suspend/resume/listUserTabs/claim/finalize', 'browser_invalid_args'))
  }

  /** @returns A fresh tab record with the residency clock started. */
  private newTab(leaseId: string, view: AgentGuestView, now: number, claimed = false): AgentTab {
    const disposers: Array<() => void> = []
    if (view.watchDialogs !== undefined) disposers.push(view.watchDialogs((event) => { this.recordDialog(leaseId, view, event) }))
    if (view.watchCrashes !== undefined) disposers.push(view.watchCrashes((event) => { this.recordCrash(leaseId, view, event) }))
    if (view.watchMedia !== undefined) disposers.push(view.watchMedia((active) => { this.recordMedia(leaseId, view, active) }))
    return {
      view, refs: new Map(), openedAt: now, lastActivityAt: now, lastSelectedAt: now,
      suspended: false, operationActive: false, captureActive: false, crashed: false, mediaActive: false,
      ...(claimed ? { claimed: true as const } : {}),
      ...(disposers.length === 0 ? {} : { dispose: () => { for (const dispose of disposers) dispose() } }),
    }
  }

  /** Remember one dialog this tab is waiting on, so the model can answer it. */
  private recordDialog(leaseId: string, view: AgentGuestView, event: AgentDialogEvent): void {
    const running = this.#dialogs.get(leaseId) ?? []
    running.push({ event, tabId: this.tabOfView(leaseId, view), openedAt: Date.now() })
    this.#dialogs.set(leaseId, running)
  }

  /** Remember whether one tab is playing media; the residency limit spares such a tab. */
  private recordMedia(leaseId: string, view: AgentGuestView, active: boolean): void {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) return
    for (const tab of lease.tabs.values()) {
      if (tab.view === view) tab.mediaActive = active
    }
  }

  /**
   * Mark one tab's renderer as dead and drop its ref cache, which described a page
   * that no longer exists. The next command reloads it, so a crash never leaves a
   * command talking to a dead process.
   */
  private recordCrash(leaseId: string, view: AgentGuestView, event: AgentCrashEvent): void {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) return
    for (const tab of lease.tabs.values()) {
      if (tab.view !== view) continue
      tab.crashed = true
      tab.refs.clear()
    }
    console.warn(`desktop agent browser: the renderer of one tab died (${event.reason}, code ${String(event.exitCode)}) at ${event.url}`)
    this.publishState(leaseId, lease)
  }

  /** @returns the tab id wrapping one view, or an empty string when it is already gone. */
  private tabOfView(leaseId: string, view: AgentGuestView): string {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) return ''
    for (const [tabId, tab] of lease.tabs) {
      if (tab.view === view) return tabId
    }
    return ''
  }

  /**
   * Reload a tab whose renderer died and clear the flags a dead process left behind.
   * @param tab - crashed tab to bring back.
   * @returns Whether the reload was requested.
   */
  private recoverTab(tab: AgentTab): boolean {
    tab.crashed = false
    tab.refs.clear()
    if (tab.view.webContents.isDestroyed()) return false
    try {
      tab.view.webContents.reload()
      return true
    } catch (error) {
      // A carrier that refuses the reload leaves the tab usable for nothing but closing.
      tab.crashed = true
      console.warn('desktop agent browser: could not reload a crashed tab', error)
      return false
    }
  }

  /** Detach one tab's carrier and drop its slot; a claimed guest belongs to the window and stays open. */
  private closeTab(lease: GuestLease, tabId: string): void {
    const closing = lease.tabs.get(tabId)
    lease.tabs.delete(tabId)
    closing?.dispose?.()
    if (closing !== undefined && closing.claimed !== true) closing.view.destroy()
  }

  /**
   * Close unprotected tabs until the lease is back within its residency limit.
   * @param leaseId - lease whose pool may exceed {@link AGENT_TAB_LIMIT}.
   * @param lease - the lease itself.
   * @returns The closed tab ids, in eviction order.
   */
  private enforceLimit(leaseId: string, lease: GuestLease): string[] {
    const evicted: string[] = []
    for (;;) {
      const victim = selectAgentTabVictim(this.residencyCandidates(leaseId, lease), AGENT_TAB_LIMIT)
      if (victim === null) return evicted
      this.closeTab(lease, victim.tabId)
      evicted.push(victim.tabId)
    }
  }

  /** @returns Every tab of one lease as residency facts for the limit policy. */
  private residencyCandidates(leaseId: string, lease: GuestLease): AgentTabResidencyCandidate[] {
    return [...lease.tabs.entries()].map(([tabId, tab]) => {
      const selected = tabId === lease.activeTabId
      return {
        tabId,
        residency: tab.suspended ? 'suspended' : selected && lease.visible ? 'live-visible' : 'live-background',
        guestAttached: !tab.view.webContents.isDestroyed(),
        openedAt: tab.openedAt,
        lastActivityAt: tab.lastActivityAt,
        lastSelectedAt: tab.lastSelectedAt,
        selected,
        visible: selected && lease.visible,
        operationActive: tab.operationActive,
        captureActive: tab.captureActive,
        downloadActive: this.downloadActive(leaseId, tabId),
        dialogPending: this.dialogPending(leaseId, tabId),
        loading: !tab.view.webContents.isDestroyed() && tab.view.webContents.isLoading(),
        audible: !tab.view.webContents.isDestroyed() && tab.view.webContents.isCurrentlyAudible(),
        mediaActive: tab.mediaActive,
      }
    })
  }

  /** @returns whether one tab is waiting on a page dialog the model has not answered. */
  private dialogPending(leaseId: string, tabId: string): boolean {
    const pending = this.#dialogs.get(leaseId)
    if (pending === undefined) return false
    return pending.some(record => record.tabId === tabId)
  }

  /** @returns whether one tab started a download that is still running. */
  private downloadActive(leaseId: string, tabId: string): boolean {
    const records = this.#downloads.get(leaseId)
    if (records === undefined) return false
    return records.some(record => record.tabId === tabId && isDownloadRunning(record.event))
  }

  /** Point the active pointer at one tab and swap the on-screen bounds between old and new. */
  private activateTab(
    lease: GuestLease,
    tabId: string,
    window: AgentGuestHostWindow | undefined,
  ): void {
    const previous = lease.tabs.get(lease.activeTabId)
    if (window !== undefined && !window.isDestroyed() && previous !== undefined && lease.activeTabId !== tabId) {
      previous.view.attach(window, parkedSurface())
    }
    lease.activeTabId = tabId
    const active = lease.tabs.get(tabId)
    if (active !== undefined) {
      active.suspended = false
      active.lastSelectedAt = Date.now()
      active.lastActivityAt = active.lastSelectedAt
    }
    this.attachActive(lease)
  }

  /**
   * Start, stop, or report the WebM recording of one lease's active tab. The
   * recorder draws captured guest frames onto its own canvas, so a hidden or
   * minimized window still records.
   * @param leaseId - lease whose active tab is recorded.
   * @param args - `action` plus an optional `frameIntervalMs`.
   * @returns Recording state, or the finished recording's path and byte count.
   */
  private async recordOp(leaseId: string, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const lease = this.lease(leaseId)
    const parsed = argsObject(args)
    const action = typeof parsed.action === 'string' ? parsed.action : undefined
    const running = this.#recording
    if (action === 'status') {
      return {
        recording: running !== undefined,
        frames: running?.frames ?? this.#lastRecording?.frames ?? 0,
        ...(running === undefined ? {} : { elapsedMs: Date.now() - running.startedAt }),
        ...(running?.failure === undefined ? {} : { failure: running.failure }),
        ...(this.#lastRecording === undefined ? {} : {
          path: this.#lastRecording.path, bytes: this.#lastRecording.bytes,
          durationMs: this.#lastRecording.durationMs,
        }),
      }
    }
    if (action === 'start') {
      if (running !== undefined) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: a recording is already running', 'browser_invalid_args'))
      }
      const tab = lease.tabs.get(lease.activeTabId)
      if (tab === undefined) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown'))
      }
      const requested = typeof parsed.frameIntervalMs === 'number' ? parsed.frameIntervalMs : AGENT_RECORD_FRAME_INTERVAL_MS
      const intervalMs = Math.min(Math.max(Math.round(requested), 40), 2_000)
      const port = (this.options.createRecorder ?? createCanvasRecorder)()
      await port.start(intervalMs)
      const recording: AgentRecording = { port, tab, startedAt: Date.now(), intervalMs, frames: 0, pumping: false }
      this.#recording = recording
      recording.timer = setInterval(() => { void this.pumpFrame(recording) }, intervalMs)
      recording.timer.unref()
      this.publishActivity(leaseId, true, 'record')
      return { recording: true, frameIntervalMs: intervalMs }
    }
    if (action === 'stop') {
      if (running === undefined) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: no recording is running', 'browser_invalid_args'))
      }
      this.#recording = undefined
      if (running.timer !== undefined) clearInterval(running.timer)
      const result = await running.port.stop()
      await running.port.dispose()
      this.publishActivity(leaseId, false)
      if (result === undefined) {
        const reason = running.failure === undefined ? '' : `: ${running.failure}`
        return Promise.reject(new ShellBrowserControlError(
          `desktop browser: the recorder produced no frames${reason}`, 'browser_empty_capture'))
      }
      const written = await this.writeRecording(result)
      this.#lastRecording = { ...written, frames: result.frames, durationMs: result.durationMs }
      return { path: written.path, bytes: written.bytes, frames: result.frames, durationMs: result.durationMs }
    }
    return Promise.reject(new ShellBrowserControlError('desktop browser: record requires action start/stop/status', 'browser_invalid_args'))
  }

  /** Draw one frame from the recorded tab, skipping a tick whose capture is already running. */
  private async pumpFrame(recording: AgentRecording): Promise<void> {
    if (this.#recording !== recording || recording.pumping) return
    recording.pumping = true
    try {
      const png = await this.captureFrame(recording.tab)
      if (png !== undefined && this.#recording === recording) {
        await recording.port.frame(png)
        recording.frames += 1
      }
    } catch (error) {
      recording.failure = error instanceof Error ? error.message : String(error)
    } finally {
      recording.pumping = false
    }
  }

  /** @returns PNG bytes of one tab, or `undefined` when the guest cannot be captured. */
  private async captureFrame(tab: AgentTab): Promise<Buffer | undefined> {
    if (tab.view.webContents.isDestroyed()) return undefined
    const image = await tab.view.webContents.capturePage()
    return image.isEmpty() ? undefined : image.toPNG()
  }

  /**
   * Write one finished recording and prune expired ones.
   * @param result - encoded WebM from the recorder.
   * @returns The written path and byte length.
   */
  private async writeRecording(result: AgentRecordingResult): Promise<{ path: string; bytes: number }> {
    const directory = this.options.recordingsDir ?? join(agentRecordingsDir(), 'agent-recordings')
    await mkdir(directory, { recursive: true })
    await pruneRecordings(directory, Date.now())
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(directory, `agent-browser-${stamp}.webm`)
    const bytes = Buffer.from(result.base64, 'base64')
    await writeFile(path, bytes)
    return { path, bytes: bytes.length }
  }

  /**
   * Report the lease's downloads, optionally waiting for the running ones.
   * @param leaseId - lease whose downloads are reported.
   * @param args - `action` (`list` or `wait`) and an optional `timeoutMs`.
   * @returns Every tracked download, oldest first, plus how many are still running.
   */
  private async downloadsOp(leaseId: string, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    this.lease(leaseId)
    const parsed = argsObject(args)
    const action = typeof parsed.action === 'string' ? parsed.action : 'list'
    if (action !== 'list' && action !== 'wait') {
      return Promise.reject(new ShellBrowserControlError('desktop browser: downloads requires action list or wait', 'browser_invalid_args'))
    }
    if (action === 'wait') {
      const requested = typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : AGENT_DOWNLOAD_WAIT_MS
      const timeoutMs = Math.min(Math.max(Math.round(requested), 100), 120_000)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && this.runningDownloads(leaseId).length > 0) {
        await new Promise((resolve) => { setTimeout(resolve, AGENT_DOWNLOAD_POLL_MS) })
      }
    }
    const records = this.#downloads.get(leaseId) ?? []
    return {
      downloads: records.map(record => ({ ...downloadSummary(record.event), tabId: record.tabId })),
      running: this.runningDownloads(leaseId).length,
    }
  }

  /** @returns the lease's downloads that are still running. */
  private runningDownloads(leaseId: string): AgentDownloadRecord[] {
    return (this.#downloads.get(leaseId) ?? []).filter(record => isDownloadRunning(record.event))
  }

  /**
   * List the page dialogs this lease is waiting on, or answer one so the page continues.
   * @param leaseId - lease whose dialogs are reported.
   * @param args - `action` (`list`, `accept`, or `dismiss`), an optional `id`, and an optional `promptText`.
   * @returns The pending dialogs, plus which one was answered when answering.
   */
  private async dialogOp(leaseId: string, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const lease = this.lease(leaseId)
    const parsed = argsObject(args)
    const action = typeof parsed.action === 'string' ? parsed.action : 'list'
    if (action !== 'list' && action !== 'accept' && action !== 'dismiss') {
      return Promise.reject(new ShellBrowserControlError('desktop browser: dialog requires action list/accept/dismiss', 'browser_invalid_args'))
    }
    const pending = this.#dialogs.get(leaseId) ?? []
    if (action === 'list') {
      return { dialogs: pending.map(dialogSummary), pending: pending.length }
    }
    // Answering without an id takes the oldest waiting dialog, which is the one blocking the page.
    const requested = typeof parsed.id === 'string' ? parsed.id : pending[0]?.event.id
    const record = requested === undefined ? undefined : pending.find(candidate => candidate.event.id === requested)
    if (record === undefined) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: no dialog is waiting for that id', 'browser_invalid_args'))
    }
    const tab = lease.tabs.get(record.tabId)
    const promptText = typeof parsed.promptText === 'string' ? parsed.promptText : undefined
    // A tab whose carrier has no dialog channel reports that it could not answer.
    const answered = tab === undefined
      ? false
      : await (tab.view.answerDialog?.(record.event.id, action === 'accept', promptText) ?? false)
    if (answered) {
      this.#dialogs.set(leaseId, pending.filter(candidate => candidate.event.id !== record.event.id))
    }
    return { ...dialogSummary(record), accepted: action === 'accept', answered }
  }

  /** Current page facts without navigating. */
  private state(view: AgentGuestView): ShellBrowserJson {
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
  }

  /** Poll the guest until one selector matches a visible element or the deadline passes. */
  private async waitFor(view: AgentGuestView, args: ShellBrowserJson): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    if (selector === undefined || selector.length === 0) {
      throw new ShellBrowserControlError('desktop browser: wait requires a CSS selector', 'browser_invalid_args')
    }
    const requested = typeof parsed.ms === 'number' ? parsed.ms : 5_000
    const deadline = Date.now() + Math.min(Math.max(requested, 0), 10_000)
    for (;;) {
      const probe = await view.webContents.evaluateInIsolatedWorld(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found: false };
          const r = el.getBoundingClientRect(); return { found: r.width >= 2 && r.height >= 2 }; })()`,
      ) as { found: boolean }
      if (probe.found) return { waited: true }
      if (Date.now() >= deadline) {
        throw new ShellBrowserControlError(`desktop browser: timed out waiting for ${JSON.stringify(selector)}`, 'browser_timeout')
      }
      await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
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
    const result = await view.webContents.evaluateInIsolatedWorld(
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

  /** Insert trusted text into the focused element, optionally focusing a ref or selector first with a trusted click. */
  private async type(view: AgentGuestView, args: ShellBrowserJson, refs: Map<string, AgentRef>): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const text = parsed.text
    if (typeof text !== 'string' || text.length === 0) {
      throw new ShellBrowserControlError('desktop browser: type requires a non-empty text', 'browser_invalid_args')
    }
    const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    if (ref !== undefined || selector !== undefined) {
      await this.click(view, { ...(ref === undefined ? {} : { ref }), ...(selector === undefined ? {} : { selector }) }, true, refs)
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
    const result = await view.webContents.evaluateInIsolatedWorld(
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
    const probed = await view.webContents.evaluateInIsolatedWorld(
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
    const after = await view.webContents.evaluateInIsolatedWorld(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return { found: el !== null, checked: el !== null && el.checked === true }; })()`,
    ) as { found: boolean; checked?: boolean }
    return { checked: after.found && after.checked === true, changed: true }
  }

  /**
   * Send one trusted key chord: the named modifiers stay held across a single raw
   * key down and up. This is the visual path for pages whose shortcuts the DOM
   * cannot be asked about.
   * @param view - active tab.
   * @param args - `key`, optional `modifiers`, and an optional `ref` or `selector` to focus first.
   * @param refs - ref cache written by the last snapshot.
   * @returns The chord that was delivered.
   */
  private async cuaKeypress(
    view: AgentGuestView,
    args: ShellBrowserJson,
    refs: Map<string, AgentRef>,
  ): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const key = typeof parsed.key === 'string' ? parsed.key : undefined
    if (key === undefined || key.length === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: cuaKeypress requires a key code', 'browser_invalid_args'))
    }
    const modifiers = readModifiers(parsed.modifiers)
    const focus = this.focusArgs(parsed)
    if (focus !== undefined) await this.click(view, focus, true, refs)
    for (const modifier of modifiers) view.webContents.sendInputEvent({ type: 'keyDown', keyCode: modifier })
    view.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: key, modifiers })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    for (const modifier of [...modifiers].reverse()) view.webContents.sendInputEvent({ type: 'keyUp', keyCode: modifier })
    return { pressed: key, modifiers }
  }

  /**
   * Scroll at one viewport point, for pages whose scroller is not the document.
   * @param view - active tab.
   * @param args - `deltaX`/`deltaY` plus an optional `x`/`y`, `ref`, or `selector`.
   * @param refs - ref cache written by the last snapshot.
   * @returns The deltas and the point they were delivered at.
   */
  private async cuaScroll(
    view: AgentGuestView,
    args: ShellBrowserJson,
    refs: Map<string, AgentRef>,
  ): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const deltaX = typeof parsed.deltaX === 'number' ? parsed.deltaX : 0
    const deltaY = typeof parsed.deltaY === 'number' ? parsed.deltaY : 0
    if (deltaX === 0 && deltaY === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: cuaScroll requires a non-zero delta', 'browser_invalid_args'))
    }
    const point = await this.resolvePoint(view, parsed, refs)
    if (point === undefined) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: cuaScroll needs x and y, a ref, or a selector', 'browser_invalid_args'))
    }
    view.webContents.sendInputEvent({ type: 'mouseWheel', ...scaledPoint(point, view.zoom?.() ?? 1), deltaX, deltaY })
    return { scrolled: { deltaX, deltaY }, x: point.x, y: point.y }
  }

  /**
   * Press at one point, move in trusted steps, and release at another: sliders,
   * drag-and-drop, and canvas surfaces that have no DOM to address.
   * @param view - active tab.
   * @param args - `from` and `to`, each `{x,y}` or a `ref`/`selector`; optional `steps`.
   * @param refs - ref cache written by the last snapshot.
   * @returns The points and the number of move steps between them.
   */
  private async cuaDrag(view: AgentGuestView, args: ShellBrowserJson, refs: Map<string, AgentRef>): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const from = await this.resolvePoint(view, readRecord(parsed.from), refs)
    const to = await this.resolvePoint(view, readRecord(parsed.to), refs)
    if (from === undefined || to === undefined) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: cuaDrag requires a resolvable from and to point', 'browser_element_not_found'))
    }
    const requested = typeof parsed.steps === 'number' ? parsed.steps : 8
    const steps = Math.min(Math.max(Math.round(requested), 1), 64)
    const zoom = view.zoom?.() ?? 1
    const start = scaledPoint(from, zoom)
    const end = scaledPoint(to, zoom)
    view.webContents.sendInputEvent({ type: 'mouseMove', ...start })
    view.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 })
    for (let step = 1; step <= steps; step += 1) {
      view.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(start.x + (end.x - start.x) * step / steps),
        y: Math.round(start.y + (end.y - start.y) * step / steps),
        button: 'left',
      })
    }
    view.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'left', clickCount: 1 })
    return { dragged: { from, to, steps } }
  }

  /** @returns The `ref`/`selector` pair a command used to focus an element, or `undefined` when it named none. */
  private focusArgs(parsed: Record<string, unknown>): ShellBrowserJson | undefined {
    const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    if (ref === undefined && selector === undefined) return undefined
    return { ...(ref === undefined ? {} : { ref }), ...(selector === undefined ? {} : { selector }) }
  }

  /**
   * Resolve one viewport point from explicit coordinates, a snapshot ref, or a CSS selector.
   * @param view - active tab.
   * @param source - object carrying `x`/`y`, `ref`, or `selector`.
   * @param refs - ref cache written by the last snapshot.
   * @returns The point, or `undefined` when the source names nothing resolvable.
   */
  private async resolvePoint(
    view: AgentGuestView,
    source: Record<string, unknown>,
    refs: Map<string, AgentRef>,
  ): Promise<{ x: number; y: number } | undefined> {
    if (typeof source.x === 'number' && typeof source.y === 'number') {
      return { x: Math.round(source.x), y: Math.round(source.y) }
    }
    const ref = typeof source.ref === 'string' ? source.ref : undefined
    if (ref !== undefined) {
      const cached = refs.get(ref)
      return cached === undefined ? undefined : { x: cached.x, y: cached.y }
    }
    const selector = typeof source.selector === 'string' ? source.selector : undefined
    if (selector === undefined || selector.length === 0) return undefined
    const probed = await view.webContents.evaluateInIsolatedWorld(elementProbeScript(selector, false)) as AgentProbeResult
    if (!probed.found || typeof probed.x !== 'number' || typeof probed.y !== 'number') return undefined
    return { x: Math.round(probed.x), y: Math.round(probed.y) }
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

  /**
   * Capture the active tab as PNG for durable model-visible attachment. Captures
   * serialize per lease through one in-flight slot, so a repeated request joins the
   * running capture rather than stacking another surface request.
   * @param leaseId - lease whose active tab is captured.
   * @param tab - active tab; carries the capture-in-flight residency fact.
   * @returns Base64 PNG, the page URL, and the calibrated pixel size.
   */
  private async screenshot(leaseId: string, tab: AgentTab): Promise<ShellBrowserJson> {
    const inFlight = this.#captures.get(leaseId)
    if (inFlight !== undefined) return inFlight
    // A capture needs a real surface, so a lease nothing is presenting gets its
    // guest parked at full viewport size before the capture runs.
    this.attachActive(this.lease(leaseId))
    const pending = this.captureOnce(this.lease(leaseId), tab).finally(() => { this.#captures.delete(leaseId) })
    this.#captures.set(leaseId, pending)
    return pending
  }

  /** Settle one paint, capture with bounded retries, and read the size from the PNG header. */
  private async captureOnce(lease: GuestLease, tab: AgentTab): Promise<ShellBrowserJson> {
    const { view } = tab
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    tab.captureActive = true
    try {
      for (let attempt = 1; ; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, SCREENSHOT_SETTLE_MS) })
        const image = await view.webContents.capturePage()
        if (!image.isEmpty()) {
          const png = image.toPNG()
          const size = pngSize(png)
          const scale = this.scaleFactor()
          // The attached rectangle is the surface the page really lays out in, so a
          // capture that matches it is exact even when the requested viewport differs.
          const surface = this.attachTarget(lease)
          return {
            base64: png.toString('base64'),
            mimeType: 'image/png',
            url: view.webContents.getURL(),
            scaleFactor: scale,
            ...(size === undefined ? {} : { width: size.width, height: size.height }),
            sizeCorrected: size !== undefined
              && (size.width !== Math.round(surface.width * scale)
                || size.height !== Math.round(surface.height * scale)),
          }
        }
        if (attempt >= AGENT_CAPTURE_ATTEMPTS) {
          throw new ShellBrowserControlError('desktop browser: captured an empty page image', 'browser_empty_capture')
        }
      }
    } finally {
      tab.captureActive = false
    }
  }

  /** Copy the page selection: trusted copy, then hold the text in the lease's virtual clipboard. */
  private async copySelection(view: AgentGuestView, leaseId: string): Promise<ShellBrowserJson> {
    const lease = this.lease(leaseId)
    view.webContents.copy()
    const text = await clipboard.readText()
    lease.clipboard = text
    return { copied: text.length }
  }

  /** Paste from the lease's virtual clipboard, falling back to the focused element's own paste. */
  private async pasteClipboard(view: AgentGuestView, leaseId: string): Promise<ShellBrowserJson> {
    const lease = this.lease(leaseId)
    if (lease.clipboard !== undefined) await clipboard.writeText(lease.clipboard)
    view.webContents.paste()
    return { pasted: lease.clipboard?.length ?? 0 }
  }

  /** @returns The lease record or throws the structured unknown-lease error. */
  private lease(leaseId: string): GuestLease {
    const lease = this.#leases.get(leaseId)
    if (lease === undefined) throw new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown')
    return lease
  }

  /** Produce the full-page ARIA snapshot through the Playwright injected runtime in the isolated world. */
  private async ariaSnapshot(view: AgentGuestView): Promise<ShellBrowserJson> {
    if (view.webContents.isDestroyed()) throw new ShellBrowserControlError('desktop browser: guest is closed', 'browser_guest_closed')
    const options = {
      browserName: 'chromium',
      customEngines: [],
      isUnderTest: false,
      sdkLanguage: 'javascript',
      stableRafCount: 1,
      testIdAttributeName: 'data-testid',
    }
    const expression = `(() => {
      globalThis.__dshAriaInjected ??= (() => {
        const module = {};
        ${getAriaInjectedScriptSource()}
        return new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)});
      })();
      const root = document.body || document.documentElement;
      if (!root) return { aria: '' };
      return { aria: globalThis.__dshAriaInjected.incrementalAriaSnapshot(root, { mode: 'ai' }).full };
    })()`
    const result = await view.webContents.evaluateInIsolatedWorld(expression) as { aria?: string }
    const full = result.aria ?? ''
    const limit = this.ariaLimit()
    return {
      aria: full.slice(0, limit),
      truncated: full.length > limit,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    }
  }

  /** Enumerate interactive elements with stable refs and cache their points for ref-based actions. */
  private async snapshot(view: AgentGuestView, refs: Map<string, AgentRef>): Promise<ShellBrowserJson> {
    const probed = await view.webContents.evaluateInIsolatedWorld(SNAPSHOT_SCRIPT) as {
      url?: string
      title?: string
      elements?: Array<{ ref: string; x: number; y: number; tag: string; role?: string; name?: string; text?: string }>
    }
    const elements = probed.elements ?? []
    refs.clear()
    for (const element of elements) {
      refs.set(element.ref, {
        x: element.x, y: element.y, tag: element.tag,
        ...(element.role === undefined ? {} : { role: element.role }),
        ...(element.name === undefined ? {} : { name: element.name }),
        ...(element.text === undefined ? {} : { text: element.text }),
      })
    }
    return { url: probed.url ?? view.webContents.getURL(), title: probed.title ?? view.webContents.getTitle(), elements }
  }

  /**
   * Describe one element by snapshot ref or CSS selector.
   * @param view - active tab.
   * @param args - `ref` (snapshot address) or `selector`.
   * @param refs - ref cache written by the last snapshot.
   * @returns The element's semantics as read at capture or probe time.
   */
  private async elementInfo(
    view: AgentGuestView,
    args: ShellBrowserJson,
    refs: Map<string, AgentRef>,
  ): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined
    if (ref !== undefined) {
      const cached = refs.get(ref)
      if (cached === undefined) {
        return Promise.reject(new ShellBrowserControlError(
          `desktop browser: ref ${JSON.stringify(ref)} is stale or unknown; run snapshot again`, 'browser_element_not_found'))
      }
      return { ref, source: 'snapshot', ...cached }
    }
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    if (selector === undefined || selector.length === 0) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: elementInfo requires a ref or CSS selector', 'browser_invalid_args'))
    }
    const probed = await view.webContents.evaluateInIsolatedWorld(
      elementProbeScript(selector, true),
    ) as AgentProbeResult
    if (!probed.found) {
      return Promise.reject(new ShellBrowserControlError(
        `desktop browser: element not found for ${JSON.stringify(selector)}${opaqueFrameNote(probed)}`, 'browser_element_not_found'))
    }
    return {
      selector, source: 'page', ...probed,
      ...(probed.frameDepth === undefined || probed.frameDepth === 0 ? {} : { insideFrame: true }),
    }
  }

  /**
   * Set the page viewport of one lease. Once a viewport is requested it governs the
   * page's layout size on every surface the lease attaches at; `follow` returns the
   * lease to the surface's own size, which is what the pane's control asks for.
   * @param leaseId - lease whose active tab is resized.
   * @param args - optional `width` and `height`, each defaulting to the viewport in force, or `follow`.
   * @returns The effective viewport, the scale it is drawn at, and whether the view is on screen.
   */
  private setViewport(leaseId: string, args: ShellBrowserJson): ShellBrowserJson {
    const lease = this.lease(leaseId)
    const parsed = argsObject(args)
    if (parsed.follow === true) lease.explicitViewport = false
    else {
      const width = viewportDimension(parsed.width, lease.viewport.width, AGENT_VIEWPORT_MIN.width, AGENT_VIEWPORT_MAX.width)
      const height = viewportDimension(parsed.height, lease.viewport.height, AGENT_VIEWPORT_MIN.height, AGENT_VIEWPORT_MAX.height)
      lease.viewport = { width, height }
      lease.explicitViewport = true
    }
    this.attachActive(lease)
    return {
      width: lease.viewport.width,
      height: lease.viewport.height,
      scale: lease.zoom,
      follow: !lease.explicitViewport,
      visible: this.presentingPane(lease) !== undefined || lease.visible,
    }
  }

  /** Resolve a ref (from the last snapshot) or a CSS selector to viewport coordinates, then hover or click with trusted input. */
  private async click(
    view: AgentGuestView,
    args: ShellBrowserJson,
    click: boolean,
    refs: Map<string, AgentRef> = new Map(),
  ): Promise<ShellBrowserJson> {
    const parsed = argsObject(args)
    const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined
    const selector = typeof parsed.selector === 'string' ? parsed.selector : undefined
    let point: { x: number; y: number }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      // Explicit coordinates reach content a selector cannot address, such as a
      // cross-origin frame or a canvas surface.
      point = { x: Math.round(parsed.x), y: Math.round(parsed.y) }
    } else if (ref !== undefined) {
      const cached = refs.get(ref)
      if (cached === undefined) {
        return Promise.reject(new ShellBrowserControlError(`desktop browser: ref ${JSON.stringify(ref)} is stale or unknown; run snapshot again`, 'browser_element_not_found'))
      }
      point = cached
    } else {
      if (selector === undefined || selector.length === 0) {
        return Promise.reject(new ShellBrowserControlError('desktop browser: click requires a ref, a CSS selector, or x and y', 'browser_invalid_args'))
      }
      const probed = await view.webContents.evaluateInIsolatedWorld(elementProbeScript(selector, false)) as AgentProbeResult
      if (!probed.found || typeof probed.x !== 'number' || typeof probed.y !== 'number') {
        return Promise.reject(new ShellBrowserControlError(
          `desktop browser: element not found for ${JSON.stringify(selector)}${opaqueFrameNote(probed)}`, 'browser_element_not_found'))
      }
      point = { x: Math.round(probed.x), y: Math.round(probed.y) }
    }
    const at = scaledPoint(point, view.zoom?.() ?? 1)
    view.webContents.sendInputEvent({ type: 'mouseMove', ...at })
    if (click) {
      view.webContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
      view.webContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    }
    return Promise.resolve({ x: point.x, y: point.y, clicked: click })
  }

  async release(request: { readonly leaseId: string }): Promise<ShellBrowserJson> {
    const lease = this.#leases.get(request.leaseId)
    if (lease === undefined) {
      return Promise.reject(new ShellBrowserControlError('desktop browser: lease is unknown', 'browser_lease_unknown'))
    }
    this.#leases.delete(request.leaseId)
    this.#downloadWatchers.get(request.leaseId)?.()
    this.#downloadWatchers.delete(request.leaseId)
    this.#downloads.delete(request.leaseId)
    this.#dialogs.delete(request.leaseId)
    // A recording of this lease ends with it; its partial file is discarded by the recorder.
    const running = this.#recording
    if (running !== undefined && [...lease.tabs.values()].includes(running.tab)) {
      this.#recording = undefined
      if (running.timer !== undefined) clearInterval(running.timer)
      await running.port.dispose()
    }
    for (const tab of lease.tabs.values()) {
      tab.dispose?.()
      if (tab.claimed !== true) tab.view.destroy()
    }
    this.options.emit?.({
      name: 'browser-state',
      leaseId: request.leaseId,
      payload: { leaseId: request.leaseId, closed: true, presented: false, tabs: [] },
    })
    return Promise.resolve(null)
  }
}

/**
 * The slice of a window-owned guest the pool may drive. Claiming borrows the page
 * the human already sees, so the pool never detaches or closes it.
 */
export interface AgentClaimedWebContents {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  insertText(text: string): Promise<void>
  copy(): void
  paste(): void
  isLoading(): boolean
  isCurrentlyAudible(): boolean
  sendInputEvent(event: Parameters<WebContents['sendInputEvent']>[0]): void
  reload(): void
  readonly navigationHistory: AgentGuestHistory
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>
  capturePage(): Promise<AgentGuestCapture>
}

/** @param web - the window's live guest. @returns A carrier the pool drives without owning it. */
function wrapClaimedGuest(web: AgentClaimedWebContents): AgentGuestView {
  return {
    webContents: {
      loadURL: (url: string) => web.loadURL(url),
      getURL: () => web.getURL(),
      getTitle: () => web.getTitle(),
      close: () => {},
      isDestroyed: () => web.isDestroyed(),
      insertText: (text: string) => web.insertText(text),
      copy: () => { web.copy() },
      paste: () => { web.paste() },
      sendInputEvent: (event: Parameters<WebContents['sendInputEvent']>[0]) => { web.sendInputEvent(event) },
      reload: () => { web.reload() },
      isLoading: () => web.isLoading(),
      isCurrentlyAudible: () => web.isCurrentlyAudible(),
      navigationHistory: web.navigationHistory,
      evaluateInIsolatedWorld: (script: string) =>
        web.executeJavaScriptInIsolatedWorld(AGENT_ISOLATED_WORLD_ID, [{ code: script }]),
      capturePage: () => web.capturePage(),
    },
    attach() {},
    destroy() {},
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
  /** Page scale this carrier last applied; input coordinates scale by it. */
  let appliedZoom = 1
  const web = view.webContents
  const crashListeners = new Set<(event: AgentCrashEvent) => void>()
  const onRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
    const crash: AgentCrashEvent = {
      reason: details.reason,
      exitCode: details.exitCode,
      url: web.isDestroyed() ? '' : web.getURL(),
    }
    for (const listener of [...crashListeners]) listener(crash)
  }
  /** Stop following this guest's renderer process and let it go. */
  const releaseCrashWatch = (): void => {
    crashListeners.clear()
    if (!web.isDestroyed()) web.removeListener('render-process-gone', onRenderProcessGone)
  }
  const mediaListeners = new Set<(active: boolean) => void>()
  const onMediaStarted = (): void => { for (const listener of [...mediaListeners]) listener(true) }
  const onMediaPaused = (): void => { for (const listener of [...mediaListeners]) listener(false) }
  /** Stop following this guest's media state and let it go. */
  const releaseMediaWatch = (): void => {
    mediaListeners.clear()
    if (web.isDestroyed()) return
    web.removeListener('media-started-playing', onMediaStarted)
    web.removeListener('media-paused', onMediaPaused)
  }
  /** Dialog state: our own id sequence, the dialogs the page still waits on, and the open one. */
  const dialogListeners = new Set<(event: AgentDialogEvent) => void>()
  const openDialogs = new Set<string>()
  let dialogSequence = 0
  let openDialogId: string | undefined
  const onDebuggerMessage = (_event: Electron.Event, method: string, params: unknown): void => {
    if (method === DIALOG_OPENED_METHOD) {
      dialogSequence += 1
      const dialog = readDialogOpening(params, `dialog-${String(dialogSequence)}`)
      if (dialog === undefined) return
      openDialogs.add(dialog.id)
      openDialogId = dialog.id
      for (const listener of [...dialogListeners]) listener(dialog)
      return
    }
    if (method === DIALOG_CLOSED_METHOD && openDialogId !== undefined) {
      openDialogs.delete(openDialogId)
      openDialogId = undefined
    }
  }
  /** @returns whether the debugger is attached and watching page dialogs. */
  const watchingDialogs = (): boolean => !web.isDestroyed() && web.debugger.isAttached()
  const releaseDebugger = (): void => {
    if (!watchingDialogs()) return
    web.debugger.removeListener('message', onDebuggerMessage)
    web.debugger.detach()
  }
  return {
    webContents: {
      loadURL: (url: string) => web.loadURL(url),
      getURL: () => web.getURL(),
      getTitle: () => web.getTitle(),
      close: () => { web.close() },
      isDestroyed: () => web.isDestroyed(),
      insertText: (text: string) => web.insertText(text),
      copy: () => { web.copy() },
      paste: () => { web.paste() },
      sendInputEvent: (event: Parameters<WebContents['sendInputEvent']>[0]) => { web.sendInputEvent(event) },
      reload: () => { web.reload() },
      isLoading: () => web.isLoading(),
      isCurrentlyAudible: () => web.isCurrentlyAudible(),
      navigationHistory: web.navigationHistory,
      evaluateInIsolatedWorld: (script: string) => web.executeJavaScriptInIsolatedWorld(AGENT_ISOLATED_WORLD_ID, [{ code: script }]),
      capturePage: () => web.capturePage(),
    },
    attach(target, bounds) {
      window = target
      window.contentView.addChildView(view)
      view.setBounds(bounds)
    },
    setZoom(factor) {
      appliedZoom = factor
      if (web.isDestroyed()) return
      web.setZoomFactor(factor)
    },
    // The requested factor is what input coordinates scale by; reading the page back
    // would report Chromium's own rounding instead of the surface the pool attached.
    zoom: () => appliedZoom,
    destroy() {
      releaseDebugger()
      releaseCrashWatch()
      releaseMediaWatch()
      if (window !== undefined && !window.isDestroyed()) window.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    },
    watchMedia(listener) {
      mediaListeners.add(listener)
      if (mediaListeners.size === 1 && !web.isDestroyed()) {
        web.on('media-started-playing', onMediaStarted)
        web.on('media-paused', onMediaPaused)
      }
      return () => {
        mediaListeners.delete(listener)
        if (mediaListeners.size === 0) releaseMediaWatch()
      }
    },
    watchCrashes(listener) {
      crashListeners.add(listener)
      if (crashListeners.size === 1 && !web.isDestroyed()) web.on('render-process-gone', onRenderProcessGone)
      return () => {
        crashListeners.delete(listener)
        if (crashListeners.size === 0 && !web.isDestroyed()) web.removeListener('render-process-gone', onRenderProcessGone)
      }
    },
    watchDialogs(listener) {
      if (!watchingDialogs()) {
        try {
          web.debugger.attach('1.3')
        } catch (error) {
          // An open DevTools window or another debugger owns this contents; the tab
          // keeps working without a dialog channel, which the operator should see.
          console.warn('desktop agent browser: page dialogs are not observed', error)
          return () => {}
        }
        web.debugger.on('message', onDebuggerMessage)
        void web.debugger.sendCommand('Page.enable')
      }
      dialogListeners.add(listener)
      return () => {
        dialogListeners.delete(listener)
        if (dialogListeners.size === 0) releaseDebugger()
      }
    },
    async answerDialog(id, accept, promptText) {
      if (!watchingDialogs() || !openDialogs.has(id)) return false
      await web.debugger.sendCommand(DIALOG_ANSWER_METHOD, {
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      })
      openDialogs.delete(id)
      if (openDialogId === id) openDialogId = undefined
      return true
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

/** Validate one optional viewport dimension against the inclusive safety bounds. */
function viewportDimension(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ShellBrowserControlError(
      `desktop browser: viewport dimension must be an integer between ${String(min)} and ${String(max)}`, 'browser_invalid_args')
  }
  return value
}

/**
 * Move one layout viewport point into the view coordinates input events carry.
 * @param point - point read from the page, in layout viewport coordinates.
 * @param zoom - page scale the view is attached with.
 * @returns The same point in view coordinates.
 */
function scaledPoint(point: { readonly x: number; readonly y: number }, zoom: number): { x: number; y: number } {
  return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
}

/** @returns The pixel size from a PNG IHDR chunk, or `undefined` when the bytes are not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return undefined
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Chord vocabulary the key tools accept, mapped to Electron's modifier names. */
const CHORD_MODIFIERS: Readonly<Record<string, 'control' | 'shift' | 'alt' | 'meta'>> = {
  ctrl: 'control', shift: 'shift', alt: 'alt', meta: 'meta',
}

/** @returns Electron modifier names in the order given, dropping anything the vocabulary does not name. */
function readModifiers(value: unknown): Array<'control' | 'shift' | 'alt' | 'meta'> {
  if (!Array.isArray(value)) return []
  const names: Array<'control' | 'shift' | 'alt' | 'meta'> = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const mapped = CHORD_MODIFIERS[entry]
    if (mapped !== undefined && !names.includes(mapped)) names.push(mapped)
  }
  return names
}

/** Frames the element probe descends into before giving up. */
const AGENT_FRAME_MAX_DEPTH = 4

/**
 * Rectangle that parks a guest nothing is showing: one pixel inside the window.
 * A view positioned outside the window is fully clipped, and Chromium then gives its
 * renderer a zero-sized viewport: the page gets no layout, no hit testing, and no
 * frames, so every command fails and captures come back empty. A parked guest
 * therefore keeps a real, if tiny, layout; the pane and watch rectangles give it the
 * surface interaction and capture need.
 * @returns The in-window parked rectangle.
 */
function parkedSurface(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: 1, height: 1 }
}

/** Smallest pane rectangle the guest may present in; a smaller report measured no area. */
const AGENT_PANE_MIN_SIDE = 2

/** Shortest interval between two pane-open requests for one lease. */
export const AGENT_REVEAL_RETRY_MS = 1000

/** Nothing is scaled below this factor; a narrower viewport than this would be unreadable. */
const AGENT_ZOOM_MIN = 0.1

/**
 * Page scale that makes a requested viewport fit one surface. The factor is capped at
 * 1, so a viewport the surface already fits draws at its own size instead of magnifying.
 * @param surface - rectangle the view occupies.
 * @param viewport - layout viewport the automation asked for.
 * @returns The scale to apply, between {@link AGENT_ZOOM_MIN} and 1.
 */
function viewportZoom(
  surface: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): number {
  const fit = Math.min(surface.width / viewport.width, surface.height / viewport.height, 1)
  return Math.max(Math.round(fit * 1000) / 1000, AGENT_ZOOM_MIN)
}

/**
 * Rectangle one scaled viewport occupies inside a surface, centred so the unused space
 * is split evenly. The view is never larger than the surface, so the page is whole
 * rather than clipped.
 * @param surface - rectangle the view may occupy.
 * @param viewport - layout viewport the automation asked for.
 * @param zoom - scale applied to the page.
 * @returns The centred rectangle, at least one pixel in each direction.
 */
function centeredSurface(
  surface: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  zoom: number,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(1, Math.min(surface.width, Math.round(viewport.width * zoom)))
  const height = Math.max(1, Math.min(surface.height, Math.round(viewport.height * zoom)))
  return {
    x: surface.x + Math.round((surface.width - width) / 2),
    y: surface.y + Math.round((surface.height - height) / 2),
    width,
    height,
  }
}

/** What {@link elementProbeScript} reports back. */
interface AgentProbeResult {
  found: boolean
  x?: number
  y?: number
  /** 0 for the top-level document, higher inside a nested frame. */
  frameDepth?: number
  /** Same-origin frames that could not be entered because the page is cross-origin. */
  opaqueFrames?: number
  [key: string]: unknown
}

/**
 * Build the isolated-world probe that finds one selector anywhere in the part of
 * the frame tree the page can reach. Same-origin frames are entered and their
 * offsets added, so the reported point is in top-level viewport coordinates; a
 * cross-origin frame is counted as opaque rather than silently skipped.
 * @param selector - CSS selector to find.
 * @param facts - whether to also read the element's facts (tag, role, text, box).
 * @returns A self-contained script evaluating to an {@link AgentProbeResult}.
 */
function elementProbeScript(selector: string, facts: boolean): string {
  return `(() => {
  const target = ${JSON.stringify(selector)};
  let opaque = 0;
  const walk = (doc, offsetX, offsetY, depth) => {
    if (doc === null || depth > ${String(AGENT_FRAME_MAX_DEPTH)}) return null;
    let el = null;
    try { el = doc.querySelector(target); } catch (error) { return null; }
    if (el !== null) {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const base = { found: true, x: r.x + r.width / 2 + offsetX, y: r.y + r.height / 2 + offsetY, frameDepth: depth };
      if (!${String(facts)}) return base;
      const style = doc.defaultView.getComputedStyle(el);
      return Object.assign(base, {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        name: el.getAttribute('aria-label') ?? el.getAttribute('name') ?? undefined,
        text: ((el.innerText ?? '') + '').slice(0, 200) || undefined,
        value: typeof el.value === 'string' ? el.value : undefined,
        checked: typeof el.checked === 'boolean' ? el.checked : undefined,
        disabled: el.disabled === true,
        visible: r.width >= 2 && r.height >= 2 && style.visibility !== 'hidden' && style.display !== 'none',
        box: { x: Math.round(r.x + offsetX), y: Math.round(r.y + offsetY), width: Math.round(r.width), height: Math.round(r.height) },
      });
    }
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      let child = null;
      try { child = frame.contentDocument; } catch (error) { child = null; }
      if (child === null) { opaque += 1; continue; }
      const fr = frame.getBoundingClientRect();
      const hit = walk(child, offsetX + fr.x, offsetY + fr.y, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  const hit = walk(document, 0, 0, 0);
  return hit !== null ? hit : { found: false, opaqueFrames: opaque };
})()`
}

/** @returns the clause naming the cross-origin frames a probe could not search. */
function opaqueFrameNote(probed: AgentProbeResult): string {
  const opaque = probed.opaqueFrames ?? 0
  return opaque === 0 ? '' : ` (${String(opaque)} cross-origin frame(s) were not searched)`
}

/** @returns The value as a plain record, or an empty record for anything that is not an object. */
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
