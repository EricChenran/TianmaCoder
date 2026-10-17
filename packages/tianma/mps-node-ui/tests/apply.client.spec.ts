/**
 * Registration through one apply: the section must reach the Settings page under
 * this plugin's own id and order, its first read must fill the snapshot the
 * component observes, and a refused Remote call must surface the Host's message
 * rather than leaving the surface busy.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { MpsNodeLogLine, MpsNodeStatus } from '@tianma/dsh-mps-node-control/types'
import { zh, type MpsNodeKey } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

/** What a stubbed `slots.register` captured. */
interface Registered {
  options: { id?: string; order?: number; locale?: string; label?: () => string; inject?: () => unknown }
  component: unknown
}

/** One reading of a node that is running. */
const RUNNING: MpsNodeStatus = {
  phase: 'running',
  profile: 'mps-node',
  pid: 4321,
  startedAt: '2026-10-16T09:00:00.000Z',
}

/** One line the node printed. */
const LINE: MpsNodeLogLine = { stream: 'stdout', at: '2026-10-16T09:00:01.000Z', text: 'registered at the platform' }

/** One deployment-parameter reading the Host can return. */
const CONFIG = {
  saved: { platformHost: 'mps.example.com' },
  effective: {
    platformHost: { value: 'mps.example.com', source: 'saved' },
    platformPort: { value: '8791', source: 'environment' },
    platformScheme: { source: 'unset' },
    platformBasePath: { source: 'unset' },
    nodeId: { source: 'unset' },
    nodeName: { source: 'unset' },
    nodeHost: { source: 'unset' },
    workspaceRoot: { source: 'unset' },
    slotsTotal: { source: 'unset' },
  },
}

/**
 * One host carrying the node surface over stubbed client services.
 * @param options - the Remote answers to build the stub with.
 * @returns the context, what it registered, and the injected operations.
 */
async function surface(options: {
  status?: () => Promise<unknown>
  logs?: () => Promise<unknown>
  start?: () => Promise<unknown>
  stop?: () => Promise<unknown>
  config?: () => Promise<unknown>
  saveConfig?: (form: unknown) => Promise<unknown>
} = {}): Promise<{ registered: Registered[]; operations: () => Record<string, (...args: never[]) => Promise<unknown>> }> {
  const ctx = new Context()
  const registered: Registered[] = []
  const remote = {
    mpsNodeControl: {
      status: options.status ?? (() => Promise.resolve({ ok: true, value: RUNNING })),
      logs: options.logs ?? (() => Promise.resolve({ ok: true, value: [LINE] })),
      start: options.start ?? (() => Promise.resolve({ ok: true, value: RUNNING })),
      stop: options.stop ?? (() => Promise.resolve({ ok: true, value: { phase: 'stopped', profile: 'mps-node' } })),
      config: options.config ?? (() => Promise.resolve({ ok: true, value: CONFIG })),
      saveConfig: options.saveConfig ?? ((form: unknown) => Promise.resolve({ ok: true, value: { ...CONFIG, saved: form } })),
    },
  }
  ctx.provide('slots', {
    inject: (_name: string, register: () => void) => { register() },
    register: (options: Registered['options'], component: unknown) => { registered.push({ options, component }) },
  } as never)
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: MpsNodeKey) => zh[key],
  } as never)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.mpsNodeControl', remote.mpsNodeControl as never)

  await ctx.plugin({ inject: [...inject], apply }).await()
  return {
    registered,
    operations: () => registered[0]?.options.inject?.() as Record<string, (...args: never[]) => Promise<void>>,
  }
}

describe('the node apply owns the Settings section', () => {
  it('registers the section under its own id, order, label, and namespace', async () => {
    const { registered } = await surface()

    expect(registered).toHaveLength(1)
    expect(registered[0]?.options.id).toBe('mps-node')
    expect(registered[0]?.options.order).toBe(-5)
    expect(registered[0]?.options.locale).toBe('settings.mpsNode')
    expect(registered[0]?.options.label?.()).toBe(zh['nav'])
    expect(registered[0]?.component).toBeTypeOf('function')
  })

  it('fills the observed snapshot from the first read', async () => {
    const { operations } = await surface()
    const hooks = operations() as unknown as { hooks: { mpsNode: { getSnapshot: () => unknown } } }

    await vi.waitFor(() => {
      expect(hooks.hooks.mpsNode.getSnapshot()).toMatchObject({ status: RUNNING, lines: [LINE], config: CONFIG, unreadable: false })
    })
  })

  it('saves the deployment form and reports what the Host refused', async () => {
    const refused = await surface({
      saveConfig: () => Promise.resolve({ ok: false, error: { message: 'platformPort is out of range' } }),
    })
    const refusedOps = refused.operations()
    expect(await refusedOps['saveConfig']?.({ platformPort: 'not a port' } as never)).toBe(false)
    const refusedHooks = refusedOps as unknown as { hooks: { mpsNode: { getSnapshot: () => Record<string, unknown> } } }
    expect(refusedHooks.hooks.mpsNode.getSnapshot()).toMatchObject({
      configBusy: false,
      configSaved: false,
      configError: 'platformPort is out of range',
    })

    const accepted = await surface()
    const acceptedOps = accepted.operations()
    expect(await acceptedOps['saveConfig']?.({ platformHost: 'mps.example.com' } as never)).toBe(true)
    const acceptedHooks = acceptedOps as unknown as { hooks: { mpsNode: { getSnapshot: () => Record<string, unknown> } } }
    expect(acceptedHooks.hooks.mpsNode.getSnapshot()).toMatchObject({
      configBusy: false,
      configSaved: true,
      configError: undefined,
    })
  })

  it('reports a refused start with the Host message and leaves nothing busy', async () => {
    const { operations } = await surface({
      start: () => Promise.resolve({ ok: false, error: { message: 'nothing to launch; state the dsh entry' } }),
    })
    const injected = operations()
    const hooks = injected as unknown as { hooks: { mpsNode: { getSnapshot: () => Record<string, unknown> } } }

    await injected['start']?.()

    expect(hooks.hooks.mpsNode.getSnapshot()).toMatchObject({
      busy: false,
      error: 'nothing to launch; state the dsh entry',
    })
  })

  it('says the node state is unreadable when the Host refuses the read', async () => {
    const { operations } = await surface({ status: () => Promise.resolve({ ok: false, error: {} }) })
    const hooks = operations() as unknown as { hooks: { mpsNode: { getSnapshot: () => Record<string, unknown> } } }

    await vi.waitFor(() => {
      expect(hooks.hooks.mpsNode.getSnapshot()).toMatchObject({ unreadable: true, error: '' })
    })
  })
})
