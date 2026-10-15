/**
 * The session serving a coding workspace: what the node records beside the
 * workspace, what it tells the platform, and what a restart re-reports.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { WorkspaceStore, checkoutSessionReporter, restoredSessionReports } from '@tianma/dsh-mps-executor'
import type { TaskSessionReporter } from '@tianma/dsh-mps-executor'
import type { ExecSessionReportRequest, ExecTaskAssignment } from '@tianma/dsh-mps-exec-core'

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

/** The session reports one test's client received. */
class RecordingPlatform {
  readonly reports: { workspaceId: string; body: ExecSessionReportRequest }[] = []
  failure: Error | undefined

  async reportSession(workspaceId: string, body: ExecSessionReportRequest): Promise<void> {
    this.reports.push({ workspaceId, body })
    if (this.failure !== undefined) throw this.failure
  }
}

/** One payload as the platform dispatches it. */
function assignment(payload: Record<string, unknown>): ExecTaskAssignment {
  return {
    task_id: 'tsk_1',
    work_item_id: 'wi_1',
    attempt: 1,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2026-10-15T04:16:00.123+08:00',
    lease_renew_seconds: 30,
    payload,
  }
}

/** One store over a coding root of its own. */
function storeWith(root: string): WorkspaceStore {
  return new WorkspaceStore({ root, now: () => new Date('2026-10-15T04:03:55.123Z') })
}

describe('workspace sessions', () => {
  it('records the session beside the workspace and reports it', async () => {
    const root = temporary('mps-coding-')
    const store = storeWith(root)
    const platform = new RecordingPlatform()
    const reporter: TaskSessionReporter = checkoutSessionReporter({ store, client: platform })
    const directory = await store.ensure('ws_1', 'tsk_1')

    await reporter.report({
      assignment: assignment({ workspace: { workspace_id: 'ws_1' } }),
      directory,
      sessionRef: 'dsh-session-01H8Z',
      baseCommit: 'a1b2c3d',
    })

    expect(store.records[0]?.session).toEqual({
      ref: 'dsh-session-01H8Z',
      base_commit: 'a1b2c3d',
      last_task_id: 'tsk_1',
    })
    expect(platform.reports).toEqual([{
      workspaceId: 'ws_1',
      body: {
        session_ref: 'dsh-session-01H8Z',
        coding_path: directory,
        base_commit: 'a1b2c3d',
        last_task_id: 'tsk_1',
      },
    }])
  })

  it('refuses to report a session for a task that names no workspace', async () => {
    const root = temporary('mps-coding-')
    const reporter = checkoutSessionReporter({ store: storeWith(root), client: new RecordingPlatform() })

    await expect(reporter.report({
      assignment: assignment({}),
      directory: join(root, 'ws_1'),
      sessionRef: 'dsh-session-01H8Z',
      baseCommit: 'a1b2c3d',
    })).rejects.toThrow(/names no workspace/)
  })

  it('re-reports what a restart restored, and only what has a session', async () => {
    const root = temporary('mps-coding-')
    const store = storeWith(root)
    const platform = new RecordingPlatform()
    await store.ensure('ws_with_session', 'tsk_1')
    await store.ensure('ws_without_session', 'tsk_2')
    await checkoutSessionReporter({ store, client: platform }).report({
      assignment: assignment({ workspace: { workspace_id: 'ws_with_session' } }),
      directory: store.directoryOf('ws_with_session'),
      sessionRef: 'dsh-session-01H8Z',
      baseCommit: 'a1b2c3d',
    })

    const restarted = storeWith(root)
    await restarted.load()

    expect(restoredSessionReports(restarted)).toEqual([{
      workspace_id: 'ws_with_session',
      body: {
        session_ref: 'dsh-session-01H8Z',
        coding_path: restarted.directoryOf('ws_with_session'),
        base_commit: 'a1b2c3d',
        last_task_id: 'tsk_1',
      },
    }])
  })

  it('keeps the session across further tasks in the same workspace', async () => {
    const root = temporary('mps-coding-')
    const store = storeWith(root)
    const platform = new RecordingPlatform()
    const reporter = checkoutSessionReporter({ store, client: platform })
    await store.ensure('ws_1', 'tsk_1')
    await reporter.report({
      assignment: assignment({ workspace: { workspace_id: 'ws_1' } }),
      directory: store.directoryOf('ws_1'),
      sessionRef: 'dsh-session-01H8Z',
      baseCommit: 'a1b2c3d',
    })

    await store.ensure('ws_1', 'tsk_2')

    expect(store.records[0]?.last_task_id).toBe('tsk_2')
    expect(store.records[0]?.session?.ref).toBe('dsh-session-01H8Z')
  })
})
