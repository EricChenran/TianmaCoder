/**
 * The node's git boundary: every command is spawned with an argument list, so a
 * task's own text can never become shell syntax. A failing command keeps git's
 * diagnostics, redacted, because task summaries quote them.
 * @module @tianma/dsh-mps-executor/git
 */

import { execFile } from 'node:child_process'
import { redactSecretText } from '@tianma/dsh-mps-exec-core'
import { toError } from './report.ts'

/** What one git command wrote. */
export interface GitOutput {
  /** Standard output. */
  stdout: string
  /** Standard error. */
  stderr: string
}

/** Runs git commands with an argument list, never through a shell. */
export interface GitRunner {
  /**
   * Run one git command in a directory.
   * @param directory - the working directory.
   * @param args - the arguments to pass verbatim.
   * @param signal - caller cancellation; an aborted command rejects with the abort, not a git failure.
   * @returns what the command wrote.
   * @throws GitError when git exits non-zero or cannot start.
   */
  run(directory: string, args: readonly string[], signal?: AbortSignal): Promise<GitOutput>
}

/** Options for a {@link GitError}. */
export interface GitErrorOptions {
  /** The failure that produced this one. */
  cause?: unknown
}

/** A git command that did not succeed. */
export class GitError extends Error {
  /** The command, as git was invoked. */
  readonly command: string
  /** Exit code, or `null` when git never started. */
  readonly exitCode: number | null
  /** git's own diagnostics, with credential-shaped values removed. */
  readonly stderr: string

  /**
   * @param command - the command, as git was invoked.
   * @param exitCode - the exit code, or `null` when git never started.
   * @param stderr - git's diagnostics.
   * @param options - the underlying failure.
   */
  constructor(command: string, exitCode: number | null, stderr: string, options: GitErrorOptions = {}) {
    super(`git ${command} failed${exitCode === null ? '' : ` with exit code ${String(exitCode)}`}${stderr === '' ? '' : `: ${stderr}`}`)
    this.name = 'GitError'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** The parts of a failed `execFile` call this module reads. */
interface ExecFailure {
  code?: unknown
}

/**
 * Turn a failed spawn into the error callers act on.
 * @param directory - the working directory git was given.
 * @param args - the arguments git was given.
 * @param error - the rejection.
 * @param stderr - what the command wrote to standard error.
 * @returns the error to throw.
 */
function gitFailure(directory: string, args: readonly string[], error: unknown, stderr: string): unknown {
  if (isAbort(error)) return error
  const failure = error as ExecFailure
  const code = typeof failure.code === 'number' ? failure.code : null
  return new GitError(`-C ${directory} ${args.join(' ')}`, code, redactSecretText(stderr.trim()), { cause: error })
}

/**
 * Whether a rejection is the caller's cancellation rather than a git failure.
 * @param error - the rejection.
 * @returns true when the error is an abort.
 */
function isAbort(error: unknown): boolean {
  return toError(error).name === 'AbortError'
}

/**
 * The git on this host.
 * @returns the runner the node uses unless a deployment composes another.
 */
export function cliGit(): GitRunner {
  return {
    async run(directory: string, args: readonly string[], signal?: AbortSignal): Promise<GitOutput> {
      return await new Promise<GitOutput>((resolve, reject) => {
        execFile('git', [...args], {
          cwd: directory,
          signal,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error === null) resolve({ stdout, stderr })
          else reject(gitFailure(directory, args, error, stderr))
        })
      })
    },
  }
}
