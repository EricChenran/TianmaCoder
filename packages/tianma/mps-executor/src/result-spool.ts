/**
 * A result the platform could not take. A submission is retried, and when the platform is
 * simply unreachable the outcome an attempt reached is worth more than the retries: it is
 * kept under the coding root and offered again, first when the platform answers again and
 * again after a restart, so a task's outcome is not left for a lease to expire over.
 * @module @tianma/dsh-mps-executor/result-spool
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExecResponseError } from '@tianma/dsh-mps-exec-core'
import type { ExecResultRequest } from '@tianma/dsh-mps-exec-core'
import { toError } from './report.ts'
import type { ExecutorReport } from './report.ts'

/**
 * Directory under the coding root holding results the platform has not taken. It lives
 * beside the coding workspaces, never inside one: a workspace is what the node commits.
 */
export const RESULT_SPOOL_DIRECTORY = '.results'

/** One result waiting for the platform. */
export interface SpooledResult {
  /** Task the result belongs to. */
  task_id: string
  /** Attempt it reports, which is what makes offering it twice harmless. */
  attempt: number
  /** The body to submit, as it was built. */
  body: ExecResultRequest
}

/** Options for {@link resultSpool}. */
export interface ResultSpoolOptions {
  /** Coding root the spool directory lives under. */
  root: string
  /** Hands one result to the platform. */
  send: (taskId: string, body: ExecResultRequest) => Promise<void>
  /**
   * Whether the platform still leases the task at that attempt. A result for a task the
   * platform has since reassigned is discarded rather than submitted.
   */
  holds: (taskId: string, attempt: number) => Promise<boolean>
  /** Operator-visible sink. */
  report: (report: ExecutorReport) => void
}

/** The spool a settled attempt's result goes through. */
export interface ResultSpool {
  /** Keep one result for later. */
  keep: (taskId: string, body: ExecResultRequest) => void
  /** Offer everything the platform has not taken yet. */
  flush: () => Promise<void>
}

/**
 * Build the spool.
 * @param options - where it keeps its files, how it sends, and where it reports.
 * @returns the spool.
 */
export function resultSpool(options: ResultSpoolOptions): ResultSpool {
  const directory = join(options.root, RESULT_SPOOL_DIRECTORY)

  /** Read one spooled result, if the file is one this node can use. */
  const read = (path: string): SpooledResult | undefined => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SpooledResult
    } catch (error: unknown) {
      // A result this node cannot read is one it cannot submit; the reason is worth a line
      // because the alternative is an outcome nobody hears about.
      options.report({ level: 'warn', message: `spooled result ${path} is unreadable: ${toError(error).message}` })
      return undefined
    }
  }

  return {
    keep(taskId: string, body: ExecResultRequest): void {
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `${taskId}.json`)
      const temporary = `${path}.writing`
      writeFileSync(temporary, JSON.stringify({ task_id: taskId, attempt: body.attempt, body }), 'utf8')
      renameSync(temporary, path)
    },

    async flush(): Promise<void> {
      let files: string[]
      try {
        files = readdirSync(directory).filter(name => name.endsWith('.json'))
      } catch {
        // Nothing spooled yet: there is no directory to read.
        return
      }
      for (const file of files) {
        const path = join(directory, file)
        const spooled = read(path)
        if (spooled === undefined) {
          rmSync(path, { force: true })
          continue
        }
        if (await options.holds(spooled.task_id, spooled.attempt) === false) {
          // The platform no longer leases this attempt, so its result would describe work
          // the platform has already reassigned.
          options.report({
            level: 'warn',
            message: `dropping the spooled result for ${spooled.task_id}: the platform no longer leases attempt ${String(spooled.attempt)}`,
          })
          rmSync(path, { force: true })
          continue
        }
        try {
          await options.send(spooled.task_id, spooled.body)
        } catch (error: unknown) {
          // An answer is final: a result the platform refuses is not worth keeping.
          if (error instanceof ExecResponseError) {
            options.report({
              level: 'error',
              message: `dropped the spooled result for ${spooled.task_id}: the platform refused it (${error.message})`,
            })
            rmSync(path, { force: true })
          }
          continue
        }
        rmSync(path, { force: true })
      }
    },
  }
}
