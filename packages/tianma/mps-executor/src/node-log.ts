/**
 * The node's own operational log. A launch through the CLI keeps plugin reports in memory and
 * prints them only when startup itself fails, so a node that is otherwise healthy has nowhere
 * an operator can read why work did not start — which is exactly the state a stalled node is
 * in. Lines are redacted here the way the platform's log lines are, and one file per day keeps
 * the directory from growing without a bound anyone can reason about.
 * @module @tianma/dsh-mps-executor/node-log
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecretText } from '@tianma/dsh-mps-exec-core'
import type { ExecutorReport } from './report.ts'

/** Directory under the coding root holding the node's own reports. */
export const NODE_LOG_DIRECTORY = 'logs'

/** One report, as the file holds it. */
export interface NodeLogRecord {
  /** When the node reported it. */
  at: string
  /** Level the report carried. */
  level: string
  /** What the node said, with credential-shaped text removed. */
  message: string
}

/**
 * Append one report to the day's file.
 * @param root - coding root the log lives under.
 * @param report - what the node reported.
 * @param at - the moment to record, for tests.
 * @returns nothing.
 */
export function appendNodeLog(root: string, report: ExecutorReport, at: Date = new Date()): void {
  const stamp = at.toISOString()
  const directory = join(root, NODE_LOG_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  const record: NodeLogRecord = {
    at: stamp,
    level: report.level,
    message: redactSecretText(report.message),
  }
  appendFileSync(join(directory, `node-${stamp.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}
