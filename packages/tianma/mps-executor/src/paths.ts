/**
 * The one place that decides whether a path is inside a coding workspace. The node
 * hands the platform paths it later reports, and it reads and writes only inside the
 * workspace it keeps, so both directions of that rule live here rather than in each
 * caller: a path is accepted only as a relative path that resolves inside the
 * workspace once symlinks and junctions are resolved.
 * @module @tianma/dsh-mps-executor/paths
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

/**
 * Whether a resolved path sits strictly inside the root.
 * @param root - the resolved root.
 * @param target - the resolved path.
 * @returns true when the path is below the root.
 */
export function isInside(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/**
 * Keep one of the node's own files out of the repository's index. The entry goes into
 * `.git/info/exclude`, which is local to the clone: a workspace that is not a
 * repository needs none, because there is no index to keep it out of.
 * @param directory - the workspace directory.
 * @param entry - the workspace-relative entry to exclude.
 */
export function excludeFromRepository(directory: string, entry: string): void {
  const exclude = join(directory, '.git', 'info', 'exclude')
  if (!existsSync(exclude)) return
  const current = readFileSync(exclude, 'utf8')
  if (current.split(/\r?\n/u).includes(entry)) return
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  writeFileSync(exclude, `${current}${separator}${entry}\n`, 'utf8')
}

/**
 * Resolve one workspace-relative path to its absolute location.
 * @param directory - the workspace directory.
 * @param file - the path, as the payload or a runner states it.
 * @returns the resolved absolute path.
 * @throws Error on an absolute path, a path that climbs out, or a path that resolves
 * outside the workspace through a link.
 */
export async function resolveWithinWorkspace(directory: string, file: string): Promise<string> {
  const root = await realpath(directory)
  if (isAbsolute(file) || file.split(/[/\\]/u).includes('..')) {
    throw new Error(`refusing ${file}: it is not a path inside the workspace`)
  }
  const target = join(root, file)
  if (existsSync(target)) {
    const resolved = await realpath(target)
    if (!isInside(root, resolved)) {
      throw new Error(`refusing ${file}: it resolves outside the workspace at ${resolved}`)
    }
    return resolved
  }
  // A path that is not on disk any more is judged by where it lived.
  const parent = await realpath(dirname(target))
  if (parent !== root && !isInside(root, parent)) {
    throw new Error(`refusing ${file}: it resolves outside the workspace at ${parent}`)
  }
  return target
}
