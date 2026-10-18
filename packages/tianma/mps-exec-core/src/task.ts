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
 * Read the session the platform asks the node to continue. The protocol sends the session
 * a previous task in the same workspace used, so a node adopts it when the agent still
 * knows it and starts a new one otherwise.
 * @param payload - the payload a claim returned.
 * @returns the session reference, or undefined when the payload states none.
 */
export function taskSessionHint(payload: Record<string, unknown>): string | undefined {
  const hint = payloadField(payload, 'limits', 'session_hint')
  return stringField(hint, 'previous_session_ref')
}

/**
 * Read the instruction a task carries, which is what a runner hands to the agent.
 * @param payload - the payload a claim returned.
 * @returns the instruction, or undefined when the payload states none.
 */
export function taskInstruction(payload: Record<string, unknown>): string | undefined {
  const instruction = payloadField(payload, 'spec', 'raw_instruction')
  return typeof instruction === 'string' && instruction.trim() !== '' ? instruction : undefined
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

/** How a node may hand its work back: pushing itself, or producing a bundle. */
export type ExecAccessMode = 'read_write' | 'read_only'

/** What a task's payload asks of the node before it hands work back. */
export interface TaskPolicy {
  /** Whether the node pushes the work branch itself or produces a bundle. */
  access_mode?: ExecAccessMode | undefined
  /** Whether the node must check that every change stays inside its workspace. */
  must_stay_in_workspace?: boolean | undefined
  /** Path patterns the task forbids. */
  forbidden_paths?: string[] | undefined
  /** Pattern the work branch name must match. */
  branch_pattern?: string | undefined
  /** Pattern the file names an attempt gives its deliverables must match. */
  filename_pattern?: string | undefined
  /** Whether the platform requires the work branch pushed. */
  push_required?: boolean | undefined
  /** The task's own summary, which names the commit. */
  summary?: string | undefined
  /** Deadline the platform set, as an RFC 3339 string. */
  deadline?: string | undefined
}

/**
 * Read the constraints and delivery promises a payload states, which the node
 * applies itself before it hands work back.
 * @param payload - the payload a claim returned.
 * @returns the fields the payload states.
 */
export function taskPolicy(payload: Record<string, unknown>): TaskPolicy {
  const constraints = payload['constraints']
  const deliverables = payload['deliverables']
  const workspace = payload['workspace']
  const mode = isRecord(workspace) ? workspace['access_mode'] : undefined
  return {
    access_mode: mode === 'read_write' || mode === 'read_only' ? mode : undefined,
    must_stay_in_workspace: payloadField(payload, 'constraints', 'must_stay_in_workspace') === true,
    forbidden_paths: isRecord(constraints) ? stringList(constraints['forbidden_paths']) : undefined,
    branch_pattern: stringField(constraints, 'branch_pattern'),
    filename_pattern: stringField(constraints, 'filename_pattern'),
    push_required: isRecord(deliverables) ? deliverables['push_required'] === true : undefined,
    summary: stringField(payload, 'summary'),
    deadline: stringField(constraints, 'deadline'),
  }
}

/**
 * Read one non-empty string field of a record.
 * @param source - the record, or undefined.
 * @param name - the field name.
 * @returns the value, or undefined when the field is missing or not a non-empty string.
 */
function stringField(source: unknown, name: string): string | undefined {
  if (!isRecord(source)) return undefined
  const value = source[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read a list of non-empty strings.
 * @param value - the field's value.
 * @returns the strings, or undefined when the field is not a list.
 */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** The coding work kind: a repository task with the full delivery pipeline. */
export const WORK_KIND_CODING = 'coding'

/**
 * The chat-answer work kind: a hosted-group question that needs one reply in
 * the result `summary`, no repository, no artifacts, and the platform's own
 * answerer taking over when the node does not settle within its soft deadline.
 */
export const WORK_KIND_CHAT_ANSWER = 'chat_answer'

/** The chat-answer task's payload, the `answer` object of a claim's response. */
export interface ChatAnswerTask {
  /** Group conversation the question arrived in; echoed back, never dialed. */
  chat_id: string
  /** Message id the platform knows the question by. */
  message_id: number
  /** The question to answer. */
  question: string
  /** Who asked, when the platform states it. */
  sender?: string | undefined
  /** Classified intent, when the platform states one. */
  intent?: string | undefined
}

/**
 * Read the chat-answer payload of an answer-kind task. A claim whose payload
 * states no readable question cannot be answered, which the caller reports as
 * `failed` so the platform's own answerer takes over quickly.
 * @param payload - the payload a claim returned.
 * @returns the answer task, or undefined when the payload states none.
 */
/**
 * Whether one claimed task is a chat answer, read the way the platform
 * actually states it: the claim's top-level kind carries the work item's
 * type ('answer'), while the protocol's 'chat_answer' spelling rides
 * payload.kind — so both are accepted, and a claim that states the kind at
 * the top level keeps working.
 * @param task - the claimed assignment.
 * @returns true when this task is answered in the result summary.
 */
export function isChatAnswerTask(task: { kind: string; payload: Record<string, unknown> }): boolean {
  return task.kind === WORK_KIND_CHAT_ANSWER
    || task.kind === 'answer'
    || task.payload['kind'] === WORK_KIND_CHAT_ANSWER
}

export function chatAnswerOf(payload: Record<string, unknown>): ChatAnswerTask | undefined {
  const answer = payload['answer']
  if (!isRecord(answer)) return undefined
  const chatId = stringField(answer, 'chat_id')
  const question = stringField(answer, 'question')
  if (chatId === undefined || question === undefined) return undefined
  const messageId = answer['message_id']
  return {
    chat_id: chatId,
    message_id: typeof messageId === 'number' && Number.isFinite(messageId) ? messageId : -1,
    question,
    ...(stringField(answer, 'sender') === undefined ? {} : { sender: stringField(answer, 'sender') }),
    ...(stringField(answer, 'intent') === undefined ? {} : { intent: stringField(answer, 'intent') }),
  }
}
