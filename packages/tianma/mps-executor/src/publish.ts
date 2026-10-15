/**
 * Handing one attempt's work back. The node commits what the attempt changed under
 * the robot identity injected per command — never in the host's global git
 * configuration — after checking the two things the platform cannot check for it:
 * that every change stays inside the workspace once symlinks resolve, and that no
 * changed text file carries a credential. Both checks run before the commit, so a
 * refused attempt leaves nothing behind to push.
 * @module @tianma/dsh-mps-executor/publish
 */

import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { containsSecretPattern, taskPolicy } from '@tianma/dsh-mps-exec-core'
import type { ExecTaskAssignment, TaskPolicy } from '@tianma/dsh-mps-exec-core'
import type { GitRunner } from './git.ts'
import type { PublishedChanges, TaskCheckout } from './runner.ts'

/** Largest changed file the node scans for credentials. */
export const PUBLISH_SCAN_MAX_BYTES = 1024 * 1024

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
   * Commit the attempt's changes and push the work branch.
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
 * Whether a resolved path sits strictly inside the root.
 * @param root - the resolved root.
 * @param target - the resolved path.
 * @returns true when the path is below the root.
 */
function isInside(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/** Split git's newline-separated output into paths. */
function pathsOf(output: string): string[] {
  return output.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

/**
 * The paths one attempt changed, both tracked and not yet tracked.
 * @param git - the git runner.
 * @param directory - the workspace directory.
 * @param baseCommit - the commit the attempt started from.
 * @param signal - caller cancellation.
 * @returns the workspace-relative paths, sorted.
 */
export async function changedFiles(
  git: GitRunner,
  directory: string,
  baseCommit: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const tracked = await git.run(directory, ['diff', '--name-only', baseCommit], signal)
  const untracked = await git.run(directory, ['ls-files', '--others', '--exclude-standard'], signal)
  return [...new Set([...pathsOf(tracked.stdout), ...pathsOf(untracked.stdout)])].sort()
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
    throw new Error(`the task's branch pattern ${JSON.stringify(pattern)} is not usable: ${String(error)}`)
  }
  if (!expression.test(branch)) {
    throw new Error(`refusing to push ${branch}: it does not match the task's branch pattern ${JSON.stringify(pattern)}`)
  }
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
  const root = await realpath(directory)
  for (const file of files) {
    if (isAbsolute(file) || file.split('/').includes('..')) {
      throw new Error(`refusing to publish ${file}: it is not a path inside the workspace`)
    }
    const forbidden = forbiddenPaths?.find(pattern => isForbidden(pattern, file))
    if (forbidden !== undefined) {
      throw new Error(`refusing to publish ${file}: the task forbids changes matching ${JSON.stringify(forbidden)}`)
    }
    const target = join(root, file)
    if (existsSync(target)) {
      const resolved = await realpath(target)
      if (!isInside(root, resolved)) {
        throw new Error(`refusing to publish ${file}: it resolves outside the workspace at ${resolved}`)
      }
      continue
    }
    // A path git reports that is not on disk any more is judged by where it lived.
    const parent = await realpath(dirname(target))
    if (parent !== root && !isInside(root, parent)) {
      throw new Error(`refusing to publish ${file}: it resolves outside the workspace at ${parent}`)
    }
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
 * Commit one attempt's changes and push its work branch.
 * @param options - the workspace, the checkout, the payload's policy, and the identity.
 * @returns the changed paths, the commit, and whether the branch was pushed.
 * @throws Error when the task asks for an access mode this node does not implement,
 * when a change leaves the workspace, when a change carries a credential, when the
 * branch name is refused, or when git fails.
 */
export async function publishChanges(options: PublishChangesOptions): Promise<PublishedChanges> {
  const { directory, checkout, policy, identity, git, signal } = options
  if (policy.access_mode === 'read_only') {
    throw new Error('this node does not implement the read_only access mode, which hands work back as a bundle')
  }
  assertBranchAllowed(checkout.work_branch, policy.branch_pattern)
  const files = await changedFiles(git, directory, checkout.base_commit, signal)
  const secrets = await filesCarryingSecrets(directory, files)
  if (secrets.length > 0) {
    throw new Error(`refusing to publish credentials in ${secrets.join(', ')}`)
  }
  // A payload may state that the task does not need the confinement check; absent,
  // the node applies it, because handing back changes from outside the workspace is
  // never what the task meant.
  if (policy.must_stay_in_workspace !== false) {
    await assertChangesInside(directory, files, policy.forbidden_paths)
  }
  if (files.length === 0) {
    return { changed_files: [], head_commit: checkout.base_commit, pushed: false }
  }
  await git.run(directory, ['add', '--all'], signal)
  await git.run(directory, [
    '-c', `user.name=${identity.name}`,
    '-c', `user.email=${identity.email}`,
    'commit', '--quiet', '-m', policy.summary ?? `task ${options.taskId}`,
  ], signal)
  const head = (await git.run(directory, ['rev-parse', 'HEAD'], signal)).stdout.trim()
  if (policy.push_required === false) {
    return { changed_files: files, head_commit: head, pushed: false }
  }
  await git.run(directory, ['push', 'origin', checkout.work_branch], signal)
  return { changed_files: files, head_commit: head, pushed: true }
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
        git: options.git,
        signal: request.signal,
      })
    },
  }
}
