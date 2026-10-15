/**
 * A result the platform could not take: the outcome an attempt reached is kept and offered
 * again, dropped when the platform no longer leases it, and never submitted twice-running.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { ExecResponseError } from '@tianma/dsh-mps-exec-core'
import type { ExecResultRequest } from '@tianma/dsh-mps-exec-core'
import { RESULT_SPOOL_DIRECTORY, resultSpool } from '@tianma/dsh-mps-executor'
import type { ExecutorReport } from '@tianma/dsh-mps-executor'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/**
 * One result body.
 * @returns the body.
 */
function body(): ExecResultRequest {
  return {
    attempt: 1,
    outcome: 'success',
    started_at: '2026-10-15T04:00:00Z',
    finished_at: '2026-10-15T04:05:00Z',
    summary: 'done',
    evidence: { changed_files: ['feature.txt'], branch: 'b', base_commit: 'a', head_commit: 'c', pushed: true },
  }
}

describe('spooling a result the platform did not take', () => {
  it('keeps one and submits it on the next flush, then lets it go', async () => {
    const root = temporary('mps-result-')
    const sent: { taskId: string; body: ExecResultRequest }[] = []
    const spool = resultSpool({
      root,
      send: async (taskId, value) => { sent.push({ taskId, body: value }) },
      holds: async () => true,
      report: () => {},
    })

    spool.keep('tsk_1', body())
    const file = join(root, RESULT_SPOOL_DIRECTORY, 'tsk_1.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ task_id: 'tsk_1', attempt: 1 })

    await spool.flush()

    expect(sent).toEqual([{ taskId: 'tsk_1', body: body() }])
    expect(existsSync(file)).toBe(false)
  })

  it('drops a result the platform no longer leases, and says so', async () => {
    const root = temporary('mps-result-')
    const reports: ExecutorReport[] = []
    const sent: string[] = []
    const spool = resultSpool({
      root,
      send: async (taskId) => { sent.push(taskId) },
      holds: async () => false,
      report: (report) => { reports.push(report) },
    })

    spool.keep('tsk_2', body())
    await spool.flush()

    // Submitting it would describe work the platform has already reassigned.
    expect(sent).toEqual([])
    expect(reports.some(report => report.message.includes('no longer leases attempt 1'))).toBe(true)
    expect(existsSync(join(root, RESULT_SPOOL_DIRECTORY, 'tsk_2.json'))).toBe(false)
  })

  it('keeps a result no answer reached, and drops one the platform refuses', async () => {
    const root = temporary('mps-result-')
    const reports: ExecutorReport[] = []
    const directory = join(root, RESULT_SPOOL_DIRECTORY)
    mkdirSync(directory, { recursive: true })
    const unreachable = resultSpool({
      root,
      send: async () => { throw new Error('the platform is unreachable') },
      holds: async () => true,
      report: (report) => { reports.push(report) },
    })
    unreachable.keep('tsk_3', body())

    await unreachable.flush()

    // No answer is not a refusal: it waits for the platform to answer again.
    expect(existsSync(join(directory, 'tsk_3.json'))).toBe(true)

    const refused = resultSpool({
      root,
      send: async () => { throw new ExecResponseError('refused', { code: 'TASK_NOT_LEASED_BY_YOU', httpStatus: 409 }) },
      holds: async () => true,
      report: (report) => { reports.push(report) },
    })
    await refused.flush()

    expect(reports.some(report => report.message.includes('the platform refused it'))).toBe(true)
    expect(existsSync(join(directory, 'tsk_3.json'))).toBe(false)
  })

  it('reports a file it cannot read instead of failing the flush, and has nothing to do without one', async () => {
    const root = temporary('mps-result-')
    const reports: ExecutorReport[] = []
    const spool = resultSpool({ root, send: async () => {}, holds: async () => true, report: (report) => { reports.push(report) } })

    await expect(spool.flush()).resolves.toBeUndefined()

    const directory = join(root, RESULT_SPOOL_DIRECTORY)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'tsk_4.json'), '{"task_id":', 'utf8')
    await spool.flush()

    expect(reports.some(report => report.message.includes('is unreadable'))).toBe(true)
    expect(existsSync(join(directory, 'tsk_4.json'))).toBe(false)
  })
})
