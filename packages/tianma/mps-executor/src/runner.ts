/**
 * The seam a node's work rides on: a runner executes one claimed attempt and
 * reports what happened, while the node owns claiming, the lease, the runtime
 * ceiling, and the outcome submission. A runner never talks to the platform and
 * never decides its own slots, so composing a different execution strategy does not
 * touch the protocol lifecycle.
 * @module @tianma/dsh-mps-executor
 */

import type {
  ExecArtifactKind,
  ExecLogLine,
  ExecResource,
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

/** What an attempt starts from inside its workspace. */
export interface TaskCheckout {
  /** Commit the attempt starts from, as the platform dispatched it. */
  base_commit: string
  /** Branch the attempt works and pushes on. */
  work_branch: string
}

/** Where an attempt works and what it starts from. */
export interface TaskWorkspace {
  /** Directory the attempt works in. */
  directory: string
  /** The checkout the node prepared, when the payload names a repository. */
  checkout?: TaskCheckout | undefined
}

/**
 * Prepares where an attempt works and what it starts from. The node keeps one
 * directory per platform workspace and reuses it across tasks, so a runner never
 * decides where a workspace lives, how the code arrives, or when one is removed.
 */
export interface TaskWorkspaceAllocator {
  /**
   * Prepare the workspace for one attempt.
   * @param assignment - the claimed task.
   * @returns the workspace, or undefined when the payload names none.
   */
  prepare(assignment: ExecTaskAssignment): Promise<TaskWorkspace | undefined>
}

/** What an attempt handed back through {@link TaskRunContext.publish}. */
export interface PublishedChanges {
  /** Paths the attempt changed, relative to the workspace. */
  changed_files: string[]
  /** Commit the work branch now points at. */
  head_commit: string
  /** Whether the work branch was pushed. */
  pushed: boolean
  /**
   * The bundle a `read_only` attempt hands back instead of a push, present only in
   * that access mode.
   */
  bundle?: TaskBundle | undefined
}

/** A git bundle carrying one attempt's commits, and the digest the platform verifies. */
export interface TaskBundle {
  /** Path of the bundle, relative to the workspace. */
  path: string
  /** SHA-256 of the file. */
  sha256: string
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
   * The checkout the node prepared and verified; `undefined` when the payload names
   * no repository. The runner works on this branch and pushes it.
   */
  checkout: TaskCheckout | undefined
  /**
   * Download one of the materials this attempt's task carries, such as the task
   * brief or an input file the payload references. The node checks the contents
   * against the digest the platform states before handing them over.
   * @param artifactId - the material, which the platform checks belongs to the task.
   * @returns the verified contents and the digest.
   */
  resource(artifactId: string): Promise<ExecResource>
  /**
   * Upload one file this attempt produced, such as a screenshot, a report, or a
   * build log. The node reads it from inside the workspace, digests it, and refuses
   * one beyond the size the protocol allows in a single request.
   * @param kind - what the file is.
   * @param path - path of the file, relative to the workspace.
   * @param meta - what the platform keeps beside the artifact.
   * @returns the artifact id the platform stored it under, for the result evidence.
   */
  uploadArtifact(kind: ExecArtifactKind, path: string, meta?: Record<string, unknown>): Promise<string>
  /**
   * Report the session serving this attempt's workspace. The node records it beside
   * the workspace and tells the platform, which needs the reference to show and
   * troubleshoot the workspace; call it whenever the session is created or replaced.
   * @param sessionRef - the session reference.
   */
  reportSession(sessionRef: string): Promise<void>
  /**
   * Hand this attempt's work back: the node commits the changes under its robot
   * identity and pushes the work branch, after checking that every change stays
   * inside the workspace and carries no credential.
   * @returns the changed paths, the commit, and whether the branch was pushed.
   */
  publish(): Promise<PublishedChanges>
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
   * @param lines - the lines in order; the node redacts and bounds them before they
   * are submitted, so a runner hands over what it read.
   */
  reportLog(stream: string, lines: ExecLogLine[]): Promise<void>
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
