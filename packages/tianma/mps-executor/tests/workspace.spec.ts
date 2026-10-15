/**
 * The coding workspaces a node keeps: one directory per platform workspace under
 * the coding root, the sidecar state that survives a restart, and the release that
 * is the only thing allowed to remove a directory.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  WORKSPACE_STATE_FILE,
  WORKSPACE_STATE_VERSION,
  WorkspaceStore,
  releasableWorkspaces,
} from '@tianma/dsh-mps-executor'
import type { ExecutorReport } from '@tianma/dsh-mps-executor'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix for the directory.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** One store over a coding root of its own. */
function storeWith(options: { root?: string; reports?: ExecutorReport[] } = {}): {
  store: WorkspaceStore
  root: string
  reports: ExecutorReport[]
} {
  const root = options.root ?? temporary('mps-coding-')
  const reports = options.reports ?? []
  const store = new WorkspaceStore({
    root,
    now: () => new Date('2026-10-15T04:03:55.123Z'),
    report: (report) => { reports.push(report) },
  })
  return { store, root, reports }
}

describe('naming the workspaces a node could release', () => {
  it('lists the ids it keeps, and says so plainly when it keeps none', () => {
    expect(releasableWorkspaces([])).toBe('none')
    expect(releasableWorkspaces([{ workspace_id: 'ws_1' }, { workspace_id: 'ws_2' }])).toBe('ws_1, ws_2')
  })
})

describe('coding workspaces', () => {
  it('creates one directory per workspace and records the use', async () => {
    const { store, root } = storeWith()

    const directory = await store.ensure('ws_1', 'tsk_1')

    expect(directory).toBe(join(root, 'ws_1'))
    expect(store.statePath).toBe(join(root, WORKSPACE_STATE_FILE))
    expect(existsSync(directory)).toBe(true)
    expect(store.records).toEqual([{
      workspace_id: 'ws_1',
      directory,
      last_used_at: '2026-10-15T12:03:55.123+08:00',
      last_task_id: 'tsk_1',
      session: undefined,
    }])
    const state = JSON.parse(readFileSync(store.statePath, 'utf8')) as { version: number; workspaces: unknown[] }
    expect(state.version).toBe(WORKSPACE_STATE_VERSION)
    expect(state.workspaces).toHaveLength(1)
  })

  it('reuses the directory across tasks and keeps its session reference', async () => {
    const { store } = storeWith()
    await store.ensure('ws_1', 'tsk_1')
    await store.setSession('ws_1', { ref: 'dsh-session-1', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })

    const again = await store.ensure('ws_1', 'tsk_2')

    expect(again).toBe(store.directoryOf('ws_1'))
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toMatchObject({ last_task_id: 'tsk_2', session: { ref: 'dsh-session-1', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' } })
  })

  it('refuses a session for a workspace it does not hold', async () => {
    const { store } = storeWith()
    await expect(store.setSession('ws_missing', { ref: 'dsh-session-1', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })).rejects.toThrow(/is not held by this node/)
  })

  it('restores what it kept across a restart', async () => {
    const { store, root } = storeWith()
    await store.ensure('ws_1', 'tsk_1')
    await store.setSession('ws_1', { ref: 'dsh-session-1', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })

    const restarted = new WorkspaceStore({ root })
    expect(restarted.loaded).toBe(false)
    await restarted.load()

    expect(restarted.loaded).toBe(true)
    expect(restarted.records).toEqual(store.records)
    await restarted.load()
    expect(restarted.records).toHaveLength(1)
  })

  it('starts quietly when there is no state file yet', async () => {
    const { store, reports } = storeWith()
    await store.load()
    expect(store.records).toEqual([])
    expect(reports).toEqual([])
  })

  it('reports state it cannot use and keeps the directories it cannot read about', async () => {
    const { store, reports } = storeWith()
    writeFileSync(store.statePath, '{ not json', 'utf8')

    await store.load()

    expect(store.records).toEqual([])
    expect(reports.some(report => report.level === 'warn' && report.message.includes('is not usable'))).toBe(true)
  })

  it('rejects a state file of another version', async () => {
    const { store, reports } = storeWith()
    writeFileSync(store.statePath, JSON.stringify({ version: 99, workspaces: [] }), 'utf8')

    await store.load()

    expect(store.records).toEqual([])
    expect(reports.some(report => report.message.includes('is not usable'))).toBe(true)
  })

  it('rejects a versioned file that carries no workspace list', async () => {
    const { store, reports } = storeWith()
    writeFileSync(store.statePath, JSON.stringify({ version: WORKSPACE_STATE_VERSION }), 'utf8')

    await store.load()

    expect(store.records).toEqual([])
    expect(reports.some(report => report.message.includes('is not usable'))).toBe(true)
  })

  it('releases a workspace the platform released, and only then', async () => {
    const { store, reports } = storeWith()
    const directory = await store.ensure('ws_1', 'tsk_1')

    expect(await store.release('ws_missing')).toBe(false)
    expect(await store.release('ws_1')).toBe(true)

    expect(existsSync(directory)).toBe(false)
    expect(store.records).toEqual([])
    expect(reports.some(report => report.message.includes('released coding workspace ws_1'))).toBe(true)
    const state = JSON.parse(readFileSync(store.statePath, 'utf8')) as { workspaces: unknown[] }
    expect(state.workspaces).toEqual([])
  })

  it('orders the workspaces it holds by their last use', async () => {
    const { store } = storeWith()
    let clock = 1
    const ticking = new WorkspaceStore({
      root: store.root,
      now: () => new Date(1_800_000_000_000 + (clock += 1000)),
    })
    await ticking.ensure('ws_first', 'tsk_1')
    await ticking.ensure('ws_second', 'tsk_2')

    expect(ticking.records.map(record => record.workspace_id)).toEqual(['ws_second', 'ws_first'])
  })

  it('works with the clock and the report sink it is not given', async () => {
    const root = temporary('mps-coding-')
    const store = new WorkspaceStore({ root })
    writeFileSync(store.statePath, JSON.stringify({ version: WORKSPACE_STATE_VERSION, workspaces: [null, { workspace_id: 'ws_x' }] }), 'utf8')

    await store.load()

    expect(store.records).toEqual([{
      workspace_id: 'ws_x',
      directory: 'undefined',
      session: undefined,
      last_task_id: undefined,
      last_used_at: 'undefined',
    }])
    await expect(store.ensure('ws_new', 'tsk_1')).resolves.toBe(join(root, 'ws_new'))

    writeFileSync(store.statePath, '{ broken', 'utf8')
    const broken = new WorkspaceStore({ root })
    await broken.load()
    expect(broken.records).toEqual([])
  })

  it('reports state it cannot read at all', async () => {
    const { store, reports } = storeWith()
    mkdirSync(store.statePath, { recursive: true })

    await store.load()

    expect(reports.some(report => report.level === 'warn' && report.message.includes('is unreadable'))).toBe(true)
  })

  it('rejects a state file that is not even an object', async () => {
    const { store, reports } = storeWith()
    writeFileSync(store.statePath, JSON.stringify('not a state file'), 'utf8')

    await store.load()

    expect(store.records).toEqual([])
    expect(reports.some(report => report.message.includes('is not usable'))).toBe(true)
  })

  it('holds every workspace to one path segment', async () => {
    const { store, root } = storeWith()
    for (const id of ['', '   ', '.', '..', 'ws/other', 'ws\\other', 'C:\\outside', '../outside']) {
      await expect(store.ensure(id, 'tsk_1')).rejects.toThrow(/one path segment/)
    }
    expect(existsSync(join(root, 'coding'))).toBe(false)
  })

  it('refuses to remove a directory that resolves outside the coding root', async () => {
    const { store, root } = storeWith()
    const outside = temporary('mps-outside-')
    mkdirSync(join(outside, 'keep'), { recursive: true })
    const link = join(root, 'ws_link')
    mkdirSync(root, { recursive: true })
    symlinkSync(outside, link, 'junction')
    await store.ensure('ws_link', 'tsk_1')

    await expect(store.release('ws_link')).rejects.toThrow(/does not resolve inside the coding root/)
    expect(existsSync(join(outside, 'keep'))).toBe(true)
  })
})
