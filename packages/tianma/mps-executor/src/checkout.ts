/**
 * The code an attempt starts from. The node works the tasks of one platform
 * workspace in the workspace's own repository cache: it initializes and fetches that
 * cache instead of cloning a fresh tree, fetches the branches a task names, checks
 * that the origin holds the base commit the platform dispatched, and resets the work
 * branch onto that commit with the previous attempt's leftovers cleared. A base no
 * fetch can reach is refused rather than silently worked from, because the result
 * would describe a tree nobody dispatched.
 * @module @tianma/dsh-mps-executor/checkout
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { taskRepository, taskWorkspaceId } from '@tianma/dsh-mps-exec-core'
import type { ExecTaskAssignment, TaskRepository } from '@tianma/dsh-mps-exec-core'
import type { GitOutput, GitRunner } from './git.ts'
import type { TaskCheckout, TaskWorkspace, TaskWorkspaceAllocator } from './runner.ts'
import type { WorkspaceStore } from './workspace.ts'

/** Options for {@link prepareCheckout}. */
export interface PrepareCheckoutOptions {
  /** Directory the workspace's repository cache lives in. */
  directory: string
  /** Repository the payload named. */
  repository: TaskRepository
  /** git on this host. */
  git: GitRunner
}

/** Options for {@link checkoutAllocator}. */
export interface CheckoutAllocatorOptions {
  /** The workspaces the node keeps. */
  store: WorkspaceStore
  /** git on this host. */
  git: GitRunner
}

/**
 * Runs a git command whose failure is an answer rather than an error.
 * @param git - the git runner.
 * @param directory - the working directory.
 * @param args - the arguments.
 * @returns what the command wrote, or undefined when it failed.
 */
async function tryRun(git: GitRunner, directory: string, args: readonly string[]): Promise<GitOutput | undefined> {
  try {
    return await git.run(directory, args)
  } catch {
    return undefined
  }
}

/**
 * Read a required repository field.
 * @param value - the field's value.
 * @param field - the field's name, for the failure text.
 * @returns the value.
 * @throws Error when the payload states none.
 */
function required(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`the task names no ${field}`)
  return value
}

/**
 * Whether the repository holds one commit, however it was reached.
 * @param git - the runner every git command goes through.
 * @param directory - the repository cache.
 * @param commit - the commit to look for.
 * @returns true when the commit is there.
 */
async function holdsCommit(git: GitRunner, directory: string, commit: string): Promise<boolean> {
  return await tryRun(git, directory, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]) !== undefined
}

/**
 * Bring the workspace's repository cache to the dispatched base commit and reset the work
 * branch onto it. The base is the commit the platform dispatched — the base branch's head
 * for a workspace's first task, and the work branch's head for a later one — so what the
 * node verifies is that the origin holds it at all: a base no fetch can reach is refused
 * rather than worked from, because the result would describe a tree nobody dispatched.
 * @param options - the directory, the repository the payload named, and git.
 * @returns the checkout the attempt works on.
 * @throws Error when the payload omits a field the flow needs, when the origin holds no
 * such commit, or when git fails.
 */
export async function prepareCheckout(options: PrepareCheckoutOptions): Promise<TaskCheckout> {
  const { directory, repository, git } = options
  const url = required(repository.url, 'repository to fetch')
  const baseBranch = required(repository.base_branch, 'base branch')
  const baseCommit = required(repository.base_commit, 'base commit')
  const workBranch = required(repository.work_branch, 'work branch')

  if (!existsSync(join(directory, '.git'))) await git.run(directory, ['init', '--quiet'])
  const origin = await tryRun(git, directory, ['remote', 'get-url', 'origin'])
  if (origin === undefined) await git.run(directory, ['remote', 'add', 'origin', url])
  else if (origin.stdout.trim() !== url) await git.run(directory, ['remote', 'set-url', 'origin', url])

  await git.run(directory, ['fetch', '--quiet', 'origin', baseBranch])
  // Then every branch: a workspace's later tasks are dispatched from the work branch an
  // earlier task pushed onto, which the base branch alone would never bring.
  await git.run(directory, ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
  if (await holdsCommit(git, directory, baseCommit) === false) {
    throw new Error(`refusing to work from a base this repository does not hold: the task dispatched ${baseCommit}`)
  }
  await git.run(directory, ['checkout', '--quiet', '-B', workBranch, baseCommit])
  // `checkout -B` leaves the tree alone when HEAD already sits on the branch, so a
  // retry in this workspace needs the reset to drop the last attempt's edits.
  await git.run(directory, ['reset', '--quiet', '--hard', baseCommit])
  await git.run(directory, ['clean', '--quiet', '-fd'])
  return { base_commit: baseCommit, work_branch: workBranch }
}

/**
 * The node's workspace allocator: the directory it keeps for a platform workspace,
 * plus the checkout inside it.
 * @param options - the workspace store and git.
 * @returns the allocator the orchestrator prepares attempts with.
 */
export function checkoutAllocator(options: CheckoutAllocatorOptions): TaskWorkspaceAllocator {
  return {
    async prepare(assignment: ExecTaskAssignment): Promise<TaskWorkspace | undefined> {
      const workspaceId = taskWorkspaceId(assignment.payload)
      if (workspaceId === undefined) return undefined
      const directory = await options.store.ensure(workspaceId, assignment.task_id)
      const repository = taskRepository(assignment.payload)
      if (repository === undefined) return { directory }
      const checkout = await prepareCheckout({ directory, repository, git: options.git })
      return { directory, checkout }
    },
  }
}
