/**
 * The node's task lifecycle: claim while a slot is free, hold the lease, hand the
 * attempt to the runner, and submit the outcome the attempt reached. The node
 * applies the rules the platform cannot apply for it — the runtime ceiling, the
 * withdrawn-lease stop, the abort command, redaction and batching of submitted log
 * lines, and result submission that survives a failure — while the platform stays
 * the only decider of what is dispatched.
 * @module @tianma/dsh-mps-executor/orchestrator
 */

import {
  ExecResponseError,
  formatRfc3339,
  logBatchId,
  redactSecretText,
  requestRetryDelayMs,
  strongerOutcome,
  taskRepository,
  taskRuntimeLimitMs,
} from '@tianma/dsh-mps-exec-core'
import type {
  ExecAbortAckRequest,
  ExecClaimRequest,
  ExecLeaseResult,
  ExecLogLine,
  ExecLogRequest,
  ExecProgressRequest,
  ExecResultEvidence,
  ExecResultRequest,
  ExecResultResponse,
  ExecRunningTask,
  ExecTaskAssignment,
  TaskOutcome,
  TaskProgress,
} from '@tianma/dsh-mps-exec-core'
import type { ExecutorSettings } from './config.ts'
import { toError } from './report.ts'
import type { ExecutorReport } from './report.ts'
import type { TaskRunResult, TaskRunner } from './runner.ts'

/** The protocol calls the task lifecycle makes. */
export interface TaskPlatformClient {
  /**
   * Ask for one task, long-polling until the budget runs out.
   * @param body - the claim request.
   * @param signal - caller cancellation.
   * @returns the assignment, or undefined when the platform has none.
   */
  claim(body: ExecClaimRequest, signal?: AbortSignal): Promise<ExecTaskAssignment | undefined>
  /**
   * Renew one attempt's lease.
   * @param taskId - the task.
   * @param attempt - the attempt.
   * @param signal - caller cancellation.
   * @returns the extended lease and whether this node still holds the task.
   */
  lease(taskId: string, attempt: number, signal?: AbortSignal): Promise<ExecLeaseResult>
  /**
   * Report one attempt's progress.
   * @param taskId - the task.
   * @param body - the progress report.
   * @param signal - caller cancellation.
   */
  progress(taskId: string, body: ExecProgressRequest, signal?: AbortSignal): Promise<void>
  /**
   * Submit one batch of log lines.
   * @param taskId - the task.
   * @param body - the batch.
   * @param signal - caller cancellation.
   */
  log(taskId: string, body: ExecLogRequest, signal?: AbortSignal): Promise<void>
  /**
   * Submit one attempt's outcome.
   * @param taskId - the task.
   * @param body - the result.
   * @param signal - caller cancellation.
   * @returns the platform's answer.
   */
  result(taskId: string, body: ExecResultRequest, signal?: AbortSignal): Promise<ExecResultResponse>
  /**
   * Acknowledge an abort, which distinguishes "never received it" from "could not stop".
   * @param taskId - the task.
   * @param body - the acknowledgement.
   * @param signal - caller cancellation.
   */
  abortAck(taskId: string, body: ExecAbortAckRequest, signal?: AbortSignal): Promise<void>
}

/** Longest log line the protocol accepts, in bytes. */
export const LOG_LINE_MAX_BYTES = 4096

/** Most log lines one submission carries. */
export const LOG_BATCH_MAX_LINES = 500

/** Wait before claiming again once every slot is busy. */
const SLOT_WAIT_MS = 1000

/** Wait before claiming again after the platform answered an empty long poll. */
const EMPTY_CLAIM_PAUSE_MS = 500

/** Wait before claiming again after a failed claim. */
const CLAIM_FAILURE_PAUSE_MS = 5000

/** How many times one result submission is retried before the node reports failure. */
const RESULT_SUBMIT_ATTEMPTS = 5

/** How the orchestrator reports through the node it belongs to. */
export interface TaskOrchestratorHooks {
  /**
   * Report a task as running, which is what the heartbeat carries.
   * @param task - the task and its initial progress.
   */
  taskStarted(task: ExecRunningTask): void
  /**
   * Report a task's progress.
   * @param taskId - the task.
   * @param progress - percent complete.
   * @param stage - current stage.
   */
  taskProgress(taskId: string, progress: number, stage: string): void
  /**
   * Drop a task once it has settled.
   * @param taskId - the task.
   */
  taskFinished(taskId: string): void
  /**
   * Slots free for another claim.
   * @returns the free-slot count.
   */
  availableSlots(): number
}

/** What the orchestrator needs to run tasks. */
export interface TaskOrchestratorOptions {
  /** The authenticated session's client. */
  client: TaskPlatformClient
  /** The node's resolved settings. */
  settings: ExecutorSettings
  /** Executes one attempt. */
  runner: TaskRunner
  /** The node this orchestrator reports through. */
  hooks: TaskOrchestratorHooks
  /** Report node events; defaults to silence. */
  report?: ((report: ExecutorReport) => void) | undefined
  /** Clock; defaults to the wall clock. */
  now?: (() => Date) | undefined
}

/** One claimed attempt the node is working on. */
interface RunningAttempt {
  assignment: ExecTaskAssignment
  controller: AbortController
  /** The platform withdrew the lease, so no result may be submitted. */
  superseded: boolean
  /** An abort command arrived, so the outcome is `cancelled`. */
  aborted: boolean
  /** The runtime ceiling passed, so the outcome carries a failure. */
  timedOut: boolean
  renewTimer?: NodeJS.Timeout | undefined
  limitTimer?: NodeJS.Timeout | undefined
}

/**
 * Bound one log line to the protocol's per-line byte limit, keeping the line valid
 * UTF-8 when the cut would split a character.
 * @param text - the line to bound.
 * @returns the line to submit and whether it was cut.
 */
export function boundLogLine(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= LOG_LINE_MAX_BYTES) return { text, truncated: false }
  const cut = bytes.subarray(0, LOG_LINE_MAX_BYTES).toString('utf8')
  return { text: cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut, truncated: true }
}

/** Claim, run, and report tasks until the node stops. */
export class TaskOrchestrator {
  readonly #client: TaskPlatformClient
  readonly #settings: ExecutorSettings
  readonly #runner: TaskRunner
  readonly #hooks: TaskOrchestratorHooks
  readonly #report: (report: ExecutorReport) => void
  readonly #now: () => Date
  readonly #attempts = new Map<string, RunningAttempt>()
  readonly #pauses = new Map<NodeJS.Timeout, () => void>()
  readonly #idleWaiters: (() => void)[] = []
  #runningCount = 0
  #claiming = false

  /**
   * @param options - the client, settings, runner, and reporting the orchestrator works with.
   */
  constructor(options: TaskOrchestratorOptions) {
    this.#client = options.client
    this.#settings = options.settings
    this.#runner = options.runner
    this.#hooks = options.hooks
    this.#report = options.report ?? (() => {})
    this.#now = options.now ?? (() => new Date())
  }

  /** Whether the orchestrator is claiming work. */
  get claiming(): boolean {
    return this.#claiming
  }

  /**
   * Ids of the attempts this node is working on.
   * @returns the task ids, in claim order.
   */
  runningTaskIds(): string[] {
    return [...this.#attempts.keys()]
  }

  /** Start claiming while a slot is free. Repeating the call changes nothing. */
  start(): void {
    if (this.#claiming) return
    this.#claiming = true
    void this.#claimLoop()
  }

  /**
   * Stop claiming and cancel every running attempt. Each attempt still settles and
   * submits its own outcome, so use {@link drain} to wait for the node to be quiet.
   */
  stop(): void {
    this.#claiming = false
    for (const resolve of this.#pauses.values()) resolve()
    this.#pauses.clear()
    for (const running of this.#attempts.values()) {
      running.controller.abort(new Error('the node stopped'))
    }
  }

  /** Wait until every running attempt has settled. */
  async drain(): Promise<void> {
    while (this.#runningCount > 0) {
      await new Promise<void>((resolve) => { this.#idleWaiters.push(resolve) })
    }
  }

  /**
   * Take one task when a slot is free and start its attempt without waiting for it.
   * @returns whether a task was taken.
   */
  async claimOnce(): Promise<boolean> {
    if (this.#hooks.availableSlots() <= 0) return false
    const assignment = await this.#client.claim({
      available_slots: this.#hooks.availableSlots(),
      capabilities: {
        lanes: [...this.#settings.capabilities.lanes],
        tools: [...this.#settings.capabilities.tools],
      },
      max_wait_seconds: this.#settings.claimLongPollSeconds,
    })
    if (assignment === undefined) return false
    this.#startAttempt(assignment)
    return true
  }

  /**
   * Cancel one running attempt because the platform asked for it. The attempt still
   * settles, acknowledges the abort, and reports `cancelled`.
   * @param taskId - the task to abort.
   * @param reason - the platform's reason, when it stated one.
   * @returns whether this node was running that task.
   */
  abort(taskId: string, reason?: string): boolean {
    const running = this.#attempts.get(taskId)
    if (running === undefined) return false
    running.aborted = true
    running.controller.abort(new Error(reason ?? 'the platform aborted the task'))
    this.#report({ level: 'warn', message: `task ${taskId} was aborted by the platform` })
    return true
  }

  async #claimLoop(): Promise<void> {
    while (this.#claiming) {
      if (this.#hooks.availableSlots() <= 0) {
        await this.#pause(SLOT_WAIT_MS)
        continue
      }
      try {
        const taken = await this.claimOnce()
        if (!taken) await this.#pause(EMPTY_CLAIM_PAUSE_MS)
      } catch (error) {
        this.#report({ level: 'warn', message: `claim failed: ${toError(error).message}` })
        await this.#pause(CLAIM_FAILURE_PAUSE_MS)
      }
    }
  }

  #startAttempt(assignment: ExecTaskAssignment): void {
    const startedAt = this.#now()
    const controller = new AbortController()
    const running: RunningAttempt = {
      assignment,
      controller,
      superseded: false,
      aborted: false,
      timedOut: false,
    }
    this.#attempts.set(assignment.task_id, running)
    this.#hooks.taskStarted({
      task_id: assignment.task_id,
      attempt: assignment.attempt,
      started_at: formatRfc3339(startedAt),
      progress: 0,
      stage: 'preparing',
    })
    const renewMs = this.#renewMs(assignment)
    if (renewMs !== undefined) {
      running.renewTimer = setInterval(() => { void this.#renew(running) }, renewMs)
    }
    const limitMs = taskRuntimeLimitMs(assignment.payload) ?? this.#settings.taskRuntimeSeconds * 1000
    running.limitTimer = setTimeout(() => { this.#expire(running) }, limitMs)
    this.#runningCount += 1
    void this.#runAttempt(running, startedAt)
  }

  /**
   * The renewal period a claim states, when it states a usable one.
   * @param assignment - the claimed task.
   * @returns the period in milliseconds, or undefined when the claim states none.
   */
  #renewMs(assignment: ExecTaskAssignment): number | undefined {
    const seconds = assignment.lease_renew_seconds
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined
    return seconds * 1000
  }

  async #renew(running: RunningAttempt): Promise<void> {
    const { task_id: taskId, attempt } = running.assignment
    try {
      const lease = await this.#client.lease(taskId, attempt)
      if (!lease.should_continue) await this.#supersede(running)
    } catch (error) {
      this.#report({ level: 'warn', message: `lease renewal failed for ${taskId}: ${toError(error).message}` })
    }
  }

  /**
   * Apply a withdrawn lease: stop the attempt and discard its work, because a
   * superseded attempt's result would describe work the platform already reassigned.
   * @param running - the attempt whose lease was withdrawn.
   */
  async #supersede(running: RunningAttempt): Promise<void> {
    if (running.superseded) return
    running.superseded = true
    running.controller.abort(new Error('the platform withdrew the lease'))
    this.#clearTimers(running)
    this.#report({
      level: 'warn',
      message: `task ${running.assignment.task_id} is no longer leased here; the attempt is discarded`,
    })
    await this.#postLog(running, 'stderr', [
      {
        at: formatRfc3339(this.#now()),
        level: 'warn',
        text: `the platform withdrew this task's lease at attempt ${running.assignment.attempt}; the attempt was stopped and no result is submitted`,
      },
    ])
  }

  /**
   * Apply the runtime ceiling the node implements itself.
   * @param running - the attempt that passed its ceiling.
   */
  #expire(running: RunningAttempt): void {
    running.timedOut = true
    running.controller.abort(new Error('the runtime ceiling passed'))
    this.#report({
      level: 'warn',
      message: `task ${running.assignment.task_id} passed its runtime ceiling (attempt ${running.assignment.attempt})`,
    })
  }

  async #runAttempt(running: RunningAttempt, startedAt: Date): Promise<void> {
    try {
      let result: TaskRunResult
      try {
        result = await this.#runner.run({
          task: running.assignment,
          signal: running.controller.signal,
          reportProgress: async (progress: TaskProgress) => { await this.#progress(running, progress) },
          reportLog: async (stream: string, lines: ExecLogLine[]) => { await this.#postLog(running, stream, lines) },
        })
      } catch (error) {
        result = { outcome: 'failed', summary: `the attempt threw: ${toError(error).message}` }
      }
      this.#clearTimers(running)
      if (running.superseded) return
      let outcome = result.outcome
      if (running.aborted) outcome = strongerOutcome(outcome, 'cancelled')
      if (running.timedOut) outcome = strongerOutcome(outcome, 'failed')
      if (running.aborted) await this.#ackAbort(running)
      await this.#submit(running, outcome, result, startedAt)
    } finally {
      this.#settle(running)
    }
  }

  async #progress(running: RunningAttempt, progress: TaskProgress): Promise<void> {
    this.#hooks.taskProgress(running.assignment.task_id, progress.progress, progress.stage)
    await this.#client.progress(running.assignment.task_id, {
      attempt: running.assignment.attempt,
      progress: progress.progress,
      stage: progress.stage,
      message: progress.message,
      eta_seconds: progress.eta_seconds,
    })
  }

  /**
   * Submit log lines redacted and bounded, in batches the protocol accepts.
   * @param running - the attempt the lines belong to.
   * @param stream - the stream the lines came from.
   * @param lines - the lines, already carrying their own time and level.
   */
  async #postLog(running: RunningAttempt, stream: string, lines: ExecLogLine[]): Promise<void> {
    if (lines.length === 0) return
    const bounded = lines.map((line) => {
      const value = boundLogLine(redactSecretText(line.text))
      return { at: line.at, level: line.level, text: value.text, truncated: value.truncated }
    })
    for (let start = 0; start < bounded.length; start += LOG_BATCH_MAX_LINES) {
      const batch = bounded.slice(start, start + LOG_BATCH_MAX_LINES)
      await this.#client.log(running.assignment.task_id, {
        batch_id: logBatchId(),
        stream,
        lines: batch.map(({ at, level, text }) => ({ at, level, text })),
        truncated: batch.some(line => line.truncated),
      })
    }
  }

  async #ackAbort(running: RunningAttempt): Promise<void> {
    try {
      await this.#client.abortAck(running.assignment.task_id, {
        attempt: running.assignment.attempt,
        aborted_at: formatRfc3339(this.#now()),
        note: 'the runner settled after the abort command',
      })
    } catch (error) {
      this.#report({
        level: 'warn',
        message: `abort acknowledgement failed for ${running.assignment.task_id}: ${toError(error).message}`,
      })
    }
  }

  /**
   * Submit one attempt's outcome, retrying while the platform's answer allows it: a
   * finished task whose result never lands is work the platform will have redone.
   * @param running - the settled attempt.
   * @param outcome - the outcome to report.
   * @param result - what the runner reported.
   * @param startedAt - when the attempt started.
   */
  async #submit(running: RunningAttempt, outcome: TaskOutcome, result: TaskRunResult, startedAt: Date): Promise<void> {
    const taskId = running.assignment.task_id
    const body: ExecResultRequest = {
      attempt: running.assignment.attempt,
      outcome,
      started_at: formatRfc3339(startedAt),
      finished_at: formatRfc3339(this.#now()),
      summary: result.summary,
      evidence: result.evidence ?? this.#defaultEvidence(running),
      ...(result.notes === undefined ? {} : { notes: result.notes }),
    }
    for (let attempt = 1; attempt <= RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.#client.result(taskId, body)
        return
      } catch (error) {
        const recovery = error instanceof ExecResponseError ? error.recovery : 'retry'
        if (recovery !== 'retry' && recovery !== 'reauthenticate') {
          this.#report({
            level: 'error',
            message: `the platform refused the ${outcome} result for ${taskId}: ${toError(error).message}`,
          })
          return
        }
        if (attempt === RESULT_SUBMIT_ATTEMPTS) {
          this.#report({
            level: 'error',
            message: `could not submit the ${outcome} result for ${taskId} after ${attempt} attempts: ${toError(error).message}`,
          })
          return
        }
        await this.#pause(requestRetryDelayMs(attempt))
      }
    }
  }

  /**
   * Evidence a settled attempt reports when the runner collected none: the checkout
   * the task named, with nothing changed and nothing pushed.
   * @param running - the settled attempt.
   * @returns the evidence.
   */
  #defaultEvidence(running: RunningAttempt): ExecResultEvidence {
    const repo = taskRepository(running.assignment.payload)
    return {
      changed_files: [],
      branch: repo?.work_branch ?? '',
      base_commit: repo?.base_commit ?? '',
      head_commit: repo?.base_commit ?? '',
      pushed: false,
    }
  }

  #settle(running: RunningAttempt): void {
    this.#clearTimers(running)
    this.#attempts.delete(running.assignment.task_id)
    this.#hooks.taskFinished(running.assignment.task_id)
    this.#runningCount -= 1
    if (this.#runningCount === 0) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve()
    }
  }

  #clearTimers(running: RunningAttempt): void {
    if (running.renewTimer !== undefined) {
      clearInterval(running.renewTimer)
      running.renewTimer = undefined
    }
    if (running.limitTimer !== undefined) {
      clearTimeout(running.limitTimer)
      running.limitTimer = undefined
    }
  }

  /**
   * Wait, ending early when the node stops.
   * @param ms - how long to wait.
   */
  #pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#pauses.delete(timer)
        resolve()
      }, ms)
      this.#pauses.set(timer, resolve)
    })
  }
}
