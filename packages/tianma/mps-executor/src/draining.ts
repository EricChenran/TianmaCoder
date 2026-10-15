/**
 * The mark a draining node leaves behind. A node that said it was draining and then
 * stopped is resumed by the process that replaces it, which is the last step of the
 * upgrade sequence; a node that never drained has nothing to clear and says nothing.
 * @module @tianma/dsh-mps-executor/draining
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File under the coding root holding that mark. */
export const DRAINING_MARKER = '.draining'

/** The mark: whether the node that ran here last left one. */
export interface DrainingMarker {
  /** Whether the node that ran here last said it was draining. */
  readonly kept: () => boolean
  /** Record that this node is draining. */
  readonly keep: () => void
  /** Clear the mark, because this node is taking work again. */
  readonly clear: () => void
}

/**
 * Build the mark for one coding root.
 * @param root - the coding root the mark lives under.
 * @returns the mark.
 */
export function drainingMarker(root: string): DrainingMarker {
  const path = join(root, DRAINING_MARKER)
  return {
    kept: () => existsSync(path),
    keep: () => {
      mkdirSync(root, { recursive: true })
      writeFileSync(path, 'draining\n', 'utf8')
    },
    clear: () => { rmSync(path, { force: true }) },
  }
}
