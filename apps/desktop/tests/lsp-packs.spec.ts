/** The desktop language-pack catalog and the rows it generates. */

import { isAbsolute, join, sep } from 'node:path'
import { dump, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  LSP_PACKS,
  LSP_PACK_SECTION_BEGIN,
  LSP_PACK_SECTION_END,
  findLspPack,
  lspPackDir,
  lspPackInstallCommand,
  lspPackLauncherDir,
  lspPackPatchRow,
  lspPackRoot,
  lspPackServerEntry,
  renderLspPackSection,
  upsertLspPackSection,
} from '../src/lsp-packs.ts'

const profileDir = 'C:\\Users\\tester\\AppData\\Roaming\\TianmaCoder\\dsh\\profiles\\desktop'
const nodeExecutable = 'C:\\Program Files\\TianmaCoder\\TianmaCoder.exe'

describe('lsp packs', () => {
  it('keeps the catalog self-consistent', () => {
    const ids = LSP_PACKS.map(pack => pack.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const pack of LSP_PACKS) {
      expect(pack.label.length).toBeGreaterThan(0)
      expect(pack.servers.length).toBeGreaterThan(0)
      const packageNames = pack.install.kind === 'npm'
        ? pack.install.packages.map(spec => spec.split('@')[0]!)
        : []
      if (pack.install.kind === 'archive') {
        expect(pack.install.url.startsWith('https://')).toBe(true)
        expect(pack.requiresJava).toBe(true)
      } else {
        expect(pack.install.packages.length).toBeGreaterThan(0)
      }
      for (const server of pack.servers) {
        if (pack.install.kind === 'npm') {
          expect(server.entry).toBeDefined()
          expect(packageNames).toContain(server.entry!.split('/')[0])
        } else {
          expect(server.launcherPrefix?.length ?? 0).toBeGreaterThan(0)
          expect(server.configurationDir?.length ?? 0).toBeGreaterThan(0)
        }
        const extensions = Object.keys(server.extensionToLanguage)
        expect(extensions.length).toBeGreaterThan(0)
        for (const extension of extensions) expect(extension.startsWith('.')).toBe(true)
      }
    }
  })

  it('resolves npm pack paths under the profile', () => {
    const pack = findLspPack('miniprogram')
    expect(pack).toBeDefined()
    expect(lspPackRoot(profileDir)).toBe(`${profileDir}${sep}lsp-packs`)
    expect(lspPackDir(profileDir, pack!)).toBe(`${profileDir}${sep}lsp-packs${sep}miniprogram`)
    const entry = lspPackServerEntry(profileDir, pack!, pack!.servers[0]!)
    expect(isAbsolute(entry)).toBe(true)
    expect(entry).toContain(`${sep}node_modules${sep}vscode-langservers-extracted${sep}bin${sep}`)
  })

  it('installs the catalog packages into the pack directory', () => {
    const pack = findLspPack('miniprogram')!
    expect(pack.install.kind).toBe('npm')
    const command = lspPackInstallCommand(pack, profileDir, { node: 'C:\\runtime\\node.exe', pnpmEntry: 'C:\\runtime\\pnpm.mjs' })
    expect(command.command).toBe('C:\\runtime\\node.exe')
    expect(command.args.slice(0, 2)).toEqual(['C:\\runtime\\pnpm.mjs', 'add'])
    expect(command.args.slice(2, 4)).toEqual(['--dir', lspPackDir(profileDir, pack)])
    expect(command.args[4]).toBe('--ignore-scripts')
    expect(command.args.slice(5)).toEqual(pack.install.kind === 'npm' ? [...pack.install.packages] : [])
  })

  it('refuses to build an npm install command for an archive pack', () => {
    const java = findLspPack('java')!
    expect(() => lspPackInstallCommand(java, profileDir, { node: 'n', pnpmEntry: 'p' })).toThrow(/not an npm pack/u)
  })

  it('mounts every npm server on one provider row', () => {
    const pack = findLspPack('miniprogram')!
    const row = lspPackPatchRow(profileDir, pack, nodeExecutable)
    expect(row.id).toBe('lsp-stdio-miniprogram')
    expect(row.name).toBe('@deepseek-ai/dsh-lsp-stdio')
    expect(Object.keys(row.config.servers).sort()).toEqual(['mini-css', 'mini-html', 'mini-json'])
    for (const [id, server] of Object.entries(row.config.servers)) {
      expect(server.command).toBe(nodeExecutable)
      expect(server.args[1]).toBe('--stdio')
      expect(isAbsolute(server.args[0]!)).toBe(true)
      expect(server.args[0]).toContain(`${sep}lsp-packs${sep}miniprogram${sep}node_modules${sep}`)
      expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
      expect(Object.keys(server.extensionToLanguage).length, id).toBeGreaterThan(0)
    }
    expect(row.config.servers['mini-html']!.extensionToLanguage).toEqual({ '.wxml': 'html' })
    expect(row.config.servers['mini-css']!.extensionToLanguage).toEqual({ '.wxss': 'css' })
    expect(row.config.servers['mini-json']!.extensionToLanguage).toEqual({ '.json': 'json' })
  })

  it('mounts the java launcher with the jdtls arguments', () => {
    const pack = findLspPack('java')!
    const launcher = join(lspPackLauncherDir(profileDir, pack), 'org.eclipse.equinox.launcher_1.6.900.jar')
    const row = lspPackPatchRow(profileDir, pack, nodeExecutable, new Map([['java', launcher]]))
    expect(row.id).toBe('lsp-stdio-java')
    const server = row.config.servers['java']!
    expect(server.command).toBe('java')
    expect(server.args).toEqual(['-jar', launcher, '-configuration', join(lspPackDir(profileDir, pack), 'config_win'), '-data', join(lspPackDir(profileDir, pack), 'jdt-data')])
    expect(server.env).toEqual({})
    expect(server.extensionToLanguage).toEqual({ '.java': 'java' })
  })

  it('requires a resolved launcher for an archive pack row', () => {
    const java = findLspPack('java')!
    expect(() => lspPackPatchRow(profileDir, java, nodeExecutable)).toThrow(/needs a resolved launcher/u)
  })

  it('serializes the row without losing Windows paths', () => {
    const pack = findLspPack('miniprogram')!
    const row = lspPackPatchRow(profileDir, pack, nodeExecutable)
    const text = dump([{ insert: [row] }])
    const parsed = load(text) as { insert: { config: { servers: Record<string, { command: string; args: string[] }> } }[] }[]
    expect(parsed[0]!.insert[0]!.config.servers['mini-css']!.command).toBe(nodeExecutable)
    expect(parsed[0]!.insert[0]!.config.servers['mini-css']!.args[0]).toContain('vscode-css-language-server')
  })

  it('renders a managed section that parses as a patch list', () => {
    const pack = findLspPack('miniprogram')!
    const section = renderLspPackSection([lspPackPatchRow(profileDir, pack, nodeExecutable)])
    expect(section.startsWith(LSP_PACK_SECTION_BEGIN)).toBe(true)
    expect(section.endsWith(LSP_PACK_SECTION_END)).toBe(true)
    const parsed = load(section) as { insert: { id: string; config: { servers: Record<string, { command: string }> } }[] }[]
    expect(parsed[0]!.insert[0]!.id).toBe('lsp-stdio-miniprogram')
    expect(parsed[0]!.insert[0]!.config.servers['mini-json']!.command).toBe(nodeExecutable)
    expect(renderLspPackSection([])).toBe('')
  })

  it('appends once, then replaces the managed section in place', () => {
    const pack = findLspPack('miniprogram')!
    const section = renderLspPackSection([lspPackPatchRow(profileDir, pack, nodeExecutable)])
    const userPatch = '- id: preset-standard\n  config:\n    retainRatio: 0.5\n'

    const appended = upsertLspPackSection(userPatch, section)
    expect(appended.startsWith(userPatch)).toBe(true)
    expect(appended.indexOf(LSP_PACK_SECTION_BEGIN)).toBeGreaterThan(-1)

    const replaced = upsertLspPackSection(appended, section)
    expect(replaced).toBe(appended)
    expect(replaced.split(LSP_PACK_SECTION_BEGIN).length - 1).toBe(1)

    const removed = upsertLspPackSection(appended, '')
    expect(removed).not.toContain(LSP_PACK_SECTION_BEGIN)
    expect(removed.startsWith(userPatch)).toBe(true)
  })
})
