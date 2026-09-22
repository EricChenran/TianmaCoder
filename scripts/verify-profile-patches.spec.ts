import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { verifyPatches } from './verify-profile-patches.ts'

const BASE_PATCH = `
- insert:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: agent-instructions
      name: '@deepseek-ai/dsh-agent-instructions'
      disabled: !!js "!ctx.get('profileContext')"
      config:
        maxBytes: 65536
`

const dir = mkdtempSync(join(tmpdir(), 'verify-profile-patches-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(name: string, content: string): string {
  const path = join(dir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

describe('verifyPatches', () => {
  it('accepts a patch whose overridden ids exist once in the base layer', () => {
    const base = fixture('base.yml', BASE_PATCH)
    const patch = fixture('tianma.yml', `
- id: compaction-basic
  config:
    retainRatio: 0.35
`)
    expect(verifyPatches([base], [patch])).toEqual([])
  })

  it('rejects an override of an id the base layer never inserts', () => {
    const base = fixture('base.yml', BASE_PATCH)
    const patch = fixture('drifted.yml', `
- id: compaction-basic-v2
  config:
    retainRatio: 0.35
`)
    const failures = verifyPatches([base], [patch])
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toContain('compaction-basic-v2')
    expect(failures[0]!.reason).toContain('drift')
  })

  it('rejects a patch overriding the same row id twice', () => {
    const base = fixture('base.yml', BASE_PATCH)
    const patch = fixture('duplicate.yml', `
- id: agent-instructions
  config:
    maxBytes: 1
- id: agent-instructions
  config:
    maxBytes: 2
`)
    const failures = verifyPatches([base], [patch])
    expect(failures.some(f => f.reason.includes('duplicate'))).toBe(true)
  })

  it('reports invalid YAML as a failure instead of throwing', () => {
    const base = fixture('base.yml', BASE_PATCH)
    const patch = fixture('broken.yml', '\t- id: not: valid: yaml')
    const failures = verifyPatches([base], [patch])
    expect(failures).toHaveLength(1)
    expect(failures[0]!.patchPath).toBe(patch)
  })

  it('ignores insert operations when collecting overridden ids', () => {
    const base = fixture('base.yml', BASE_PATCH)
    const patch = fixture('with-insert.yml', `
- insert:
    - id: tianma-new-row
      name: '@tianma/dsh-example'
`)
    expect(verifyPatches([base], [patch])).toEqual([])
  })
})
