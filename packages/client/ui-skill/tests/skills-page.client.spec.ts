/**
 * Skills page controller: selection following, catalog reads through the
 * shared per-Session fetch port, the disabled-list write path, and the two
 * row groups the page renders.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SKILL_DISABLED_FIELD, SKILL_REGISTRY_ENTRY, type SkillRegistrySettings } from '../src/client/skill-registry-settings.ts'
import { SkillsPageController, type SkillsPagePorts, type SkillsPageState } from '../src/client/skills-page.ts'

const sid = (id: string) => id as SessionId

/** One catalog row as the `skills/list` Remote returns it. */
const skill = (name: string, description = `${name} description`, path?: string) => ({
  name,
  description,
  ...(path === undefined ? {} : { path }),
  modelInvocable: true,
})

/** A deferred catalog read the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** One settings section as the shared form publishes it. */
function fakeForm(
  section: SkillRegistrySettings | undefined,
  writable: boolean,
  setOutcome?: () => Promise<boolean>,
) {
  const stub = stubConfigForm<SkillRegistrySettings>()
  stub.publish({
    status: section === undefined ? 'unavailable' : 'ready',
    value: section,
    writable,
  })
  // An accepted write publishes the merged section, as the Host acceptance would.
  const set = vi.fn((field: string, value: unknown): Promise<boolean> => {
    if (setOutcome !== undefined) return setOutcome()
    if (!writable) return Promise.resolve(false)
    stub.publish({ value: { ...(stub.scope.getSnapshot().value ?? {}), [field]: value } })
    return Promise.resolve(true)
  })
  return {
    set,
    scope: { ...stub.scope, set },
    publish: (next: SkillRegistrySettings | undefined, isWritable = writable) => {
      stub.publish({ status: next === undefined ? 'unavailable' : 'ready', value: next, writable: isWritable })
    },
  }
}

/** The main column's selection as the page reads it. */
function fakeSessions(ctx: Context) {
  type Row = { id: string; retainedBy: { mainView?: number | undefined }; cwd?: string | undefined }
  const store = createSnapshotStore<{ byId: Record<string, Row> }>({ byId: {} })
  ctx.provide('sessions', { list: store })
  return {
    retain: (id: string, cwd = `/home/${id}`) => {
      store.update((draft) => { draft.byId[id] = { id, retainedBy: { mainView: 1 }, cwd } })
    },
    release: (id: string) => {
      store.update((draft) => {
        const row = draft.byId[id]
        if (row !== undefined) draft.byId[id] = { id: row.id, retainedBy: {}, cwd: row.cwd }
      })
    },
  }
}

interface Harness {
  page: SkillsPageController
  sessions: ReturnType<typeof fakeSessions>
  form: ReturnType<typeof fakeForm>
  loadCatalog: ReturnType<typeof vi.fn>
  invalidateCatalog: ReturnType<typeof vi.fn>
  openSkillFile: ReturnType<typeof vi.fn>
  state: () => SkillsPageState
  dispose: () => Promise<void>
}

/** Boot one controller over a plugin fiber with the faces it reads. */
async function harness(options: {
  catalog?: ReturnType<typeof skill>[]
  failTimes?: number
  section?: SkillRegistrySettings | undefined
  writable?: boolean
  setOutcome?: () => Promise<boolean>
} = {}): Promise<Harness> {
  const ctx = new Context()
  const sessions = fakeSessions(ctx)
  const form = fakeForm(options.section ?? {}, options.writable ?? true, options.setOutcome)
  ctx.provide('configForms', { get: vi.fn(() => form.scope) })
  new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
  let reads = 0
  const failTimes = options.failTimes ?? 0
  const loadCatalog = vi.fn(async () => {
    reads += 1
    if (reads <= failTimes) throw new Error('catalog unavailable')
    return options.catalog ?? []
  })
  const invalidateCatalog = vi.fn()
  const openSkillFile = vi.fn()
  const ports: SkillsPagePorts = { loadCatalog, invalidateCatalog, openSkillFile }
   let page: SkillsPageController | undefined
  const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
  const dispose = async (): Promise<void> => { await fiber.dispose() }
  onTestFinished(dispose)
  await fiber.await()
  const controller = page as SkillsPageController
  return {
    page: controller,
    sessions,
    form,
    loadCatalog,
    invalidateCatalog,
    openSkillFile,
    state: () => controller.store.getSnapshot(),
    dispose,
  }
}

describe('SkillsPageController', () => {
  it('reports the empty selection until a session is retained', async () => {
    const h = await harness({ catalog: [skill('a')] })
    h.page.ensure()
    expect(h.state().status).toBe('no-session')
    expect(h.loadCatalog).not.toHaveBeenCalled()
    expect(h.state().available).toEqual([])
  })

  it('loads the retained session catalog into the available group', async () => {
    const h = await harness({
      catalog: [skill('a', 'A desc', '/x/a/SKILL.md'), { ...skill('b'), modelInvocable: false }],
    })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    expect(h.state().available).toEqual([
      { name: 'a', description: 'A desc', path: '/x/a/SKILL.md', modelInvocable: true },
      { name: 'b', description: 'b description', path: undefined, modelInvocable: false },
    ])
    expect(h.state().disabled).toEqual([])
    expect(h.state().writable).toBe(true)
    // A second ensure follows the same selection and reads nothing new.
    h.page.ensure()
    expect(h.loadCatalog).toHaveBeenCalledTimes(1)
  })

  it('splits a disabled name into the off group and keeps its remembered text', async () => {
    const h = await harness({ catalog: [skill('a'), skill('b')], section: { disabled: ['b', 'ghost'] } })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    expect(h.state().available.map(row => row.name)).toEqual(['a'])
    expect(h.state().disabled.map(row => row.name)).toEqual(['b', 'ghost'])
    expect(h.state().disabled[0]).toMatchObject({ description: 'b description', modelInvocable: true })
    // A name this page never saw enabled carries the name alone.
    expect(h.state().disabled[1]).toMatchObject({ description: undefined, modelInvocable: false })
  })

  it('follows the selection and drops the previous catalog', async () => {
    const h = await harness({ catalog: [skill('a')] })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    h.sessions.release('s1')
    h.sessions.retain('s2')
    await vi.waitFor(() =>{  expect(h.loadCatalog).toHaveBeenCalledTimes(2) })
    expect(h.state().available.map(row => row.name)).toEqual(['a'])
    h.sessions.release('s2')
    await vi.waitFor(() =>{  expect(h.state().status).toBe('no-session') })
    expect(h.state().available).toEqual([])
  })

  it('reports a failed read and recovers on refresh', async () => {
    const h = await harness({ failTimes: 1 })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('error') })
    expect(h.state().error).toBe('catalog unavailable')
    // The next read succeeds, so the page recovers without a manual refresh.
    h.page.refresh()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    expect(h.state().error).toBeUndefined()
  })

  it('keeps the current rows when a quiet reload fails', async () => {
    const h = await harness({ failTimes: 1 })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('error') })
    h.page.refresh()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    expect(h.invalidateCatalog).toHaveBeenCalledWith(sid('s1'))
  })

  it('ignores a read superseded by a newer selection', async () => {
    const ctx = new Context()
    const sessions = fakeSessions(ctx)
    const form = fakeForm({}, true)
    ctx.provide('configForms', { get: vi.fn(() => form.scope) })
    new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
    const first = deferred<ReturnType<typeof skill>[]>()
    const loadCatalog = vi.fn(async () => first.promise)
    const ports: SkillsPagePorts = { loadCatalog, invalidateCatalog: vi.fn(), openSkillFile: vi.fn() }
    let page: SkillsPageController | undefined
    const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
    onTestFinished(async () => { await fiber.dispose() })
    await fiber.await()
    const controller = page as SkillsPageController
    sessions.retain('s1')
    controller.ensure()
    expect(loadCatalog).toHaveBeenCalledTimes(1)
    sessions.release('s1')
    sessions.retain('s2')
    await vi.waitFor(() =>{  expect(loadCatalog).toHaveBeenCalledTimes(2) })
    // The stale answer arrives last and must not replace the newer catalog.
    first.resolve([skill('stale')])
    await vi.waitFor(() =>{  expect(controller.store.getSnapshot().status).toBe('loading') })
    expect(controller.store.getSnapshot().available).toEqual([])
  })

  it('ignores a failed read superseded by a newer selection', async () => {
    const ctx = new Context()
    const sessions = fakeSessions(ctx)
    const form = fakeForm({}, true)
    ctx.provide('configForms', { get: vi.fn(() => form.scope) })
    new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
    const first = deferred<ReturnType<typeof skill>[]>()
    const loadCatalog = vi.fn(async () => first.promise)
    const ports: SkillsPagePorts = { loadCatalog, invalidateCatalog: vi.fn(), openSkillFile: vi.fn() }
    let page: SkillsPageController | undefined
    const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
    onTestFinished(async () => { await fiber.dispose() })
    await fiber.await()
    const controller = page as SkillsPageController
    sessions.retain('s1')
    controller.ensure()
    sessions.release('s1')
    sessions.retain('s2')
    await vi.waitFor(() =>{  expect(loadCatalog).toHaveBeenCalledTimes(2) })
    first.reject('catalog down')
    // The stale failure lands on the older generation; the newer one reports it.
    await vi.waitFor(() =>{  expect(controller.store.getSnapshot().status).toBe('error') })
    expect(controller.store.getSnapshot().error).toBe('catalog down')
  })

  it('keeps the phase and records the diagnostic when a quiet reload fails', async () => {
    const ctx = new Context()
    const sessions = fakeSessions(ctx)
    const form = fakeForm({}, true)
    ctx.provide('configForms', { get: vi.fn(() => form.scope) })
    new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
    let reads = 0
    const loadCatalog = vi.fn(async () => {
      reads += 1
      if (reads === 1) return [skill('a')]
      // A non-Error rejection exercises the plain-string diagnostic.
      throw 'catalog down'
    })
    const ports: SkillsPagePorts = { loadCatalog, invalidateCatalog: vi.fn(), openSkillFile: vi.fn() }
    let page: SkillsPageController | undefined
    const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
    onTestFinished(async () => { await fiber.dispose() })
    await fiber.await()
    const controller = page as SkillsPageController
    sessions.retain('s1')
    controller.ensure()
    await vi.waitFor(() =>{  expect(controller.store.getSnapshot().status).toBe('ready') })
    // A preset switch reloads quietly; the failure keeps the rows standing.
    ctx.emit('connection/reset')
    await vi.waitFor(() =>{  expect(controller.store.getSnapshot().error).toBe('catalog down') })
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().available.map(row => row.name)).toEqual(['a'])
  })

  it('ignores a settled read after disposal', async () => {
    const ctx = new Context()
    const sessions = fakeSessions(ctx)
    const form = fakeForm({}, true)
    ctx.provide('configForms', { get: vi.fn(() => form.scope) })
    new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
    const gate = deferred<ReturnType<typeof skill>[]>()
    const ports: SkillsPagePorts = { loadCatalog: vi.fn(() => gate.promise), invalidateCatalog: vi.fn(), openSkillFile: vi.fn() }
    let page: SkillsPageController | undefined
    const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
    await fiber.await()
    const controller = page as SkillsPageController
    sessions.retain('s1')
    controller.ensure()
    await fiber.dispose()
    gate.resolve([skill('late')])
    expect(controller.store.getSnapshot().status).toBe('loading')
  })

  it('ignores a failed read after disposal', async () => {
    const ctx = new Context()
    const sessions = fakeSessions(ctx)
    const form = fakeForm({}, true)
    ctx.provide('configForms', { get: vi.fn(() => form.scope) })
    new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
    const gate = deferred<ReturnType<typeof skill>[]>()
    const ports: SkillsPagePorts = { loadCatalog: vi.fn(() => gate.promise), invalidateCatalog: vi.fn(), openSkillFile: vi.fn() }
    let page: SkillsPageController | undefined
    const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
    await fiber.await()
    const controller = page as SkillsPageController
    sessions.retain('s1')
    controller.ensure()
    await fiber.dispose()
    gate.reject(new Error('late failure'))
    expect(controller.store.getSnapshot().status).toBe('loading')
  })

  it('skips a refresh without a session', async () => {
    const h = await harness({ catalog: [skill('a')] })
    h.page.refresh()
    expect(h.loadCatalog).not.toHaveBeenCalled()
  })

  it('ignores a switch settlement after disposal', async () => {
    const gate = deferred<boolean>()
    const h = await harness({
      catalog: [skill('a')],
      section: { disabled: [] },
      setOutcome: () => gate.promise,
    })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    h.page.setEnabled('a', false)
    expect(h.state().busy).toEqual(['a'])
    await h.dispose()
    gate.resolve(true)
    expect(h.state().busy).toEqual(['a'])
  })

  it('writes the disabled list when a switch turns a skill off', async () => {
    const h = await harness({ catalog: [skill('a'), skill('b')], section: { disabled: [] } })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    h.page.setEnabled('b', false)
    await vi.waitFor(() =>{  expect(h.state().disabled.map(row => row.name)).toEqual(['b']) })
    expect(h.form.set).toHaveBeenCalledWith(SKILL_DISABLED_FIELD, ['b'])
    expect(h.invalidateCatalog).toHaveBeenCalledWith(sid('s1'))
    expect(h.state().available.map(row => row.name)).toEqual(['a'])
    expect(h.state().busy).toEqual([])
    expect(h.state().writeFailed).toBe(false)
    // The remembered text survives the move to the off group.
    expect(h.state().disabled[0]?.description).toBe('b description')
  })

  it('writes the disabled list when a switch turns a skill back on', async () => {
    const h = await harness({ catalog: [skill('a')], section: { disabled: ['b'] } })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    h.page.setEnabled('b', true)
    await vi.waitFor(() =>{  expect(h.form.set).toHaveBeenCalledWith(SKILL_DISABLED_FIELD, []) })
    expect(h.state().disabled).toEqual([])
  })

  it('refuses writes without a session, without a writable Host, and while one is in flight', async () => {
    const h = await harness({ catalog: [skill('a')], section: { disabled: [] } })
    h.page.setEnabled('a', false)
    expect(h.form.set).not.toHaveBeenCalled()

    const readOnly = await harness({ catalog: [skill('a')], section: { disabled: [] }, writable: false })
    readOnly.sessions.retain('s1')
    readOnly.page.ensure()
    await vi.waitFor(() =>{  expect(readOnly.state().status).toBe('ready') })
    expect(readOnly.state().writable).toBe(false)
    readOnly.page.setEnabled('a', false)
    expect(readOnly.form.set).not.toHaveBeenCalled()

    const gate = deferred<boolean>()
    const ctx = new Context()
    const sessions = fakeSessions(ctx)
    const form = fakeForm({ disabled: [] }, true, () => gate.promise)
    ctx.provide('configForms', { get: vi.fn(() => form.scope) })
    new TestRemote(ctx, { skills: { list: () => Promise.resolve({ ok: true as const, value: { skills: [] } }) } })
    const ports: SkillsPagePorts = {
      loadCatalog: vi.fn(async () => [skill('a')]),
      invalidateCatalog: vi.fn(),
      openSkillFile: vi.fn(),
    }
    let page: SkillsPageController | undefined
    const fiber = ctx.plugin({ inject: [], apply: (scope) => { page = new SkillsPageController(scope, ports) } })
    onTestFinished(async () => { await fiber.dispose() })
    await fiber.await()
    const controller = page as SkillsPageController
    sessions.retain('s1')
    controller.ensure()
    await vi.waitFor(() =>{  expect(controller.store.getSnapshot().status).toBe('ready') })
    controller.setEnabled('a', false)
    expect(controller.store.getSnapshot().busy).toEqual(['a'])
    // A second request for the same row is dropped while the write runs.
    controller.setEnabled('a', false)
    gate.resolve(true)
    await vi.waitFor(() =>{  expect(controller.store.getSnapshot().busy).toEqual([]) })
  })

  it('marks the page when the Host refuses or drops a write', async () => {
    const refused = await harness({ catalog: [skill('a')], section: { disabled: [] } })
    refused.sessions.retain('s1')
    refused.page.ensure()
    await vi.waitFor(() =>{  expect(refused.state().status).toBe('ready') })
    refused.form.set.mockResolvedValueOnce(false)
    refused.page.setEnabled('a', false)
    await vi.waitFor(() =>{  expect(refused.state().writeFailed).toBe(true) })
    expect(refused.state().busy).toEqual([])

    const failed = await harness({ catalog: [skill('a')], section: { disabled: [] } })
    failed.sessions.retain('s1')
    failed.page.ensure()
    await vi.waitFor(() =>{  expect(failed.state().status).toBe('ready') })
    failed.form.set.mockRejectedValueOnce(new Error('transport down'))
    failed.page.setEnabled('a', false)
    await vi.waitFor(() =>{  expect(failed.state().writeFailed).toBe(true) })
    expect(failed.state().busy).toEqual([])
  })

  it('leaves a row in its asked state alone', async () => {
    const h = await harness({ catalog: [skill('a')], section: { disabled: [] } })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    h.page.setEnabled('a', true)
    expect(h.form.set).not.toHaveBeenCalled()
  })

  it('reveals a remembered instruction file and ignores the rest', async () => {
    const h = await harness({ catalog: [skill('a', 'a description', '/x/a/SKILL.md')], section: { disabled: [] } })
    h.sessions.retain('s1')
    h.page.ensure()
    await vi.waitFor(() =>{  expect(h.state().status).toBe('ready') })
    h.page.openFile('a')
    expect(h.openSkillFile).toHaveBeenCalledWith(sid('s1'), '/x/a/SKILL.md')
    h.page.openFile('missing')
    expect(h.openSkillFile).toHaveBeenCalledTimes(1)

    const bare = await harness({ catalog: [skill('a')] })
    bare.sessions.retain('s1')
    bare.page.ensure()
    await vi.waitFor(() =>{  expect(bare.state().status).toBe('ready') })
    bare.page.openFile('a')
    expect(bare.openSkillFile).not.toHaveBeenCalled()
    expect(SKILL_REGISTRY_ENTRY).toBe('skill')
    expect(SKILL_DISABLED_FIELD).toBe('disabled')
  })
})
