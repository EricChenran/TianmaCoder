import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGuestHostWindow, AgentGuestView } from '../src/browser-guests-agent.ts'
import { AgentBrowserGuests, createWebContentsViewGuest, isAgentNavigableUrl } from '../src/browser-guests-agent.ts'

/** Recorded navigation outcome of one fake guest. */
interface FakeGuestRecord {
  loadedUrls: string[]
  closed: number
  destroyed: boolean
  bounds: Array<{ x: number; y: number; width: number; height: number }>
  lastPreferences: unknown
}

/** The full fake guest: recorded state plus the AgentGuestView surface. */
interface FakeWrappedGuest extends FakeGuestRecord {
  readonly webContents: AgentGuestView['webContents']
  attach(window: AgentGuestHostWindow): void
  destroy(): void
}

/** Constructor of the fake view; carries the instance registry. */
interface FakeViewCtor {
  readonly instances: FakeWrappedGuest[]
  new (options: { webPreferences: unknown }): FakeWrappedGuest
}

const { FakeView, makeWrappedGuest } = vi.hoisted((): {
  FakeView: FakeViewCtor
  makeWrappedGuest: (loadURL: (url: string) => Promise<void>) => FakeWrappedGuest
} => {
  class FakeView implements FakeWrappedGuest {
    loadedUrls: string[] = []
    closed = 0
    destroyed = false
    bounds: Array<{ x: number; y: number; width: number; height: number }> = []
    lastPreferences: unknown
    currentUrl = 'about:blank'
    readonly webContents
    readonly setBounds = (bounds: { x: number; y: number; width: number; height: number }): void => {
      this.bounds.push(bounds)
    }

    constructor(options: { webPreferences: unknown }) {
      this.lastPreferences = options.webPreferences
      this.webContents = {
        loadURL: async (url: string): Promise<void> => {
          this.currentUrl = url
          this.loadedUrls.push(url)
        },
        getURL: () => this.currentUrl,
        getTitle: () => 'Example',
        close: () => { this.closed += 1 },
        isDestroyed: () => this.destroyed,
      }
      FakeView.instances.push(this)
    }

    attach(window: AgentGuestHostWindow): void {
      window.contentView.addChildView({ setBounds: this.setBounds })
      this.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    }

    destroy(): void {
      this.destroyed = true
    }

    static instances: FakeWrappedGuest[] = []
  }
  return {
    FakeView,
    makeWrappedGuest: (loadURL) => {
      const view = new FakeView({ webPreferences: {} })
      return {
        loadedUrls: view.loadedUrls,
        get closed() { return view.closed },
        get destroyed() { return view.destroyed },
        bounds: view.bounds,
        lastPreferences: view.lastPreferences,
        webContents: {
          loadURL: async (url: string) => { await loadURL(url) },
          getURL: () => view.webContents.getURL(),
          getTitle: () => view.webContents.getTitle(),
          close: () => { view.webContents.close() },
          isDestroyed: () => view.webContents.isDestroyed(),
        },
        attach: (target) => { view.attach(target) },
        destroy: () => { view.destroy() },
      }
    },
  }
})

vi.mock('electron', () => ({ WebContentsView: FakeView, app: { isPackaged: true } }))

interface Harness {
  guests: AgentBrowserGuests
}

function makeGuests(overrides?: {
  getWindow?: () => AgentGuestHostWindow | undefined
  navigateTimeoutMs?: number
  loadURL?: (url: string) => Promise<void>
}): Harness {
  const fakeWindow: AgentGuestHostWindow = {
    contentView: {
      addChildView: () => {},
      removeChildView: () => {},
    },
    isDestroyed: () => false,
  }
  FakeView.instances.length = 0
  const loadURL = overrides?.loadURL
  const navigateTimeoutMs = overrides?.navigateTimeoutMs
  const guests = new AgentBrowserGuests({
    hostUrl: () => 'http://127.0.0.1:19387',
    getWindow: overrides?.getWindow ?? (() => fakeWindow),
    partitionFor: workspace => `partition-${workspace}`,
    ...(navigateTimeoutMs === undefined ? {} : { navigateTimeoutMs }),
    ...(loadURL === undefined ? {} : { createView: (): AgentGuestView => makeWrappedGuest(loadURL) }),
  })
  return { guests }
}

function lastRecord(): FakeGuestRecord {
  const record = FakeView.instances.at(-1)
  if (record === undefined) throw new Error('no fake guest view was created')
  return record
}

beforeEach(() => { FakeView.instances.length = 0 })
afterEach(() => { FakeView.instances.length = 0 })

describe('Agent guest URL policy', () => {
  it('accepts http(s) targets without credentials', () => {
    expect(isAgentNavigableUrl('https://example.com/page', 'http://127.0.0.1:19387')).toBe(true)
    expect(isAgentNavigableUrl('http://localhost:3000/app', 'http://127.0.0.1:19387')).toBe(true)
  })

  it('rejects non-http schemes, embedded credentials, and the application host', () => {
    expect(isAgentNavigableUrl('file:///etc/passwd', undefined)).toBe(false)
    expect(isAgentNavigableUrl('https://user:pass@example.com', undefined)).toBe(false)
    expect(isAgentNavigableUrl('not a url', undefined)).toBe(false)
    expect(isAgentNavigableUrl('http://127.0.0.1:19387/app/', 'http://127.0.0.1:19387')).toBe(false)
    expect(isAgentNavigableUrl('http://localhost:19387/app/', 'http://127.0.0.1:19387')).toBe(false)
  })
})

describe('AgentBrowserGuests', () => {
  it('creates a hardened attached view per lease and returns its id', async () => {
    const { guests } = makeGuests()
    const result = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws-1' }) as { leaseId: string }
    expect(typeof result.leaseId).toBe('string')
    const record = lastRecord()
    expect(record.lastPreferences).toMatchObject({ partition: 'partition-ws-1', sandbox: true, nodeIntegration: false })
    expect(record.bounds).toEqual([{ x: 0, y: 0, width: 1, height: 1 }])
  })

  it('creates the lease without attachment when no window is available', async () => {
    const { guests } = makeGuests({ getWindow: () => undefined })
    const result = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws-1' }) as { leaseId: string }
    expect(result.leaseId).toBeTruthy()
    expect(lastRecord().bounds).toEqual([])
  })

  it('attaches with the requested on-screen bounds when the acquire carries them', async () => {
    const { guests } = makeGuests()
    const requested = { x: 12, y: 20, width: 640, height: 480 }
    await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws-1', bounds: requested }) as { leaseId: string }
    expect(lastRecord().bounds).toEqual([requested])
  })

  it('navigates an allowed target and reports the settled url and title', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'navigate', args: { url: 'https://example.com/page' } }) as { url: string; title: string }
    expect(lastRecord().loadedUrls).toEqual(['https://example.com/page'])
    expect(result).toEqual({ url: 'https://example.com/page', title: 'Example' })
  })

  it('rejects disallowed navigation without touching the guest', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'navigate', args: { url: 'file:///etc/passwd' } }))
      .rejects.toMatchObject({ code: 'browser_url_rejected' })
    expect(lastRecord().loadedUrls).toEqual([])
  })

  it('fails a navigation that misses the deadline', async () => {
    const { guests } = makeGuests({ navigateTimeoutMs: 10, loadURL: () => new Promise(() => {}) })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'navigate', args: { url: 'https://example.com' } }))
      .rejects.toMatchObject({ code: 'browser_timeout' })
  })

  it('rejects unknown leases, unknown commands, and releases guests once', async () => {
    const { guests } = makeGuests()
    await expect(guests.execute({ type: 'browser', requestId: 1, op: 'execute', leaseId: 'gone', command: 'navigate', args: {} }))
      .rejects.toMatchObject({ code: 'browser_lease_unknown' })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 2, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'screenshot', args: {} }))
      .rejects.toMatchObject({ code: 'browser_unknown_command' })
    await expect(guests.release({ leaseId })).resolves.toBeNull()
    const record = lastRecord()
    expect(record.closed).toBe(1)
    await expect(guests.release({ leaseId })).rejects.toMatchObject({ code: 'browser_lease_unknown' })
    expect(record.closed).toBe(1)
  })
})

describe('WebContentsView carrier', () => {
  it('builds the hardened offscreen view and detaches it on destroy', () => {
    const view = createWebContentsViewGuest('partition-ws')
    const record = lastRecord()
    expect(record.lastPreferences).toMatchObject({ sandbox: true, webviewTag: false, backgroundThrottling: false })
    const window: AgentGuestHostWindow = {
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      isDestroyed: () => false,
    }
    view.attach(window, { x: 0, y: 0, width: 1, height: 1 })
    expect(record.bounds).toEqual([{ x: 0, y: 0, width: 1, height: 1 }])
    view.destroy()
    expect(record.closed).toBe(1)
    expect(record.destroyed).toBe(false)
  })
})
