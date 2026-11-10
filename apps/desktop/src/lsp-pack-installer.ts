/** Installs desktop language packs into the profile and mounts them through its patch file. */

import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  LSP_PACKS,
  findLspPack,
  lspPackDir,
  lspPackInstallCommand,
  lspPackPatchRow,
  lspPackServerEntry,
  renderLspPackSection,
  upsertLspPackSection,
  type LspPack,
  type LspPackPatchRow,
} from './lsp-packs.ts'

const run = promisify(execFile)

/** How much of a pack is present on disk. */
export type LspPackState = 'missing' | 'installed' | 'broken'

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
}

/** Runs one installer command; tests replace it. */
export type LspPackRunner = (command: string, args: readonly string[]) => Promise<void>

/**
 * Install one pack with the runtime pnpm under a bounded budget.
 * @param command - pnpm executable from the running runtime.
 * @param args - argv produced by {@link lspPackInstallCommand}.
 * @returns a promise settling when the install run exits.
 */
export const runLspPackCommand: LspPackRunner = async (command, args) => {
  await run(command, [...args], { timeout: 10 * 60 * 1000, windowsHide: true })
}

/** Inputs the desktop shell owns. */
export interface LspPackInstallerOptions {
  /** Profile directory that holds `cordis.patch.yml`. */
  readonly profileDir: string
  /** pnpm executable from the running runtime. */
  readonly pnpmPath: string
  /** Executable that runs pack entries as Node. */
  readonly nodeExecutable: string
  /** Command runner override for tests. */
  readonly runner?: LspPackRunner
}

/** Installer for the catalog's packs, backed by the profile directory. */
export class LspPackInstaller {
  private readonly options: LspPackInstallerOptions

  /**
   * Bind the installer to one profile.
   * @param options - profile directory, runtime executables, and optional runner.
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
    const directory = lspPackDir(this.options.profileDir, pack)
    await mkdir(directory, { recursive: true })
    const command = lspPackInstallCommand(pack, this.options.profileDir, this.options.pnpmPath)
    try {
      await (this.options.runner ?? runLspPackCommand)(command.command, command.args)
      await this.requireEntries(pack)
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
   * Fail unless every server entry of one pack exists.
   * @param pack - pack whose entries must be present.
   * @returns a promise settling after the checks.
   */
  private async requireEntries(pack: LspPack): Promise<void> {
    for (const server of pack.servers) {
      await access(lspPackServerEntry(this.options.profileDir, pack, server))
    }
  }

  /**
   * Show whether a pack's entries are all present.
   * @param pack - pack to inspect.
   * @returns the pack's current state.
   */
  private async status(pack: LspPack): Promise<LspPackStatus> {
    const directory = lspPackDir(this.options.profileDir, pack)
    let present = 0
    for (const server of pack.servers) {
      try {
        await access(lspPackServerEntry(this.options.profileDir, pack, server))
        present += 1
      } catch {
        // A missing entry is the ordinary not-installed case, not an error.
      }
    }
    let state: LspPackState = 'installed'
    if (present !== pack.servers.length) {
      state = present === 0 && !(await directoryExists(directory)) ? 'missing' : 'broken'
    }
    return { id: pack.id, label: pack.label, state, directory }
  }

  /**
   * Rewrite the managed block from the packs that are installed now.
   * @returns a promise settling after the patch file is replaced.
   */
  private async rewritePatch(): Promise<void> {
    const rows: LspPackPatchRow[] = []
    for (const pack of LSP_PACKS) {
      const status = await this.status(pack)
      if (status.state === 'installed') {
        rows.push(lspPackPatchRow(this.options.profileDir, pack, this.options.nodeExecutable))
      }
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
