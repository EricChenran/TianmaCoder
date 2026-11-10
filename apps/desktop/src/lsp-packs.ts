/** Installable language packs for the desktop app, and the mount rows they add. */

import { join } from 'node:path'

/** Packs the installer recognizes. Adding one here is the only catalog change. */
export type LspPackId = 'miniprogram' | 'java'

/** How a pack's files reach the pack directory. */
export type LspPackInstall =
  | {
    /** Registry dependencies installed with pnpm into the pack directory. */
    readonly kind: 'npm'
    readonly packages: readonly string[]
  }
  | {
    /** Archive downloaded, extracted, and resolved through a launcher glob. */
    readonly kind: 'archive'
    readonly url: string
  }

/** One stdio language server a pack supplies. */
export interface LspPackServer {
  /** Provider key reported to `dsh-lsp-stdio`. */
  readonly id: string
  /** Leading-dot extension to LSP language id. */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /** Node entry script, relative to the pack's `node_modules`; npm packs only. */
  readonly entry?: string
  /** File-name prefix of the launcher jar under `<pack>/plugins`; archive packs only. */
  readonly launcherPrefix?: string
  /** Configuration directory, relative to the pack directory; archive packs only. */
  readonly configurationDir?: string
}

/** Everything the installer needs for one pack. */
export interface LspPack {
  /** Stable id used for the directory and the patch row. */
  readonly id: LspPackId
  /** Label shown in the settings page. */
  readonly label: string
  /** Where the pack's files come from. */
  readonly install: LspPackInstall
  /** Servers the row mounts. */
  readonly servers: readonly LspPackServer[]
  /** True when the pack's servers need a `java` executable on PATH. */
  readonly requiresJava?: boolean
  /** Lowest JDK feature release the servers accept; checked against `java -version`. */
  readonly requiresJavaMajor?: number
}

/** One server entry as the patch writes it. */
export interface LspPackServerConfig {
  /** Executable that runs the server. */
  readonly command: string
  /** Arguments for that executable. */
  readonly args: readonly string[]
  /** Environment additions; empty for servers that run their own runtime. */
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

/** Absolute path of one server's resolved executable file. */
export type LspPackResolvedEntries = ReadonlyMap<string, string>

/** Pack that adds WeChat mini-program page and configuration support. */
const MINIPROGRAM_PACK: LspPack = {
  id: 'miniprogram',
  label: '微信小程序（JSON / WXML / WXSS）',
  install: { kind: 'npm', packages: ['vscode-langservers-extracted@4.10.0'] },
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

/** Pack that adds Eclipse JDT language support; needs a local JDK 17 or newer. */
const JAVA_PACK: LspPack = {
  id: 'java',
  label: 'Java（Eclipse JDT）',
  install: {
    kind: 'archive',
    url: 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz',
  },
  requiresJava: true,
  requiresJavaMajor: 25,
  servers: [
    {
      id: 'java',
      launcherPrefix: 'org.eclipse.equinox.launcher_',
      configurationDir: 'config_win',
      extensionToLanguage: { '.java': 'java' },
    },
  ],
}

/** Installable packs, in settings-page order. */
export const LSP_PACKS: readonly LspPack[] = [MINIPROGRAM_PACK, JAVA_PACK]

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
 * Absolute entry script of one npm pack server.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pack - catalog entry that supplies the server.
 * @param server - server whose entry is wanted.
 * @returns absolute path under the pack's `node_modules`.
 */
export function lspPackServerEntry(profileDir: string, pack: LspPack, server: LspPackServer): string {
  if (server.entry === undefined) throw new Error(`language pack ${pack.id}: server ${server.id} has no node entry`)
  return join(lspPackDir(profileDir, pack), 'node_modules', server.entry)
}

/**
 * Directory that holds an archive pack's launcher jars.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pack - archive pack to locate.
 * @returns the extracted `plugins` directory.
 */
export function lspPackLauncherDir(profileDir: string, pack: LspPack): string {
  return join(lspPackDir(profileDir, pack), 'plugins')
}

/**
 * Command that installs an npm pack's registry dependencies into its directory.
 * @param pack - catalog entry to install.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param runtime - node executable and pnpm entry supplied by the running runtime.
 * @returns executable and argv for one install run.
 */
export function lspPackInstallCommand(
  pack: LspPack,
  profileDir: string,
  runtime: { readonly node: string; readonly pnpmEntry: string },
): { readonly command: string; readonly args: readonly string[] } {
  if (pack.install.kind !== 'npm') throw new Error(`language pack ${pack.id}: not an npm pack`)
  return {
    command: runtime.node,
    // Language-pack dependencies are pure JavaScript; skipping lifecycle scripts
    // keeps an install from running unreviewed build code and from failing the
    // runtime's strict build-script approval.
    args: [runtime.pnpmEntry, 'add', '--dir', lspPackDir(profileDir, pack), '--ignore-scripts', ...pack.install.packages],
  }
}

/**
 * Patch row that mounts a pack on its own stdio provider.
 * @param profileDir - the profile directory that holds `cordis.patch.yml`.
 * @param pack - catalog entry to mount.
 * @param nodeExecutable - executable that runs npm pack entries as Node.
 * @param resolvedEntries - absolute executable per server, required by archive packs.
 * @returns row content for the profile patch; serialize it where it is written.
 */
export function lspPackPatchRow(
  profileDir: string,
  pack: LspPack,
  nodeExecutable: string,
  resolvedEntries: LspPackResolvedEntries = new Map(),
): LspPackPatchRow {
  const servers: Record<string, LspPackServerConfig> = {}
  for (const server of pack.servers) {
    if (server.entry !== undefined) {
      servers[server.id] = {
        command: nodeExecutable,
        args: [lspPackServerEntry(profileDir, pack, server), '--stdio'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        extensionToLanguage: server.extensionToLanguage,
      }
      continue
    }
    const launcher = resolvedEntries.get(server.id)
    if (launcher === undefined || server.configurationDir === undefined) {
      throw new Error(`language pack ${pack.id}: server ${server.id} needs a resolved launcher`)
    }
    servers[server.id] = {
      command: 'java',
      args: ['-jar', launcher, '-configuration', join(lspPackDir(profileDir, pack), server.configurationDir), '-data', join(lspPackDir(profileDir, pack), 'jdt-data')],
      env: {},
      extensionToLanguage: server.extensionToLanguage,
    }
  }
  return { id: `lsp-stdio-${pack.id}`, name: '@deepseek-ai/dsh-lsp-stdio', config: { servers } }
}

/** Opening marker of the managed block inside a profile patch file. */
export const LSP_PACK_SECTION_BEGIN = '# >>> tianma lsp packs (managed)'

/** Closing marker of the managed block inside a profile patch file. */
export const LSP_PACK_SECTION_END = '# <<< tianma lsp packs'

/**
 * Quote one YAML scalar with single quotes, doubling embedded quotes.
 * @param value - raw scalar text.
 * @returns the quoted scalar.
 */
function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Render the managed block that mounts every installed pack.
 * @param rows - rows to write; an empty list renders an empty section.
 * @returns the block text, or an empty string when there is nothing to mount.
 */
export function renderLspPackSection(rows: readonly LspPackPatchRow[]): string {
  if (rows.length === 0) return ''
  const lines = [LSP_PACK_SECTION_BEGIN]
  for (const row of rows) {
    lines.push('- insert:')
    lines.push(`    - id: ${yamlScalar(row.id)}`)
    lines.push(`      name: ${yamlScalar(row.name)}`)
    lines.push('      config:')
    lines.push('        servers:')
    for (const [id, server] of Object.entries(row.config.servers)) {
      lines.push(`          ${id}:`)
      lines.push(`            command: ${yamlScalar(server.command)}`)
      lines.push('            args:')
      for (const arg of server.args) lines.push(`              - ${yamlScalar(arg)}`)
      lines.push('            env:')
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`              ${key}: ${yamlScalar(value)}`)
      }
      lines.push('            extensionToLanguage:')
      for (const [extension, language] of Object.entries(server.extensionToLanguage)) {
        lines.push(`              ${yamlScalar(extension)}: ${language}`)
      }
    }
  }
  lines.push(LSP_PACK_SECTION_END)
  return lines.join('\n')
}

/**
 * Replace the managed block in a profile patch, appending it when absent.
 * @param patchText - current profile patch text.
 * @param section - block produced by {@link renderLspPackSection}; empty removes the block.
 * @returns the patch text that keeps every line outside the markers untouched.
 */
export function upsertLspPackSection(patchText: string, section: string): string {
  const begin = patchText.indexOf(LSP_PACK_SECTION_BEGIN)
  const end = patchText.indexOf(LSP_PACK_SECTION_END)
  const replaceable = begin !== -1 && end > begin
  const before = replaceable ? patchText.slice(0, begin) : patchText
  const after = replaceable ? patchText.slice(end + LSP_PACK_SECTION_END.length) : ''

  if (section === '') {
    const trimmed = `${before}${after}`.replace(/\n{3,}/gu, '\n\n')
    return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
  }

  const head = before === '' || before.endsWith('\n') ? before : `${before}\n`
  const tailText = after === '' ? '\n' : after.startsWith('\n') ? after : `\n${after}`
  return `${head}${section}${tailText}`
}
