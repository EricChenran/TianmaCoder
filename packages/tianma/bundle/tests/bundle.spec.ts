/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list, and PR-0 ships it empty by
 * design — later PRs land exactly one row per capability.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('@tianma/dsh-bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: string } } }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('overrides only ids the dsh-base layer inserts exactly once', async () => {
    const { verifyPatches } = await import('../../../../scripts/verify-profile-patches.ts')
    const root = fileURLToPath(new URL('..', import.meta.url))
    const failures = verifyPatches(
      resolve(root, '../../bundle/base/cordis.patch.yml'),
      [resolve(root, 'cordis.patch.yml')],
    )
    expect(failures).toEqual([])
  })

  it('swaps the compaction-basic row to the fidelity summarizer keeping retainRatio', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { id?: string; name?: string; config?: Record<string, number> }[]
    const row = parsed.find(op => op.id === 'compaction-basic')
    expect(row?.name).toBe('@tianma/dsh-compaction-summarize')
    expect(row?.config).toEqual({ retainRatio: 0.35 })
    expect(manifest.dependencies).toHaveProperty('@tianma/dsh-compaction-summarize')
  })

  it('swaps the tool-result-pruner row to the recency clearer with policy config', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { id?: string; name?: string; config?: Record<string, number> }[]
    const row = parsed.find(op => op.id === 'tool-result-pruner')
    expect(row?.name).toBe('@tianma/dsh-compaction-recency-pruner')
    expect(row?.config).toEqual({
      keepRecentResults: 5,
      thresholdChars: 8192,
      minCharsSaved: 1024,
    })
    expect(manifest.dependencies).toHaveProperty('@tianma/dsh-compaction-recency-pruner')
  })

  it('inserts the behavioral-guidelines row declared as a dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; name?: string }[] }[]
    const inserted = parsed.flatMap(op => op.insert ?? [])
    expect(inserted.find(row => row.id === 'tianma-behavioral-guidelines')?.name)
      .toBe('@tianma/dsh-behavioral-guidelines')
    expect(manifest.dependencies).toHaveProperty('@tianma/dsh-behavioral-guidelines')
  })
})
