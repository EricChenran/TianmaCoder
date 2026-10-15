/**
 * Retry schedules: how long a failed task attempt waits before the platform may
 * re-dispatch it, and how long one failed request waits before the node repeats
 * it. Both are fixed here so the client and the node lifecycle cannot drift.
 * @module @tianma/dsh-mps-exec-core/backoff
 */

/** Delays after the first, second, and third task attempts, per the protocol. */
export const TASK_ATTEMPT_DELAYS_MS: readonly number[] = [60_000, 300_000, 1_800_000]

/** The first request-retry delay. */
export const REQUEST_RETRY_BASE_MS = 500

/** The longest request-retry delay. */
export const REQUEST_RETRY_MAX_MS = 30_000

/**
 * The delay before a re-dispatched task may be attempted again.
 * @param attempt - the attempt that just failed, counting from 1.
 * @returns the delay in milliseconds, capped at the final scheduled delay.
 */
export function taskAttemptDelayMs(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), TASK_ATTEMPT_DELAYS_MS.length) - 1
  return TASK_ATTEMPT_DELAYS_MS[index] as number
}

/**
 * The delay before one failed request is repeated: doubling from
 * {@link REQUEST_RETRY_BASE_MS} to {@link REQUEST_RETRY_MAX_MS}, with jitter so
 * nodes that lost the same platform do not retry in lockstep.
 * @param attempt - the attempt that just failed, counting from 1.
 * @param random - source of jitter in `[0, 1)`; injectable for deterministic tests.
 * @returns the delay in milliseconds.
 */
export function requestRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.max(Math.trunc(attempt), 1) - 1
  const ceiling = Math.min(REQUEST_RETRY_BASE_MS * 2 ** index, REQUEST_RETRY_MAX_MS)
  const floor = Math.ceil(ceiling / 2)
  return Math.min(floor + Math.floor(random() * (ceiling - floor + 1)), REQUEST_RETRY_MAX_MS)
}

/**
 * The delay a `Retry-After` header demands, which overrides the local schedule.
 * @param header - the header value: a delta in seconds or an HTTP date.
 * @param nowMs - the current time, used for the HTTP-date form.
 * @returns the delay in milliseconds, or `undefined` when the header is absent or unreadable.
 */
export function retryAfterDelayMs(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined
  const trimmed = header.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(date - nowMs, 0)
}
