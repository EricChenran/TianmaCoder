/**
 * How a failed attempt describes itself: one sentence for the operator, one code for the
 * platform's failure classification, and git's own words in full. A platform keeps only a
 * short summary for a person to read, so a node that wants a failure understood
 * mechanically states the code and the raw diagnostics beside it instead of packing them
 * into the sentence.
 * @module @tianma/dsh-mps-executor/failures
 */

import { RESULT_ERROR_DETAIL_MAX_CHARS } from '@tianma/dsh-mps-exec-core'
import type { ExecResultError } from '@tianma/dsh-mps-exec-core'
import { ArtifactTooLargeError } from './artifacts.ts'
import { GitError } from './git.ts'
import { toError } from './report.ts'

/** Failure codes a node reports. The platform classifies and labels by these. */
export const FAILURE_CODES = {
  /** git refused the push because the remote branch holds commits the attempt does not. */
  nonFastForward: 'git_non_fast_forward',
  /** git refused the push for another reason, such as a hook or a protected branch. */
  pushRejected: 'git_push_rejected',
  /** git printed a path in its quoted, octal-escaped form, which names no file on disk. */
  quotedPath: 'git_quoted_path',
  /** Any other git command that did not succeed. */
  gitRefused: 'git_refused',
  /** A changed text file carried a credential. */
  credentials: 'credentials_in_change',
  /** A change resolved outside the workspace, or the path was not a relative one. */
  pathOutsideWorkspace: 'path_outside_workspace',
  /** The attempt was not on the branch the task hands back. */
  branchMoved: 'branch_moved',
  /** The work branch does not match the pattern the task states. */
  branchNotAllowed: 'branch_not_allowed',
  /** git staged none of the paths the attempt reported, so there was nothing to commit. */
  changesNotStaged: 'changes_not_staged',
  /** The run exited non-zero. */
  runFailed: 'run_failed',
  /** The node stopped the run. */
  runStopped: 'run_stopped',
  /** The run finished without changing anything on a dispatch that was not a repeat. */
  noChanges: 'no_changes',
  /** The session the platform named is still owned by another write handle. */
  sessionInUse: 'session_in_use',
  /** An artifact the platform would not store. */
  artifactTooLarge: 'artifact_too_large',
  /** Anything the node has no more specific code for. */
  attemptFailed: 'attempt_failed',
} as const

/** Options for an {@link AttemptRefusal}. */
export interface AttemptRefusalOptions {
  /** Commit the attempt had reached, when the refusal came after it committed. */
  headCommit?: string | undefined
  /**
   * Raw diagnostics to report instead of the sentence. A refusal that wraps a failed git
   * command passes git's own words through, so the platform stores what git said rather
   * than the node's paraphrase of it.
   */
  detail?: string | undefined
}

/**
 * A refusal the node itself decided. The code names the rule that was applied, so the
 * platform reads the reason from the code rather than from a sentence it would have to
 * parse.
 */
export class AttemptRefusal extends Error {
  /** Stable code the platform classifies this refusal with. */
  readonly code: string
  /** Raw diagnostics, when this refusal wraps somebody else's words. */
  readonly detail: string | undefined
  /** Commit the attempt reached, when it got that far. */
  readonly headCommit: string | undefined

  /**
   * @param code - the failure code to report.
   * @param message - the sentence an operator reads.
   * @param options - facts the refusal carries beyond its text.
   */
  constructor(code: string, message: string, options: AttemptRefusalOptions = {}) {
    super(message)
    this.name = 'AttemptRefusal'
    this.code = code
    this.detail = options.detail
    this.headCommit = options.headCommit
  }
}

/** One failed attempt, as the result reports it. */
export interface AttemptFailure {
  /** One sentence for the operator. */
  summary: string
  /** The code and diagnostics the platform classifies with. */
  error: ExecResultError
  /** Commit the attempt reached, when it got far enough to have one. */
  headCommit?: string | undefined
}

/**
 * Describe a failure one attempt threw.
 * @param error - what the attempt threw.
 * @returns the sentence, the code and detail, and the commit when one is known.
 */
export function attemptFailure(error: unknown): AttemptFailure {
  if (error instanceof AttemptRefusal) {
    return {
      summary: error.message,
      error: { code: error.code, detail: boundedDetail(error.detail ?? error.message) },
      ...(error.headCommit === undefined ? {} : { headCommit: error.headCommit }),
    }
  }
  if (error instanceof GitError) return gitFailure(error)
  if (error instanceof ArtifactTooLargeError) {
    return {
      summary: `the attempt could not deliver ${error.path}: ${error.message}`,
      error: { code: FAILURE_CODES.artifactTooLarge, detail: boundedDetail(error.message) },
    }
  }
  const message = toError(error).message
  return {
    summary: `the attempt threw: ${message}`,
    error: { code: refusalCode(message), detail: boundedDetail(message) },
  }
}

/**
 * Describe a failed git command. A push the remote refuses is the failure this node meets
 * most often in the field, so it is told apart from every other git command that failed.
 * @param failure - the git failure.
 * @returns the failure as the result reports it.
 */
function gitFailure(failure: GitError): AttemptFailure {
  const diagnostics = `${failure.stderr}${failure.stderr === '' ? '' : '\n'}${failure.stdout}`.trim()
  const code = gitFailureCode(failure, diagnostics)
  return {
    summary: `${gitSummary(code)}: ${firstLine(diagnostics)}`.replace(/: $/u, ''),
    error: { code, detail: boundedDetail(diagnostics) },
  }
}

/**
 * Which code a failed git command carries. git states a refused push on standard error and
 * its reason on the lines around it, so the diagnostics decide, not just the command.
 * @param failure - the git failure.
 * @param diagnostics - both streams, joined.
 * @returns the code to report.
 */
function gitFailureCode(failure: GitError, diagnostics: string): string {
  if (/non-fast-forward|\[rejected\]|fetch first|failed to push some refs/iu.test(diagnostics)) {
    return FAILURE_CODES.nonFastForward
  }
  // git writes a path outside ASCII as `"\345\212\251..."`: a quote, then octal escapes.
  if (/\\[0-7]{3}/u.test(diagnostics)) return FAILURE_CODES.quotedPath
  if (/\bpush\b/u.test(failure.command)) return FAILURE_CODES.pushRejected
  return FAILURE_CODES.gitRefused
}

/**
 * One sentence naming what a code means, so the summary reads without the diagnostics.
 * @param code - the failure code.
 * @returns the sentence's opening.
 */
function gitSummary(code: string): string {
  switch (code) {
    case FAILURE_CODES.nonFastForward:
      return 'the push was refused: the remote branch already holds commits this attempt does not include'
    case FAILURE_CODES.pushRejected:
      return 'the push was refused'
    case FAILURE_CODES.quotedPath:
      return 'git printed a path in its escaped form, which names no file on disk'
    default:
      return 'git did not succeed'
  }
}

/**
 * Whether a refusal raised away from its thrower carries a more specific code.
 * @param message - the refusal's message.
 * @returns the code the message identifies, or the generic attempt failure.
 */
function refusalCode(message: string): string {
  if (/not a path inside the workspace|resolves outside the workspace/u.test(message)) {
    return FAILURE_CODES.pathOutsideWorkspace
  }
  return FAILURE_CODES.attemptFailed
}

/**
 * The first line of a diagnostic block.
 * @param text - the diagnostics.
 * @returns the first non-empty line, or an empty string.
 */
function firstLine(text: string): string {
  return text.split(/\r?\n/u).find(line => line.trim() !== '')?.trim() ?? ''
}

/**
 * Keep a diagnostic block a platform will store whole. A long block is cut from both ends,
 * because git states a refusal at the start of one diagnostic and at the end of another.
 * @param text - the diagnostics.
 * @returns the text, shortened when it is longer than the protocol's ceiling.
 */
function boundedDetail(text: string): string {
  if (text.length <= RESULT_ERROR_DETAIL_MAX_CHARS) return text
  const half = Math.floor(RESULT_ERROR_DETAIL_MAX_CHARS / 2)
  return `${text.slice(0, half)}\n…\n${text.slice(text.length - half)}`
}
