/** Installs desktop language packs into the profile and mounts them through its patch file. */

import { execFile } from 'node:child_process'
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  LSP_PACKS,
  findLspPack,
  lspPackDir,
  lspPackInstallCommand,
  lspPackLauncherDir,
  lspPackPatchRow,
  lspPackServerEntry,
  renderLspPackSection,
  upsertLspPackSection,
  type LspPack,
  type LspPackPatchRow,
  type LspPackResolvedEntries,
} from './lsp-packs.ts'

const run = promisify(execFile)

/** How much of a pack is present on disk. */
export type LspPackState = 'missing' | 'installed' | 'broken'

/** Why a pack cannot be installed on this machine. */
export type LspPackBlocked = 'java-missing'

/** What the settings page shows for one pack. */
export interface LspPackStatus {
  /** Catalog id. */
  readonly id: string
  /** Label shown to the user. */
  readonly label: string
  /** Whether every server entry exists. */
  readonly state: LspPackState
  /** Directory the pack occupies. */
  readonly directory: string
  /** True when the pack needs a JDK on this machine. */
  readonly requiresJava: boolean
  /** Present when the machine cannot install this pack. */
  readonly blocked?: LspPackBlocked
}

/** Runs one installer command; tests replace it. */
export type LspPackRunner = (command: string, args: readonly string[]) => Promise<void>

/** Downloads and extracts an archive pack; tests replace it. */
export interface LspPackArchiveTools {
  /** Save a URL to one file. */
  download(url: string, destination: string): Promise<void>
  /** Extract one archive into a directory. */
  extract(archive: string, destination: string): Promise<void>
}

/**
 * Install one pack with the runtime pnpm under a bounded budget.
 * @param command - node executable from the running runtime.
 * @param args - argv produced by {@link lspPackInstallCommand}.
 * @returns a promise settling when the install run exits.
 */
export const runLspPackCommand: LspPackRunner = async (command, args) => {
  await run(command, [...args], { timeout: 10 * 60 * 1000, windowsHide: true })
}

/**
 * Download one archive with the platform's HTTP stack.
 * @param url - archive URL.
 * @param destination - file to write.
 * @returns a promise settling after the file is complete.
 */
async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

/**
 * Extract one archive with the platform tar.
 * @param archive - archive file to read.
 * @param destination - directory to extract into.
 * @returns a promise settling after extraction finishes.
 */
async function extractArchive(archive: string, destination: string): Promise<void> {
  const tar = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  await run(tar, ['-xzf', archive, '-C', destination], { timeout: 5 * 60 * 1000, windowsHide: true })
}

/** Default archive tools backed by fetch and the platform tar. */
export const lspPackArchiveTools: LspPackArchiveTools = { download: downloadArchive, extract: extractArchive }

/**
 * Report whether a JDK is on PATH.
 * @returns true when `java -version` exits cleanly.
 */
async function javaOnPath(): Promise<boolean> {
  try {
    await run('java', ['-version'], { timeout: 10_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Inputs the desktop shell owns. */
export interface LspPackInstallerOptions {
  /** Profile directory that holds `cordis.patch.yml`. */
  readonly profileDir: string
  /** Node executable that runs pnpm and the pack entries. */
  readonly nodeExecutable: string
  /** pnpm entry script from the running runtime. */
  readonly pnpmEntry: string
  /** Command runner override for tests. */
  readonly runner?: LspPackRunner
  /** Archive download and extraction override for tests. */
  readonly archive?: LspPackArchiveTools
  /** JDK probe override for tests. */
  readonly javaAvailable?: () => Promise<boolean>
}

/** Installer for the catalog's packs, backed by the profile directory. */
export class LspPackInstaller {
  private readonly options: LspPackInstallerOptions
  private java?: Promise<boolean>

  /**
   * Bind the installer to one profile.
   * @param options - profile directory, runtime executables, and test overrides.
   */
  constructor(options: LspPackInstallerOptions) {
    this.options = options
  }

  /**
   * Report every catalog pack's state.
   * @returns one status per catalog entry, in catalog order.
   */
  async list(): Promise<LspPackStatus[]> {
    return Promise.all(LSP_PACKS.map(pack => this.status(pack)))
  }

  /**
   * Install one pack and mount its row.
   * @param id - catalog id from the settings request.
   * @returns the installed pack's status.
   */
  async install(id: string): Promise<LspPackStatus> {
    const pack = requirePack(id)
    if (pack.requiresJava === true && !(await this.javaReadiness())) {
      throw new Error(`language pack ${pack.id}: requires a JDK (\`java\` was not found on PATH)`)
    }
    const directory = lspPackDir(this.options.profileDir, pack)
    await mkdir(directory, { recursive: true })
    try {
      if (pack.install.kind === 'npm') await this.installNpm(pack)
      else await this.installArchive(pack, directory)
      await this.resolvedEntries(pack)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw new Error(`language pack ${pack.id}: install failed: ${message(error)}`, { cause: error })
    }
    await this.rewritePatch()
    return this.status(pack)
  }

  /**
   * Remove one pack and its mount row.
   * @param id - catalog id from the settings request.
   * @returns the removed pack's status.
   */
  async uninstall(id: string): Promise<LspPackStatus> {
    const pack = requirePack(id)
    await rm(lspPackDir(this.options.profileDir, pack), { recursive: true, force: true })
    await this.rewritePatch()
    return this.status(pack)
  }

  /**
   * Install an npm pack's registry dependencies.
   * @param pack - npm pack to install.
   * @returns a promise settling when the install run exits.
   */
  private async installNpm(pack: LspPack): Promise<void> {
    const command = lspPackInstallCommand(pack, this.options.profileDir, {
      node: this.options.nodeExecutable,
      pnpmEntry: this.options.pnpmEntry,
    })
    await (this.options.runner ?? runLspPackCommand)(command.command, command.args)
  }

  /**
   * Download, extract, and clean up an archive pack.
   * @param pack - archive pack to install.
   * @param directory - pack directory that receives the extracted files.
   * @returns a promise settling after the archive is removed.
   */
  private async installArchive(pack: LspPack, directory: string): Promise<void> {
    if (pack.install.kind !== 'archive') return
    const tools = this.options.archive ?? lspPackArchiveTools
    const archive = join(directory, 'pack.tar.gz')
    await tools.download(pack.install.url, archive)
    await tools.extract(archive, directory)
    await rm(archive, { force: true })
  }

  /**
   * Resolve every server's executable file, failing when one is absent.
   * @param pack - pack whose servers must resolve.
   * @returns absolute executable path per server id.
   */
  private async resolvedEntries(pack: LspPack): Promise<LspPackResolvedEntries> {
    const entries = new Map<string, string>()
    for (const server of pack.servers) {
      if (server.entry !== undefined) {
        const entry = lspPackServerEntry(this.options.profileDir, pack, server)
        await access(entry)
        entries.set(server.id, entry)
        continue
      }
      if (server.launcherPrefix === undefined) throw new Error(`server ${server.id} has no launcher`)
      entries.set(server.id, await this.findLauncher(pack, server.launcherPrefix))
    }
    return entries
  }

  /**
   * Locate the launcher jar of an archive pack.
   * @param pack - archive pack to search.
   * @param prefix - launcher file-name prefix.
   * @returns absolute launcher path.
   */
  private async findLauncher(pack: LspPack, prefix: string): Promise<string> {
    const directory = lspPackLauncherDir(this.options.profileDir, pack)
    const names = await readdir(directory).catch(() => [] as string[])
    const launcher = names.filter(name => name.startsWith(prefix) && name.endsWith('.jar')).sort()[0]
    if (launcher === undefined) throw new Error(`no ${prefix}*.jar under ${directory}`)
    return join(directory, launcher)
  }

  /**
   * Show whether a pack's servers all resolve on disk.
   * @param pack - pack to inspect.
   * @returns the pack's current state plus what blocks installation.
   */
  private async status(pack: LspPack): Promise<LspPackStatus> {
    const directory = lspPackDir(this.options.profileDir, pack)
    let present = 0
    for (const server of pack.servers) {
      try {
        if (server.entry !== undefined) await access(lspPackServerEntry(this.options.profileDir, pack, server))
        else if (server.launcherPrefix !== undefined) await this.findLauncher(pack, server.launcherPrefix)
        else throw new Error('no entry')
        present += 1
      } catch {
        // A missing server is the ordinary not-installed case, not an error.
      }
    }
    let state: LspPackState = 'installed'
    if (present !== pack.servers.length) {
      state = present === 0 && !(await directoryExists(directory)) ? 'missing' : 'broken'
    }
    const requiresJava = pack.requiresJava === true
    const blocked: LspPackBlocked | undefined = requiresJava && !(await this.javaReadiness())
      ? 'java-missing'
      : undefined
    return { id: pack.id, label: pack.label, state, directory, requiresJava, ...blocked === undefined ? {} : { blocked } }
  }

  /**
   * Probe for a JDK once per installer instance.
   * @returns whether `java` is on PATH.
   */
  private javaReadiness(): Promise<boolean> {
    this.java ??= (this.options.javaAvailable ?? javaOnPath)()
    return this.java
  }

  /**
   * Rewrite the managed block from the packs that are installed now.
   * @returns a promise settling after the patch file is replaced.
   */
  private async rewritePatch(): Promise<void> {
    const rows: LspPackPatchRow[] = []
    for (const pack of LSP_PACKS) {
      const status = await this.status(pack)
      if (status.state !== 'installed') continue
      rows.push(lspPackPatchRow(
        this.options.profileDir,
        pack,
        this.options.nodeExecutable,
        await this.resolvedEntries(pack),
      ))
    }
    const patchPath = patchFilePath(this.options.profileDir)
    let current = ''
    try {
      current = await readFile(patchPath, 'utf8')
    } catch {
      // A profile without a user patch starts from an empty document.
    }
    await mkdir(dirname(patchPath), { recursive: true })
    await writeFileAtomic(patchPath, upsertLspPackSection(current, renderLspPackSection(rows)), { mode: 0o600 })
  }
}

/**
 * Resolve a catalog pack or fail loud.
 * @param id - requested pack id.
 * @returns the catalog entry.
 */
function requirePack(id: string): LspPack {
  const pack = findLspPack(id)
  if (pack === undefined) throw new Error(`language pack ${id}: unknown pack id`)
  return pack
}

/**
 * Report whether a directory exists.
 * @param directory - path to test.
 * @returns true when the path is present.
 */
async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory)
    return true
  } catch {
    return false
  }
}

/**
 * Profile patch file the managed block lives in.
 * @param profileDir - profile directory.
 * @returns the profile's user patch path.
 */
function patchFilePath(profileDir: string): string {
  return join(profileDir, 'cordis.patch.yml')
}

/**
 * Read a caught value's message.
 * @param error - caught value.
 * @returns a human-readable message.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
