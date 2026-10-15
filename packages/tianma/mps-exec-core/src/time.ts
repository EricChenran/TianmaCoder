/**
 * RFC 3339 formatting for the timestamps the protocol carries: every request
 * field named `*_time`, `*_at`, or `expires_at` holds a local-offset timestamp
 * such as `2026-10-15T12:03:55.123+08:00`, and the platform compares node time
 * against its own to detect clock skew.
 * @module @tianma/dsh-mps-exec-core/time
 */

/** Largest offset in minutes a real time zone reaches. */
const MAX_OFFSET_MINUTES = 14 * 60

/** Pad a non-negative integer to two digits. */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/**
 * Format one instant as an RFC 3339 timestamp with a numeric UTC offset.
 * @param date - the instant to format.
 * @param offsetMinutes - offset from UTC in minutes; defaults to the host's current offset.
 * @returns the timestamp, with millisecond precision.
 */
export function formatRfc3339(date: Date, offsetMinutes: number = -date.getTimezoneOffset()): string {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('RFC 3339 formatting requires a valid date')
  }
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    throw new TypeError(`UTC offset must be whole minutes within ${String(MAX_OFFSET_MINUTES)}, got ${String(offsetMinutes)}`)
  }
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const hours = pad2(Math.floor(absolute / 60))
  const minutes = pad2(absolute % 60)
  const fraction = shifted.toISOString().slice(0, 23)
  return `${fraction}${sign}${hours}:${minutes}`
}
