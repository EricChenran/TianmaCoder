/**
 * Task vocabulary of the executor protocol: the outcomes a node reports, how
 * conflicting signals resolve, and the two payload fields that steer a node's own
 * behaviour. The payload itself stays as the platform sent it — a runner reads the
 * fields it needs — so this module reads only what the node must honour on its own.
 * @module @tianma/dsh-mps-exec-core
 */

/** Terminal outcome a node reports for one attempt. */
export type TaskOutcome = 'success' | 'failed' | 'blocked' | 'cancelled'

/**
 * Outcome precedence the protocol's result table implies: an abort overrides
 * everything, a blocked report outranks a failure (it names a more specific
 * reason), and a failure outranks success.
 */
const OUTCOME_PRECEDENCE: Record<TaskOutcome, number> = {
  cancelled: 3,
  blocked: 2,
  failed: 1,
  success: 0,
}

/**
 * The outcome two signals agree on.
 * @param left - one reported outcome.
 * @param right - the other reported outcome.
 * @returns whichever of the two outranks the other.
 */
export function strongerOutcome(left: TaskOutcome, right: TaskOutcome): TaskOutcome {
  return OUTCOME_PRECEDENCE[left] >= OUTCOME_PRECEDENCE[right] ? left : right
}

/** Stage names a progress report may carry. */
export const TASK_STAGES = [
  'preparing',
  'coding',
  'building',
  'testing',
  'collecting_evidence',
  'uploading',
  'pushing',
] as const

/** One stage of a task's progress. */
export type TaskStage = (typeof TASK_STAGES)[number]

/**
 * Progress a runner reports, without the attempt the client fills in.
 */
export interface TaskProgress {
  /** Percent complete, an estimate. */
  progress: number
  /** Current stage. */
  stage: TaskStage
  /** Operator-visible note. */
  message: string
  /** Estimated seconds to completion. */
  eta_seconds?: number | undefined
}

/**
 * Whether a payload field is a plain object.
 * @param value - the value to test.
 * @returns true for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a nested payload field.
 * @param payload - the task payload.
 * @param group - the top-level field carrying the value.
 * @param field - the field inside that group.
 * @returns the value, or undefined when the payload states none.
 */
function payloadField(payload: Record<string, unknown>, group: string, field: string): unknown {
  const container = payload[group]
  if (!isRecord(container)) return undefined
  return container[field]
}

/**
 * Read the node-side runtime ceiling a task payload states. The node implements
 * this timeout itself; lease recycling is the platform's fallback, not a timeout.
 * @param payload - the payload a claim returned.
 * @returns the ceiling in milliseconds, or undefined when the payload states none.
 */
export function taskRuntimeLimitMs(payload: Record<string, unknown>): number | undefined {
  const seconds = payloadField(payload, 'limits', 'max_runtime_seconds')
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined
  return seconds * 1000
}

/**
 * Read the workspace a task belongs to, which is the directory the node keeps for
 * that workspace across tasks and attempts.
 * @param payload - the payload a claim returned.
 * @returns the workspace id, or undefined when the payload states none.
 */
export function taskWorkspaceId(payload: Record<string, unknown>): string | undefined {
  const workspace = payload['workspace']
  if (!isRecord(workspace)) return undefined
  const id = workspace['workspace_id']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The repository a task's workspace carries. */
export interface TaskRepository {
  /** Remote URL. */
  url?: string | undefined
  /** Branch the base commit belongs to. */
  base_branch?: string | undefined
  /** Commit the platform synchronized before dispatch. */
  base_commit?: string | undefined
  /** Branch the node works and pushes on. */
  work_branch?: string | undefined
}

/**
 * Read the repository a task's workspace carries. The base commit is the platform's
 * synchronized commit, so evidence reports against it.
 * @param payload - the payload a claim returned.
 * @returns the fields the payload states, or undefined when it carries no repository.
 */
export function taskRepository(payload: Record<string, unknown>): TaskRepository | undefined {
  const workspace = payload['workspace']
  if (!isRecord(workspace)) return undefined
  const repo = workspace['repo']
  if (!isRecord(repo)) return undefined
  const field = (name: string): string | undefined => {
    const value = repo[name]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  return {
    url: field('url'),
    base_branch: field('base_branch'),
    base_commit: field('base_commit'),
    work_branch: field('work_branch'),
  }
}
