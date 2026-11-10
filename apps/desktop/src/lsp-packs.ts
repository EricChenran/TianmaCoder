/** Installable language packs for the desktop app, and the mount rows they add. */

import { join } from 'node:path'

/** Packs the installer recognizes. Adding one here is the only catalog change. */
export type LspPackId = 'miniprogram'

/** One stdio language server a pack supplies. */
export interface LspPackServer {
  /** Provider key reported to `dsh-lsp-stdio`. */
  readonly id: string
  /** Entry script, relative to the pack's own `node_modules`. */
  readonly entry: string
  /** Leading-dot extension to LSP language id. */
  readonly extensionToLanguage: Readonly<Record<string, string>>
}

/** Everything the installer needs for one pack. */
export interface LspPack {
  /** Stable id used for the directory and the patch row. */
  readonly id: LspPackId
  /** Label shown in the settings page. */
  readonly label: string
  /** Registry specs installed into the pack directory. */
  readonly packages: readonly string[]
  /** Servers the row mounts. */
  readonly servers: readonly LspPackServer[]
}

/** One server entry as the patch writes it. */
export interface LspPackServerConfig {
  /** Executable that runs the entry script. */
  readonly command: string
  /** Entry script followed by the fixed protocol flag. */
  readonly args: readonly string[]
  /** Tells the Electron binary to behave as Node for the child process. */
  readonly env: Readonly<Record<string, string>>
  /** Extension to language id for this server's documents. */
  readonly extensionToLanguage: Readonly<Record<string, string>>
}

/** Row appended to the profile patch to mount one pack. */
export interface LspPackPatchRow {
  /** Stable row id, derived from the pack id. */
  readonly id: string
  /** Plugin that owns the stdio provider. */
  readonly name: string
  /** Provider configuration for every server in the pack. */
  readonly config: { readonly servers: Readonly<Record<string, LspPackServerConfig>> }
}

/** Pack that adds WeChat mini-program page and configuration support. */
const MINIPROGRAM_PACK: LspPack = {
  id: 'miniprogram',
  label: '微信小程序（JSON / WXML / WXSS）',
  packages: ['vscode-langservers-extracted@4.10.0'],
  servers: [
    {
      id: 'mini-json',
      entry: 'vscode-langservers-extracted/bin/vscode-json-language-server',
      extensionToLanguage: { '.json': 'json' },
    },
    {
      id: 'mini-html',
      entry: 'vscode-langservers-extracted/bin/vscode-html-language-server',
      extensionToLanguage: { '.wxml': 'html' },
    },
    {
      id: 'mini-css',
      entry: 'vscode-langservers-extracted/bin/vscode-css-language-server',
      extensionToLanguage: { '.wxss': 'css' },
    },
  ],
}

/** Installable packs, in settings-page order. */
export const LSP_PACKS: readonly LspPack[] = [MINIPROGRAM_PACK]

/**
 * Look up an installed or installable pack.
 * @param id - pack id from the settings request.
 * @returns the catalog entry, or undefined for an unknown id.
 */
export function findLspPack(id: string): LspPack | undefined {
  return LSP_PACKS.find(pack => pack.id === id)
}

/**
 * Directory that owns every installed pack of one profile.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @returns the pack root inside that profile.
 */
export function lspPackRoot(profileDir: string): string {
  return join(profileDir, 'lsp-packs')
}

/**
 * Directory of one installed pack.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pack - catalog entry to locate.
 * @returns the pack directory, created by the installer.
 */
export function lspPackDir(profileDir: string, pack: LspPack): string {
  return join(lspPackRoot(profileDir), pack.id)
}

/**
 * Absolute entry script of one pack server.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pack - catalog entry that supplies the server.
 * @param server - server whose entry is wanted.
 * @returns absolute path under the pack's `node_modules`.
 */
export function lspPackServerEntry(profileDir: string, pack: LspPack, server: LspPackServer): string {
  return join(lspPackDir(profileDir, pack), 'node_modules', server.entry)
}

/**
 * Command that installs a pack's registry dependencies into its own directory.
 * @param pack - catalog entry to install.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pnpmPath - pnpm executable supplied by the running runtime.
 * @returns executable and argv for one install run.
 */
export function lspPackInstallCommand(
  pack: LspPack,
  profileDir: string,
  pnpmPath: string,
): { readonly command: string; readonly args: readonly string[] } {
  return {
    command: pnpmPath,
    args: ['add', '--dir', lspPackDir(profileDir, pack), ...pack.packages],
  }
}

/**
 * Patch row that mounts a pack on its own stdio provider.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pack - catalog entry to mount.
 * @param nodeExecutable - executable that runs the entry scripts as Node.
 * @returns row content for the profile patch; serialize it where it is written.
 */
export function lspPackPatchRow(
  profileDir: string,
  pack: LspPack,
  nodeExecutable: string,
): LspPackPatchRow {
  const servers: Record<string, LspPackServerConfig> = {}
  for (const server of pack.servers) {
    servers[server.id] = {
      command: nodeExecutable,
      args: [lspPackServerEntry(profileDir, pack, server), '--stdio'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      extensionToLanguage: server.extensionToLanguage,
    }
  }
  return { id: `lsp-stdio-${pack.id}`, name: '@deepseek-ai/dsh-lsp-stdio', config: { servers } }
}
