import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unpackedWorkspacePackages } from '../scripts/unpacked-workspace-packages.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const DESKTOP_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'

describe('unpacked workspace packages', () => {
  it('names every private package the product runtime reaches, and nothing else', () => {
    const packages = unpackedWorkspacePackages(REPOSITORY_ROOT, [DESKTOP_HOST_PACKAGE])
    expect(packages.map(entry => entry.name)).toEqual([
      '@tianma/dsh-department-prompts',
      '@tianma/dsh-oa-account',
      '@tianma/dsh-oa-account-ui',
    ])
    for (const entry of packages) {
      const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, entry.directory, 'package.json'), 'utf8')) as {
        name: string
        private: boolean
      }
      expect(manifest.name).toBe(entry.name)
      expect(manifest.private).toBe(true)
    }
  })

  it('leaves released families, earlier pack stages, and npm resolution out', () => {
    const names = unpackedWorkspacePackages(REPOSITORY_ROOT, [DESKTOP_HOST_PACKAGE]).map(entry => entry.name)
    expect(names).not.toContain('@deepseek-ai/dsh-web-app')
    expect(names).not.toContain('@deepseek-ai/schemastery')
    expect(names).not.toContain(DESKTOP_HOST_PACKAGE)
    expect(names).not.toContain('commander')
  })

  it('names a private root the caller has not packed yet', () => {
    expect(unpackedWorkspacePackages(REPOSITORY_ROOT, []).map(entry => entry.name))
      .toContain(DESKTOP_HOST_PACKAGE)
  })
})
