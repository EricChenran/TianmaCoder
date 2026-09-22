import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { auditModule, auditRepository, importSources, parsePolicy } from './verify-architecture.ts'

const dir = mkdtempSync(join(tmpdir(), 'verify-architecture-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(rel: string, content: string): string {
  const path = join(dir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

describe('parsePolicy', () => {
  it('parses modules and rejects a wrong version', () => {
    const policy = parsePolicy('version: 1\nmodules:\n  - id: a\n    roots: [packages/a/src]')
    expect(policy.modules[0]!.id).toBe('a')
    expect(() => parsePolicy('version: 2\nmodules: []')).toThrow(/version 1/)
  })
})

describe('importSources', () => {
  it('captures value, type-only, and inline-object imports', () => {
    const sources = importSources([
      "import { Context } from '@deepseek-ai/cordis'",
      "import type {} from '@deepseek-ai/dsh-system-prompt'",
      "import type { Agent } from '@deepseek-ai/dsh-agent'",
      "import x from 'left-pad'",
    ].join('\n'))
    expect(sources).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-agent',
      'left-pad',
    ])
  })
})

describe('auditModule', () => {
  const policy = { id: 'm', roots: ['packages/m/src'], upstreamSeams: ['cordis', 'dsh-session'] }

  it('allows declared seams, node builtins, and in-root relatives', () => {
    const file = fixture('mod/ok.ts', [
      "import { Context } from '@deepseek-ai/cordis'",
      "import type {} from '@deepseek-ai/dsh-session'",
      "import { readFileSync } from 'node:fs'",
      "import { helper } from './helper.ts'",
    ].join('\n'))
    void file
    expect(auditModule(join(dir, 'mod'), policy)).toEqual([])
  })

  it('flags undeclared upstream imports and cross-package tianma imports', () => {
    fixture('mod/bad.ts', [
      "import LlmRuntime from '@deepseek-ai/dsh-llm'",
      "import { thing } from '@tianma/dsh-other'",
      "import stale from '../outside.ts'",
    ].join('\n'))
    const violations = auditModule(join(dir, 'mod'), policy)
    const messages = violations.map(v => v.message)
    expect(messages.some(m => m.includes('dsh-llm') && m.includes('outside declared'))).toBe(true)
    expect(messages.some(m => m.includes('cross-package import'))).toBe(true)
    expect(messages.some(m => m.includes('escapes the module root'))).toBe(true)
  })
})

describe('auditRepository', () => {
  it('walks the policy roots from a repo-shaped temp tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-repo-'))
    try {
      writeFileSync(join(root, 'architecture-policy.yaml'), [
        'version: 1',
        'modules:',
        '  - id: tianma-x',
        '    roots: [packages/tianma/x/src]',
        '    upstreamSeams: [cordis]',
      ].join('\n'))
      mkdirSync(join(root, 'packages/tianma/x/src'), { recursive: true })
      writeFileSync(join(root, 'packages/tianma/x/src/index.ts'), "import { Context } from '@deepseek-ai/cordis'\n")
      expect(auditRepository(root)).toEqual([])
      writeFileSync(join(root, 'packages/tianma/x/src/index.ts'), "import 'left-pad'\n")
      expect(auditRepository(root)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
