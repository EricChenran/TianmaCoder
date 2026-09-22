/**
 * Read-file state view rebuilt from the append-only session log.
 *
 * After a compaction checkpoint lands, the summary carries intent but the
 * model loses the "which files have I read, at what freshness" ledger, so it
 * re-reads blindly or edits against stale content. This module rebuilds that
 * ledger from the full log — the data compaction cannot destroy — and renders
 * it as a compact context section.
 *
 * @module @tianma/dsh-compaction-file-rehydrator/view
 */

/** One tracked file's rebuilt read/edit ledger. */
export interface FileStateEntry {
  /** Path as the read tool received it. */
  readonly path: string
  /** How many read results for this path are in the log. */
  readonly readCount: number
  /** How many write/edit results for this path happened after the last read. */
  readonly editsSinceLastRead: number
  /** Log seq of the last event touching the path. */
  readonly lastSeq: number
}

/** The rebuilt ledger plus the accounting the section renderer needs. */
export interface FileStateView {
  /** Entries with at least one read, newest-touch first. */
  readonly entries: readonly FileStateEntry[]
  /** Read results skipped because their tool call carried no parseable path. */
  readonly skippedUnreadable: number
}

/** Tools whose first string argument (or `path`/`file_path` field) is a path. */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'tool-read', 'view'])
/** Tools that mutate a file, bumping `editsSinceLastRead`. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'tool-write', 'tool-edit', 'applypatch', 'multiedit'])

interface LogEventLike {
  readonly type: string
  readonly data: {
    message?: {
      source?: { callId?: string }
    }
    callId?: string
    name?: string
    arguments?: string
  }
}

/** Extract a file path from a tool-call arguments JSON, tolerating shapes. */
function pathFromArguments(argumentsJson: string | undefined): string | undefined {
  if (argumentsJson === undefined) return undefined
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>
    for (const key of ['path', 'file_path', 'filePath', 'file']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    const firstString = Object.values(parsed).find(value => typeof value === 'string')
    return typeof firstString === 'string' && firstString.length > 0 ? firstString : undefined
  } catch {
    return undefined
  }
}

/**
 * Rebuild the read/edit ledger from a session's event list. Only the log is
 * consulted — the current surface may have been compacted away, and the log
 * is precisely the part compaction cannot destroy.
 * @param events - the session's full event list, in log order.
 * @returns the rebuilt ledger with skip accounting.
 */
export function buildFileStateView(events: readonly unknown[]): FileStateView {
  const argsByCall = new Map<string, string | undefined>()
  const byPath = new Map<string, {
    readCount: number
    editsSinceLastRead: number
    lastSeq: number
  }>()
  let skippedUnreadable = 0

  const nameByCall = new Map<string, string>()
  for (const unknownEvent of events) {
    const event = unknownEvent as LogEventLike
    if (event.type === 'tool/call' && event.data.callId !== undefined) {
      nameByCall.set(event.data.callId, event.data.name ?? '')
      argsByCall.set(event.data.callId, event.data.arguments)
    }
  }
  for (const [seq, unknownEvent] of events.entries()) {
    const event = unknownEvent as LogEventLike
    if (event.type !== 'tool/result') continue
    const callId = event.data.message?.source?.callId
    if (callId === undefined) continue
    const name = (nameByCall.get(callId) ?? '').toLowerCase()
    const isRead = READ_TOOLS.has(name)
    const isWrite = WRITE_TOOLS.has(name)
    if (!isRead && !isWrite) continue
    const path = pathFromArguments(argsByCall.get(callId))
    if (path === undefined) {
      if (isRead) skippedUnreadable += 1
      continue
    }
    const entry = byPath.get(path) ?? { readCount: 0, editsSinceLastRead: 0, lastSeq: seq }
    if (isRead) entry.readCount += 1
    else entry.editsSinceLastRead += 1
    entry.lastSeq = seq
    byPath.set(path, entry)
  }

  const entries = [...byPath.entries()]
    .filter(([, entry]) => entry.readCount > 0)
    .sort((a, b) => b[1].lastSeq - a[1].lastSeq)
    .map(([path, entry]) => ({
      path,
      readCount: entry.readCount,
      editsSinceLastRead: entry.editsSinceLastRead,
      lastSeq: entry.lastSeq,
    }))
  return { entries, skippedUnreadable }
}

/**
 * Render the ledger as a bounded context section. Files edited after their
 * last read are listed first and flagged — those are exactly the ones a
 * post-compaction model would stale-edit.
 * @param view - the rebuilt ledger.
 * @param maxChars - upper bound for the rendered section text.
 * @returns the section text, or an empty string when there is nothing to say.
 */
export function renderRehydrationSection(view: FileStateView, maxChars = 4_000): string {
  if (view.entries.length === 0) return ''
  const lines: string[] = [
    '# Files you have read this session (rebuilt after compaction)',
    '',
    'Re-read any file before editing it if its content is not otherwise in your context. Files marked STALE were changed after your last read.',
    '',
  ]
  let used = lines.join('\n').length
  let listed = 0
  for (const entry of view.entries) {
    const stale = entry.editsSinceLastRead > 0
    const line = `- ${stale ? 'STALE: ' : ''}${entry.path}`
      + ` (reads: ${entry.readCount}, edits since last read: ${entry.editsSinceLastRead})`
    if (used + line.length + 1 > maxChars) {
      lines.push(`- … ${view.entries.length - listed} more files omitted (re-read by path as needed)`)
      break
    }
    lines.push(line)
    used += line.length + 1
    listed += 1
  }
  return lines.join('\n')
}
