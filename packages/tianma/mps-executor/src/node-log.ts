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

/**
 * Most lines one day's file holds. A node that keeps failing the same way reports every
 * time, and an unbounded file would fill the disk the node is protecting.
 */
export const NODE_LOG_MAX_LINES = 5000

/** Lines written per day so far, so the ceiling costs no read of the file. */
const writtenPerDay = new Map<string, number>()

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
 * @param maxLines - lines one day's file holds before it stops and says so.
 * @returns nothing.
 */
export function appendNodeLog(root: string, report: ExecutorReport, at: Date = new Date(), maxLines: number = NODE_LOG_MAX_LINES): void {
  const stamp = at.toISOString()
  const day = stamp.slice(0, 10)
  const directory = join(root, NODE_LOG_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `node-${day}.jsonl`)
  const written = writtenPerDay.get(path) ?? 0
  if (written > maxLines) return
  const record: NodeLogRecord = written === maxLines
    ? { at: stamp, level: 'warn', message: `further reports are dropped from this file: it holds its ceiling of ${String(maxLines)} lines for ${day}` }
    : { at: stamp, level: report.level, message: redactSecretText(report.message) }
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
  writtenPerDay.set(path, written + 1)
}
