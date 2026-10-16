/**
 * The code an attempt starts from: the command sequence the node runs against its
 * workspace's own repository cache, checked once against a recording git and once
 * against the git on this host.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { GitError, WorkspaceStore, checkoutAllocator, cliGit, prepareCheckout } from '@tianma/dsh-mps-executor'
import type { GitRunner } from '@tianma/dsh-mps-executor'
import type { ExecTaskAssignment, TaskRepository } from '@tianma/dsh-mps-exec-core'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix for the directory.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** A git that records the commands it was given and answers from a script. */
class RecordingGit implements GitRunner {
  readonly calls: string[] = []
  readonly answers = new Map<string, string>()
  readonly failures = new Set<string>()

  async run(_directory: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const command = args.join(' ')
    this.calls.push(command)
    if (this.failures.has(command)) throw new GitError(`-C workspace ${command}`, 128, 'fatal: not a git repository')
    return { stdout: this.answers.get(command) ?? '', stderr: '' }
  }
}

/** The repository a dispatched payload names. */
const REPOSITORY: TaskRepository = {
  url: 'https://example.invalid/r.git',
  base_branch: 'main',
  base_commit: 'a1b2c3d',
  work_branch: 'feature/tsk_1',
}

/** One payload as the platform dispatches it. */
function assignment(payload: Record<string, unknown>): ExecTaskAssignment {
  return {
    task_id: 'tsk_1',
    work_item_id: 'wi_1',
    attempt: 1,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2026-10-15T04:16:00.123+08:00',
    lease_renew_seconds: 30,
    payload,
  }
}

/**
 * Read a workspace file with the host's line endings normalized.
 * @param directory - the workspace directory.
 * @returns the file's text.
 */
function checkedOut(directory: string): string {
  return readFileSync(join(directory, 'readme.md'), 'utf8').replace(/\r\n/gu, '\n')
}

/**
 * Run a git command that is expected to fail and hand back the failure.
 * @param git - the git runner.
 * @param directory - the working directory.
 * @param args - the arguments.
 * @returns the failure git reported.
 */
async function failureOf(git: GitRunner, directory: string, args: readonly string[]): Promise<GitError> {
  try {
    await git.run(directory, args)
  } catch (error) {
    if (error instanceof GitError) return error
    throw error
  }
  throw new Error('the git command was expected to fail')
}

describe('checkout preparation', () => {
  it('caches the repository in the workspace and resets it onto the base commit', async () => {
    const directory = temporary('mps-flow-')
    const git = new RecordingGit()
    git.failures.add('remote get-url origin')
    git.answers.set('rev-parse origin/main', 'a1b2c3d\n')

    const checkout = await prepareCheckout({ directory, repository: REPOSITORY, git })

    expect(git.calls).toEqual([
      'init --quiet',
      'remote get-url origin',
      'remote add origin https://example.invalid/r.git',
      'fetch --quiet origin main',
      'fetch --quiet origin +refs/heads/*:refs/remotes/origin/*',
      'rev-parse --verify --quiet a1b2c3d^{commit}',
      'merge-base --is-ancestor origin/main a1b2c3d',
      'checkout --quiet -B feature/tsk_1 a1b2c3d',
      'reset --quiet --hard a1b2c3d',
      'clean --quiet -fd',
    ])
    expect(checkout).toEqual({ base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' })
  })

  it('reuses the cache it already has for the same remote', async () => {
    const directory = temporary('mps-flow-')
    mkdirSync(join(directory, '.git'))
    const git = new RecordingGit()
    git.answers.set('remote get-url origin', 'https://example.invalid/r.git\n')
    git.answers.set('rev-parse origin/main', 'a1b2c3d\n')

    await prepareCheckout({ directory, repository: REPOSITORY, git })

    expect(git.calls).not.toContain('init --quiet')
    expect(git.calls).not.toContain('remote add origin https://example.invalid/r.git')
    expect(git.calls).not.toContain('remote set-url origin https://example.invalid/r.git')
  })

  it('points a cache at the repository the task names', async () => {
    const directory = temporary('mps-flow-')
    mkdirSync(join(directory, '.git'))
    const git = new RecordingGit()
    git.answers.set('remote get-url origin', 'https://elsewhere.invalid/old.git\n')
    git.answers.set('rev-parse origin/main', 'a1b2c3d\n')

    await prepareCheckout({ directory, repository: REPOSITORY, git })

    expect(git.calls).toContain('remote set-url origin https://example.invalid/r.git')
  })

  it('works from the base the platform dispatched even when the branch moved past it', async () => {
    const directory = temporary('mps-flow-')
    const git = new RecordingGit()
    git.failures.add('remote get-url origin')
    // The platform dispatches what it synced before the task, so the branch having moved
    // on since is the platform's business: the node works from the commit it was given.
    git.answers.set('rev-parse origin/main', 'f0f0f0f\n')

    const checkout = await prepareCheckout({ directory, repository: REPOSITORY, git })

    expect(checkout).toEqual({ base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' })
    expect(git.calls).toContain('checkout --quiet -B feature/tsk_1 a1b2c3d')
  })

  it('refuses a base no fetch can reach', async () => {
    const directory = temporary('mps-flow-')
    const git = new RecordingGit()
    git.failures.add('remote get-url origin')
    // Neither the branches the task names nor a full fetch turn the commit up: no result
    // this node could report would describe the tree the platform dispatched.
    git.failures.add('rev-parse --verify --quiet a1b2c3d^{commit}')

    await expect(prepareCheckout({ directory, repository: REPOSITORY, git })).rejects.toThrow(
      /refusing to work from a base this repository does not hold: the task dispatched a1b2c3d/,
    )
    expect(git.calls).not.toContain('clean --quiet -fd')
  })

  it('reports a payload that omits a field the flow needs', async () => {
    const directory = temporary('mps-flow-')
    const git = new RecordingGit()
    const cases: [Partial<TaskRepository>, RegExp][] = [
      [{ url: undefined }, /names no repository to fetch/],
      [{ base_branch: undefined }, /names no base branch/],
      [{ base_commit: undefined }, /names no base commit/],
      [{ work_branch: undefined }, /names no work branch/],
    ]

    for (const [overrides, expected] of cases) {
      await expect(prepareCheckout({ directory, repository: { ...REPOSITORY, ...overrides }, git })).rejects.toThrow(expected)
    }
    expect(git.calls).toEqual([])
  })

  it('carries a git failure out to the caller', async () => {
    const directory = temporary('mps-flow-')
    const git = new RecordingGit()
    git.failures.add('fetch --quiet origin main')

    await expect(prepareCheckout({ directory, repository: REPOSITORY, git })).rejects.toThrow(GitError)
  })

  it('clears the last attempt before checking out a refreshed base', async () => {
    const directory = temporary('mps-flow-')
    mkdirSync(join(directory, '.git'))
    const git = new RecordingGit()
    git.answers.set('remote get-url origin', 'https://example.invalid/r.git\n')
    git.answers.set('rev-parse origin/main', 'f0f0f0f\n')

    await prepareCheckout({
      directory,
      repository: { ...REPOSITORY, base_commit: 'f0f0f0f' },
      git,
      heldBaseCommit: 'a1b2c3d',
    })

    // The clear comes before the checkout: `checkout -B` refuses to overwrite what a failed
    // attempt left in the tree, so leaving the tree alone would fail every re-dispatch.
    expect(git.calls).toEqual([
      'remote get-url origin',
      'fetch --quiet origin main',
      'fetch --quiet origin +refs/heads/*:refs/remotes/origin/*',
      'rev-parse --verify --quiet f0f0f0f^{commit}',
      'merge-base --is-ancestor origin/main f0f0f0f',
      'rev-parse --verify --quiet HEAD^{commit}',
      'reset --quiet --hard',
      'clean --quiet -fd',
      'checkout --quiet -B feature/tsk_1 f0f0f0f',
      'reset --quiet --hard f0f0f0f',
      'clean --quiet -fd',
    ])
  })

  it('leaves a workspace that already holds the dispatched base alone', async () => {
    const directory = temporary('mps-flow-')
    mkdirSync(join(directory, '.git'))
    const git = new RecordingGit()
    git.answers.set('remote get-url origin', 'https://example.invalid/r.git\n')
    git.answers.set('rev-parse origin/main', 'a1b2c3d\n')

    await prepareCheckout({ directory, repository: REPOSITORY, git, heldBaseCommit: 'a1b2c3d' })

    expect(git.calls).not.toContain('reset --quiet --hard')
  })

  it('checks a refreshed base out of a cache that holds no HEAD', async () => {
    const directory = temporary('mps-flow-')
    mkdirSync(join(directory, '.git'))
    const git = new RecordingGit()
    git.answers.set('remote get-url origin', 'https://example.invalid/r.git\n')
    git.answers.set('rev-parse origin/main', 'f0f0f0f\n')
    // A recorded baseline outlives a cache that was wiped: there is nothing to clear, and a
    // reset would fail on a repository whose HEAD names no commit yet.
    git.failures.add('rev-parse --verify --quiet HEAD^{commit}')

    const checkout = await prepareCheckout({
      directory,
      repository: { ...REPOSITORY, base_commit: 'f0f0f0f' },
      git,
      heldBaseCommit: 'a1b2c3d',
    })

    expect(checkout).toEqual({ base_commit: 'f0f0f0f', work_branch: 'feature/tsk_1' })
    expect(git.calls).not.toContain('reset --quiet --hard')
    expect(git.calls).toContain('checkout --quiet -B feature/tsk_1 f0f0f0f')
  })
})

describe('workspace allocation', () => {
  it('prepares the directory and the checkout the payload names', async () => {
    const root = temporary('mps-coding-')
    const git = new RecordingGit()
    git.failures.add('remote get-url origin')
    git.answers.set('rev-parse origin/main', 'a1b2c3d\n')
    const allocator = checkoutAllocator({ store: new WorkspaceStore({ root }), git })

    const workspace = await allocator.prepare(assignment({ workspace: { workspace_id: 'ws_1', repo: REPOSITORY } }))

    expect(workspace).toEqual({
      directory: join(root, 'ws_1'),
      checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
    })
    expect(existsSync(join(root, 'ws_1'))).toBe(true)
  })

  it('hands over the directory alone when the payload names no repository', async () => {
    const root = temporary('mps-coding-')
    const git = new RecordingGit()
    const allocator = checkoutAllocator({ store: new WorkspaceStore({ root }), git })

    const workspace = await allocator.prepare(assignment({ workspace: { workspace_id: 'ws_2' } }))

    expect(workspace).toEqual({ directory: join(root, 'ws_2') })
    expect(git.calls).toEqual([])
  })

  it('prepares nothing when the payload names no workspace', async () => {
    const root = temporary('mps-coding-')
    const allocator = checkoutAllocator({ store: new WorkspaceStore({ root }), git: new RecordingGit() })

    expect(await allocator.prepare(assignment({}))).toBeUndefined()
    expect(existsSync(join(root, 'ws_1'))).toBe(false)
  })

  it('clears the workspace the platform re-dispatched onto a refreshed baseline', async () => {
    const root = temporary('mps-coding-')
    const store = new WorkspaceStore({ root })
    const git = new RecordingGit()
    git.failures.add('remote get-url origin')
    git.answers.set('rev-parse origin/main', 'f0f0f0f\n')
    const allocator = checkoutAllocator({ store, git })

    await allocator.prepare(assignment({ workspace: { workspace_id: 'ws_1', repo: REPOSITORY } }))
    // What the node reported for the workspace after its first task: the baseline it held.
    await store.setSession('ws_1', { ref: 'session-1', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })
    git.calls.length = 0

    const workspace = await allocator.prepare(
      assignment({ workspace: { workspace_id: 'ws_1', repo: { ...REPOSITORY, base_commit: 'f0f0f0f' } } }),
    )

    expect(workspace?.checkout).toEqual({ base_commit: 'f0f0f0f', work_branch: 'feature/tsk_1' })
    expect(workspace?.directory).toBe(join(root, 'ws_1'))
    // The reset moves the tree and the branch; the workspace and the session it carries are
    // what the platform expects to find again, so both stay.
    expect(store.records[0]?.session?.ref).toBe('session-1')
    expect(git.calls).toContain('reset --quiet --hard')
    expect(git.calls).toContain('checkout --quiet -B feature/tsk_1 f0f0f0f')
  })

  it('leaves a workspace with no recorded baseline alone', async () => {
    const root = temporary('mps-coding-')
    const store = new WorkspaceStore({ root })
    const git = new RecordingGit()
    git.failures.add('remote get-url origin')
    git.answers.set('rev-parse origin/main', 'f0f0f0f\n')
    const allocator = checkoutAllocator({ store, git })

    await allocator.prepare(assignment({ workspace: { workspace_id: 'ws_1', repo: REPOSITORY } }))
    git.calls.length = 0

    // Nothing was ever reported for this workspace, so a different dispatched base is not
    // known to be a refresh: the checkout itself still lands the tree on what was dispatched.
    await allocator.prepare(
      assignment({ workspace: { workspace_id: 'ws_1', repo: { ...REPOSITORY, base_commit: 'f0f0f0f' } } }),
    )

    expect(git.calls).not.toContain('reset --quiet --hard')
    expect(git.calls).toContain('checkout --quiet -B feature/tsk_1 f0f0f0f')
  })
})

describe('git on this host', () => {
  /** One repository with one commit, and the commit it sits at. */
  async function sourceRepository(git: GitRunner): Promise<{ directory: string; branch: string; commit: string }> {
    const directory = temporary('mps-source-')
    await git.run(directory, ['init', '--quiet'])
    writeFileSync(join(directory, 'readme.md'), 'base\n', 'utf8')
    await git.run(directory, ['add', 'readme.md'])
    await git.run(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'base'])
    const branch = (await git.run(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    const commit = (await git.run(directory, ['rev-parse', 'HEAD'])).stdout.trim()
    return { directory, branch, commit }
  }

  /**
   * Move a source repository's branch on by one commit.
   * @param git - the git runner.
   * @param directory - the source repository.
   * @param text - what the committed file should hold.
   * @returns the new commit.
   */
  async function advance(git: GitRunner, directory: string, text: string): Promise<string> {
    writeFileSync(join(directory, 'readme.md'), text, 'utf8')
    await git.run(directory, ['add', 'readme.md'])
    await git.run(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'move on'])
    return (await git.run(directory, ['rev-parse', 'HEAD'])).stdout.trim()
  }

  it('checks a task out and starts a retry clean', async () => {
    const git = cliGit()
    const source = await sourceRepository(git)
    const workspace = temporary('mps-workspace-')
    const repository: TaskRepository = {
      url: source.directory,
      base_branch: source.branch,
      base_commit: source.commit,
      work_branch: 'feature/tsk_1',
    }

    const checkout = await prepareCheckout({ directory: workspace, repository, git })

    expect(checkout).toEqual({ base_commit: source.commit, work_branch: 'feature/tsk_1' })
    // git checks out the line endings this host is configured for.
    expect(checkedOut(workspace)).toBe('base\n')
    expect((await git.run(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('feature/tsk_1')

    writeFileSync(join(workspace, 'readme.md'), 'half-done edit\n', 'utf8')
    writeFileSync(join(workspace, 'scratch.txt'), 'left over from the last attempt\n', 'utf8')
    await prepareCheckout({ directory: workspace, repository, git })

    expect(checkedOut(workspace)).toBe('base\n')
    expect(existsSync(join(workspace, 'scratch.txt'))).toBe(false)
  })

  it('refuses a base the base branch has moved past', async () => {
    const git = cliGit()
    const source = await sourceRepository(git)
    const workspace = temporary('mps-workspace-')
    const repository: TaskRepository = {
      url: source.directory,
      base_branch: source.branch,
      base_commit: source.commit,
      work_branch: 'feature/tsk_1',
    }
    await prepareCheckout({ directory: workspace, repository, git })

    writeFileSync(join(source.directory, 'readme.md'), 'moved on\n', 'utf8')
    await git.run(source.directory, ['add', 'readme.md'])
    await git.run(source.directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'move on'])

    // The platform dispatched from before a commit the branch already holds, so the tree
    // the node would hand back describes work that is no longer the branch's past.
    await expect(prepareCheckout({ directory: workspace, repository, git })).rejects.toThrow(
      /refusing to work from a base that is behind origin\//,
    )
  })

  it('keeps what a failing command said', async () => {
    const directory = temporary('mps-norepo-')

    const failure = await failureOf(cliGit(), directory, ['rev-parse', 'HEAD'])

    expect(failure.exitCode).toBe(128)
    expect(failure.stderr).toContain('not a git repository')
    expect(failure.command).toContain('rev-parse HEAD')
  })

  it('reports a git that never started', async () => {
    const directory = temporary('mps-nogit-')
    vi.stubEnv('PATH', directory)

    const failure = await failureOf(cliGit(), directory, ['status'])

    expect(failure.exitCode).toBeNull()
    expect(failure.stderr).toBe('')
    expect(failure.message).toContain('status failed')
  })

  it('reports the caller cancellation instead of a git failure', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(cliGit().run(tmpdir(), ['status'], controller.signal)).rejects.toThrow(/abort/i)
  })

  it('resets a re-dispatched workspace onto the refreshed base', async () => {
    const git = cliGit()
    const source = await sourceRepository(git)
    const workspace = temporary('mps-workspace-')
    const repository: TaskRepository = {
      url: source.directory,
      base_branch: source.branch,
      base_commit: source.commit,
      work_branch: 'feature/tsk_1',
    }
    await prepareCheckout({ directory: workspace, repository, git })
    // What a failed attempt leaves behind: a commit on the work branch, an edit to a tracked
    // file that was never committed, and a file git never tracked.
    writeFileSync(join(workspace, 'notes.md'), 'half done\n', 'utf8')
    await git.run(workspace, ['add', 'notes.md'])
    await git.run(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'half done'])
    writeFileSync(join(workspace, 'readme.md'), 'half-done edit\n', 'utf8')
    writeFileSync(join(workspace, 'scratch.txt'), 'left over from the last attempt\n', 'utf8')
    // The platform refreshes the baseline to what the branch holds now and re-dispatches.
    const refreshed = await advance(git, source.directory, 'moved on\n')

    const checkout = await prepareCheckout({
      directory: workspace,
      repository: { ...repository, base_commit: refreshed },
      git,
      heldBaseCommit: source.commit,
    })

    expect(checkout).toEqual({ base_commit: refreshed, work_branch: 'feature/tsk_1' })
    expect(checkedOut(workspace)).toBe('moved on\n')
    expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
    expect(existsSync(join(workspace, 'scratch.txt'))).toBe(false)
    expect((await git.run(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('feature/tsk_1')
    expect((await git.run(workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(refreshed)
    // The directory is what carries the workspace and its session across tasks, so the reset
    // moves the tree and the branch and leaves the directory, and its repository, where they were.
    expect(existsSync(workspace)).toBe(true)
    expect(existsSync(join(workspace, '.git'))).toBe(true)
  })

  it('still refuses a retry whose base the base branch has moved past', async () => {
    const git = cliGit()
    const source = await sourceRepository(git)
    const workspace = temporary('mps-workspace-')
    const repository: TaskRepository = {
      url: source.directory,
      base_branch: source.branch,
      base_commit: source.commit,
      work_branch: 'feature/tsk_1',
    }
    await prepareCheckout({ directory: workspace, repository, git })
    await advance(git, source.directory, 'moved on\n')

    // The dispatched base is the one this workspace already holds, so the task is a retry
    // rather than a re-dispatch: a base branch that moved past it is still refused.
    await expect(prepareCheckout({ directory: workspace, repository, git, heldBaseCommit: source.commit })).rejects.toThrow(
      /refusing to work from a base that is behind origin\//,
    )
  })
})
