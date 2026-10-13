/** Download facts the agent lease tracks for the tabs it drives. */

/** One download started by a guest, as the shell observes it. */
export interface AgentDownloadEvent {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Absolute path once the download completed and the shell saved it. */
  readonly savePath?: string
}

/** What the main process must supply so an agent lease can observe its guests' downloads. */
export interface AgentDownloadWatcher {
  /**
   * Follow downloads started by guests in one storage partition.
   * @param partition - guest storage partition the lease uses.
   * @param listener - receives every state change for every download in that partition.
   * @returns unsubscribe callback.
   */
  watch(partition: string, listener: (event: AgentDownloadEvent) => void): () => void
}

/** One tracked download: the latest event, the tab it started from, and when tracking began. */
export interface AgentDownloadRecord {
  event: AgentDownloadEvent
  readonly tabId: string
  readonly startedAt: number
}

/** @returns whether the download is still running. */
export function isDownloadRunning(event: AgentDownloadEvent): boolean {
  return event.state === 'progressing'
}

/** @returns the download facts the model may see, without shell-internal handles. */
export function downloadSummary(event: AgentDownloadEvent): Record<string, string | number> {
  return {
    id: event.id,
    filename: event.filename,
    url: event.url,
    state: event.state,
    receivedBytes: event.receivedBytes,
    totalBytes: event.totalBytes,
    ...(event.savePath === undefined ? {} : { savePath: event.savePath }),
  }
}
