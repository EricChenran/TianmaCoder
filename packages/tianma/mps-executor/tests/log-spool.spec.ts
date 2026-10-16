/**
 * The log a node keeps when the platform cannot take it: the lines describe work that
 * already happened, so they wait on disk rather than disappearing with the request.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { ExecResponseError } from '@tianma/dsh-mps-exec-core'
import { LOG_SPOOL_DIRECTORY, logSpool } from '@tianma/dsh-mps-executor'
import type { ExecutorReport, SpooledBatch } from '@tianma/dsh-mps-executor'

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
 * One batch of log lines.
 * @param text - the line.
 * @returns the batch.
 */
function batch(text: string, id = 'batch-1'): SpooledBatch {
  return { batch_id: id, attempt: 1, stream: 'stdout', lines: [{ at: '2026-10-15T04:00:00Z', level: 'info', text }], truncated: false }
}

describe('spooling a log the platform did not take', () => {
  it('leaves nothing behind when the platform takes the batch', async () => {
    const root = temporary('mps-spool-')
    const sent: SpooledBatch[] = []
    const spool = logSpool({ root, send: async (_taskId, entry) => { sent.push(entry) }, report: () => {} })

    await spool.post('tsk_1', batch('built'))

    expect(sent).toHaveLength(1)
    expect(existsSync(join(root, LOG_SPOOL_DIRECTORY))).toBe(false)
  })

  it('keeps a batch it cannot hand over, and sends it under the same id later', async () => {
    const root = temporary('mps-spool-')
    const reports: ExecutorReport[] = []
    const sent: { taskId: string; batch: SpooledBatch }[] = []
    let reachable = false
    const spool = logSpool({
      root,
      send: async (taskId, entry) => {
        if (!reachable) throw new Error('the platform is unreachable')
        sent.push({ taskId, batch: entry })
      },
      report: (report) => { reports.push(report) },
    })

    await spool.post('tsk_1', batch('built', 'batch-kept'))
    const file = join(root, LOG_SPOOL_DIRECTORY, 'tsk_1.jsonl')
    expect(readFileSync(file, 'utf8')).toContain('batch-kept')
    expect(reports.some(report => report.message.includes('kept 1 log line(s) for tsk_1'))).toBe(true)

    reachable = true
    await spool.flush()

    // The same id travels: the platform deduplicates a batch it already has.
    expect(sent).toEqual([{ taskId: 'tsk_1', batch: expect.objectContaining({ batch_id: 'batch-kept' }) }])
    expect(existsSync(file)).toBe(false)
  })

  it('drops a batch the platform refuses instead of keeping it forever', async () => {
    const root = temporary('mps-spool-')
    const reports: ExecutorReport[] = []
    mkdirSync(join(root, LOG_SPOOL_DIRECTORY), { recursive: true })
    writeFileSync(join(root, LOG_SPOOL_DIRECTORY, 'tsk_9.jsonl'), `${JSON.stringify(batch('late'))}\n`, 'utf8')
    const spool = logSpool({
      root,
      send: async () => { throw new ExecResponseError('TASK_NOT_FOUND', { code: 'TASK_NOT_FOUND', httpStatus: 404 }) },
      report: (report) => { reports.push(report) },
    })

    await spool.flush()

    // An answer is final: keeping it would only make every later flush fail on it.
    expect(reports.some(report => report.message.includes('dropped 1 log line(s) for tsk_9'))).toBe(true)
    expect(existsSync(join(root, LOG_SPOOL_DIRECTORY, 'tsk_9.jsonl'))).toBe(false)
  })

  it('keeps a batch no answer reached, and skips a half-written line', async () => {
    const root = temporary('mps-spool-')
    mkdirSync(join(root, LOG_SPOOL_DIRECTORY), { recursive: true })
    const file = join(root, LOG_SPOOL_DIRECTORY, 'tsk_2.jsonl')
    writeFileSync(file, `${JSON.stringify(batch('first'))}\n{"batch_id":"half`, 'utf8')
    const spool = logSpool({ root, send: async () => { throw new Error('still down') }, report: () => {} })

    await spool.flush()

    const kept = readFileSync(file, 'utf8')
    expect(kept).toContain('first')
    // The half-written line cannot be reconstructed, so it is gone rather than retried.
    expect(kept).not.toContain('half')
  })

  it('reports an entry it cannot read instead of failing the flush', async () => {
    const root = temporary('mps-spool-')
    const reports: ExecutorReport[] = []
    const sent: SpooledBatch[] = []
    mkdirSync(join(root, LOG_SPOOL_DIRECTORY, 'tsk_3.jsonl'), { recursive: true })
    const spool = logSpool({
      root,
      send: async (_taskId, entry) => { sent.push(entry) },
      report: (report) => { reports.push(report) },
    })

    await spool.flush()

    expect(sent).toEqual([])
    expect(reports.some(report => report.message.includes('is unreadable'))).toBe(true)
  })

  it('has nothing to flush before anything was spooled', async () => {
    const root = temporary('mps-spool-')
    const spool = logSpool({ root, send: async () => {}, report: () => {} })

    await expect(spool.flush()).resolves.toBeUndefined()
  })
})
