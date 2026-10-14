/** The Agent Browser plugin: what it registers, and how it answers the shell's reveal. */

import { describe, expect, it, vi } from 'vitest'
import type { DesktopAgentBrowserActivity, DesktopAgentBrowserBridge } from '../src/types.ts'
import { apply as applyClient } from '../src/client/index.ts'
import { AGENT_BROWSER_ID, AGENT_BROWSER_KIND, agentBrowserDefinition } from '../src/client/definition.tsx'

/** One captured slot registration. */
interface CapturedRegistration {
  readonly name: string
  readonly registration: Record<string, unknown>
  readonly component: unknown
}

/** A bridge whose reveal and activity listeners the test drives directly. */
function bridgeStub() {
  const handlers = {
    activity: [] as Array<(activity: DesktopAgentBrowserActivity) => void>,
    reveal: [] as Array<(sessionKey: string) => void>,
  }
  const present = vi.fn(() => Promise.resolve(true))
  const command = vi.fn(() => Promise.resolve(undefined))
  const bridge: DesktopAgentBrowserBridge = {
    present,
    command,
    onActivity(listener) {
      handlers.activity.push(listener)
      return () => { handlers.activity = handlers.activity.filter(entry => entry !== listener) }
    },
    onReveal(listener) {
      handlers.reveal.push(listener)
      return () => { handlers.reveal = handlers.reveal.filter(entry => entry !== listener) }
    },
  }
  return { bridge, handlers, present, command }
}

/** The mounting context the plugin needs, capturing every registration it makes. */
function hostContext(options: { readonly mounted?: string | undefined; readonly registeredType?: boolean } = {}) {
  const registrations: CapturedRegistration[] = []
  const injections: Array<{ readonly key: string; readonly run: () => unknown }> = []
  const dictionaries = new Map<string, unknown>()
  const disposers: Array<() => void> = []
  const openTab = vi.fn()
  const mountedListeners = new Set<() => void>()
  let mounted = options.mounted
  const ctx = {
    locale: {
      bind: () => (key: string) => key,
      register: (namespace: string, dictionary: unknown) => {
        dictionaries.set(namespace, dictionary)
        return () => {}
      },
    },
    effect: (callback: () => unknown) => {
      const dispose = callback()
      disposers.push(() => { if (typeof dispose === 'function') (dispose as () => void)() })
      return () => {}
    },
    slots: {
      inject: (key: string, run: () => unknown) => { injections.push({ key, run }); return () => {} },
      register: (registration: { name: string }, component: unknown) => {
        registrations.push({ name: registration.name, registration, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: vi.fn(() => () => {}),
      get: (id: string) => (options.registeredType === false ? undefined : { id }),
    },
    sidebarRight: {
      mounted: {
        getSnapshot: () => mounted,
        subscribe: (listener: () => void) => {
          mountedListeners.add(listener)
          return () => { mountedListeners.delete(listener) }
        },
      },
      openTab,
    },
  }
  /** Move the Session the column shows, as the runtime does when the human switches. */
  const showSession = (sessionKey: string | undefined): void => {
    mounted = sessionKey
    for (const listener of [...mountedListeners]) listener()
  }
  return { ctx: ctx as never, registrations, injections, dictionaries, disposers, openTab, showSession }
}

/** Mount the Client plugin and run the injections that register its contributions. */
function mount(options: { readonly mounted?: string | undefined; readonly registeredType?: boolean } = {}) {
  const host = hostContext(options)
  applyClient(host.ctx)
  for (const injection of host.injections) injection.run()
  return host
}

/** @returns the body registration the plugin made. */
function bodyRegistration(host: ReturnType<typeof mount>): CapturedRegistration {
  const body = host.registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
  if (body === undefined) throw new Error('the plugin did not register the pane body')
  return body
}

const SESSION = 'session-1'
const PAGE_ADDRESS = 'dsh-resource://agent-browser/page'

describe('Agent Browser plugin registration', () => {
  it('registers the tab type, the dictionary, and a title that renders the label', () => {
    const host = mount()
    expect(host.dictionaries.has('agentBrowser')).toBe(true)
    const title = host.registrations.find(entry => entry.name === 'sidebar.right.pane.tab.title')
    expect(title).toBeDefined()
    expect(typeof title?.component).toBe('function')
  })

  it('registers a plain body without a Desktop bridge', () => {
    const host = mount()
    expect(bodyRegistration(host).registration.inject).toBeUndefined()
  })

  it('registers an injectable body when the Desktop bridge is exposed', () => {
    const { bridge } = bridgeStub()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { protocolVersion: 1, agentBrowser: bridge }
    try {
      const host = mount()
      expect(typeof bodyRegistration(host).registration.inject).toBe('function')
    } finally {
      delete (globalThis as { dshDesktop?: unknown }).dshDesktop
    }
  })
})

describe('Agent Browser tab definition', () => {
  it('declares the keyed builtin type with localized title and guide', () => {
    const definition = agentBrowserDefinition(key => `copy:${key}`)
    expect(definition).toMatchObject({ id: AGENT_BROWSER_ID, kind: AGENT_BROWSER_KIND, multiple: true, priority: 'builtin' })
    expect(definition.title(PAGE_ADDRESS)).toBe('copy:type.label')
    expect(definition.guide?.[0]?.title()).toBe('copy:guide.title')
    expect(definition.guide?.[0]?.description?.()).toBe('copy:guide.description')
  })
})

describe('Agent Browser pane injection', () => {
  /** @returns the inject face the Desktop bridge produced for one Session. */
  function injectFace(mounted: string | undefined) {
    const stub = bridgeStub()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { protocolVersion: 1, agentBrowser: stub.bridge }
    try {
      const host = mount({ mounted })
      const inject = bodyRegistration(host).registration.inject as (id: string, actions: { set: (value: unknown) => void }) => {
        readonly present: (pane: { x: number; y: number; width: number; height: number } | null) => void
        readonly command: (name: string, args: Record<string, string | number | boolean>) => void
      }
      const actions = { set: vi.fn() }
      return { host, stub, face: inject(SESSION, actions), actions }
    } finally {
      delete (globalThis as { dshDesktop?: unknown }).dshDesktop
    }
  }

  it('binds the pane under the Session key the renderer resolved', () => {
    const { stub, face } = injectFace(SESSION)
    face.present({ x: 1, y: 2, width: 300, height: 200 })
    expect(stub.present).toHaveBeenCalledWith(SESSION, { x: 1, y: 2, width: 300, height: 200 })
    face.present(null)
    expect(stub.present).toHaveBeenLastCalledWith(SESSION, null)
  })

  it('runs the pane\u2019s own controls on the Session\u2019s lease', () => {
    const { stub, face } = injectFace(SESSION)
    face.command('reload', {})
    expect(stub.command).toHaveBeenCalledWith(SESSION, 'reload', {})
  })

  it('reports a refused control command instead of failing the pane', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { stub, face } = injectFace(SESSION)
    stub.command.mockRejectedValueOnce(new Error('navigation target is not allowed'))
    face.command('navigate', { url: 'https://example.com' })
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ends every Session subscription with the plugin', () => {
    const { host, stub } = injectFace(SESSION)
    expect(stub.handlers.activity).toHaveLength(1)
    for (const dispose of host.disposers) dispose()
    expect(stub.handlers.activity).toHaveLength(0)
  })

  it('merges only the Session\u2019s own activity into the pane store', () => {
    const { stub, actions } = injectFace(SESSION)
    stub.handlers.activity[0]?.({ leaseId: 'l-1', sessionKey: 'other', busy: true, presented: true })
    expect(actions.set).not.toHaveBeenCalled()
    stub.handlers.activity[0]?.({ leaseId: 'l-1', sessionKey: SESSION, busy: true, presented: true, command: 'navigate' })
    expect(actions.set).toHaveBeenCalledWith({ busy: true, presented: true, command: 'navigate' })
  })

  it('carries the address and the viewport the pane\u2019s controls show', () => {
    const { stub, actions } = injectFace(SESSION)
    stub.handlers.activity[0]?.({
      leaseId: 'l-1', sessionKey: SESSION, busy: false, presented: true,
      url: 'https://example.com/', title: 'Example', viewport: { width: 375, height: 667 }, follow: false,
    })
    expect(actions.set).toHaveBeenCalledWith({
      busy: false, presented: true, url: 'https://example.com/', title: 'Example',
      viewport: { width: 375, height: 667 }, follow: false,
    })
  })

  it('subscribes once per Session occurrence', () => {
    const { host, stub } = injectFace(SESSION)
    const inject = bodyRegistration(host).registration.inject as (id: string, actions: { set: (value: unknown) => void }) => unknown
    inject(SESSION, { set: vi.fn() })
    expect(stub.handlers.activity).toHaveLength(1)
  })

  it('drops the command when the activity carries none', () => {
    const { stub, actions } = injectFace(SESSION)
    stub.handlers.activity[0]?.({ leaseId: 'l-1', sessionKey: SESSION, busy: false, presented: true })
    expect(actions.set).toHaveBeenCalledWith({ busy: false, presented: true })
  })

  it('opens the tab when the shell reveals the on-screen Session', () => {
    const { host, stub } = injectFace(SESSION)
    expect(stub.handlers.reveal).toHaveLength(1)
    stub.handlers.reveal[0]?.(SESSION)
    expect(host.openTab).toHaveBeenCalledWith(AGENT_BROWSER_ID)
  })

  it('holds a reveal for another Session and opens it once that Session arrives', () => {
    // The automation can start in a Session the human is not looking at; the request is
    // kept rather than dropped, because an unopened pane leaves the guest with no surface.
    const { host, stub } = injectFace('session-2')
    stub.handlers.reveal[0]?.(SESSION)
    expect(host.openTab).not.toHaveBeenCalled()
    host.showSession(SESSION)
    expect(host.openTab).toHaveBeenCalledWith(AGENT_BROWSER_ID)
  })

  it('retries a reveal the column had no surface for, and stops once it opens', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { host, stub } = injectFace(SESSION)
    host.openTab.mockImplementationOnce(() => { throw new Error('no session surface is mounted') })
    stub.handlers.reveal[0]?.(SESSION)
    expect(warn).toHaveBeenCalled()
    host.showSession(SESSION)
    expect(host.openTab).toHaveBeenCalledTimes(2)
    host.showSession(SESSION)
    expect(host.openTab).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('holds a reveal until the tab type is registered', () => {
    const stub = bridgeStub()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { protocolVersion: 1, agentBrowser: stub.bridge }
    try {
      const host = mount({ mounted: SESSION, registeredType: false })
      stub.handlers.reveal[0]?.(SESSION)
      expect(host.openTab).not.toHaveBeenCalled()
    } finally {
      delete (globalThis as { dshDesktop?: unknown }).dshDesktop
    }
  })
})
