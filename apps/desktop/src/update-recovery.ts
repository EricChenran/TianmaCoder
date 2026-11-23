/** Startup decision derived from the update journal, so an interrupted install never looks like a fresh launch. */
import type { UpdateJournalRecord } from './update-journal.ts'

/**
 * What this launch should do about an install a previous launch handed to the installer.
 * `manual` means repeated attempts never completed, so the UI offers a download instead of retrying.
 */
export type StartupUpdateRecovery =
  | { readonly kind: 'none' }
  | { readonly kind: 'completed'; readonly version: string }
  | { readonly kind: 'failed'; readonly version: string }
  | { readonly kind: 'manual'; readonly version: string }

/** Consecutive unconsumed install handoffs that turn startup recovery into a manual download. */
export const STARTUP_UPDATE_RETRY_LIMIT = 3

/**
 * Decide how this launch treats the last install handoff.
 *
 * A `restart-consumed` record closes every earlier handoff, because that launch already reported
 * the outcome. Otherwise the newest `install-started` decides: the installed version proves the
 * installer ran, a different version proves it did not finish, and repeated handoffs mean retrying
 * in place is not working.
 * @param records Journal records in write order, oldest first.
 * @param currentVersion Version this process is actually running.
 * @returns The recovery decision; `none` when no handoff is outstanding.
 */
export function resolveStartupUpdateRecovery(
  records: readonly UpdateJournalRecord[],
  currentVersion: string,
): StartupUpdateRecovery {
  let pending: string | undefined
  let attempts = 0
  for (const record of records) {
    if (record.event === 'restart-consumed') {
      pending = undefined
      attempts = 0
      continue
    }
    if (record.event !== 'install-started') continue
    const version = record.targetVersion ?? record.version
    if (version === undefined) continue
    pending = version
    attempts += 1
  }
  if (pending === undefined) return { kind: 'none' }
  if (pending === currentVersion) return { kind: 'completed', version: pending }
  if (attempts >= STARTUP_UPDATE_RETRY_LIMIT) return { kind: 'manual', version: pending }
  return { kind: 'failed', version: pending }
}
