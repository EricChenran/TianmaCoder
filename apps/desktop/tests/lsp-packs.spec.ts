/** The desktop language-pack catalog and the rows it generates. */

import { isAbsolute, sep } from 'node:path'
import { dump, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  LSP_PACKS,
  findLspPack,
  lspPackDir,
  lspPackInstallCommand,
  lspPackPatchRow,
  lspPackRoot,
  lspPackServerEntry,
} from '../src/lsp-packs.ts'

const profileDir = 'C:\\Users\\tester\\AppData\\Roaming\\TianmaCoder\\dsh\\profiles\\desktop'
const nodeExecutable = 'C:\\Program Files\\TianmaCoder\\TianmaCoder.exe'

describe('lsp packs', () => {
  it('keeps the catalog self-consistent', () => {
    const ids = LSP_PACKS.map(pack => pack.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const pack of LSP_PACKS) {
      expect(pack.label.length).toBeGreaterThan(0)
      expect(pack.packages.length).toBeGreaterThan(0)
      expect(pack.servers.length).toBeGreaterThan(0)
      const packageNames = pack.packages.map(spec => spec.split('@')[0])
      for (const server of pack.servers) {
        expect(packageNames).toContain(server.entry.split('/')[0])
        const extensions = Object.keys(server.extensionToLanguage)
        expect(extensions.length).toBeGreaterThan(0)
        for (const extension of extensions) expect(extension.startsWith('.')).toBe(true)
      }
    }
  })

  it('resolves pack paths under the profile', () => {
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
    const command = lspPackInstallCommand(pack, profileDir, 'C:\\runtime\\pnpm.cmd')
    expect(command.command).toBe('C:\\runtime\\pnpm.cmd')
    expect(command.args.slice(0, 3)).toEqual(['add', '--dir', lspPackDir(profileDir, pack)])
    expect(command.args.slice(3)).toEqual([...pack.packages])
  })

  it('mounts every server on one provider row', () => {
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

  it('serializes the row without losing Windows paths', () => {
    const pack = findLspPack('miniprogram')!
    const row = lspPackPatchRow(profileDir, pack, nodeExecutable)
    const text = dump([{ insert: [row] }])
    const parsed = load(text) as { insert: { config: { servers: Record<string, { command: string; args: string[] }> } }[] }[]
    expect(parsed[0]!.insert[0]!.config.servers['mini-css']!.command).toBe(nodeExecutable)
    expect(parsed[0]!.insert[0]!.config.servers['mini-css']!.args[0]).toContain('vscode-css-language-server')
  })
})
