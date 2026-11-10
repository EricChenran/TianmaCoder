/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list, and PR-0 ships it empty by
 * design — later PRs land exactly one row per capability.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface NestedRow {
  id?: string
  name?: string
  config?: unknown
  disabled?: unknown
  plugins?: NestedRow[]
}
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
      [
        resolve(root, '../../bundle/base/cordis.patch.yml'),
        resolve(root, '../../bundle/web-app/cordis.patch.yml'),
        resolve(root, '../../bundle/web-app/presets/standard.patch.yml'),
        resolve(root, '../../bundle/web-app/presets/ptc.patch.yml'),
        resolve(root, '../../bundle/web-app/presets/minimal.patch.yml'),
        resolve(root, '../../bundle/web-app/presets/cordis.patch.yml'),
      ],
      [resolve(root, 'cordis.patch.yml')],
    )
    expect(failures).toEqual([])
  })

  it('restates the standard preset with the fidelity summarizer and recency clearer', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { id?: string; name?: string; config?: { plugins?: NestedRow[] } }[]
    const preset = parsed.find(op => op.id === 'preset-standard')
    expect(preset?.name).toBe('@deepseek-ai/dsh-agent-preset')
    const compaction = preset?.config?.plugins
      ?.find(plugin => plugin.id === 'compaction')?.config as NestedRow[] ?? []
    const summarize = compaction.find(row => row.id === 'compaction-basic')
    expect(summarize?.name).toBe('@tianma/dsh-compaction-summarize')
    expect(summarize?.config).toEqual({ retainRatio: 0.35 })
    const pruner = compaction.find(row => row.id === 'tool-result-pruner')
    expect(pruner?.name).toBe('@tianma/dsh-compaction-recency-pruner')
    expect(pruner?.config).toEqual({
      keepRecentResults: 5,
      thresholdChars: 8192,
      minCharsSaved: 1024,
    })
    const instructions = preset?.config?.plugins
      ?.find(plugin => plugin.id === 'agent-instructions')?.config
    expect(instructions).toEqual({ maxBytes: 262144 })
    expect(manifest.dependencies).toHaveProperty('@tianma/dsh-compaction-summarize')
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

  it('wires the opt-in lsp service and mounts its tool in every composing preset', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const loadPatch = (path: string) => yaml.load(
      readFileSync(path, 'utf8'),
      { schema: entryListSchema },
    ) as { id?: string; insert?: NestedRow[]; config?: { plugins?: NestedRow[] } }[]

    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))
    const inserted = patch.flatMap(op => op.insert ?? [])
    expect(inserted.find(row => row.id === 'lsp')?.name).toBe('@deepseek-ai/dsh-lsp')
    expect(inserted.find(row => row.id === 'lsp-stdio')?.name).toBe('@deepseek-ai/dsh-lsp-stdio')
    expect(inserted.find(row => row.id === 'lsp-stdio')?.disabled).toBeDefined()
    expect(inserted.find(row => row.id === 'lsp-stdio-python')?.name).toBe('@deepseek-ai/dsh-lsp-stdio')
    expect(inserted.find(row => row.id === 'lsp-stdio-python')?.disabled).toBeDefined()
    for (const id of ['lsp-stdio', 'lsp-stdio-python']) {
      const gate = JSON.stringify(inserted.find(row => row.id === id)?.disabled)
      expect(gate, `${id} must expose the DSH_LSP=off kill switch`).toContain('DSH_LSP')
    }

    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    for (const dep of ['typescript-language-server', 'typescript', 'pyright']) {
      expect(manifest.dependencies).toHaveProperty(dep)
    }

    for (const id of ['preset-standard', 'preset-ptc', 'preset-cordis']) {
      const plugins = patch.find(op => op.id === id)?.config?.plugins ?? []
      const row = plugins.find(plugin => plugin.id === 'tool-lsp')
      expect(row?.name, `${id} must mount tool-lsp`).toBe('@deepseek-ai/dsh-tool-lsp')
    }

    const webAppPresets = resolve(root, '../../bundle/web-app/presets')
    for (const name of ['department-tech', 'department-business', 'department-bid', 'department-tester']) {
      const parsed = loadPatch(resolve(webAppPresets, `${name}.patch.yml`))
      const plugins = parsed.flatMap(op => op.insert ?? [])
        .flatMap(row => (row as { config?: { plugins?: NestedRow[] } }).config?.plugins ?? [])
      expect(plugins.find(plugin => plugin.id === 'tool-lsp')?.name,
        `${name} must mount tool-lsp`).toBe('@deepseek-ai/dsh-tool-lsp')
    }
  })

  it('wires session search and worktree as profile-level capabilities', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const patch = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: NestedRow[] }[]
    const inserted = patch.flatMap(op => op.insert ?? [])

    const search = inserted.find(row => row.id === 'optional-session-search')
    expect(search?.name).toBe('cordis:group')
    const searchChildren = (search?.config ?? []) as NestedRow[]
    expect(searchChildren.find(row => row.id === 'optional-session-query-sqlite')?.name)
      .toBe('@deepseek-ai/dsh-session-query-sqlite')
    expect(searchChildren.find(row => row.id === 'optional-tool-session-query')?.name)
      .toBe('@deepseek-ai/dsh-tool-session-query')

    expect(inserted.find(row => row.id === 'worktree')?.name)
      .toBe('@deepseek-ai/dsh-experimental-worktree')
    expect(inserted.find(row => row.id === 'tool-worktree')?.name)
      .toBe('@deepseek-ai/dsh-experimental-tool-worktree')

    for (const dep of [
      '@deepseek-ai/dsh-session-query-sqlite',
      '@deepseek-ai/dsh-tool-session-query',
      '@deepseek-ai/dsh-experimental-worktree',
      '@deepseek-ai/dsh-experimental-tool-worktree',
    ]) expect(manifest.dependencies).toHaveProperty(dep)
  })

  it('mounts the language-pack card from the web-app patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, '../../bundle/web-app/cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: NestedRow[] }[]
    const inserted = parsed.flatMap(op => op.insert ?? [])
    expect(inserted.find(row => row.id === 'lsp-packs-ui')?.name).toBe('@tianma/dsh-lsp-packs-ui')
  })
})
