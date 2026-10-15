/**
 * The mark a draining node leaves for the process that replaces it: the last step of an
 * upgrade is a node that takes work again, and only a node that drained has to say so.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { DRAINING_MARKER, drainingMarker } from '@tianma/dsh-mps-executor'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

describe('the mark a draining node leaves', () => {
  it('is absent until a node drains, and gone once it takes work again', () => {
    const root = temporary('mps-drain-')
    const mark = drainingMarker(root)

    expect(mark.kept()).toBe(false)
    mark.keep()
    expect(mark.kept()).toBe(true)
    expect(existsSync(join(root, DRAINING_MARKER))).toBe(true)
    mark.clear()
    expect(mark.kept()).toBe(false)
  })

  it('creates the coding root it writes into', () => {
    const root = join(temporary('mps-drain-'), 'missing', 'coding')
    const mark = drainingMarker(root)

    mark.keep()

    expect(mark.kept()).toBe(true)
  })
})
