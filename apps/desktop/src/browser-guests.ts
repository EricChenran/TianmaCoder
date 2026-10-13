/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** One live guest a window opened, as the agent browser's unified tab pool reads it. */
export interface DesktopBrowserUserTab {
  readonly leaseId: DesktopBrowserLeaseId
  readonly url: string
  readonly title: string
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    const partition = this.partitionFor(workspace)
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /**
   * Storage partition for one workspace identity, created and hardened on first
   * use. Agent-driven guests join the same partition to share login state with
   * the human sidebar browser of the workspace.
   * @param workspace - workspace identity; validated exactly like `acquire`.
   * @returns The partition approved for this workspace.
   */
  partitionFor(workspace: unknown): string {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    return partition
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * List the live guests one window opened, so an agent lease can offer them for claim.
   * @param owner - authenticated IPC sender whose guests are listed.
   * @returns One entry per attached, live guest of that window.
   */
  listOwned(owner: WebContents): DesktopBrowserUserTab[] {
    const tabs: DesktopBrowserUserTab[] = []
    for (const [leaseId, lease] of this.leases) {
      const guest = lease.guest
      if (lease.owner !== owner || guest === undefined || guest.isDestroyed()) continue
      tabs.push({ leaseId, url: guest.getURL(), title: guest.getTitle() })
    }
    return tabs
  }

  /**
   * Resolve one guest this window owns without taking its lease from the renderer,
   * so the agent and the human drive the same page.
   * @param owner - authenticated IPC sender that owns the guest.
   * @param id - lease received from the caller.
   * @returns The live guest, or `undefined` when it is not this window's attached guest.
   */
  ownedGuest(owner: WebContents, id: unknown): WebContents | undefined {
    if (typeof id !== 'string') return undefined
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    if (lease === undefined || lease.owner !== owner) return undefined
    const guest = lease.guest
    if (guest === undefined || guest.isDestroyed()) return undefined
    return guest
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
