/**
 * Discovers Sessions that another process sharing this Host home materialized
 * after this Host started. The Session list otherwise changes only from
 * in-process lifecycle events plus one baseline pull per Client connection, so
 * a task run by a separate `dsh` process (an MPS executor node, a second CLI
 * run) never reaches a connected sidebar.
 *
 * The scan compares persisted header revisions and announces only the Sessions
 * the local registry does not own: a live Session already publishes its own
 * lifecycle and projection events.
 *
 * @module @deepseek-ai/dsh-api-session-controller/discovery
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionSummary } from './types.ts'

/** How often the Host looks for Sessions another process stored, in milliseconds. */
export const DEFAULT_EXTERNAL_SESSION_SCAN_MS = 2_000

/** Host facts one scan reads and the Client events it publishes. */
export interface ExternalSessionSource {
  /** List stored Sessions with their change tokens. */
  list(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]>
  /** Whether this process owns the Session, in which case its own events are authoritative. */
  isLive(sessionId: SessionId): boolean
  /** Build the list summary of a stored Session without activating it. */
  summarize(record: SessionPersistenceSnapshot): SessionSummary
  /** Publish one stored Session as a list addition (an upsert for later revisions). */
  announce(summary: SessionSummary): void
  /** Advance one row's list recency after a stored revision changed. */
  touch(sessionId: SessionId, updatedAt: number): void
  /** Drop one row whose stored artifact disappeared. */
  remove(sessionId: SessionId): void
  /** Report a failed scan without stopping later attempts. */
  warn(message: string): void
}

/**
 * Polls stored Session headers and publishes the ones this process did not
 * create. The first scan establishes the baseline silently: Clients already
 * receive that history from their connection baseline, so only later
 * materializations are announcements.
 */
export class ExternalSessionWatch {
  private readonly known = new Map<SessionId, SessionPersistenceRevision>()
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: AbortController | undefined
  private seeded = false
  /** Bumped by start and stop, so a listing from an earlier run publishes nothing. */
  private generation = 0

  /**
   * @param source - Host facts and the Client events one change produces.
   * @param intervalMs - positive scan period.
   */
  constructor(
    private readonly source: ExternalSessionSource,
    private readonly intervalMs: number,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error(`external Session scan interval must be a positive integer, got ${String(intervalMs)}`)
    }
  }

  /** Begin scanning; repeated calls keep the one timer. */
  start(): void {
    if (this.timer !== undefined) return
    this.generation += 1
    this.timer = setInterval(() => { void this.scan() }, this.intervalMs)
    this.timer.unref()
    void this.scan()
  }

  /** Stop scanning and abandon an in-flight listing without publishing its result. */
  stop(): void {
    this.generation += 1
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.inFlight?.abort()
    this.inFlight = undefined
  }

  /**
   * Read the stored Session set once and publish what changed since the last
   * scan. A scan already in flight makes this a no-op.
   */
  async scan(): Promise<void> {
    if (this.inFlight !== undefined) return
    const generation = this.generation
    const controller = new AbortController()
    this.inFlight = controller
    let records: readonly SessionPersistenceSnapshot[]
    try {
      records = await this.source.list(controller.signal)
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.source.warn(`external Session scan failed: ${errorMessage(error)}`)
      }
      return
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined
    }
    if (generation !== this.generation) return

    const seen = new Set<SessionId>()
    for (const record of records) {
      // The Host list omits Sessions without a working directory; match it so
      // the watch never announces a row the list would not return.
      if (record.header.cwd === undefined) continue
      const sessionId = record.header.id
      seen.add(sessionId)
      if (this.source.isLive(sessionId)) {
        this.known.set(sessionId, record.revision)
        continue
      }
      if (!this.seeded) {
        this.known.set(sessionId, record.revision)
        continue
      }
      const previous = this.known.get(sessionId)
      if (previous === record.revision) continue
      this.known.set(sessionId, record.revision)
      const summary = this.source.summarize(record)
      this.source.announce(summary)
      // An addition carries the row; a revision change also needs its recency
      // advanced because the row already existed in the Client.
      if (previous !== undefined) this.source.touch(sessionId, summary.updatedAt)
    }
    for (const [sessionId] of this.known) {
      if (seen.has(sessionId)) continue
      this.known.delete(sessionId)
      if (!this.source.isLive(sessionId)) this.source.remove(sessionId)
    }
    this.seeded = true
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
