import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { WebContents } from 'electron'
import type { AgentRecorderPort, AgentRecordingResult } from '../src/agent-recorder.ts'
import type { AgentDownloadEvent, AgentDownloadWatcher } from '../src/agent-downloads.ts'
import type { AgentClaimedWebContents, AgentGuestHostWindow, AgentGuestView } from '../src/browser-guests-agent.ts'
import { AGENT_REVEAL_RETRY_MS, AgentBrowserGuests, createWebContentsViewGuest, isAgentNavigableUrl } from '../src/browser-guests-agent.ts'
import { AGENT_TAB_LIMIT } from '../src/browser-tab-residency.ts'

/** Minimal PNG header carrying the given pixel size, so capture calibration can be asserted. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.writeUInt32BE(0x89504e47, 0)
  bytes.writeUInt32BE(0x0d0a1a0a, 4)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

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
  pngBytes: Buffer
  captures: number
  loading: boolean
  audible: boolean
  readonly mediaStarted: Set<() => void>
  readonly mediaPaused: Set<() => void>
  playMedia(): void
  pauseMedia(): void
  bounds: Array<{ x: number; y: number; width: number; height: number }>
  lastPreferences: unknown
  reloads: number
  readonly crashListeners: Set<(...args: unknown[]) => void>
  crash(reason: string, exitCode: number): void
}

/** Debugger channel the fake guest exposes: attachment state, recorded commands, and message delivery. */
interface FakeDebugger {
  attach(version: string): void
  detach(): void
  isAttached(): boolean
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
  sendCommand(method: string, params?: unknown): Promise<unknown>
  readonly commands: Array<{ method: string; params?: unknown }>
  readonly listening: Set<(...args: unknown[]) => void>
  deliver(method: string, params: unknown): void
}

/** The full fake guest: recorded state plus the AgentGuestView surface. */
interface FakeWrappedGuest extends FakeGuestRecord {
  readonly webContents: AgentGuestView['webContents']
  /** Page scales applied to this guest, in order. */
  readonly zoomFactors: number[]
  attach(window: AgentGuestHostWindow): void
  destroy(): void
}

/** Constructor of the fake view; carries the instance registry. */
interface FakeViewCtor {
  readonly instances: FakeWrappedGuest[]
  new (options: { webPreferences: unknown }): FakeWrappedGuest
}

const { FakeView, makeWrappedGuest, clipboardStore, lastDebugger } = vi.hoisted((): {
  FakeView: FakeViewCtor
  makeWrappedGuest: (loadURL: (url: string) => Promise<void>) => FakeWrappedGuest
  clipboardStore: { text: string }
  lastDebugger: () => FakeDebugger
} => {
  const clipboardStore = { text: '' }
  const debuggers: FakeDebugger[] = []
  class FakeView implements FakeWrappedGuest {
    loadedUrls: string[] = []
    insertedTexts: string[] = []
    inputEvents: object[] = []
    executedScripts: string[] = []
    jsResult: unknown = { found: true, x: 50, y: 60 }
    closed = 0
    destroyed = false
    emptyCapture = false
    pngBytes: Buffer = Buffer.from('png-bytes')
    captures = 0
    reloads = 0
    loading = false
    audible = false
    readonly crashListeners = new Set<(...args: unknown[]) => void>()
    readonly mediaStarted = new Set<() => void>()
    readonly mediaPaused = new Set<() => void>()
    playMedia = (): void => { for (const listener of [...this.mediaStarted]) listener() }
    pauseMedia = (): void => { for (const listener of [...this.mediaPaused]) listener() }
    crash = (reason: string, exitCode: number): void => {
      for (const listener of [...this.crashListeners]) listener({}, { reason, exitCode })
    }

    bounds: Array<{ x: number; y: number; width: number; height: number }> = []
    /** Page scale applied to this guest, in order; the last one is in force. */
    zoomFactors: number[] = []
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
        reload: () => { this.reloads += 1; this.loadedUrls.push(this.currentUrl) },
        navigationHistory: {
          goBack: () => { this.currentUrl = 'https://example.com/back' },
          goForward: () => { this.currentUrl = 'https://example.com/forward' },
          reload: async () => { this.loadedUrls.push(this.currentUrl) },
        },
        insertText: async (text: string): Promise<void> => { this.insertedTexts.push(text) },
        copy: () => { clipboardStore.text = 'selected text' },
        paste: () => { this.insertedTexts.push('<paste:' + clipboardStore.text + '>') },
        sendInputEvent: (event: Parameters<WebContents['sendInputEvent']>[0]): void => { this.inputEvents.push(event) },
        executeJavaScriptInIsolatedWorld: async (_worldId: number, scripts: Array<{ code: string }>): Promise<unknown> => {
          this.executedScripts.push(scripts[0]?.code ?? '')
          return this.jsResult
        },
        evaluateInIsolatedWorld: async (script: string): Promise<unknown> => {
          this.executedScripts.push(script)
          return this.jsResult
        },
        capturePage: async () => {
          this.captures += 1
          return {
            isEmpty: () => this.emptyCapture,
            toPNG: () => this.pngBytes,
          }
        },
        debugger: createFakeDebugger(),
        isLoading: (): boolean => this.loading,
        isCurrentlyAudible: (): boolean => this.audible,
        setZoomFactor: (factor: number): void => { this.zoomFactors.push(factor) },
        on: (event: string, listener: (...args: unknown[]) => void): void => {
          if (event === 'render-process-gone') this.crashListeners.add(listener)
          if (event === 'media-started-playing') this.mediaStarted.add(listener)
          if (event === 'media-paused') this.mediaPaused.add(listener)
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void): void => {
          if (event === 'render-process-gone') this.crashListeners.delete(listener)
          if (event === 'media-started-playing') this.mediaStarted.delete(listener)
          if (event === 'media-paused') this.mediaPaused.delete(listener)
        },
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

  /**
   * Minimal debugger channel: the carrier attaches, enables Page, listens for the
   * dialog method, and answers through `Page.handleJavaScriptDialog`.
   * @returns A stand-in for `webContents.debugger` plus the state a test drives.
   */
  function createFakeDebugger(): FakeDebugger {
    const commands: Array<{ method: string; params?: unknown }> = []
    const listening = new Set<(...args: unknown[]) => void>()
    const state = { attached: false, commands, listening }
    const channel: FakeDebugger = {
      commands: state.commands,
      listening: state.listening,
      attach: () => { state.attached = true },
      detach: () => { state.attached = false },
      isAttached: () => state.attached,
      on: (event, listener) => { if (event === 'message') state.listening.add(listener) },
      removeListener: (event, listener) => { if (event === 'message') state.listening.delete(listener) },
      sendCommand: async (method, params) => { state.commands.push({ method, ...(params === undefined ? {} : { params }) }); return {} },
      deliver: (method, params) => { for (const listener of [...state.listening]) listener({}, method, params) },
    }
    debuggers.push(channel)
    return channel
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
        get pngBytes() { return view.pngBytes },
        set pngBytes(value: Buffer) { view.pngBytes = value },
        get captures() { return view.captures },
        get reloads() { return view.reloads },
        get loading() { return view.loading },
        set loading(value: boolean) { view.loading = value },
        get audible() { return view.audible },
        set audible(value: boolean) { view.audible = value },
        get crashListeners() { return view.crashListeners },
        crash: (reason: string, exitCode: number) => { view.crash(reason, exitCode) },
        get mediaStarted() { return view.mediaStarted },
        get mediaPaused() { return view.mediaPaused },
        playMedia: () => { view.playMedia() },
        pauseMedia: () => { view.pauseMedia() },
        bounds: view.bounds,
        zoomFactors: view.zoomFactors,
        lastPreferences: view.lastPreferences,
        webContents: {
          loadURL: async (url: string) => { await loadURL(url) },
          getURL: () => view.webContents.getURL(),
          getTitle: () => view.webContents.getTitle(),
          close: () => { view.webContents.close() },
          isDestroyed: () => view.webContents.isDestroyed(),
          insertText: async (text) => { await view.webContents.insertText(text) },
          copy: () => { view.webContents.copy() },
          paste: () => { view.webContents.paste() },
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
          debugger: view.webContents.debugger,
          isLoading: () => view.webContents.isLoading(),
          isCurrentlyAudible: () => view.webContents.isCurrentlyAudible(),
          on: view.webContents.on,
          removeListener: view.webContents.removeListener,
        },
        attach: (target) => { view.attach(target) },
        setZoom: (factor: number) => { view.webContents.setZoomFactor(factor) },
        zoom: () => view.zoomFactors.at(-1) ?? 1,
        destroy: () => { view.destroy() },
      }
    },
    clipboardStore,
    lastDebugger: () => {
      const channel = debuggers.at(-1)
      if (channel === undefined) throw new Error('no fake guest was created')
      return channel
    },
  }
})

vi.mock('electron', () => ({
  WebContentsView: FakeView,
  app: { isPackaged: true },
  clipboard: {
    readText: () => clipboardStore.text,
    writeText: (value: string) => { clipboardStore.text = value },
  },
}))

/** A guest the window owns, as the claim path sees it. */
function makeClaimedGuest(): {
  web: AgentClaimedWebContents
  urls: string[]
  state: { url: string; destroyed: boolean }
} {
  const state = { url: 'https://example.com/human', destroyed: false }
  const urls: string[] = []
  return {
    urls,
    state,
    web: {
      loadURL: async (url: string) => { state.url = url; urls.push(url) },
      getURL: () => state.url,
      getTitle: () => 'Human page',
      isDestroyed: () => state.destroyed,
      insertText: async () => {},
      isLoading: () => false,
      isCurrentlyAudible: () => false,
      copy: () => {},
      paste: () => {},
      sendInputEvent: () => {},
      reload: () => {},
      navigationHistory: { goBack: () => {}, goForward: () => {} },
      executeJavaScriptInIsolatedWorld: async () => ({ found: false }),
      capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.from('') }),
    },
  }
}

/** Deterministic recorder carrier for the shell's recording lifecycle. */
function makeFakeRecorder(): {
  port: AgentRecorderPort
  drawn: number[]
  intervals: number[]
  disposed: number
  result: AgentRecordingResult | undefined
} {
  const state = {
    drawn: [] as number[],
    intervals: [] as number[],
    disposed: 0,
    result: {
      base64: Buffer.from('webm-bytes').toString('base64'), frames: 2, durationMs: 250,
    } as AgentRecordingResult | undefined,
  }
  return {
    drawn: state.drawn,
    intervals: state.intervals,
    get disposed() { return state.disposed },
    get result() { return state.result },
    set result(value: AgentRecordingResult | undefined) { state.result = value },
    port: {
      start: async (intervalMs: number) => { state.intervals.push(intervalMs) },
      frame: async (png: Buffer) => { state.drawn.push(png.length) },
      stop: async () => state.result,
      dispose: async () => { state.disposed += 1 },
    },
  }
}

/** Download source a test can drive directly. */
function makeFakeDownloads(): {
  watcher: AgentDownloadWatcher
  emit: (event: AgentDownloadEvent) => void
  watched: string[]
  unwatched: number
} {
  const listeners = new Set<(event: AgentDownloadEvent) => void>()
  const watched: string[] = []
  const state = { unwatched: 0 }
  return {
    watched,
    get unwatched() { return state.unwatched },
    watcher: {
      watch: (partition, listener) => {
        watched.push(partition)
        listeners.add(listener)
        return () => { listeners.delete(listener); state.unwatched += 1 }
      },
    },
    emit: (event: AgentDownloadEvent) => { for (const listener of [...listeners]) listener(event) },
  }
}

interface Harness {
  guests: AgentBrowserGuests
}

function makeGuests(overrides?: {
  getWindow?: () => AgentGuestHostWindow | undefined
  navigateTimeoutMs?: number
  ariaMaxChars?: number
  loadURL?: (url: string) => Promise<void>
  emit?: (event: { name: string; leaseId: string; payload: unknown }) => void
  humanTabs?: {
    readonly list: () => Array<{ tabId: string; url: string; title: string }>
    readonly guest: (tabId: string) => AgentClaimedWebContents | undefined
  }
  createRecorder?: () => AgentRecorderPort
  recordingsDir?: string
  deviceScaleFactor?: () => number
  downloads?: AgentDownloadWatcher
  revealPane?: (sessionKey: string) => void
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
  const ariaMaxChars = overrides?.ariaMaxChars
  const revealPane = overrides?.revealPane
  const guests = new AgentBrowserGuests({
    hostUrl: () => 'http://127.0.0.1:19387',
    getWindow: overrides?.getWindow ?? (() => fakeWindow),
    partitionFor: workspace => `partition-${workspace}`,
    ...(navigateTimeoutMs === undefined ? {} : { navigateTimeoutMs }),
    ...(ariaMaxChars === undefined ? {} : { ariaMaxChars }),
    ...(revealPane === undefined ? {} : { revealPane }),
    ...(overrides?.emit === undefined ? {} : { emit: overrides.emit }),
    ...(overrides?.humanTabs === undefined ? {} : { humanTabs: overrides.humanTabs }),
    ...(overrides?.createRecorder === undefined ? {} : { createRecorder: overrides.createRecorder }),
    ...(overrides?.recordingsDir === undefined ? {} : { recordingsDir: overrides.recordingsDir }),
    ...(overrides?.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: overrides.deviceScaleFactor }),
    ...(overrides?.downloads === undefined ? {} : { downloads: overrides.downloads }),
    ...(loadURL === undefined ? {} : { createView: (): AgentGuestView => makeWrappedGuest(loadURL) }),
  })
  return { guests }
}

function lastRecord(): FakeWrappedGuest {
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
    // A guest nothing presents stays inside the window at one pixel. A view clipped
    // outside the window gets a zero-sized renderer viewport, which breaks layout.
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

  it('focuses a selector or ref with a trusted click before typing', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true, x: 12, y: 34 }
    await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'type', args: { selector: '#q', text: 'hello' } })
    const record = lastRecord()
    expect(record.insertedTexts).toEqual(['hello'])
    expect(record.inputEvents.map(event => (event as { type?: string }).type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
    const scriptsBefore = record.executedScripts.length
    lastRecord().jsResult = { url: 'https://example.com/', title: 'Example', elements: [{ ref: 'e1', tag: 'button', x: 1, y: 2 }] }
    const snapshotResult = await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'snapshot', args: {} }) as { elements: Array<{ ref: string }> }
    expect(snapshotResult.elements[0]!.ref).toBe('e1')
    await guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'type', args: { ref: 'e1', text: 'again' } })
    expect(lastRecord().insertedTexts.at(-1)).toBe('again')
    expect(lastRecord().executedScripts).toHaveLength(scriptsBefore + 1)
    lastRecord().jsResult = { found: false }
    await expect(guests.execute({ type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'type', args: { ref: 'gone', text: 'x' } }))
      .rejects.toMatchObject({ code: 'browser_element_not_found' })
  })

  it('captures the guest page as base64 png on screenshot', async () => {    const { guests } = makeGuests()
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

  it('manages multiple tabs with new, activate, close, and list', async () => {
    const { guests } = makeGuests({ loadURL: async () => {} })
    const acquire = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string; tabId: string }
    const { leaseId, tabId: first } = acquire
    const opened = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' } }) as { tabId: string; tabs: Array<{ tabId: string; active: boolean }> }
    expect(opened.tabs).toHaveLength(2)
    expect(opened.tabs.find(tab => tab.tabId === opened.tabId)?.active).toBe(true)
    await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'tabs', args: { action: 'activate', tabId: first } })
    const listed = await guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'tabs', args: { action: 'list' } }) as { tabs: Array<{ active: boolean }> }
    expect(listed.tabs.filter(tab => tab.active)).toHaveLength(1)
    const closed = await guests.execute({ type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'tabs', args: { action: 'close', tabId: opened.tabId } }) as { closed: string }
    expect(closed.closed).toBe(opened.tabId)
    await expect(guests.execute({ type: 'browser', requestId: 6, op: 'execute', leaseId, command: 'tabs', args: { action: 'close', tabId: opened.tabId } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('waits for a visible element and times out otherwise', async () => {    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true }
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'wait', args: { selector: '#ready', ms: 500 } }))
      .resolves.toEqual({ waited: true })
    lastRecord().jsResult = { found: false }
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'wait', args: { selector: '#gone', ms: 300 } }))
      .rejects.toMatchObject({ code: 'browser_timeout' })
  })

  it('truncates the ARIA snapshot at the configured bound', async () => {
    const { guests } = makeGuests({ ariaMaxChars: 8 })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { aria: '- yaml: '.padEnd(30, 'x') }
    const result = await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'aria', args: {} }) as { aria: string; truncated: boolean }
    expect(result.aria).toHaveLength(8)
    expect(result.truncated).toBe(true)
    lastRecord().jsResult = { aria: '- short' }
    const small = await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'aria', args: {} }) as { aria: string; truncated: boolean }
    expect(small.aria).toBe('- short')
    expect(small.truncated).toBe(false)
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

  it('describes a snapshot ref from the cache without probing the page again', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = {
      url: 'https://example.com/',
      title: 'Example',
      elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'Submit', x: 30, y: 40 }],
    }
    await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'snapshot', args: {} })
    const probed = lastRecord().executedScripts.length
    const described = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'elementInfo', args: { ref: 'e1' },
    }) as { source: string; tag: string; role: string; name: string }
    expect(described).toMatchObject({ source: 'snapshot', tag: 'button', role: 'button', name: 'Submit' })
    expect(lastRecord().executedScripts).toHaveLength(probed)
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'elementInfo', args: { ref: 'e9' } }))
      .rejects.toMatchObject({ code: 'browser_element_not_found' })
  })

  it('probes one element by selector and reports its live facts', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true, tag: 'input', visible: true, disabled: false, box: { x: 1, y: 2, width: 3, height: 4 } }
    const described = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'elementInfo', args: { selector: '#name' },
    }) as { selector: string; source: string; tag: string; visible: boolean }
    expect(described).toMatchObject({ selector: '#name', source: 'page', tag: 'input', visible: true })
    expect(lastRecord().executedScripts.at(-1)).toContain('#name')
    lastRecord().jsResult = { found: false }
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'elementInfo', args: { selector: '#gone' } }))
      .rejects.toMatchObject({ code: 'browser_element_not_found' })
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'elementInfo', args: {} }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('lays the page out at the viewport the automation asked for, centred in a pane that fits it', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 's-1',
    }) as { leaseId: string }
    expect(guests.present('s-1', { x: 10, y: 20, width: 420, height: 900 })).toBe(true)
    const sized = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'viewport', args: { width: 375, height: 667 },
    }) as { width: number; height: number; scale: number; follow: boolean; visible: boolean }
    expect(sized).toEqual({ width: 375, height: 667, scale: 1, follow: false, visible: true })
    // The pane is the surface; a viewport it can hold draws at its own size, centred.
    expect(lastRecord().bounds.at(-1)).toEqual({ x: 33, y: 137, width: 375, height: 667 })
    expect(lastRecord().zoomFactors.at(-1)).toBe(1)
  })

  it('scales a viewport the pane cannot fit and maps input through that scale', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 's-2',
    }) as { leaseId: string }
    guests.present('s-2', { x: 0, y: 0, width: 420, height: 900 })
    const sized = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'viewport', args: { width: 1280, height: 720 },
    }) as { scale: number }
    expect(sized.scale).toBe(0.328)
    const record = lastRecord()
    // Scaled down to fit rather than clipped, so the whole page stays visible.
    expect(record.bounds.at(-1)).toEqual({ x: 0, y: 332, width: 420, height: 236 })
    expect(record.zoomFactors.at(-1)).toBe(0.328)
    record.inputEvents.length = 0
    const clicked = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'click', args: { x: 100, y: 50 },
    }) as { x: number; y: number }
    // A point read from the page is a layout viewport coordinate; the events it turns
    // into are view coordinates, so they carry the page scale.
    expect(record.inputEvents).toEqual([
      { type: 'mouseMove', x: 33, y: 16 },
      { type: 'mouseDown', x: 33, y: 16, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 33, y: 16, button: 'left', clickCount: 1 },
    ])
    expect(clicked).toMatchObject({ x: 100, y: 50 })
  })

  it('defaults a partial viewport request to the size in force and rejects out-of-range dimensions', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 's-3',
    }) as { leaseId: string }
    guests.present('s-3', { x: 0, y: 0, width: 800, height: 600 })
    await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'viewport', args: { width: 1024, height: 768 },
    })
    const widened = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'viewport', args: { width: 640 },
    }) as { width: number; height: number }
    expect(widened).toMatchObject({ width: 640, height: 768 })
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'viewport', args: { width: 100 } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    await expect(guests.execute({ type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'viewport', args: { height: 1.5 } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    await expect(guests.execute({ type: 'browser', requestId: 6, op: 'execute', leaseId, command: 'viewport', args: { height: 4000 } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('returns the page to the pane\u2019s own size, and finds the lease a pane drives', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 's-4',
    }) as { leaseId: string }
    guests.present('s-4', { x: 5, y: 6, width: 700, height: 500 })
    await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'viewport', args: { width: 375, height: 667 },
    })
    expect(lastRecord().zoomFactors.at(-1)).toBe(0.75)
    const followed = await guests.commandForSession('s-4', 'viewport', { follow: true }) as { follow: boolean; scale: number }
    expect(followed).toMatchObject({ follow: true, scale: 1 })
    expect(lastRecord().bounds.at(-1)).toEqual({ x: 5, y: 6, width: 700, height: 500 })
    expect(await guests.commandForSession('no-such-session', 'reload', {})).toBeUndefined()
  })

  it('keeps asking the pane to open until one presents the lease', async () => {
    vi.useFakeTimers()
    try {
      const revealPane = vi.fn()
      const { guests } = makeGuests({ revealPane })
      const { leaseId } = await guests.acquire({
        type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 's-5',
      }) as { leaseId: string }
      expect(revealPane).toHaveBeenCalledExactlyOnceWith('s-5')
      // An unopened pane leaves the guest without a surface, so the request is repeated —
      // rate-limited, not on every command.
      await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'reload', args: {} })
      expect(revealPane).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(AGENT_REVEAL_RETRY_MS)
      await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'reload', args: {} })
      expect(revealPane).toHaveBeenCalledTimes(2)
      // Once a pane has shown the lease the human owns the tab, so closing it is final.
      guests.present('s-5', { x: 0, y: 0, width: 300, height: 200 })
      vi.advanceTimersByTime(AGENT_REVEAL_RETRY_MS * 3)
      await guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'reload', args: {} })
      expect(revealPane).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the requested viewport and keeps a parked lease inside the window', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'viewport', args: { width: 500, height: 400 },
    }) as { width: number; height: number; visible: boolean }
    expect(result).toEqual({ width: 500, height: 400, scale: 1, follow: false, visible: false })
    // Only a presented surface gives the page the size it lays out in; the parked
    // rectangle stays inside the window so the renderer keeps a real viewport.
    expect(lastRecord().bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('reports the PNG pixel size and flags a capture that misses the viewport', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', bounds: { x: 0, y: 0, width: 800, height: 600 },
    }) as { leaseId: string }
    lastRecord().pngBytes = pngHeader(800, 600)
    const exact = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { width: number; height: number; sizeCorrected: boolean }
    expect(exact).toMatchObject({ width: 800, height: 600, sizeCorrected: false })
    lastRecord().pngBytes = pngHeader(1600, 1200)
    const scaled = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { width: number; height: number; sizeCorrected: boolean }
    expect(scaled).toMatchObject({ width: 1600, height: 1200, sizeCorrected: true })
    lastRecord().pngBytes = Buffer.from('not a png')
    const opaque = await guests.execute({
      type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { width?: number; sizeCorrected: boolean }
    expect(opaque.width).toBeUndefined()
    expect(opaque.sizeCorrected).toBe(false)
  })

  it('shares one in-flight capture between concurrent screenshot requests', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const before = lastRecord().captures
    const [first, second] = await Promise.all([
      guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {} }),
      guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'screenshot', args: {} }),
    ])
    expect(lastRecord().captures).toBe(before + 1)
    expect(first).toEqual(second)
  })

  it('suspends and resumes a background tab', async () => {
    const { guests } = makeGuests()
    const { leaseId, tabId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string; tabId: string }
    const opened = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' },
    }) as { tabId: string }
    await guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'tabs', args: { action: 'activate', tabId } })
    const suspended = await guests.execute({
      type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'tabs', args: { action: 'suspend', tabId: opened.tabId },
    }) as { suspended: boolean; tabs: Array<{ tabId: string; suspended?: boolean }> }
    expect(suspended.suspended).toBe(true)
    expect(suspended.tabs.find(tab => tab.tabId === opened.tabId)?.suspended).toBe(true)
    const resumed = await guests.execute({
      type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'tabs', args: { action: 'resume', tabId: opened.tabId },
    }) as { suspended: boolean }
    expect(resumed.suspended).toBe(false)
    await expect(guests.execute({ type: 'browser', requestId: 6, op: 'execute', leaseId, command: 'tabs', args: { action: 'suspend', tabId } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    await expect(guests.execute({ type: 'browser', requestId: 7, op: 'execute', leaseId, command: 'tabs', args: { action: 'suspend', tabId: 'missing' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    const reactivated = await guests.execute({
      type: 'browser', requestId: 8, op: 'execute', leaseId, command: 'tabs', args: { action: 'activate', tabId: opened.tabId },
    }) as { tabs: Array<{ tabId: string; suspended?: boolean }> }
    expect(reactivated.tabs.find(tab => tab.tabId === opened.tabId)?.suspended).toBe(false)
    await expect(guests.execute({ type: 'browser', requestId: 9, op: 'execute', leaseId, command: 'tabs', args: { action: 'nope' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('binds a Sidebar pane to the lease acquired for its Session', async () => {
    const events: Array<{ name: string; leaseId: string; payload: Record<string, unknown> }> = []
    const { guests } = makeGuests({ emit: event => events.push(event as never) })
    await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 'session-1',
    })
    const attachments = lastRecord().bounds.length
    expect(guests.present('another-session', { x: 0, y: 0, width: 10, height: 10 })).toBe(false)
    expect(guests.present('session-1', { x: 5, y: 6, width: 700, height: 500 })).toBe(true)
    expect(lastRecord().bounds).toHaveLength(attachments + 1)
    const presented = events.filter(event => event.name === 'browser-state').at(-1)
    expect(presented?.payload.presented).toBe(true)
    expect(presented?.payload.tabs).toHaveLength(1)
    expect(guests.present('session-1', null)).toBe(true)
    const released = events.filter(event => event.name === 'browser-state').at(-1)
    expect(released?.payload.presented).toBe(false)
  })

  it('publishes activity around each command and a closed state on release', async () => {
    const events: Array<{ name: string; leaseId: string; payload: Record<string, unknown> }> = []
    const { guests } = makeGuests({ emit: event => events.push(event as never) })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'getState', args: {} })
    const activity = events.filter(event => event.name === 'browser-activity').map(event => event.payload)
    expect(activity[0]).toMatchObject({ active: true, command: 'getState' })
    expect(activity.at(-1)).toMatchObject({ active: false })
    await guests.release({ leaseId })
    const closed = events.at(-1)
    expect(closed?.name).toBe('browser-state')
    expect(closed?.payload).toMatchObject({ closed: true, presented: false })
  })

  it('lists, claims, and finalizes a tab the human opened', async () => {
    const human = makeClaimedGuest()
    const { guests } = makeGuests({
      humanTabs: {
        list: () => [{ tabId: 'human-1', url: 'https://example.com/human', title: 'Human page' }],
        guest: tabId => tabId === 'human-1' ? human.web : undefined,
      },
    })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const listed = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'tabs', args: { action: 'listUserTabs' },
    }) as { userTabs: Array<{ tabId: string; title: string }> }
    expect(listed.userTabs).toEqual([{ tabId: 'human-1', url: 'https://example.com/human', title: 'Human page' }])
    const claimed = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'tabs', args: { action: 'claim', tabId: 'human-1' },
    }) as { tabId: string; claimed: string; tabs: Array<{ tabId: string; url: string; active?: boolean }> }
    expect(claimed.claimed).toBe('human-1')
    const adopted = claimed.tabs.find(tab => tab.tabId === claimed.tabId)
    expect(adopted).toMatchObject({ url: 'https://example.com/human', active: true })
    // Commands on a claimed tab drive the very page the human is looking at.
    await guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'navigate', args: { url: 'https://example.com/next' } })
    expect(human.urls).toEqual(['https://example.com/next'])
    const finalized = await guests.execute({
      type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'tabs', args: { action: 'finalize', tabId: claimed.tabId },
    }) as { finalized: string; claimed: boolean }
    expect(finalized).toMatchObject({ finalized: claimed.tabId, claimed: true })
    expect(human.state.destroyed).toBe(false)
    await expect(guests.execute({ type: 'browser', requestId: 6, op: 'execute', leaseId, command: 'tabs', args: { action: 'claim', tabId: 'missing' } }))
      .rejects.toMatchObject({ code: 'browser_element_not_found' })
    await expect(guests.execute({ type: 'browser', requestId: 7, op: 'execute', leaseId, command: 'tabs', args: { action: 'finalize', tabId: 'missing' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('leaves a claimed guest open when its lease is released', async () => {
    const human = makeClaimedGuest()
    const { guests } = makeGuests({
      humanTabs: { list: () => [], guest: tabId => tabId === 'human-1' ? human.web : undefined },
    })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'tabs', args: { action: 'claim', tabId: 'human-1' } })
    await guests.release({ leaseId })
    expect(human.state.destroyed).toBe(false)
    // The pool's own tab is closed through the carrier; the claimed guest is left alone.
    expect(lastRecord().closed).toBe(1)
  })

  it('records the active tab and writes a WebM file, pruning expired ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-recording-'))
    const stale = join(directory, 'agent-browser-old.webm')
    await writeFile(stale, Buffer.from('old'))
    await utimes(stale, new Date(0), new Date(0))
    const recorder = makeFakeRecorder()
    const { guests } = makeGuests({ createRecorder: () => recorder.port, recordingsDir: directory })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const idle = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'record', args: { action: 'status' },
    }) as { recording: boolean; frames: number }
    expect(idle).toMatchObject({ recording: false, frames: 0 })
    const started = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'record', args: { action: 'start', frameIntervalMs: 50 },
    }) as { recording: boolean; frameIntervalMs: number }
    expect(started).toEqual({ recording: true, frameIntervalMs: 50 })
    expect(recorder.intervals).toEqual([50])
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'record', args: { action: 'start' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    await new Promise((resolve) => { setTimeout(resolve, 120) })
    expect(recorder.drawn.length).toBeGreaterThan(0)
    const stopping = await guests.execute({
      type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'record', args: { action: 'stop' },
    }) as { path: string; bytes: number; frames: number; durationMs: number }
    expect(basename(stopping.path).startsWith('agent-browser-')).toBe(true)
    expect(stopping.bytes).toBe(Buffer.from('webm-bytes').length)
    expect(stopping.frames).toBe(2)
    expect(recorder.disposed).toBe(1)
    // The expired file is gone; only the recording just written remains.
    expect(await readdir(directory)).toEqual([basename(stopping.path)])
    await rm(directory, { recursive: true, force: true })
  })

  it('reports a recorder that produced no frames and clamps the frame interval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-recording-'))
    const recorder = makeFakeRecorder()
    recorder.result = undefined
    const { guests } = makeGuests({ createRecorder: () => recorder.port, recordingsDir: directory })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'record', args: { action: 'start', frameIntervalMs: 1 },
    })
    expect(recorder.intervals).toEqual([40])
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'record', args: { action: 'stop' } }))
      .rejects.toMatchObject({ code: 'browser_empty_capture' })
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'record', args: { action: 'stop' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    await expect(guests.execute({ type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'record', args: { action: 'nope' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    expect(recorder.disposed).toBe(1)
    expect(await readdir(directory)).toEqual([])
    await rm(directory, { recursive: true, force: true })
  })

  it('holds the named modifiers across one trusted key chord', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'cuaKeypress',
      args: { key: 'A', modifiers: ['ctrl', 'shift', 'bogus'] },
    }) as { pressed: string; modifiers: string[] }
    expect(result).toEqual({ pressed: 'A', modifiers: ['control', 'shift'] })
    const events = lastRecord().inputEvents as Array<{ type?: string; keyCode?: string; modifiers?: string[] }>
    expect(events.map(event => event.type)).toEqual([
      'keyDown', 'keyDown', 'rawKeyDown', 'keyUp', 'keyUp', 'keyUp',
    ])
    expect(events[0]?.keyCode).toBe('control')
    expect(events[1]?.keyCode).toBe('shift')
    expect(events[2]).toMatchObject({ keyCode: 'A', modifiers: ['control', 'shift'] })
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'cuaKeypress', args: {} }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('scrolls at one viewport point and rejects an unusable gesture', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'cuaScroll', args: { x: 10, y: 20, deltaY: 100 },
    }) as { x: number; y: number; scrolled: { deltaY: number } }
    expect(result).toMatchObject({ x: 10, y: 20, scrolled: { deltaX: 0, deltaY: 100 } })
    expect(lastRecord().inputEvents.at(-1)).toMatchObject({ type: 'mouseWheel', x: 10, y: 20, deltaY: 100 })
    await expect(guests.execute({ type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'cuaScroll', args: { x: 1, y: 1 } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'cuaScroll', args: { deltaY: 40 } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('drags between two points in interpolated trusted steps', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'cuaDrag',
      args: { from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, steps: 4 },
    }) as { dragged: { from: { x: number; y: number }; to: { x: number; y: number }; steps: number } }
    expect(result.dragged).toEqual({ from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, steps: 4 })
    const events = lastRecord().inputEvents as Array<{ type?: string; x?: number; y?: number }>
    expect(events.map(event => event.type)).toEqual([
      'mouseMove', 'mouseDown', 'mouseMove', 'mouseMove', 'mouseMove', 'mouseMove', 'mouseUp',
    ])
    expect(events.at(-1)).toMatchObject({ type: 'mouseUp', x: 100, y: 50 })
    await expect(guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'cuaDrag', args: { from: { x: 0, y: 0 }, to: { ref: 'stale' } },
    })).rejects.toMatchObject({ code: 'browser_element_not_found' })
  })

  it('calibrates the captured size against the display scale factor', async () => {
    const { guests } = makeGuests({ deviceScaleFactor: () => 2 })
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', bounds: { x: 0, y: 0, width: 800, height: 600 },
    }) as { leaseId: string }
    lastRecord().pngBytes = pngHeader(1600, 1200)
    const scaled = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { width: number; height: number; scaleFactor: number; sizeCorrected: boolean }
    expect(scaled).toMatchObject({ width: 1600, height: 1200, scaleFactor: 2, sizeCorrected: false })
    lastRecord().pngBytes = pngHeader(800, 600)
    const unscaled = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { sizeCorrected: boolean }
    expect(unscaled.sizeCorrected).toBe(true)
  })

  it('tracks the lease downloads and reports their saved paths', async () => {
    const downloads = makeFakeDownloads()
    const { guests } = makeGuests({ downloads: downloads.watcher })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    expect(downloads.watched).toEqual(['partition-ws'])
    const idle = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'downloads', args: { action: 'list' },
    }) as { downloads: unknown[]; running: number }
    expect(idle).toEqual({ downloads: [], running: 0 })
    const file = { id: 'd1', filename: 'report.pdf', url: 'https://example.com/report.pdf' }
    downloads.emit({ ...file, state: 'progressing', receivedBytes: 10, totalBytes: 100 })
    const running = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'downloads', args: { action: 'list' },
    }) as { downloads: Array<{ filename: string; state: string }>; running: number }
    expect(running.running).toBe(1)
    expect(running.downloads[0]).toMatchObject({ filename: 'report.pdf', state: 'progressing' })
    downloads.emit({
      ...file, state: 'completed', receivedBytes: 100, totalBytes: 100, savePath: 'C:\\Users\\me\\Downloads\\report.pdf',
    })
    const settled = await guests.execute({
      type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'downloads', args: { action: 'list' },
    }) as { downloads: Array<{ state: string; savePath?: string }>; running: number }
    expect(settled.running).toBe(0)
    expect(settled.downloads).toHaveLength(1)
    expect(settled.downloads[0]).toMatchObject({ state: 'completed', savePath: 'C:\\Users\\me\\Downloads\\report.pdf' })
    await guests.release({ leaseId })
    expect(downloads.unwatched).toBe(1)
    await expect(guests.execute({ type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'downloads', args: { action: 'list' } }))
      .rejects.toMatchObject({ code: 'browser_lease_unknown' })
  })

  it('waits for a running download and gives up at the deadline', async () => {
    const downloads = makeFakeDownloads()
    const { guests } = makeGuests({ downloads: downloads.watcher })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const file = { id: 'd1', filename: 'archive.zip', url: 'https://example.com/archive.zip' }
    downloads.emit({ ...file, state: 'progressing', receivedBytes: 1, totalBytes: 10 })
    const started = Date.now()
    const timedOut = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'downloads', args: { action: 'wait', timeoutMs: 150 },
    }) as { running: number }
    expect(timedOut.running).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    // A download that settles mid-wait returns before the deadline.
    const waiting = guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'downloads', args: { action: 'wait', timeoutMs: 5_000 },
    })
    setTimeout(() => {
      downloads.emit({ ...file, state: 'completed', receivedBytes: 10, totalBytes: 10, savePath: 'C:\\tmp\\archive.zip' })
    }, 20)
    const settled = await waiting as { running: number; downloads: Array<{ state: string }> }
    expect(settled.running).toBe(0)
    expect(settled.downloads[0]?.state).toBe('completed')
    await expect(guests.execute({ type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'downloads', args: { action: 'nope' } }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('clicks explicit viewport coordinates without probing the page', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const result = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'click', args: { x: 12.6, y: 34.2 },
    }) as { x: number; y: number; clicked: boolean }
    expect(result).toEqual({ x: 13, y: 34, clicked: true })
    const record = lastRecord()
    expect(record.executedScripts).toEqual([])
    expect(record.inputEvents).toEqual([
      { type: 'mouseMove', x: 13, y: 34 },
      { type: 'mouseDown', x: 13, y: 34, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 13, y: 34, button: 'left', clickCount: 1 },
    ])
  })

  it('searches same-origin frames and reports the ones a selector could not reach', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    lastRecord().jsResult = { found: true, x: 40, y: 60, frameDepth: 1 }
    const clicked = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'click', args: { selector: '#inner' },
    }) as { x: number; y: number; clicked: boolean }
    expect(clicked).toEqual({ x: 40, y: 60, clicked: true })
    const script = lastRecord().executedScripts.at(-1) ?? ''
    expect(script).toContain('contentDocument')
    expect(script).toContain('#inner')
    lastRecord().jsResult = { found: false, opaqueFrames: 2 }
    let failure: { code?: string; message?: string } | undefined
    try {
      await guests.execute({
        type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'click', args: { selector: '#inner' },
      })
    } catch (error) {
      failure = error as { code?: string; message?: string }
    }
    expect(failure?.code).toBe('browser_element_not_found')
    expect(failure?.message).toContain('2 cross-origin frame(s) were not searched')
    lastRecord().jsResult = { found: true, tag: 'button', frameDepth: 1, box: { x: 1, y: 2, width: 3, height: 4 } }
    const info = await guests.execute({
      type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'elementInfo', args: { selector: '#inner' },
    }) as { insideFrame?: boolean; tag?: string }
    expect(info).toMatchObject({ insideFrame: true, tag: 'button' })
    await expect(guests.execute({ type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'click', args: {} }))
      .rejects.toMatchObject({ code: 'browser_invalid_args' })
  })

  it('tracks a page dialog and answers it so the page continues', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const channel = lastDebugger()
    expect(channel.commands[0]?.method).toBe('Page.enable')
    const idle = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'dialog', args: { action: 'list' },
    }) as { dialogs: unknown[]; pending: number }
    expect(idle).toEqual({ dialogs: [], pending: 0 })
    channel.deliver('Page.javascriptDialogOpening', {
      type: 'confirm', message: 'Delete this?', url: 'https://example.com/app',
    })
    const waiting = await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'dialog', args: { action: 'list' },
    }) as { dialogs: Array<{ id: string; type: string; message: string }>; pending: number }
    expect(waiting.pending).toBe(1)
    expect(waiting.dialogs[0]).toMatchObject({ id: 'dialog-1', type: 'confirm', message: 'Delete this?' })
    const accepted = await guests.execute({
      type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'dialog', args: { action: 'accept' },
    }) as { id: string; answered: boolean; accepted: boolean }
    expect(accepted).toMatchObject({ id: 'dialog-1', accepted: true, answered: true })
    expect(channel.commands.at(-1)).toMatchObject({
      method: 'Page.handleJavaScriptDialog', params: { accept: true },
    })
    const settled = await guests.execute({
      type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'dialog', args: { action: 'list' },
    }) as { pending: number }
    expect(settled.pending).toBe(0)
    await expect(guests.execute({
      type: 'browser', requestId: 6, op: 'execute', leaseId, command: 'dialog', args: { action: 'accept', id: 'nope' },
    })).rejects.toMatchObject({ code: 'browser_invalid_args' })
    // A dialog the page answered itself is no longer answerable.
    channel.deliver('Page.javascriptDialogOpening', { type: 'alert', message: 'done' })
    channel.deliver('Page.javascriptDialogClosed', {})
    const closed = await guests.execute({
      type: 'browser', requestId: 7, op: 'execute', leaseId, command: 'dialog', args: { action: 'dismiss', id: 'dialog-2' },
    }) as { answered: boolean; accepted: boolean }
    expect(closed).toMatchObject({ answered: false, accepted: false })
    // Releasing the debugger follows the lease.
    await guests.release({ leaseId })
    expect(channel.isAttached()).toBe(false)
    expect(channel.listening.size).toBe(0)
    await expect(guests.execute({
      type: 'browser', requestId: 8, op: 'execute', leaseId, command: 'dialog', args: { action: 'nope' },
    })).rejects.toMatchObject({ code: 'browser_lease_unknown' })
  })

  it('marks a dead renderer, tells the pane, and reloads the tab before the next command', async () => {
    const events: Array<{ name: string; payload: unknown }> = []
    const { guests } = makeGuests({ emit: (event) => { events.push({ name: event.name, payload: event.payload }) } })
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    const record = lastRecord()
    record.jsResult = { elements: [{ ref: 'e1', tag: 'button', x: 10, y: 20 }] }
    await guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'snapshot', args: {} })
    expect(await guests.execute({
      type: 'browser', requestId: 3, op: 'execute', leaseId, command: 'click', args: { ref: 'e1' },
    })).toMatchObject({ x: 10, y: 20, clicked: true })
    expect(record.crashListeners.size).toBe(1)
    record.crash('crashed', 139)
    const dead = await guests.execute({
      type: 'browser', requestId: 4, op: 'execute', leaseId, command: 'tabs', args: { action: 'list' },
    }) as { tabs: Array<{ crashed?: boolean }> }
    expect(dead.tabs[0]?.crashed).toBe(true)
    const states = events.filter(event => event.name === 'browser-state')
    const reported = states.at(-1)?.payload as { tabs?: Array<{ crashed?: boolean }> } | undefined
    expect(reported?.tabs?.[0]?.crashed).toBe(true)
    // The ref cache described the page that died, and the next command brings the tab back first.
    await expect(guests.execute({
      type: 'browser', requestId: 5, op: 'execute', leaseId, command: 'click', args: { ref: 'e1' },
    })).rejects.toMatchObject({ code: 'browser_element_not_found' })
    expect(record.reloads).toBe(1)
    const alive = await guests.execute({
      type: 'browser', requestId: 6, op: 'execute', leaseId, command: 'tabs', args: { action: 'list' },
    }) as { tabs: Array<{ crashed?: boolean }> }
    expect(alive.tabs[0]?.crashed).toBe(false)
    await guests.release({ leaseId })
    expect(record.crashListeners.size).toBe(0)
  })

  it('keeps the configured watch rectangle over a pane that measured no area', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 'session-watch',
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
    }) as { leaseId: string }
    // A collapsed measurement still reaches the shell; it must not become the surface.
    guests.present('session-watch', { x: 5, y: 6, width: 1, height: 1 })
    expect(lastRecord().bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    // A capture is measured against the surface the guest attached at, so the watch
    // rectangle — not the collapsed report — is what an exact capture matches.
    lastRecord().pngBytes = pngHeader(1280, 720)
    const shot = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { width: number; sizeCorrected: boolean }
    expect(shot).toMatchObject({ width: 1280, sizeCorrected: false })
    guests.present('session-watch', { x: 7, y: 8, width: 400, height: 300 })
    expect(lastRecord().bounds.at(-1)).toEqual({ x: 7, y: 8, width: 400, height: 300 })
  })

  it('attaches a lease at the pane its Session reported', async () => {
    const { guests } = makeGuests()
    // The pane renders before the first tool call, so its report arrives with no lease.
    expect(guests.present('session-1', { x: 5, y: 6, width: 700, height: 500 })).toBe(false)
    const { leaseId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws', sessionKey: 'session-1',
    }) as { leaseId: string }
    const record = lastRecord()
    // The lease binds the remembered pane instead of parking, and captures there.
    expect(record.bounds[0]).toEqual({ x: 5, y: 6, width: 700, height: 500 })
    record.pngBytes = pngHeader(700, 500)
    const shot = await guests.execute({
      type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'screenshot', args: {},
    }) as { width: number; height: number; sizeCorrected: boolean }
    expect(shot).toMatchObject({ width: 700, height: 500, sizeCorrected: false })
  })

  it('never closes the oldest tab while its page is still loading', async () => {
    /** Residency orders tabs by millisecond timestamps, so give each one its own. */
    const settle = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 2) }) }
    const { guests } = makeGuests()
    const { leaseId, tabId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws',
    }) as { leaseId: string; tabId: string }
    // The first tab is the oldest, so it is the natural victim once the pool overflows.
    lastRecord().loading = true
    await settle()
    for (let index = 0; index < 32; index += 1) {
      await settle()
      await guests.execute({ type: 'browser', requestId: 2 + index, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' } })
    }
    const listed = await guests.execute({
      type: 'browser', requestId: 40, op: 'execute', leaseId, command: 'tabs', args: { action: 'list' },
    }) as { tabs: Array<{ tabId: string }> }
    // The pool still came back to its limit, but the loading tab was spared.
    expect(listed.tabs).toHaveLength(32)
    expect(listed.tabs.map(tab => tab.tabId)).toContain(tabId)
  })

  it('spares a tab that is playing media and releases it once the media pauses', async () => {
    /** Residency orders tabs by millisecond timestamps, so give each one its own. */
    const settle = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 2) }) }
    const { guests } = makeGuests()
    const { leaseId, tabId } = await guests.acquire({
      type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws',
    }) as { leaseId: string; tabId: string }
    const first = lastRecord()
    first.playMedia()
    await settle()
    for (let index = 0; index < 32; index += 1) {
      await settle()
      await guests.execute({ type: 'browser', requestId: 2 + index, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' } })
    }
    const listed = await guests.execute({
      type: 'browser', requestId: 40, op: 'execute', leaseId, command: 'tabs', args: { action: 'list' },
    }) as { tabs: Array<{ tabId: string }> }
    expect(listed.tabs).toHaveLength(32)
    expect(listed.tabs.map(tab => tab.tabId)).toContain(tabId)
    // Pausing hands the tab back: the next overflow closes it as the oldest one.
    first.pauseMedia()
    await settle()
    await guests.execute({ type: 'browser', requestId: 41, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' } })
    const after = await guests.execute({
      type: 'browser', requestId: 42, op: 'execute', leaseId, command: 'tabs', args: { action: 'list' },
    }) as { tabs: Array<{ tabId: string }> }
    expect(after.tabs).toHaveLength(32)
    expect(after.tabs.map(tab => tab.tabId)).not.toContain(tabId)
  })

  it('rejects an unknown command with a structured code', async () => {
    const { guests } = makeGuests()
    const { leaseId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string }
    await expect(guests.execute({ type: 'browser', requestId: 2, op: 'execute', leaseId, command: 'nope', args: {} }))
      .rejects.toMatchObject({ code: 'browser_unknown_command' })
  })

  it('closes the oldest background tab when a new one exceeds the residency limit', async () => {
    const { guests } = makeGuests()
    const { leaseId, tabId } = await guests.acquire({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'ws' }) as { leaseId: string; tabId: string }
    const opened: string[] = [tabId]
    for (let index = 1; index < AGENT_TAB_LIMIT; index += 1) {
      const created = await guests.execute({
        type: 'browser', requestId: 100 + index, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' },
      }) as { tabId: string; evicted?: string[] }
      expect(created.evicted).toBeUndefined()
      opened.push(created.tabId)
    }
    const overflow = await guests.execute({
      type: 'browser', requestId: 200, op: 'execute', leaseId, command: 'tabs', args: { action: 'new' },
    }) as { evicted?: string[]; tabs: Array<{ tabId: string; active?: boolean }> }
    expect(overflow.evicted).toHaveLength(1)
    expect(opened).toContain(overflow.evicted?.[0] ?? '')
    expect(overflow.tabs).toHaveLength(AGENT_TAB_LIMIT)
    expect(overflow.tabs.some(tab => tab.tabId === overflow.evicted?.[0])).toBe(false)
    expect(overflow.tabs.filter(tab => tab.active === true)).toHaveLength(1)
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
