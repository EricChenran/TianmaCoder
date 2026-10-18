/**
 * How one failed attempt describes itself: the code the platform classifies with, the
 * diagnostics it stores whole, and the sentence an operator reads. Each case here is a
 * failure the node meets in the field, classified from git's own words rather than from
 * the command the node happened to run.
 */

import { describe, expect, it } from 'vitest'
import {
  FAILURE_CODES,
  ArtifactTooLargeError,
  AttemptRefusal,
  GitError,
  attemptFailure,
} from '@tianma/dsh-mps-executor'
import { RESULT_ERROR_DETAIL_MAX_CHARS } from '@tianma/dsh-mps-exec-core'

/**
 * One git failure, as the runner raises it.
 * @param args - the arguments git was given.
 * @param stderr - what git wrote to standard error.
 * @param stdout - what git wrote to standard output.
 * @returns the failure.
 */
function gitFailure(args: string[], stderr: string, stdout = ''): GitError {
  return new GitError(`-C ws ${args.join(' ')}`, 1, stderr, stdout)
}

describe('describing a failed attempt', () => {
  it('tells a refused push apart from every other git failure', () => {
    const forward = attemptFailure(gitFailure(['push', 'origin', 'feature/tsk_1'],
      ' ! [rejected]        feature/tsk_1 -> feature/tsk_1 (non-fast-forward)\nerror: failed to push some refs'))
    expect(forward.error.code).toBe(FAILURE_CODES.nonFastForward)
    expect(forward.error.detail).toContain('non-fast-forward')
    expect(forward.summary).toContain('the remote branch already holds commits')

    const fetchFirst = attemptFailure(gitFailure(['push', 'origin', 'feature/tsk_1'], ' ! [rejected] (fetch first)\n'))
    expect(fetchFirst.error.code).toBe(FAILURE_CODES.nonFastForward)

    const hook = attemptFailure(gitFailure(['push', 'origin', 'feature/tsk_1'], 'remote: a hook refused this push\n'))
    expect(hook.error.code).toBe(FAILURE_CODES.pushRejected)

    const commit = attemptFailure(gitFailure(['commit', '--quiet', '-m', 'x'], '', 'nothing added to commit'))
    expect(commit.error.code).toBe(FAILURE_CODES.gitRefused)
    // The refusal git spells out on standard output is kept as the detail.
    expect(commit.error.detail).toBe('nothing added to commit')
  })

  it('names the escaped path git printed, which is the failure this node used to crash on', () => {
    const escaped = attemptFailure(gitFailure(['ls-files', '--others'],
      '"\\345\\212\\251\\346\\211\\213\\344\\273\\213\\347\\273\\215.md"'))

    expect(escaped.error.code).toBe(FAILURE_CODES.quotedPath)
    expect(escaped.summary).toContain('escaped form')
  })

  it('keeps the code a refusal was raised with, and the commit it reached', () => {
    const refusal = attemptFailure(new AttemptRefusal(FAILURE_CODES.credentials, 'refusing to publish credentials in leak.env', {
      headCommit: 'b2c3d4e',
      detail: 'password: hunter2',
    }))

    expect(refusal).toEqual({
      summary: 'refusing to publish credentials in leak.env',
      error: { code: FAILURE_CODES.credentials, detail: 'password: hunter2' },
      headCommit: 'b2c3d4e',
    })
  })

  it('classifies a path refusal raised away from its thrower, and anything else generically', () => {
    expect(attemptFailure(new Error('refusing ../outside.ts: it resolves outside the workspace at /tmp')).error.code)
      .toBe(FAILURE_CODES.pathOutsideWorkspace)
    expect(attemptFailure(new Error('something nobody predicted')).error.code).toBe(FAILURE_CODES.attemptFailed)
    expect(attemptFailure('a thrown string').error.code).toBe(FAILURE_CODES.attemptFailed)
  })

  it('keeps an artifact the platform would not store as its own outcome', () => {
    const failure = attemptFailure(new ArtifactTooLargeError('too large', { path: 'build.log', sizeBytes: 2, ceilingBytes: 1 }))

    expect(failure.error.code).toBe(FAILURE_CODES.artifactTooLarge)
    expect(failure.summary).toContain('build.log')
  })

  it('cuts a long diagnostic from both ends, because git states a refusal at either', () => {
    const head = 'start-marker\n'
    const tail = '\nend-marker'
    const middle = 'x'.repeat(RESULT_ERROR_DETAIL_MAX_CHARS * 2)
    const failure = attemptFailure(gitFailure(['push', 'origin', 'b'], `${head}${middle}${tail}`))

    expect(failure.error.detail).toBeDefined()
    expect((failure.error.detail ?? '').length).toBeLessThanOrEqual(RESULT_ERROR_DETAIL_MAX_CHARS + 8)
    expect(failure.error.detail).toContain('start-marker')
    expect(failure.error.detail).toContain('end-marker')
  })
})
