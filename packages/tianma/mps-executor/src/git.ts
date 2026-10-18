/**
 * The node's git boundary: every command is spawned with an argument list, so a
 * task's own text can never become shell syntax, and every command carries
 * `core.quotepath=false`, so a path git prints is a path this host can open. A failing
 * command keeps git's diagnostics — both streams, because git states ordinary refusals
 * on standard output and leaves standard error empty — redacted, because task
 * summaries quote them.
 * @module @tianma/dsh-mps-executor/git
 */

import { execFile } from 'node:child_process'
import { redactSecretText } from '@tianma/dsh-mps-exec-core'
import { toError } from './report.ts'

/**
 * Arguments every git command carries before the subcommand. git quotes and
 * octal-escapes any path outside ASCII when it prints one, and a quoted name is not a
 * name any filesystem accepts; path lists are read with `-z` on top of this, so the
 * setting is the second of two independent guarantees rather than the only one.
 */
export const GIT_PATH_ARGS: readonly string[] = ['-c', 'core.quotepath=false']

/**
 * Longest diagnostic text one failure keeps, in characters. git can print a whole
 * progress stream; what a refusal says is at the end of it.
 */
export const GIT_DIAGNOSTIC_MAX_CHARS = 2000

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
   * Run one git command in a directory. A composition that installs its own runner
   * keeps the same obligations: path lists are requested with `-z`, and `quotepath`
   * stays off, or names outside ASCII do not survive the round trip.
   * @param directory - the working directory.
   * @param args - the arguments to pass verbatim, after {@link GIT_PATH_ARGS}.
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
  /** git's own diagnostics on standard error, with credential-shaped values removed. */
  readonly stderr: string
  /** git's diagnostics on standard output, which is where an ordinary refusal goes. */
  readonly stdout: string

  /**
   * @param command - the command, as git was invoked.
   * @param exitCode - the exit code, or `null` when git never started.
   * @param stderr - what git wrote to standard error.
   * @param stdout - what git wrote to standard output.
   * @param options - the underlying failure.
   */
  constructor(
    command: string,
    exitCode: number | null,
    stderr: string,
    stdout: string,
    options: GitErrorOptions = {},
  ) {
    // A refusal such as "nothing to commit" is spelled out on standard output and leaves
    // standard error empty, so the message quotes whichever stream said something.
    const diagnostics = boundedDiagnostics(stderr === '' ? stdout : stderr)
    super(`git ${command} failed${exitCode === null ? '' : ` with exit code ${String(exitCode)}`}${diagnostics === '' ? '' : `: ${diagnostics}`}`)
    this.name = 'GitError'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
    this.stdout = stdout
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Keep the end of a diagnostic text, which is where git states the refusal.
 * @param text - the diagnostics, already trimmed.
 * @returns the text, shortened from the front when it is longer than the bound.
 */
function boundedDiagnostics(text: string): string {
  if (text.length <= GIT_DIAGNOSTIC_MAX_CHARS) return text
  return `…${text.slice(text.length - GIT_DIAGNOSTIC_MAX_CHARS)}`
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
 * @param stdout - what the command wrote to standard output.
 * @returns the error to throw.
 */
function gitFailure(directory: string, args: readonly string[], error: unknown, stderr: string, stdout: string): Error {
  if (isAbort(error)) return toError(error)
  const failure = error as ExecFailure
  const code = typeof failure.code === 'number' ? failure.code : null
  const command = `-C ${directory} ${[...GIT_PATH_ARGS, ...args].join(' ')}`
  return new GitError(command, code, redactSecretText(stderr.trim()), redactSecretText(stdout.trim()), { cause: error })
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
        execFile('git', [...GIT_PATH_ARGS, ...args], {
          cwd: directory,
          signal,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error === null) resolve({ stdout, stderr })
          else reject(gitFailure(directory, args, error, stderr, stdout))
        })
      })
    },
  }
}
