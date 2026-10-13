import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentGuestHostWindow, AgentGuestView } from '../src/browser-guests-agent.ts'
import { AgentBrowserGuests, createWebContentsViewGuest, isAgentNavigableUrl } from '../src/browser-guests-agent.ts'

/** Recorded navigation outcome of one fake guest. */
interface FakeGuestRecord {
  loadedUrls: string[]
  insertedTexts: string[]
  inputEvents: object[]
  executedScripts: string[]
  jsResult: unknown
  closed: number
  destroyed: boolean
  emptyCapture: boolean
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
    insertedTexts: string[] = []
    inputEvents: object[] = []
    executedScripts: string[] = []
    jsResult: unknown = { found: true, x: 50, y: 60 }
    closed = 0
    destroyed = false
    emptyCapture = false
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
        goBack: () => { this.currentUrl = 'https://example.com/back' },
        goForward: () => { this.currentUrl = 'https://example.com/forward' },
        reload: () => { this.loadedUrls.push(this.currentUrl) },
        navigationHistory: {
          goBack: () => { this.currentUrl = 'https://example.com/back' },
          goForward: () => { this.currentUrl = 'https://example.com/forward' },
          reload: async () => { this.loadedUrls.push(this.currentUrl) },
        },
        insertText: async (text: string): Promise<void> => { this.insertedTexts.push(text) },
        sendInputEvent: (event: Parameters<WebContents['sendInputEvent']>[0]): void => { this.inputEvents.push(event) },
        executeJavaScriptInIsolatedWorld: async (_worldId: number, scripts: Array<{ code: string }>): Promise<unknown> => {
          this.executedScripts.push(scripts[0]?.code ?? '')
          return this.jsResult
        },
        evaluateInIsolatedWorld: async (script: string): Promise<unknown> => {
          this.executedScripts.push(script)
          return this.jsResult
        },
        capturePage: async () => ({
          isEmpty: () => this.emptyCapture,
          toPNG: () => Buffer.from('png-bytes'),
        }),
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
        insertedTexts: view.insertedTexts,
        inputEvents: view.inputEvents,
        executedScripts: view.executedScripts,
        get jsResult() { return view.jsResult },
        set jsResult(value: unknown) { view.jsResult = value },
        get closed() { return view.closed },
        get destroyed() { return view.destroyed },
        get emptyCapture() { return view.emptyCapture },
        bounds: view.bounds,
        lastPreferences: view.lastPreferences,
        webContents: {
          loadURL: async (url: string) => { await loadURL(url) },
          getURL: () => view.webContents.getURL(),
          getTitle: () => view.webContents.getTitle(),
          close: () => { view.webContents.close() },
          isDestroyed: () => view.webContents.isDestroyed(),
          insertText: async (text) => { await view.webContents.insertText(text) },
          sendInputEvent: (event: Parameters<WebContents['sendInputEvent']>[0]) => { view.webContents.sendInputEvent(event) },
          evaluateInIsolatedWorld: async (script: string) => {
            return view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: script }])
          },
          reload: () => { view.webContents.reload() },
          navigationHistory: {
            goBack: () => { view.webContents.navigationHistory.goBack() },
            goForward: () => { view.webContents.navigationHistory.goForward() },
          },
          capturePage: async () => view.webContents.capturePage(),
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
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'drag', args: {} }))
      .rejects.toMatchObject({ code: 'browser_unknown_command' })
    await expect(guests.release({ leaseId })).resolves.toBeNull()
    const record = lastRecord()
    expect(record.closed).toBe(1)
    await expect(guests.release({ leaseId })).rejects.toMatchObject({ code: 'browser_lease_unknown' })
    expect(record.closed).toBe(1)
  })

  it('captures the guest page as base64 png on screenshot', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {} }) as { base64: string; mimeType: string }
    expect(result.mimeType).toBe('image/png')
    expect(Buffer.from(result.base64, 'base64').toString()).toBe('png-bytes')
  })

  it('reports an empty capture as a structured error', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().emptyCapture = true
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {} }))
      .rejects.toMatchObject({ code: 'browser_empty_capture' })
  })

  it('clicks a selector at its resolved coordinates with trusted mouse input', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'click', args: { selector: '#submit' } }) as { x: number; y: number; clicked: boolean }
    expect(result).toEqual({ x: 50, y: 60, clicked: true })
    const record = lastRecord()
    expect(record.executedScripts.some(script => script.includes('"#submit"'))).toBe(true)
    const kinds = record.inputEvents.map(event => (event as { type?: string }).type)
    expect(kinds).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
  })

  it('hovers without pressing buttons', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'hover', args: { selector: '.menu' } }) as { clicked: boolean }
    expect(result.clicked).toBe(false)
    const kinds = lastRecord().inputEvents.map(event => (event as { type?: string }).type)
    expect(kinds).toEqual(['mouseMove'])
  })

  it('reports a missing click target as a structured error', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: false }
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'click', args: { selector: '#nope' } }))
      .rejects.toMatchObject({ code: 'browser_element_not_found' })
  })

  it('waits for a visible element and times out otherwise', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true }
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'wait', args: { selector: '#ready', ms: 500 } }))
      .resolves.toEqual({ waited: true })
    lastRecord().jsResult = { found: false }
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'wait', args: { selector: '#gone', ms: 300 } }))
      .rejects.toMatchObject({ code: 'browser_timeout' })
  })

  it('fills an input by selector with real input and change events', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true, value: 'hello world' }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'fill', args: { selector: '#name', text: 'hello world' } }) as { filled: string; value: string }
    expect(result).toEqual({ filled: '#name', value: 'hello world' })
    const script = lastRecord().executedScripts.at(-1) ?? ''
    expect(script).toContain('dispatchEvent')
    expect(script).toContain('"hello world"')
  })

  it('checks an unchecked box and reports an already-checked one without clicking', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true, checked: false, x: 30, y: 40 }
    await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'check', args: { selector: '#agree' } })
    const kinds = lastRecord().inputEvents.map(event => (event as { type?: string }).type)
    expect(kinds).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
    lastRecord().inputEvents.length = 0
    lastRecord().jsResult = { found: true, checked: true }
    const result = await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'check', args: { selector: '#agree' } }) as { checked: boolean; changed: boolean }
    expect(result).toEqual({ checked: true, changed: false })
    expect(lastRecord().inputEvents).toHaveLength(0)
  })

  it('caches snapshot refs and clicks by ref without re-resolving', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = {
      url: 'https://example.com/',
      title: 'Example',
      elements: [{ ref: 'e1', tag: 'button', name: 'Submit', x: 30, y: 40 }],
    }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'snapshot', args: {} }) as { elements: Array<{ ref: string; tag: string }> }
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0]!.ref).toBe('e1')
    const scriptsBefore = lastRecord().executedScripts.length
    const clicked = await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'click', args: { ref: 'e1' } }) as { x: number; y: number; clicked: boolean }
    expect(clicked).toEqual({ x: 30, y: 40, clicked: true })
    expect(lastRecord().executedScripts).toHaveLength(scriptsBefore)
    const kinds = lastRecord().inputEvents.map(event => (event as { type?: string }).type)
    expect(kinds).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'click', args: { ref: 'stale' } }))
      .rejects.toMatchObject({ code: 'browser_element_not_found' })
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
