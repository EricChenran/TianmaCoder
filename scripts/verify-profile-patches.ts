/**
 * Fail-closed verifier for bundle patch row references.
 *
 * Tianma bundle patches override dsh-base rows by id. When an upstream row id
 * drifts, a stale override silently stops applying. This gate parses the base
 * bundle patch and every Tianma patch file, then asserts each referenced id
 * exists exactly once in the base layer, so drift fails CI instead of shipping.
 *
 * Static YAML analysis is deliberate: it needs no profile boot, no plugins,
 * and no credentials, so it runs in every PR including docs-only ones.
 *
 * @module scripts/verify-profile-patches
 */

import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

/** One parsed patch operation (`- insert:` or a row override). */
interface PatchOp {
  insert?: Array<Record<string, unknown>>
  id?: string
  name?: string
  [key: string]: unknown
}

export interface VerificationFailure {
  readonly patchPath: string
  readonly reason: string
}

/** Collect row ids inserted by a patch document (the `- insert:` list). */
function insertedIds(ops: readonly PatchOp[]): string[] {
  const ids: string[] = []
  for (const op of ops) {
    for (const row of op.insert ?? []) {
      if (typeof row.id === 'string') ids.push(row.id)
    }
  }
  return ids
}

/** Collect row ids this patch overrides (top-level rows carrying an `id`). */
function overriddenIds(ops: readonly PatchOp[]): string[] {
  const ids: string[] = []
  for (const op of ops) {
    if (op.insert === undefined && typeof op.id === 'string') ids.push(op.id)
  }
  return ids
}

/** Parse one patch file into operations; throws on invalid YAML. */
function parsePatch(path: string): PatchOp[] {
  const raw = readFileSync(path, 'utf8')
  // Cordis patch files carry `!!js` expression tags the loader evaluates; the
  // verifier never evaluates them, so strip the tag marker and keep the raw
  // scalar. Ids and names are always plain strings, which survive intact.
  const sanitized = raw.replaceAll(/!!js\s+/g, '')
  const document = load(sanitized) as unknown
  if (document === undefined || document === null) return []
  if (!Array.isArray(document)) {
    throw new Error(`${path}: patch document must be a YAML list of operations`)
  }
  return document as PatchOp[]
}

/**
 * Verify every Tianma patch's overridden ids against the upstream layers.
 * @param basePatchPaths - paths whose inserts form the upstream row universe
 *   (the dsh-base patch, the mode bundle patches, and their preset patches).
 * @param patchPaths - paths to Tianma bundle patch files.
 * @returns failures; an empty array means the verification passed.
 */
export function verifyPatches(
  basePatchPaths: readonly string[],
  patchPaths: readonly string[],
): VerificationFailure[] {
  const baseIds: string[] = []
  for (const basePatchPath of basePatchPaths) {
    baseIds.push(...insertedIds(parsePatch(basePatchPath)))
  }
  const failures: VerificationFailure[] = []
  for (const patchPath of patchPaths) {
    let ops: PatchOp[]
    try {
      ops = parsePatch(patchPath)
    } catch (error) {
      failures.push({ patchPath, reason: (error as Error).message })
      continue
    }
    const ownIds = overriddenIds(ops)
    const duplicates = ownIds.filter((id, index) => ownIds.indexOf(id) !== index)
    for (const duplicate of new Set(duplicates)) {
      failures.push({ patchPath, reason: `duplicate override of row id "${duplicate}"` })
    }
    for (const id of ownIds) {
      const occurrences = baseIds.filter(candidate => candidate === id).length
      if (occurrences === 0) {
        failures.push({
          patchPath,
          reason: `overrides row id "${id}" which no upstream layer inserts — upstream id drift or typo`,
        })
      } else if (occurrences > 1) {
        failures.push({
          patchPath,
          reason: `row id "${id}" is ambiguous: inserted ${occurrences} times across upstream layers`,
        })
      }
    }
  }
  return failures
}

/** CLI entry: `tsx scripts/verify-profile-patches.ts <base> <patch...>`. */
function main(argv: readonly string[]): number {
  if (argv.length < 2) {
    process.stderr.write('usage: verify-profile-patches <upstream-layer.yml> [...] <tianma-patch.yml>\n')
    return 2
  }
  const patchPaths = argv.slice(-1)
  const basePatchPaths = argv.slice(0, -1)
  const failures = verifyPatches(basePatchPaths, patchPaths)
  for (const failure of failures) {
    process.stderr.write(`verify-profile-patches: ${failure.patchPath}: ${failure.reason}\n`)
  }
  if (failures.length > 0) return 1
  process.stdout.write(`verify-profile-patches: ${patchPaths.length} patch file(s) reference intact upstream row ids\n`)
  return 0
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/verify-profile-patches.ts')) {
  process.exitCode = main(process.argv.slice(2))
}
