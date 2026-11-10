/** Installing and removing language packs through the desktop installer. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { LSP_PACKS, findLspPack, lspPackDir } from '../src/lsp-packs.ts'
import { LspPackInstaller, type LspPackRunner } from '../src/lsp-pack-installer.ts'

const profileDirs: string[] = []

afterEach(async () => {
  for (const dir of profileDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * Create one profile directory for a test.
 * @returns the new profile path.
 */
async function makeProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lsp-installer-'))
  profileDirs.push(dir)
  return dir
}

/**
 * Build a runner that materializes every catalog server entry.
 * @returns a runner writing the expected files.
 */
const creatingRunner: LspPackRunner = async (_command, args) => {
  const directory = args[3]!
  for (const pack of LSP_PACKS) {
    for (const server of pack.servers) {
      const file = join(directory, 'node_modules', server.entry)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, '#!/usr/bin/env node\n', 'utf8')
    }
  }
}

/**
 * Build an installer bound to one profile.
 * @param profileDir - profile under test.
 * @param runner - command runner to use.
 * @returns the installer.
 */
function makeInstaller(profileDir: string, runner: LspPackRunner): LspPackInstaller {
  return new LspPackInstaller({
    profileDir,
    pnpmEntry: 'C:\\runtime\\pnpm.mjs',
    nodeExecutable: 'C:\\runtime\\node.exe',
    runner,
  })
}

describe('LspPackInstaller', () => {
  it('reports a fresh profile as missing', async () => {
    const profileDir = await makeProfile()
    const installer = makeInstaller(profileDir, creatingRunner)
    const statuses = await installer.list()
    expect(statuses).toHaveLength(LSP_PACKS.length)
    expect(statuses.every(status => status.state === 'missing')).toBe(true)
  })

  it('installs a pack and mounts it in the profile patch', async () => {
    const profileDir = await makeProfile()
    const installer = makeInstaller(profileDir, creatingRunner)
    const status = await installer.install('miniprogram')
    expect(status.state).toBe('installed')
    expect(status.directory).toBe(lspPackDir(profileDir, findLspPack('miniprogram')!))

    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('# >>> tianma lsp packs (managed)')
    expect(patch).toContain('lsp-stdio-miniprogram')
    const parsed = load(patch) as { insert: { config: { servers: Record<string, { command: string }> } }[] }[]
    expect(parsed[0]!.insert[0]!.config.servers['mini-json']!.command).toBe('C:\\runtime\\node.exe')
  })

  it('keeps user rows outside the managed block', async () => {
    const profileDir = await makeProfile()
    const userPatch = '- id: preset-standard\n  config:\n    retainRatio: 0.5\n'
    await writeFile(join(profileDir, 'cordis.patch.yml'), userPatch, 'utf8')
    const installer = makeInstaller(profileDir, creatingRunner)
    await installer.install('miniprogram')
    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch.startsWith(userPatch)).toBe(true)
    expect(patch).toContain('lsp-stdio-miniprogram')
  })

  it('removes the pack and its block on uninstall', async () => {
    const profileDir = await makeProfile()
    const installer = makeInstaller(profileDir, creatingRunner)
    await installer.install('miniprogram')
    const status = await installer.uninstall('miniprogram')
    expect(status.state).toBe('missing')
    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('tianma lsp packs (managed)')
  })

  it('rolls back a failed install and leaves the patch untouched', async () => {
    const profileDir = await makeProfile()
    const failing: LspPackRunner = async () => { throw new Error('registry unreachable') }
    const installer = makeInstaller(profileDir, failing)
    await expect(installer.install('miniprogram')).rejects.toThrow(/install failed: registry unreachable/u)
    const status = await installer.list()
    expect(status[0]!.state).toBe('missing')
    await expect(readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).rejects.toThrow()
  })

  it('rolls back when the package reports success but entries are absent', async () => {
    const profileDir = await makeProfile()
    const installer = makeInstaller(profileDir, async () => {})
    await expect(installer.install('miniprogram')).rejects.toThrow(/install failed/u)
    const status = await installer.list()
    expect(status[0]!.state).toBe('missing')
  })

  it('rejects an unknown pack id', async () => {
    const profileDir = await makeProfile()
    const installer = makeInstaller(profileDir, creatingRunner)
    await expect(installer.install('rust')).rejects.toThrow(/unknown pack id/u)
  })
})
