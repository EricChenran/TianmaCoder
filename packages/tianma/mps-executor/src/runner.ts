/**
 * The seam a node's work rides on: a runner executes one claimed attempt and
 * reports what happened, while the node owns claiming, the lease, the runtime
 * ceiling, and the outcome submission. A runner never talks to the platform and
 * never decides its own slots, so composing a different execution strategy does not
 * touch the protocol lifecycle.
 * @module @tianma/dsh-mps-executor
 */

import type {
  ExecLogLine,
  ExecResultEvidence,
  ExecTaskAssignment,
  TaskOutcome,
  TaskProgress,
} from '@tianma/dsh-mps-exec-core'

/** What a runner reports about one finished attempt. */
export interface TaskRunResult {
  /** What the attempt achieved. */
  outcome: TaskOutcome
  /** Operator-visible summary of the attempt. */
  summary: string
  /** Evidence the platform checks for a delivered change. */
  evidence?: ExecResultEvidence | undefined
  /** Free-form notes the summary does not carry. */
  notes?: string | undefined
}

/** What a runner is given for one attempt. */
export interface TaskRunContext {
  /** The attempt's assignment, including the payload the platform sent. */
  task: ExecTaskAssignment
  /**
   * Directory this attempt works in, kept across the tasks of one platform
   * workspace; `undefined` when the payload names no workspace.
   */
  workspaceDirectory: string | undefined
  /**
   * Cancellation for this attempt. It is aborted when the platform withdraws the
   * task, when an abort command arrives, when the runtime ceiling passes, or when
   * the node stops; the runner must stop its work and settle promptly.
   */
  signal: AbortSignal
  /**
   * Report progress for this attempt.
   * @param progress - the stage and estimate to publish.
   */
  reportProgress(progress: TaskProgress): Promise<void>
  /**
   * Submit log lines for this attempt.
   * @param stream - the stream the lines came from.
   * @param lines - already-redacted lines, in order.
   */
  reportLog(stream: string, lines: ExecLogLine[]): Promise<void>
}

/**
 * Resolves the directory an attempt works in. The node keeps one directory per
 * platform workspace and reuses it across tasks, so a runner never decides where a
 * workspace lives or removes one itself.
 */
export interface TaskWorkspaceAllocator {
  /**
   * Resolve the directory for one workspace, creating it the first time.
   * @param workspaceId - the platform's workspace id.
   * @param taskId - the task being served.
   * @returns the directory.
   */
  ensure(workspaceId: string, taskId: string): Promise<string>
}

/** Executes one claimed attempt of a task. */
export interface TaskRunner {
  /**
   * Run one attempt to a settled result. Throwing reports the attempt as failed
   * with the thrown reason; returning reports the outcome it states.
   * @param context - the attempt's task, cancellation, and reporting channels.
   * @returns what the attempt achieved.
   */
  run(context: TaskRunContext): Promise<TaskRunResult>
}

/**
 * Resolves the runner this node executes with. It is read when the node starts
 * claiming, so a runner plugin composed anywhere in the tree is found even when it
 * mounts after the node, and a node without one holds its session instead of
 * claiming work it cannot do.
 * @returns the runner, or undefined when none is composed.
 */
export type TaskRunnerSource = () => TaskRunner | undefined
