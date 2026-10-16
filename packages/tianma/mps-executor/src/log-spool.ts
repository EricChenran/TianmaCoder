/**
 * The log a node cannot hand over yet. A platform that is briefly unreachable must not cost
 * the log lines an attempt produced: they describe work that already happened, so a batch
 * the platform did not take is kept on disk and offered again until it does.
 * @module @tianma/dsh-mps-executor/log-spool
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExecResponseError } from '@tianma/dsh-mps-exec-core'
import type { ExecLogLine } from '@tianma/dsh-mps-exec-core'
import { toError } from './report.ts'
import type { ExecutorReport } from './report.ts'

/**
 * Directory under the coding root holding batches the platform has not taken. It lives
 * beside the coding workspaces, never inside one: a workspace is what the node commits.
 */
export const LOG_SPOOL_DIRECTORY = '.buffers'

/** One batch waiting for the platform. */
export interface SpooledBatch {
  /** Idempotency key the platform deduplicates on, so offering a batch twice is harmless. */
  batch_id: string
  /** Attempt the lines belong to, which is how the platform keeps each attempt's log apart. */
  attempt: number
  /** Stream the lines came from. */
  stream: string
  /** The lines, already bounded and redacted. */
  lines: ExecLogLine[]
  /** Whether any line was cut to the per-line limit. */
  truncated: boolean
}

/** Options for {@link logSpool}. */
export interface LogSpoolOptions {
  /** Coding root the spool directory lives under. */
  root: string
  /** Hands one batch to the platform. */
  send: (taskId: string, batch: SpooledBatch) => Promise<void>
  /** Operator-visible sink. */
  report: (report: ExecutorReport) => void
}

/** The spool an attempt's log goes through. */
export interface LogSpool {
  /**
   * Hand one batch over, keeping it on disk when the platform cannot take it.
   * @param taskId - the task the lines belong to.
   * @param batch - the batch.
   */
  post: (taskId: string, batch: SpooledBatch) => Promise<void>
  /**
   * Offer everything the platform has not taken yet. A batch the platform answers on is
   * dropped when it refuses that batch outright; a batch no answer reached is kept.
   */
  flush: () => Promise<void>
}

/**
 * Build the spool.
 * @param options - where it keeps its files, how it sends, and where it reports.
 * @returns the spool.
 */
export function logSpool(options: LogSpoolOptions): LogSpool {
  const directory = join(options.root, LOG_SPOOL_DIRECTORY)

  /** The spool file one task's batches live in. */
  const pathOf = (taskId: string): string => join(directory, `${taskId}.jsonl`)

  /** Read one spool file, dropping lines this node can no longer reconstruct. */
  const read = (path: string): SpooledBatch[] => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      // Whatever is there cannot be read, so there is nothing to send and the reason is
      // worth telling an operator: a spool file the node cannot use is a log that will
      // never arrive.
      options.report({ level: 'warn', message: `log spool ${path} is unreadable: ${toError(error).message}` })
      return []
    }
    const batches: SpooledBatch[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        batches.push(JSON.parse(line) as SpooledBatch)
      } catch {
        // A half-written line describes a batch this node can no longer reconstruct, and
        // keeping it would make every later flush fail on it.
      }
    }
    return batches
  }

  /** Replace one spool file's contents, atomically so a crash cannot merge two writes. */
  const write = (path: string, batches: readonly SpooledBatch[]): void => {
    const temporary = `${path}.writing`
    writeFileSync(temporary, batches.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
    renameSync(temporary, path)
  }

  return {
    async post(taskId: string, batch: SpooledBatch): Promise<void> {
      try {
        await options.send(taskId, batch)
      } catch (error: unknown) {
        // The platform did not take it, so it stays here; the next flush offers it again
        // under the same id, which is what makes sending it twice harmless.
        mkdirSync(directory, { recursive: true })
        const path = pathOf(taskId)
        write(path, [...read(path), batch])
        options.report({
          level: 'warn',
          message: `kept ${String(batch.lines.length)} log line(s) for ${taskId} on disk: ${toError(error).message}`,
        })
      }
    },

    async flush(): Promise<void> {
      let files: string[]
      try {
        files = readdirSync(directory).filter(name => name.endsWith('.jsonl'))
      } catch {
        // Nothing spooled yet: there is no directory to read.
        return
      }
      for (const file of files) {
        const taskId = file.slice(0, -'.jsonl'.length)
        const path = join(directory, file)
        const remaining: SpooledBatch[] = []
        for (const batch of read(path)) {
          try {
            await options.send(taskId, batch)
          } catch (error: unknown) {
            // An answer is final: a batch the platform refuses is not worth keeping, and
            // saying so is how a gap in the log reaches the operator.
            if (error instanceof ExecResponseError) {
              options.report({
                level: 'warn',
                message: `dropped ${String(batch.lines.length)} log line(s) for ${taskId}: the platform refused them (${error.message})`,
              })
              continue
            }
            remaining.push(batch)
          }
        }
        // Whatever shape the entry has, an entry with nothing left to send goes.
        if (remaining.length === 0) rmSync(path, { force: true, recursive: true })
        else write(path, remaining)
      }
    },
  }
}
