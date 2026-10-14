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
  const bridge: DesktopAgentBrowserBridge = {
    present,
    onActivity(listener) {
      handlers.activity.push(listener)
      return () => { handlers.activity = handlers.activity.filter(entry => entry !== listener) }
    },
    onReveal(listener) {
      handlers.reveal.push(listener)
      return () => { handlers.reveal = handlers.reveal.filter(entry => entry !== listener) }
    },
  }
  return { bridge, handlers, present }
}

/** The mounting context the plugin needs, capturing every registration it makes. */
function hostContext(options: { readonly mounted?: string | undefined; readonly registeredType?: boolean } = {}) {
  const registrations: CapturedRegistration[] = []
  const injections: Array<{ readonly key: string; readonly run: () => unknown }> = []
  const dictionaries = new Map<string, unknown>()
  const disposers: Array<() => void> = []
  const openTab = vi.fn()
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
      mounted: { getSnapshot: () => options.mounted },
      openTab,
    },
  }
  return { ctx: ctx as never, registrations, injections, dictionaries, disposers, openTab }
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

  it('leaves the tab alone for another Session or an unregistered type', () => {
    const other = injectFace('session-2')
    other.stub.handlers.reveal[0]?.(SESSION)
    expect(other.host.openTab).not.toHaveBeenCalled()

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

  it('keeps working when the right Sidebar has no Session surface to open into', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { host, stub } = injectFace(SESSION)
    host.openTab.mockImplementation(() => { throw new Error('no session surface is mounted') })
    expect(() => { stub.handlers.reveal[0]?.(SESSION) }).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
