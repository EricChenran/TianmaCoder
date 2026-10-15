/**
 * What this node can do, probed rather than written by hand: the protocol requires a
 * node's capabilities to be detected from the machine it runs on, because the platform
 * schedules on them.
 * @module @tianma/dsh-mps-executor/capabilities
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, posix, win32 } from 'node:path'
import { promisify } from 'node:util'

/** Commands a coding node is expected to have, probed on PATH. */
export const PROBED_TOOLS = [
  'git',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'go',
  'cargo',
  'java',
  'docker',
  'rg',
] as const

/** Suffixes a Windows host appends to an executable name. */
const WINDOWS_SUFFIXES = ['', '.exe', '.cmd', '.bat'] as const

/** Options for {@link probeTools}. */
export interface ProbeToolsOptions {
  /** The PATH to search; defaults to this process's. */
  path?: string | undefined
  /** Whether one candidate file exists; defaults to the filesystem. */
  exists?: ((candidate: string) => boolean) | undefined
  /** The host platform; defaults to this one. */
  platform?: NodeJS.Platform | undefined
}

/**
 * Detect the commands this machine has. A capability is a promise, so the node reports
 * what it found rather than what a deployment hoped for.
 * @param options - the PATH to search, the existence check, and the host platform.
 * @returns the tool names that resolved, in the order they were probed.
 */
export function probeTools(options: ProbeToolsOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  const search = options.path ?? process.env['PATH'] ?? ''
  const exists = options.exists ?? existsSync
  const separator = windows ? ';' : delimiter
  const paths = windows ? win32 : posix
  const directories = search.split(separator).filter(directory => directory !== '')
  const suffixes = windows ? WINDOWS_SUFFIXES : ([''] as const)
  return PROBED_TOOLS.filter(tool =>
    directories.some(directory =>
      suffixes.some(suffix => exists(paths.join(directory, `${tool}${suffix}`)))))
}

/**
 * Read the version one command reports for itself.
 * @param output - what the command printed when asked for its version.
 * @returns the first line it printed, or undefined when it reported none.
 */
export function versionFrom(output: string): string | undefined {
  const line = output.split(/\r?\n/u).map(text => text.trim()).find(text => text !== '')
  return line
}

/** Options for {@link probeAgentVersion}. */
export interface ProbeAgentVersionOptions {
  /** The executable to ask, such as the CLI this node runs. */
  bin: string
  /** Arguments that make it print its version. */
  args?: readonly string[] | undefined
  /** How the command is run; defaults to spawning it. */
  run?: ((bin: string, args: readonly string[]) => Promise<string>) | undefined
}

/**
 * Ask the agent's own CLI which version it is, so the node reports the build it runs
 * rather than a value someone wrote down.
 * @param options - the executable, the flag, and how to run it.
 * @returns the version, or undefined when the command could not say.
 */
export async function probeAgentVersion(options: ProbeAgentVersionOptions): Promise<string | undefined> {
  const run = options.run ?? defaultRun
  const args = options.args ?? ['--version']
  try {
    return versionFrom(await run(options.bin, args))
  } catch {
    // A CLI that cannot report its version is not a reason to fail a handshake: the
    // node reports the version the deployment stated instead.
    return undefined
  }
}

/**
 * Run one command and collect what it printed.
 * @param bin - the executable.
 * @param args - its arguments.
 * @returns everything it wrote to stdout.
 */
async function defaultRun(bin: string, args: readonly string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(bin, [...args], { windowsHide: true, timeout: 30_000 })
  return stdout
}
