/** Opt-in qualification evidence outside the installation directory; no raw diagnostics or request data. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { DesktopUpdateState } from './ipc.ts'

/** User and process milestones that connect update states across application restarts. */
export type DesktopUpdateJournalAction = 'started' | 'workspace-ready' | 'workspace-failed'
  | 'check-requested' | 'download-requested' | 'install-confirmed' | 'install-started'
  | 'restart-consumed' | 'quit-requested'
  | 'policy-login-opened' | 'policy-login-returned' | 'policy-login-cancelled' | 'policy-login-failed'

/** The journal fields a later startup reads back; every other field is qualification-only. */
export interface UpdateJournalRecord {
  readonly event: string
  readonly time?: string
  readonly version?: string
  readonly targetVersion?: string
}

const ERROR_CODES = ['ETIMEDOUT', 'ENOSPC', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_CHECKSUM_MISMATCH'] as const

/**
 * Whitelist one update state for disk; neither error text nor unexpected object fields survive.
 * @param state Main-process-owned update state.
 * @returns Only phase, target version, integer progress, operation, and a fixed error classification.
 */
export function desktopUpdateJournalState(state: DesktopUpdateState): object {
  return {
    phase: state.phase,
    ...(state.version !== undefined ? { targetVersion: state.version } : {}),
    ...(state.phase === 'downloading' && state.percent !== undefined ? { percent: Math.floor(state.percent) } : {}),
    ...(state.phase === 'error' ? {
      failedOperation: state.failedOperation,
      errorCode: ERROR_CODES.find(code => state.message?.includes(code)) ?? 'UNCLASSIFIED',
    } : {}),
  }
}

/** Process-owned JSONL evidence; each append is flushed before the caller continues. */
export class DesktopUpdateJournal {
  readonly path: string
  private sequence = 0
  private previousState: string | undefined

  /**
   * @param directory Absolute evidence directory, retained across installs; creation errors stop qualification.
   * @param version Installed application version, not a version supplied by the feed.
   */
  constructor(directory: string, private readonly version: string) {
    if (!isAbsolute(directory)) throw new Error('desktop update journal: directory must be absolute')
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, `${Date.now()}-${randomUUID()}.jsonl`)
    writeFileSync(this.path, '', { flag: 'wx', mode: 0o600, flush: true })
    this.action('started')
  }

  /**
   * Append a fixed action; failures propagate so incomplete qualification is never reported as traced.
   * @param action Update operation or process milestone; no free-text fields are accepted.
   * @returns Nothing after the record has been flushed.
   */
  action(action: DesktopUpdateJournalAction): void { this.append({ event: action }) }

  /**
   * Record the handoff to the installer, so the next startup can tell an interrupted install from a completed one.
   * @param targetVersion Exact version this process asked the installer to apply.
   * @returns Nothing after the record has been flushed; a failed flush aborts the install.
   */
  installStarted(targetVersion: string): void { this.append({ event: 'install-started', targetVersion }) }

  /**
   * Retain state changes and integer progress increments without raw errors, URLs, or request data.
   * @param state Main-process-owned update state.
   * @returns Nothing after the changed state has been flushed; duplicate states add no record.
   */
  state(state: DesktopUpdateState): void {
    const fields = desktopUpdateJournalState(state)
    const encoded = JSON.stringify(fields)
    if (encoded === this.previousState) return
    this.append({ event: 'state', ...fields })
    this.previousState = encoded
  }

  private append(fields: object): void {
    appendFileSync(this.path, `${JSON.stringify({ schemaVersion: 1, sequence: this.sequence++,
      time: new Date().toISOString(), pid: process.pid, version: this.version, ...fields })}\n`, { flush: true })
  }
}

/**
 * Read the retained qualification records in write order, newest last.
 * Files are per-process and named by creation time, so name order is chronological.
 * @param directory Absolute evidence directory; an unreadable directory yields no records.
 * @param limit Maximum records to return, keeping the newest.
 * @returns Parsed records whose recovery-relevant fields survived validation; malformed lines are dropped.
 */
export function readUpdateJournalRecords(directory: string, limit = 64): UpdateJournalRecord[] {
  if (!isAbsolute(directory)) return []
  let names: string[]
  try {
    names = readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()
  } catch {
    // An absent or unreadable evidence directory means nothing was traced; startup continues.
    return []
  }
  const records: UpdateJournalRecord[] = []
  for (const name of names) {
    let text: string
    try {
      text = readFileSync(join(directory, name), 'utf8')
    } catch {
      // One unreadable file must not hide the records other runs did flush.
      continue
    }
    for (const line of text.split('\n')) {
      const record = parseJournalRecord(line)
      if (record !== undefined) records.push(record)
    }
  }
  return records.length <= limit ? records : records.slice(records.length - limit)
}

function parseJournalRecord(line: string): UpdateJournalRecord | undefined {
  if (line.trim() === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    // A truncated final line is expected when the process lost power mid-append.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { event, time, version, targetVersion } = value as Record<string, unknown>
  if (typeof event !== 'string') return undefined
  return {
    event,
    ...(typeof time === 'string' ? { time } : {}),
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof targetVersion === 'string' ? { targetVersion } : {}),
  }
}
