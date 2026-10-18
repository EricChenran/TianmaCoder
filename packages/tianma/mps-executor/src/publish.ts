/**
 * Handing one attempt's work back. The node commits what the attempt left uncommitted
 * under the robot identity injected per command — never in the host's global git
 * configuration — after checking the two things the platform cannot check for it:
 * that every change stays inside the workspace once symlinks resolve, and that no
 * changed text file carries a credential. Work the attempt committed itself is handed
 * back as it stands. Both checks run before the commit, so a refused attempt leaves
 * nothing behind to push. Every path list comes from git with `-z`, so a deliverable
 * named outside ASCII reaches the filesystem, the checks, and the report as itself.
 * @module @tianma/dsh-mps-executor/publish
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { containsSecretPattern, isRepeatDispatch, lastAttemptHeadCommit, sha256Of, taskPolicy } from '@tianma/dsh-mps-exec-core'
import type { ExecTaskAssignment, TaskPolicy } from '@tianma/dsh-mps-exec-core'
import { FAILURE_CODES, AttemptRefusal, attemptFailure } from './failures.ts'
import type { GitRunner } from './git.ts'
import { excludeFromRepository, resolveWithinWorkspace } from './paths.ts'
import type { PublishedChanges, TaskBundle, TaskCheckout } from './runner.ts'

/** Largest changed file the node scans for credentials. */
export const PUBLISH_SCAN_MAX_BYTES = 1024 * 1024

/** Directory inside the workspace where a `read_only` attempt leaves its bundle. */
export const BUNDLE_DIRECTORY = '.bundles'

/** The identity a node commits under, injected per command. */
export interface GitIdentity {
  /** `user.name` for the commit. */
  name: string
  /** `user.email` for the commit. */
  email: string
}

/** Options for {@link publishChanges}. */
export interface PublishChangesOptions {
  /** The workspace directory. */
  directory: string
  /** The checkout the attempt worked on. */
  checkout: TaskCheckout
  /** What the payload asked of the node. */
  policy: TaskPolicy
  /** The robot identity the commit carries. */
  identity: GitIdentity
  /** The task the commit belongs to, which names it when the payload states no summary. */
  taskId: string
  /**
   * Whether this dispatch repeats work an earlier attempt of the same task may already
   * have delivered. With nothing left to commit, a repeat re-pushes the branch it already
   * holds and reports that push, which is the delivery the platform's gate reads; a first
   * dispatch that changed nothing has delivered nothing.
   */
  repeat?: boolean | undefined
  /** git on this host. */
  git: GitRunner
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/** What one publish request tells the node to hand back. */
export interface TaskPublishRequest {
  /** The attempt being published. */
  assignment: ExecTaskAssignment
  /** The workspace directory. */
  directory: string
  /** The checkout the attempt worked on. */
  checkout: TaskCheckout
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/** Hands one attempt's work back to the platform. */
export interface TaskPublisher {
  /**
   * Commit the changes the attempt left uncommitted and push the work branch.
   * @param request - the attempt, its workspace, and its checkout.
   * @returns the paths, the commit, and whether the branch was pushed.
   */
  publish(request: TaskPublishRequest): Promise<PublishedChanges>
}

/** Options for {@link checkoutPublisher}. */
export interface CheckoutPublisherOptions {
  /** git on this host. */
  git: GitRunner
  /** The robot identity the node commits under. */
  identity: GitIdentity
}

/**
 * Split one git path listing into the paths it holds. Every listing this module reads
 * is asked for with `-z`, so git separates entries with NUL and quotes nothing: a name
 * with a space, a parenthesis, or Chinese characters arrives as the name it is. A
 * line-separated listing would arrive as `"\345\212\251..."` — a string no filesystem
 * can open, and one whose leading quote makes every path check below it meaningless.
 * @param output - the command's standard output.
 * @returns the paths, in the order git listed them.
 */
function listedPaths(output: string): string[] {
  return output.split('\0').filter(path => path !== '')
}

/**
 * The paths that differ from one commit, both tracked and not yet tracked.
 * @param git - the git runner.
 * @param directory - the workspace directory.
 * @param against - the commit to compare the tree with, or `HEAD` for uncommitted work.
 * @param signal - caller cancellation.
 * @returns the workspace-relative paths, sorted.
 */
export async function changedFiles(
  git: GitRunner,
  directory: string,
  against: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const tracked = await git.run(directory, ['diff', '--name-only', '-z', against], signal)
  const untracked = await git.run(directory, ['ls-files', '--others', '--exclude-standard', '-z'], signal)
  return [...new Set([...listedPaths(tracked.stdout), ...listedPaths(untracked.stdout)])].sort()
}

/**
 * Whether a path is the pattern or sits under it.
 * @param pattern - the pattern the payload forbids.
 * @param file - the workspace-relative path.
 * @returns true when the path is forbidden.
 */
function isForbidden(pattern: string, file: string): boolean {
  const trimmed = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (trimmed === '') return false
  return file === trimmed || file.startsWith(`${trimmed}/`)
}

/**
 * Check that a work branch may be pushed.
 * @param branch - the branch the node works on.
 * @param pattern - the pattern the payload states, when it states one.
 * @throws Error when the branch does not match, or the pattern is not a pattern.
 */
export function assertBranchAllowed(branch: string, pattern: string | undefined): void {
  if (pattern === undefined) return
  let expression: RegExp
  try {
    expression = new RegExp(pattern, 'u')
  } catch (error) {
    throw new AttemptRefusal(FAILURE_CODES.branchNotAllowed, `the task's branch pattern ${JSON.stringify(pattern)} is not usable: ${String(error)}`)
  }
  if (!expression.test(branch)) {
    throw new AttemptRefusal(FAILURE_CODES.branchNotAllowed, `refusing to push ${branch}: it does not match the task's branch pattern ${JSON.stringify(pattern)}`)
  }
}

/**
 * Check that the attempt is still on the branch it hands back. A run works with the
 * CLI's own permissions, so it can check out another branch or detach HEAD; the commit
 * would then land on a ref the push does not carry, and the reported commit and changed
 * paths would describe a tree the platform never receives.
 * @param git - the git runner.
 * @param directory - the workspace directory.
 * @param branch - the branch the task works on.
 * @param signal - caller cancellation.
 * @throws Error when HEAD is a detached or a different branch.
 */
export async function assertOnWorkBranch(
  git: GitRunner,
  directory: string,
  branch: string,
  signal?: AbortSignal | undefined,
): Promise<void> {
  // `--abbrev-ref` prints `HEAD` for a detached one, which is the one case a name cannot express.
  const current = (await git.run(directory, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).stdout.trim()
  if (current === branch) return
  throw new AttemptRefusal(FAILURE_CODES.branchMoved, current === 'HEAD'
    ? `refusing to hand back work from a detached HEAD: the task works on ${branch}`
    : `refusing to hand back work from ${current}: the task works on ${branch}`)
}

/**
 * Check that every change stays inside the workspace once symlinks resolve.
 * @param directory - the workspace directory.
 * @param files - the changed paths.
 * @param forbiddenPaths - patterns the task forbids.
 * @throws Error on an absolute path, a path that climbs out, a forbidden path, or a
 * path that resolves outside the workspace.
 */
export async function assertChangesInside(
  directory: string,
  files: readonly string[],
  forbiddenPaths?: readonly string[] | undefined,
): Promise<void> {
  for (const file of files) {
    const forbidden = forbiddenPaths?.find(pattern => isForbidden(pattern, file))
    if (forbidden !== undefined) {
      throw new Error(`refusing to publish ${file}: the task forbids changes matching ${JSON.stringify(forbidden)}`)
    }
    await resolveWithinWorkspace(directory, file)
  }
}

/**
 * Find changed files whose text carries a credential.
 * @param directory - the workspace directory.
 * @param files - the changed paths.
 * @returns the offending paths, sorted.
 */
export async function filesCarryingSecrets(directory: string, files: readonly string[]): Promise<string[]> {
  const offending: string[] = []
  for (const file of files) {
    const target = join(directory, file)
    const details = await stat(target).catch(() => undefined)
    if (details === undefined || !details.isFile() || details.size > PUBLISH_SCAN_MAX_BYTES) continue
    const content = await readFile(target)
    // A NUL byte means the file is not text the node can judge.
    if (content.includes(0)) continue
    if (containsSecretPattern(content.toString('utf8'))) offending.push(file)
  }
  return offending
}

/**
 * Commit what one attempt left uncommitted, push its work branch, and report the
 * deliverable against the base the platform dispatched.
 * @param options - the workspace, the checkout, the payload's policy, and the identity.
 * @returns the changed paths, the commit, and whether the branch was pushed.
 * @throws Error when the task asks for an access mode this node does not implement,
 * when a change leaves the workspace, when a change carries a credential, when the
 * branch name is refused, when the attempt moved off the task's branch, when git cannot
 * stage changes it reports, or when git fails.
 */
export async function publishChanges(options: PublishChangesOptions): Promise<PublishedChanges> {
  const { directory, checkout, policy, identity, git, signal } = options
  // A read_only task hands its work back as a bundle the platform fetches, so the node
  // commits but never pushes.
  const readOnly = policy.access_mode === 'read_only'
  assertBranchAllowed(checkout.work_branch, policy.branch_pattern)
  // The branch the attempt hands back is the one the task named, whatever the run did to
  // HEAD inside: a commit on another ref would be pushed as nothing, and the reported
  // commit would name a tree the platform never receives.
  await assertOnWorkBranch(git, directory, checkout.work_branch, signal)
  const files = await changedFiles(git, directory, checkout.base_commit, signal)
  const secrets = await filesCarryingSecrets(directory, files)
  if (secrets.length > 0) {
    throw new AttemptRefusal(FAILURE_CODES.credentials, `refusing to publish credentials in ${secrets.join(', ')}`)
  }
  // A payload may state that the task does not need the confinement check; absent,
  // the node applies it, because handing back changes from outside the workspace is
  // never what the task meant.
  if (policy.must_stay_in_workspace !== false) {
    await assertChangesInside(directory, files, policy.forbidden_paths)
  }
  if (files.length === 0) {
    // A repeat with nothing new to commit is work the platform already has: push the branch
    // it points at and report the push, rather than reporting a failure for a delivery that
    // is on the remote. A first dispatch that changed nothing delivered nothing.
    if (options.repeat === true && !readOnly && policy.push_required !== false) {
      const head = (await git.run(directory, ['rev-parse', 'HEAD'], signal)).stdout.trim()
      await pushWorkBranch({ git, directory, branch: checkout.work_branch, head, signal })
      return { changed_files: [], head_commit: head, pushed: true }
    }
    return { changed_files: [], head_commit: checkout.base_commit, pushed: false }
  }
  // The commit decision compares the tree with HEAD, not with the base: an attempt may
  // commit its own work (a task can tell it to), and a retry starts from the dispatched
  // base while its work branch already holds earlier commits. Against the base those
  // committed paths look pending, the index stays empty, and git answers the commit with
  // exit code 1 — the failure this node used to report with no diagnostic at all.
  const pending = await changedFiles(git, directory, 'HEAD', signal)
  if (pending.length > 0) {
    await git.run(directory, ['add', '--all'], signal)
    // A path git will not stage — a submodule whose worktree is dirty, say — would leave
    // the commit empty too; name the paths instead of letting git fail with a bare code.
    const staged = listedPaths((await git.run(directory, ['diff', '--cached', '--name-only', '-z'], signal)).stdout)
    if (staged.length === 0) {
      throw new AttemptRefusal(FAILURE_CODES.changesNotStaged, `git staged none of the changes the attempt left uncommitted: ${pending.join(', ')}`)
    }
    await git.run(directory, [
      '-c', `user.name=${identity.name}`,
      '-c', `user.email=${identity.email}`,
      'commit', '--quiet', '-m', policy.summary ?? `task ${options.taskId}`,
    ], signal)
  }
  const head = (await git.run(directory, ['rev-parse', 'HEAD'], signal)).stdout.trim()
  if (readOnly) {
    return {
      changed_files: files,
      head_commit: head,
      pushed: false,
      bundle: await writeBundle({ directory, branch: checkout.work_branch, base: checkout.base_commit, head, git, signal }),
    }
  }
  if (policy.push_required === false) {
    return { changed_files: files, head_commit: head, pushed: false }
  }
  await pushWorkBranch({ git, directory, branch: checkout.work_branch, head, signal })
  return { changed_files: files, head_commit: head, pushed: true }
}

/**
 * Push the work branch, telling a refusal apart from every other git failure. A remote
 * branch that already holds commits this attempt does not is the failure a node meets in
 * the field, and the platform retries it differently from a hook or a protected branch —
 * so the refusal carries the code, git's own words, and the commit the attempt reached,
 * which the platform keeps as the previous attempt's head.
 * @param options - the runner, the workspace, the branch, the commit, and cancellation.
 * @throws AttemptRefusal naming why the push did not happen.
 */
async function pushWorkBranch(options: {
  git: GitRunner
  directory: string
  branch: string
  head: string
  signal?: AbortSignal
}): Promise<void> {
  try {
    await options.git.run(options.directory, ['push', 'origin', options.branch], options.signal)
  } catch (error: unknown) {
    const failure = attemptFailure(error)
    throw new AttemptRefusal(failure.error.code, failure.summary, {
      headCommit: options.head,
      detail: failure.error.detail ?? '',
    })
  }
}

/**
 * Write the bundle one `read_only` attempt hands back: the commits it made, with the
 * base the receiver already has as a prerequisite. The bundle is the node's own output,
 * so it is written after the commit and kept out of the repository.
 * @param options - the workspace, the branch, the base, the head, git, and cancellation.
 * @returns the path relative to the workspace and the file's digest.
 * @throws Error when git cannot write the bundle.
 */
async function writeBundle(options: {
  directory: string
  branch: string
  base: string
  head: string
  git: GitRunner
  signal?: AbortSignal | undefined
}): Promise<TaskBundle> {
  const name = `${options.branch.replace(/[^A-Za-z0-9._-]+/gu, '-')}-${options.head.slice(0, 12)}.bundle`
  const path = join(BUNDLE_DIRECTORY, name)
  await mkdir(join(options.directory, BUNDLE_DIRECTORY), { recursive: true })
  await options.git.run(
    options.directory,
    // The positive side is the branch the platform will fetch; the base is a prerequisite.
    ['bundle', 'create', path, options.branch, '--not', options.base],
    options.signal,
  )
  excludeFromRepository(options.directory, `${BUNDLE_DIRECTORY}/`)
  return { path, sha256: sha256Of(await readFile(join(options.directory, path))) }
}

/**
 * The node's publisher: the git boundary and robot identity a deployment configured.
 * @param options - git and the identity.
 * @returns the publisher the orchestrator hands to a runner.
 */
export function checkoutPublisher(options: CheckoutPublisherOptions): TaskPublisher {
  return {
    async publish(request: TaskPublishRequest): Promise<PublishedChanges> {
      return await publishChanges({
        directory: request.directory,
        checkout: request.checkout,
        policy: taskPolicy(request.assignment.payload),
        identity: options.identity,
        taskId: request.assignment.task_id,
        // A repeat that names the head an earlier attempt reached is work the platform
        // already has; committing nothing then is idempotence, not an empty attempt.
        repeat: isRepeatDispatch(request.assignment.payload)
          && lastAttemptHeadCommit(request.assignment.payload) !== undefined,
        git: options.git,
        signal: request.signal,
      })
    },
  }
}
