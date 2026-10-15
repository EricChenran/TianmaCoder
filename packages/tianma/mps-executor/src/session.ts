/**
 * The dsh session serving a coding workspace. The platform keeps the reference for
 * display and troubleshooting only, but a node that loses it cannot tell an
 * operator which session produced a workspace's work, so the node records it beside
 * the workspace before reporting it and re-reports what it restored after a
 * restart.
 * @module @tianma/dsh-mps-executor/session
 */

import { taskWorkspaceId } from '@tianma/dsh-mps-exec-core'
import type { ExecSessionReportRequest, ExecTaskAssignment } from '@tianma/dsh-mps-exec-core'
import type { WorkspaceStore } from './workspace.ts'

/** The session call the node makes. */
export interface SessionPlatformClient {
  /**
   * Report the session and coding path this node keeps for one workspace.
   * @param workspaceId - the platform's workspace id.
   * @param body - session reference, coding path, baseline commit, and last task.
   * @param signal - caller cancellation.
   */
  reportSession(workspaceId: string, body: ExecSessionReportRequest, signal?: AbortSignal): Promise<void>
}

/** What one session report tells the node. */
export interface TaskSessionRequest {
  /** The attempt the session was serving. */
  assignment: ExecTaskAssignment
  /** The workspace directory the session works in. */
  directory: string
  /** The session reference to report. */
  sessionRef: string
  /** Baseline commit the directory holds. */
  baseCommit: string
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/** Reports the session serving one workspace, when it changes. */
export interface TaskSessionReporter {
  /**
   * Record the session beside its workspace and report it to the platform.
   * @param request - the attempt, its workspace, and the session.
   */
  report(request: TaskSessionRequest): Promise<void>
}

/** Options for {@link checkoutSessionReporter}. */
export interface CheckoutSessionReporterOptions {
  /** The workspaces the node keeps. */
  store: WorkspaceStore
  /** The authenticated session's client. */
  client: SessionPlatformClient
}

/** One session report a restarted node owes the platform. */
export interface RestoredSessionReport {
  /** The workspace the session serves. */
  workspace_id: string
  /** The report to send. */
  body: ExecSessionReportRequest
}

/**
 * The node's session reporter: it records the session beside the workspace first, so
 * a failed report never loses it, and then tells the platform.
 * @param options - the workspace store and the platform client.
 * @returns the reporter the orchestrator hands to a runner.
 */
export function checkoutSessionReporter(options: CheckoutSessionReporterOptions): TaskSessionReporter {
  return {
    async report(request: TaskSessionRequest): Promise<void> {
      const workspaceId = taskWorkspaceId(request.assignment.payload)
      if (workspaceId === undefined) throw new Error('the task names no workspace to report a session for')
      await options.store.setSession(workspaceId, {
        ref: request.sessionRef,
        base_commit: request.baseCommit,
        last_task_id: request.assignment.task_id,
      })
      await options.client.reportSession(workspaceId, {
        session_ref: request.sessionRef,
        coding_path: request.directory,
        base_commit: request.baseCommit,
        last_task_id: request.assignment.task_id,
      }, request.signal)
    },
  }
}

/**
 * The session reports a node owes after a restart, so the platform keeps showing the
 * session and coding path of workspaces this node already held.
 * @param store - the workspaces the node restored.
 * @returns one report per workspace that has a session.
 */
export function restoredSessionReports(store: WorkspaceStore): RestoredSessionReport[] {
  const reports: RestoredSessionReport[] = []
  for (const record of store.records) {
    const session = record.session
    if (session === undefined) continue
    reports.push({
      workspace_id: record.workspace_id,
      body: {
        session_ref: session.ref,
        coding_path: record.directory,
        base_commit: session.base_commit,
        last_task_id: session.last_task_id,
      },
    })
  }
  return reports
}
