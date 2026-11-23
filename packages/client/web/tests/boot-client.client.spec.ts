// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import {
  createClientModuleSystem, parseBootManifest,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget, type WebBootEntry, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertEntriesActive, bootClient, type EntryStateLabel } from '../src/boot-client.ts'
import { FIBER_STATE } from '../src/loader-status.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'

/** A row inside {@link requiredClientEntryNames}: its failure must still reject the boot. */
const REQUIRED_ROW = '@deepseek-ai/dsh-client-ui-chat'

/** A client package outside the required set: its failure degrades the page, not the boot. */
const OPTIONAL_ROW = '@deepseek-ai/dsh-client-ui-dockkit'

function graphOf(ids: readonly string[]): WebBootGraph {
  const entries: WebBootEntry[] = ids.map(id => ({ id, url: `/${id}.js`, rev: '1' }))
  return {
    rev: 'graph',
    entries,
    batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: [...ids] }],
  }
}

/** Module system seeded with inline plugin modules; `loaded` records every transport call. */
function modulesOf(graph: WebBootGraph, staticModules: Record<string, unknown>): { modules: ClientModuleLoader; loaded: string[] } {
  const loaded: string[] = []
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: BOOTSTRAP_ID, exports: {} }, options),
  }
  const modules = target.create({
    boot: graph,
    staticModules,
    loadBundle: async (url) => { loaded.push(url) },
  })
  return { modules, loaded }
}

/** Recording progress sink. */
function stateSink(): { states: Map<string, EntryStateLabel[]>; onEntryState: (name: string, state: EntryStateLabel) => void } {
  const states = new Map<string, EntryStateLabel[]>()
  return {
    states,
    onEntryState: (name, state) => { states.set(name, [...(states.get(name) ?? []), state]) },
  }
}

describe('bootClient', () => {
  it('activates every seeded row without touching the bundle transport', async () => {
    const graph = graphOf(['provider', 'consumer'])
    const { modules, loaded } = modulesOf(graph, {
      provider: { apply: (ctx: Context) => { ctx.reflect.provide('x', { marker: 'x' }) } },
      consumer: { inject: ['x'], apply: () => {} },
    })
    const ctx = new Context()
    const sink = stateSink()

    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })

    expect(loaded).toEqual([])
    const consumer = sink.states.get('consumer') ?? []
    expect(consumer[0]).toBe('loading')
    expect(consumer.at(-1)).toBe('active')
    expect(sink.states.get('provider')?.at(-1)).toBe('active')
    await ctx.fiber.dispose()
  })

  it('reports a required row waiting on a service the roster never provides', async () => {
    const graph = graphOf([REQUIRED_ROW])
    const { modules } = modulesOf(graph, { [REQUIRED_ROW]: { inject: ['nothing'], apply: () => {} } })
    const ctx = new Context()

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(
      `${REQUIRED_ROW} (required): pending (waiting for service: nothing)`,
    )
    await ctx.fiber.dispose()
  })

  it('reports and logs an import failure for a required row that is neither seeded nor a graph row', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf([REQUIRED_ROW]))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const sink = stateSink()

    await expect(bootClient({ ctx, modules, manifest, onEntryState: sink.onEntryState })).rejects.toThrow(
      `web boot: 1 required entry did not activate\n${REQUIRED_ROW} (required): import failed (see console for the import error)`,
    )
    expect(sink.states.get(REQUIRED_ROW)).toEqual(['loading', 'failed'])
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toHaveProperty('message', expect.stringContaining('client-modules: cannot resolve'))
  })

  it('boots when only an optional row fails to import', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf([OPTIONAL_ROW]))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const sink = stateSink()

    await expect(bootClient({ ctx, modules, manifest, onEntryState: sink.onEntryState })).resolves.toBeUndefined()
    expect(sink.states.get(OPTIONAL_ROW)).toEqual(['loading', 'failed'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain(`${OPTIONAL_ROW}: import failed`)
  })
})

describe('assertEntriesActive', () => {
  interface FakeEntry { name: string; fiber?: { state: number; inject: Record<string, null> } }

  /** Loader-shaped double: entries with scripted fiber states, services by name. */
  function auditCtx(entries: readonly FakeEntry[], services: Record<string, unknown> = {}): Context {
    return {
      loader: {
        * entries() {
          for (const entry of entries) yield { options: { name: entry.name }, fiber: entry.fiber }
        },
      },
      get: (name: string) => services[name],
    } as unknown as Context
  }

  const silent = { importError: () => undefined }

  /** Record `console.warn` lines for the "optional row skipped" assertions. */
  function warnSink(): string[] {
    const lines: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: string) => { lines.push(line) })
    onTestFinished(() => { warn.mockRestore() })
    return lines
  }

  it('passes when every entry is active', () => {
    const ctx = auditCtx([{ name: REQUIRED_ROW, fiber: { state: FIBER_STATE.ACTIVE, inject: {} } }])
    expect(() => { assertEntriesActive(ctx, silent) }).not.toThrow()
  })

  it('names import failures, missing services, and other non-active states of required rows', () => {
    const ctx = auditCtx([
      { name: '@deepseek-ai/dsh-client-ui-chat' },
      { name: '@deepseek-ai/dsh-client-ui-layout', fiber: { state: FIBER_STATE.PENDING, inject: { present: null, a: null, b: null } } },
      { name: '@deepseek-ai/dsh-client-ui-renderer', fiber: { state: FIBER_STATE.PENDING, inject: {} } },
      { name: '@deepseek-ai/dsh-client-ui-workspace', fiber: { state: FIBER_STATE.FAILED, inject: {} } },
    ], { present: {} })

    expect(() => { assertEntriesActive(ctx, silent) }).toThrow([
      'web boot: 4 required entries did not activate',
      '@deepseek-ai/dsh-client-ui-chat (required): import failed (see console for the import error)',
      '@deepseek-ai/dsh-client-ui-layout (required): pending (waiting for services: a, b)',
      '@deepseek-ai/dsh-client-ui-renderer (required): pending (waiting for services: unknown)',
      '@deepseek-ai/dsh-client-ui-workspace (required): failed',
    ].join('\n'))
  })

  it('warns instead of rejecting when only optional rows are inactive', () => {
    const warnings = warnSink()
    const ctx = auditCtx([
      { name: REQUIRED_ROW, fiber: { state: FIBER_STATE.ACTIVE, inject: {} } },
      { name: OPTIONAL_ROW, fiber: { state: FIBER_STATE.FAILED, inject: {} } },
    ])

    expect(() => { assertEntriesActive(ctx, silent) }).not.toThrow()
    expect(warnings).toEqual([`web boot: optional entry did not activate: ${OPTIONAL_ROW}: failed`])
  })

  it('uses the singular form for one failing required entry', () => {
    warnSink()
    expect(() => { assertEntriesActive(auditCtx([{ name: REQUIRED_ROW }]), silent) }).toThrow('web boot: 1 required entry did not activate\n')
  })

  it('names the recorded import error of a fiberless required row and notes skipped optional rows', () => {
    warnSink()
    const recorded = new Map([[REQUIRED_ROW, new Error('client-modules: could not load "x": bundle script failed to load')]])
    const modules = { importError: (id: string) => recorded.get(id) }
    expect(() => { assertEntriesActive(auditCtx([{ name: REQUIRED_ROW }, { name: OPTIONAL_ROW }]), modules) }).toThrow([
      'web boot: 1 required entry did not activate',
      `${REQUIRED_ROW} (required): import failed: client-modules: could not load "x": bundle script failed to load`,
      '(1 optional entry skipped)',
    ].join('\n'))
  })
})
