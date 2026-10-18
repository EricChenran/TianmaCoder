/**
 * The one place that decides whether a file name is one Windows and the workspace can
 * carry. A name the platform or an attempt states may arrive wrapped in the quotes of
 * the sentence it was read from, and Windows refuses `"` in a name outright — so a path
 * built from it can never exist on disk, no matter how many times it is retried. Every
 * name the node adopts from outside itself goes through here before it is joined onto
 * a workspace.
 * @module @tianma/dsh-mps-executor/filenames
 */

/** Characters no Windows file name may carry, plus the C0 control range. */
const ILLEGAL = /[\u0000-\u001f<>:"|?*]/gu

/**
 * Make one file name one that can exist: drop the characters Windows refuses, collapse
 * the whitespace the sentence around a name may have left, and trim. Chinese characters
 * are kept — they are legal in a name and only ever appear in content file names the
 * node does not choose itself.
 * @param name - the stated file name.
 * @returns the name with illegal characters removed.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(ILLEGAL, '').replace(/\s+/gu, ' ').trim()
}

/**
 * Clean one stated path the way the node adopts it: each segment is sanitized, and the
 * wrapping quotes a name picked up from plan text — `"助手介绍.md"` — are stripped, so
 * the path names the file that was actually written. Segments that say nothing (`.`,
 * empty) drop out, and the separator style the path arrived in is kept, so a caller
 * comparing the cleaned path against what it stated still matches.
 * @param path - the stated workspace-relative path.
 * @returns the cleaned path; empty when nothing usable remains.
 */
export function cleanStatedPath(path: string): string {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  return path
    .split(/[/\\]/u)
    .map(segment => sanitizeFilename(segment).replace(/^['"`]+/u, '').replace(/['"`]+$/u, ''))
    .filter(segment => segment !== '' && segment !== '.')
    .join(separator)
}
