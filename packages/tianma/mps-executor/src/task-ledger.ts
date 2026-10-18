/**
 * The task ledger: one JSON line per task event, under the node's operator
 * directory, so the surface that supervises the node — the GUI's Settings page,
 * or an operator reading the file — can show what the node took and how each
 * attempt settled without going through the platform.
 *
 * @module @tianma/dsh-mps-executor/task-ledger
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** File under the operator directory holding the ledger. */
export const TASK_LEDGER_FILE = 'task-ledger.jsonl'

/** Most ledger lines a reader is offered; the file itself is append-only. */
export const TASK_LEDGER_MAX_LINES = 200

/** One line of the ledger. */
export interface TaskLedgerEntry {
  /** When the event happened, as an RFC 3339 string. */
  at: string
  /** Which event this line carries. */
  event: 'claimed' | 'settled'
  /** Protocol task id, which is the platform's work-item id. */
  task_id: string
  /** Work-item kind as the platform dispatched it. */
  kind: string
  /** Attempt number. */
  attempt: number
  /** Outcome of a settled attempt. */
  outcome?: string | undefined
  /** Operator-visible summary of a settled attempt. */
  summary?: string | undefined
  /** Session reference the attempt used, once one was reported. */
  session?: string | undefined
  /** Directory the attempt worked in, when it worked in one. */
  workspace?: string | undefined
}

/** Writes and reads the task ledger of one node. */
export interface TaskLedger {
  /** Append one event. */
  append(entry: TaskLedgerEntry): void
  /** Read the most recent lines, oldest first. */
  recent(maxLines?: number): TaskLedgerEntry[]
}

/**
 * Build the ledger for one operator directory.
 * @param root - the operator directory, created when missing.
 * @returns the ledger.
 */
export function taskLedger(root: string): TaskLedger {
  const path = join(root, TASK_LEDGER_FILE)
  return {
    append(entry: TaskLedgerEntry): void {
      mkdirSync(root, { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
    },
    recent(maxLines = TASK_LEDGER_MAX_LINES): TaskLedgerEntry[] {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return []
      }
      const lines = text.split('\n').filter(line => line !== '')
      const entries: TaskLedgerEntry[] = []
      for (const line of lines.slice(-maxLines)) {
        try {
          entries.push(JSON.parse(line) as TaskLedgerEntry)
        } catch {
          // A line this reader cannot parse is skipped, not fatal: the ledger is
          // an operator surface, and one torn line must not hide the rest.
        }
      }
      return entries
    },
  }
}
