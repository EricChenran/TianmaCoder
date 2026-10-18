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
  isChatAnswerTask,
  strongerOutcome,
  taskRepository,
  taskRuntimeLimitMs,
} from '@tianma/dsh-mps-exec-core'
import type {
  ExecAbortAckRequest,
  ExecArtifactKind,
  ExecClaimRequest,
  ExecLeaseResult,
  ExecLogLine,
  ExecLogRequest,
  ExecProgressRequest,
  ExecResource,
  ExecResultEvidence,
  ExecResultRequest,
  ExecResultResponse,
  ExecRunningTask,
  ExecTaskAssignment,
  TaskOutcome,
  TaskProgress,
} from '@tianma/dsh-mps-exec-core'
import { attemptFailure } from './failures.ts'
import type { ExecutorSettings } from './config.ts'
import { logSpool } from './log-spool.ts'
import type { TaskLedger } from './task-ledger.ts'
import type { LogSpool } from './log-spool.ts'
import { resultSpool } from './result-spool.ts'
import type { ResultSpool } from './result-spool.ts'
import { toError } from './report.ts'
import type { ExecutorReport } from './report.ts'
import type { TaskRunResult, TaskRunner, TaskWorkspace, TaskWorkspaceAllocator } from './runner.ts'
import type { PublishedChanges } from './runner.ts'
import type { TaskPublisher } from './publish.ts'
import type { TaskArtifactUploader } from './artifacts.ts'
import type { TaskSessionReporter } from './session.ts'

/** The protocol calls the task lifecycle makes. */
export interface TaskPlatformClient {
  /**
   * Download one task material, verified against the digest the platform states.
   * @param taskId - the task.
   * @param artifactId - the material, which the platform checks belongs to the task.
   * @param signal - caller cancellation.
   * @returns the verified contents and the digest.
   */
  resource(taskId: string, artifactId: string, signal?: AbortSignal): Promise<ExecResource>
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

/** Wait before claiming again after the platform answered an empty long poll. */
const EMPTY_CLAIM_PAUSE_MS = 500

/** Wait before claiming again while the node has no room for work at all. */
const ROOM_WAIT_MS = 1000

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
  /**
   * Executes one chat-answer attempt. Without one, an answer task the platform
   * dispatches is reported `failed` at once, so the platform's own answerer takes
   * over instead of waiting on the lease.
   */
  chatRunner?: TaskRunner | undefined
  /**
   * Resolves the directory an attempt works in. Without one, an attempt runs where
   * its runner decides and the context names no directory.
   */
  workspaces?: TaskWorkspaceAllocator | undefined
  /**
   * Hands one attempt's work back. Without one, a runner's `publish()` reports that
   * the attempt has nothing to publish.
   */
  publisher?: TaskPublisher | undefined
  /**
   * Whether the node has room for another attempt. Read before every claim; without one
   * the node claims whenever it has a free slot.
   * @returns true when the node may take on work.
   */
  canClaim?: (() => boolean) | undefined
  /**
   * The claim long poll in force, which the platform assigns at registration; defaults to
   * the configured value. It is read per claim, because a registration may change it.
   */
  claimLongPollSeconds?: (() => number) | undefined
  /**
   * Reports the session serving an attempt's workspace. Without one, a runner's
   * `reportSession()` reports that the attempt has no workspace to report.
   */
  sessions?: TaskSessionReporter | undefined
  /**
   * Uploads what an attempt produced. Without one, a runner's `uploadArtifact()`
   * reports that the attempt has no workspace to upload from.
   */
  artifacts?: TaskArtifactUploader | undefined
  /**
   * The largest batch of log lines the platform accepts, as it currently states it;
   * defaults to the protocol's own ceiling. It is read per batch, because a configuration
   * revision may lower it.
   */
  logBatchMaxLines?: (() => number) | undefined
  /**
   * The task ledger an operator surface reads. Without one, the node keeps
   * no local record of what it took and how each attempt settled.
   */
  ledger?: TaskLedger | undefined
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
  /** What the attempt published through the node, once it handed its work back. */
  published?: PublishedChanges | undefined
  /** Artifact the platform stored the attempt's bundle under, in `read_only` mode. */
  bundleArtifactId?: string | undefined
  /** Session reference the attempt reported, once one arrived. */
  sessionRef?: string | undefined
  /** The prepared workspace, kept so a held attempt can still be delivered. */
  prepared?: TaskWorkspace | undefined
  /** An operator took the attempt over: no result until they finish it. */
  held?: boolean | undefined
  /** Directory the attempt worked in, when it worked in one. */
  workspaceDirectory?: string | undefined
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
  readonly #chatRunner: TaskRunner | undefined
  readonly #workspaces: TaskWorkspaceAllocator | undefined
  readonly #publisher: TaskPublisher | undefined
  readonly #sessions: TaskSessionReporter | undefined
  readonly #artifacts: TaskArtifactUploader | undefined
  readonly #hooks: TaskOrchestratorHooks
  /** Where a batch waits when the platform cannot take it. */
  readonly #spool: LogSpool
  /** Where an outcome waits when the platform cannot take it. */
  readonly #results: ResultSpool
  /** How long a claim waits, as the platform most recently assigned it. */
  /** The last claim failure reported, so a repeat of it is not reported again. */
  #claimFailure: string | undefined

  readonly #claimLongPollSeconds: () => number
  readonly #logBatchMaxLines: () => number
  /** Whether the node has room for another attempt, when a deployment composes one. */
  readonly #canClaim: (() => boolean) | undefined
  readonly #ledger: TaskLedger | undefined
  readonly #report: (report: ExecutorReport) => void
  /** The last wording reported for each repeating failure, so a repeat is not reported. */
  readonly #reportedFailures = new Map<string, string>()

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
    this.#chatRunner = options.chatRunner
    this.#workspaces = options.workspaces
    this.#publisher = options.publisher
    this.#sessions = options.sessions
    this.#artifacts = options.artifacts
    this.#hooks = options.hooks
    this.#ledger = options.ledger
    this.#report = options.report ?? (() => {})
    this.#spool = logSpool({
      root: options.settings.codingRoot,
      send: async (taskId, batch) => { await this.#client.log(taskId, batch) },
      report: this.#report,
    })
    this.#results = resultSpool({
      root: options.settings.codingRoot,
      send: async (taskId, body) => { await this.#client.result(taskId, body) },
      // A result is worth submitting while the platform still leases the attempt; after
      // that it describes work the platform has already reassigned.
      holds: async (taskId, attempt) => {
        try {
          const lease = await this.#client.lease(taskId, attempt)
          return lease.should_continue
        } catch {
          // No answer is not a withdrawal: the result waits for the next flush.
          return true
        }
      },
      report: this.#report,
    })
    this.#canClaim = options.canClaim
    this.#claimLongPollSeconds = options.claimLongPollSeconds ?? (() => options.settings.claimLongPollSeconds)
    this.#logBatchMaxLines = options.logBatchMaxLines ?? (() => LOG_BATCH_MAX_LINES)
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

  /**
   * How many running attempts are chat answers, which hold no coding slot. The
   * runtime reads this so a busy coder still counts as available to a customer.
   * @returns the count of running answer attempts.
   */
  chatAnswerCount(): number {
    let count = 0
    for (const attempt of this.#attempts.values()) {
      if (isChatAnswerTask(attempt.assignment)) count += 1
    }
    return count
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
    // The precondition belongs to the claim itself: a caller that reaches it directly
    // must not take on work the node has no room for.
    if (this.#canClaim?.() === false) return false
    // A claim is sent even while every coding slot is busy: an answer task needs no
    // slot and no workspace, so the node would otherwise keep a customer waiting while
    // it writes code. The platform reads `available_slots` and sends coding only when
    // one is free.
    const assignment = await this.#client.claim({
      available_slots: this.#hooks.availableSlots(),
      capabilities: {
        lanes: [...this.#settings.capabilities.lanes],
        tools: [...this.#settings.capabilities.tools],
      },
      max_wait_seconds: this.#claimLongPollSeconds(),
    })
    if (assignment === undefined) return false
    // A claim can wait a long poll, and the room this node had when it asked can be gone by
    // the time the work arrives. Starting it would run an attempt the disk cannot hold;
    // dropping it in silence would leave the platform waiting on a task nobody is doing.
    // It is named and left to its lease, which is what redispatching is for.
    if (this.#canClaim?.() === false) {
      this.#report({
        level: 'warn',
        message: `the platform dispatched ${assignment.task_id} while this node had no room for it; leaving it to its lease rather than starting it`,
      })
      return false
    }
    if (!isChatAnswerTask(assignment) && this.#hooks.availableSlots() <= 0) {
      this.#report({
        level: 'warn',
        message: `the platform dispatched ${assignment.task_id} while every coding slot was busy; leaving it to its lease rather than starting it`,
      })
      return false
    }
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

  /**
   * Hand one running attempt to the operator: the agent run stops, the runtime
   * ceiling is lifted, and no result is submitted until {@link completeHeld}. The
   * lease keeps being renewed, so the platform sees the task as still held here.
   * @param taskId - the task to take over.
   * @returns whether a running attempt was handed over.
   */
  hold(taskId: string): boolean {
    const running = this.#attempts.get(taskId)
    if (running === undefined || running.held === true) return false
    running.held = true
    if (running.limitTimer !== undefined) {
      clearTimeout(running.limitTimer)
      running.limitTimer = undefined
    }
    running.controller.abort(new Error('the operator took this attempt over'))
    this.#ledger?.append({
      at: formatRfc3339(this.#now()),
      event: 'held',
      task_id: taskId,
      kind: running.assignment.kind,
      attempt: running.assignment.attempt,
      ...(running.sessionRef === undefined ? {} : { session: running.sessionRef }),
    })
    this.#report({ level: 'info', message: `task ${taskId} was taken over by the operator; no result is submitted until they finish it` })
    return true
  }

  /**
   * Finish an attempt the operator took over: a coding attempt is published the
   * way the runner would have published it, and the result carries the summary
   * the operator stated (or a plain statement that they delivered it).
   * @param taskId - the held task.
   * @param summary - what the operator wants the result to say.
   */
  async completeHeld(taskId: string, summary: string): Promise<void> {
    const running = this.#attempts.get(taskId)
    if (running === undefined || running.held !== true) return
    running.held = false
    let result: TaskRunResult
    try {
      if (this.#publisher !== undefined && running.prepared?.checkout !== undefined) {
        await this.#publish(running, running.prepared)
      }
      result = {
        outcome: 'success',
        summary: summary.trim() === '' ? 'delivered by the operator' : summary.trim(),
      }
    } catch (error: unknown) {
      result = failedResult(error)
    }
    this.#clearTimers(running)
    await this.#submit(running, result.outcome, result, this.#now())
    this.#ledgerSettled(running, result.outcome, { summary: `${result.summary} (operator)` })
    this.#settle(running)
  }

  async #claimLoop(): Promise<void> {
    while (this.#claiming) {
      // Offer anything the platform has not taken yet — a task's log, and the outcome of an
      // attempt whose result the platform could not take when it settled. A spool this node
      // cannot read is a warning: letting it end the loop would leave a node that looks
      // online and claims nothing.
      try {
        await this.#spool.flush()
        await this.#results.flush()
      } catch (error: unknown) {
        this.#report({
          level: 'warn',
          message: `could not offer what the platform has not taken yet: ${toError(error).message}`,
        })
      }
      if (this.#canClaim?.() === false) {
        // A node without room claims nothing; whoever knows why has already reported it.
        await this.#pause(ROOM_WAIT_MS)
        continue
      }
      try {
        const taken = await this.claimOnce()
        if (!taken) await this.#pause(EMPTY_CLAIM_PAUSE_MS)
      } catch (error) {
        // The same failure is reported once, and again only when it changes: a node that
        // cannot claim reports it every five seconds otherwise, and a day of that fills its
        // own file with one line. Its heartbeat is what shows it is still alive.
        const message = `claim failed: ${toError(error).message}`
        if (message !== this.#claimFailure) {
          this.#claimFailure = message
          this.#report({ level: 'warn', message })
        }
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
    this.#ledger?.append({
      at: formatRfc3339(startedAt),
      event: 'claimed',
      task_id: assignment.task_id,
      kind: assignment.kind,
      attempt: assignment.attempt,
    })
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
    // An answer attempt runs inside the platform's soft answer deadline, which its own
    // engine enforces after the node's ceiling: a node still working past the deadline
    // would answer a question the platform has already taken back.
    const defaultLimit = isChatAnswerTask(assignment)
      ? this.#settings.answerRuntimeSeconds * 1000
      : this.#settings.taskRuntimeSeconds * 1000
    const limitMs = taskRuntimeLimitMs(assignment.payload) ?? defaultLimit
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
      // A renewal fails on every interval while the platform cannot take one; the same rule as
      // the runtime's repeating failures keeps this from writing the same line each time.
      this.#reportFailure(`lease:${taskId}`, `lease renewal failed for ${taskId}: ${toError(error).message}`)
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
        // An answer task owns no workspace: it asks one question in a throwaway
        // directory, so preparing one would both wait on a slot it does not need and
        // hold a checkout it must never touch.
        const chat = isChatAnswerTask(running.assignment)
        // Nothing to prepare without an allocator, so the attempt starts without
        // yielding; otherwise the runner waits for its workspace.
        const workspace = chat || this.#workspaces === undefined
          ? undefined
          : await this.#workspaces.prepare(running.assignment)
        running.workspaceDirectory = workspace?.directory
        running.prepared = workspace
        if (running.superseded) return
        const runner = chat ? this.#chatRunner : this.#runner
        if (runner === undefined) {
          // Reported at once, so the platform's own answerer takes over instead of
          // waiting on the lease to recycle the question.
          result = { outcome: 'failed', summary: 'this node composes no runner for chat answers' }
        } else {
          // An attempt stopped while its workspace was prepared must not start work
          // the platform no longer wants.
          result = running.aborted || running.timedOut
            ? { outcome: 'blocked', summary: 'the attempt was stopped before its work started' }
            : await runner.run({
              task: running.assignment,
              workspaceDirectory: workspace?.directory,
              checkout: workspace?.checkout,
              publish: async () => await this.#publish(running, workspace),
              uploadArtifact: async (kind: ExecArtifactKind, path: string, meta?: Record<string, unknown>) =>
                await this.#uploadArtifact(running, workspace, kind, path, meta),
              resource: async (artifactId: string) => await this.#resource(running, artifactId),
              reportSession: async (sessionRef: string) => { await this.#reportSession(running, workspace, sessionRef) },
              signal: running.controller.signal,
              reportProgress: async (progress: TaskProgress) => { await this.#progress(running, progress) },
              reportLog: async (stream: string, lines: ExecLogLine[]) => { await this.#postLog(running, stream, lines) },
            })
        }
      } catch (error: unknown) {
        result = failedResult(error)
      }
      this.#clearTimers(running)
      // A held attempt stops here: the operator owns the work now, the result is
      // submitted when they finish it, and the lease keeps being renewed.
      if (running.held === true) return
      if (running.superseded) {
        this.#ledgerSettled(running, 'cancelled', { summary: 'the platform withdrew the lease; no result submitted' })
        return
      }
      let outcome = result.outcome
      if (running.aborted) outcome = strongerOutcome(outcome, 'cancelled')
      if (running.timedOut) outcome = strongerOutcome(outcome, 'failed')
      if (running.aborted) await this.#ackAbort(running)
      // Offer the lines the platform could not take while the attempt ran, so the log a
      // result refers to is whole by the time that result arrives.
      await this.#spool.flush()
      await this.#submit(running, outcome, result, startedAt)
      this.#ledgerSettled(running, outcome, result)
    } finally {
      if (running.held !== true) this.#settle(running)
    }
  }

  /**
   * Hand this attempt's work back, remembering what it published so the result's
   * evidence reports the node's own facts.
   * @param running - the attempt.
   * @param workspace - the workspace the attempt was prepared with.
   * @returns the changed paths, the commit, and whether the branch was pushed.
   */
  async #publish(running: RunningAttempt, workspace: TaskWorkspace | undefined): Promise<PublishedChanges> {
    const checkout = workspace?.checkout
    if (this.#publisher === undefined || workspace === undefined || checkout === undefined) {
      throw new Error('this attempt has no prepared checkout to publish')
    }
    const published = await this.#publisher.publish({
      assignment: running.assignment,
      directory: workspace.directory,
      checkout,
      signal: running.controller.signal,
    })
    running.published = published
    if (published.bundle !== undefined) {
      // The platform fetches the change from this artifact in `read_only` mode.
      running.bundleArtifactId = await this.#uploadArtifact(running, workspace, 'bundle', published.bundle.path, {
        branch: checkout.work_branch,
        base_commit: checkout.base_commit,
        head_commit: published.head_commit,
        sha256: published.bundle.sha256,
      })
    }
    return published
  }

  /**
   * Upload one file this attempt produced.
   * @param running - the attempt.
   * @param workspace - the workspace the attempt was prepared with.
   * @param kind - what the file is.
   * @param path - path of the file, relative to the workspace.
   * @param meta - what the platform keeps beside the artifact.
   * @returns the artifact id the platform stored it under.
   */
  async #uploadArtifact(
    running: RunningAttempt,
    workspace: TaskWorkspace | undefined,
    kind: ExecArtifactKind,
    path: string,
    meta?: Record<string, unknown>,
  ): Promise<string> {
    if (this.#artifacts === undefined || workspace === undefined) {
      throw new Error('this attempt has no prepared workspace to upload from')
    }
    return await this.#artifacts.upload({
      taskId: running.assignment.task_id,
      directory: workspace.directory,
      kind,
      path,
      meta,
      signal: running.controller.signal,
    })
  }

  /**
   * Download one of the materials this attempt's task carries.
   * @param running - the attempt.
   * @param artifactId - the material, which the platform checks belongs to the task.
   * @returns the verified contents and the digest.
   */
  async #resource(running: RunningAttempt, artifactId: string): Promise<ExecResource> {
    return await this.#client.resource(running.assignment.task_id, artifactId, running.controller.signal)
  }

  /**
   * Report the session serving this attempt's workspace.
   * @param running - the attempt.
   * @param workspace - the workspace the attempt was prepared with.
   * @param sessionRef - the session reference.
   */
  async #reportSession(
    running: RunningAttempt,
    workspace: TaskWorkspace | undefined,
    sessionRef: string,
  ): Promise<void> {
    running.sessionRef = sessionRef
    const checkout = workspace?.checkout
    if (this.#sessions === undefined || workspace === undefined || checkout === undefined) {
      throw new Error('this attempt has no prepared workspace to report a session for')
    }
    try {
      await this.#sessions.report({
        assignment: running.assignment,
        directory: workspace.directory,
        sessionRef,
        baseCommit: checkout.base_commit,
        signal: running.controller.signal,
      })
    } catch (error: unknown) {
      // The node recorded the session beside its workspace before reporting it, so a
      // platform that cannot take the report now still gets the next one.
      this.#report({
        level: 'warn',
        message: `the session report for ${running.assignment.task_id} did not reach the platform: ${toError(error).message}`,
      })
    }
  }

  /**
   * Report one repeating failure once, and again only when its wording changes.
   * @param key - which failure this is, so kinds do not suppress each other.
   * @param message - what to say.
   * @returns nothing.
   */
  #reportFailure(key: string, message: string): void {
    if (this.#reportedFailures.get(key) === message) return
    this.#reportedFailures.set(key, message)
    this.#report({ level: 'warn', message })
  }

  async #progress(running: RunningAttempt, progress: TaskProgress): Promise<void> {
    this.#hooks.taskProgress(running.assignment.task_id, progress.progress, progress.stage)
    try {
      await this.#client.progress(running.assignment.task_id, {
        attempt: running.assignment.attempt,
        progress: progress.progress,
        stage: progress.stage,
        message: progress.message,
        eta_seconds: progress.eta_seconds,
      })
    } catch (error: unknown) {
      // Progress is a report, not the work: a platform that cannot take one right now
      // must not end an attempt, and the next report carries the newest state anyway.
      this.#report({
        level: 'warn',
        message: `progress for ${running.assignment.task_id} did not reach the platform: ${toError(error).message}`,
      })
    }
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
    const cap = this.#batchLines()
    for (let start = 0; start < bounded.length; start += cap) {
      const batch = bounded.slice(start, start + cap)
      // Through the spool: a platform that is briefly unreachable must not cost the lines
      // an attempt produced, and the batch id makes offering them twice harmless.
      await this.#spool.post(running.assignment.task_id, {
        batch_id: logBatchId(),
        // The attempt travels with the batch: the platform names the file it lands in after
        // it, so two attempts at one task must not append to the same one.
        attempt: running.assignment.attempt,
        stream,
        lines: batch.map(({ at, level, text }) => ({ at, level, text })),
        truncated: batch.some(line => line.truncated),
      })
    }
  }

  /**
   * The largest batch of log lines to submit: the protocol's ceiling, lowered by whatever
   * the platform currently accepts.
   * @returns the line count one batch may carry.
   */
  #batchLines(): number {
    return Math.min(LOG_BATCH_MAX_LINES, this.#logBatchMaxLines())
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
      ...(result.error === undefined ? {} : { error: result.error }),
      // The node's own delivery facts win; what the runner collected — the build, the
      // end-to-end run, the report — is what the node has no other way to know.
      evidence: running.published === undefined
        ? { ...this.#defaultEvidence(running, result.headCommit), ...result.evidence }
        : { ...result.evidence, ...this.#defaultEvidence(running, result.headCommit) },
      ...(result.notes === undefined ? {} : { notes: result.notes }),
    }
    for (let attempt = 1; attempt <= RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.#client.result(taskId, body)
        return
      } catch (error) {
        const recovery = error instanceof ExecResponseError ? error.recovery : 'retry'
        if (recovery === 'reject-result') {
          // The platform refused this result's contents — a path it will not take, a branch
          // name it will not accept — so the same body is refused identically every time.
          this.#report({
            level: 'error',
            message: `the platform refused the ${outcome} result for ${taskId} on its contents, so it was not repeated: ${toError(error).message}`,
          })
          return
        }
        if (recovery !== 'retry' && recovery !== 'reauthenticate') {
          const already = error instanceof ExecResponseError && error.code === 'ALREADY_FINAL'
          this.#report({
            level: already ? 'warn' : 'error',
            message: already
              ? `the platform already holds this task's result, so the ${outcome} report for ${taskId} was left as it stands`
              : `the platform refused the ${outcome} result for ${taskId}: ${toError(error).message}`,
          })
          return
        }
        if (attempt === RESULT_SUBMIT_ATTEMPTS) {
          // The platform being unreachable is not a refusal: the outcome is kept and
          // offered again, so a task is not redone just because its result missed a window.
          this.#results.keep(taskId, body)
          this.#report({
            level: 'error',
            message: `could not submit the ${outcome} result for ${taskId} after ${attempt} attempts, so it is kept for later: ${toError(error).message}`,
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
   * @param headCommit - the commit the attempt reached, when it failed after making one.
   * @returns the evidence.
   */
  #defaultEvidence(running: RunningAttempt, headCommit?: string): ExecResultEvidence {
    const repo = taskRepository(running.assignment.payload)
    const published = running.published
    return {
      changed_files: published?.changed_files ?? [],
      branch: repo?.work_branch ?? '',
      base_commit: repo?.base_commit ?? '',
      head_commit: published?.head_commit ?? headCommit ?? repo?.base_commit ?? '',
      pushed: published?.pushed ?? false,
      ...(running.bundleArtifactId === undefined ? {} : { patch_artifact_id: running.bundleArtifactId }),
    }
  }

  /** Write the settled line of one attempt, whatever way it settled. */
  #ledgerSettled(running: RunningAttempt, outcome: TaskOutcome, result: { summary: string }): void {
    this.#ledger?.append({
      at: formatRfc3339(this.#now()),
      event: 'settled',
      task_id: running.assignment.task_id,
      kind: running.assignment.kind,
      attempt: running.assignment.attempt,
      outcome,
      summary: result.summary.slice(0, 300),
      ...(running.sessionRef === undefined ? {} : { session: running.sessionRef }),
      ...(running.workspaceDirectory === undefined ? {} : { workspace: running.workspaceDirectory }),
    })
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

/**
 * How an attempt that threw describes the outcome it reached: the sentence an operator
 * reads, the code and diagnostics the platform classifies with, and the commit the attempt
 * reached when it got that far — a push the remote refused still happened locally, and a
 * later repeat needs to know it.
 * @param error - what the attempt threw.
 * @returns the failed result.
 */
function failedResult(error: unknown): TaskRunResult {
  const failure = attemptFailure(error)
  return {
    outcome: 'failed',
    summary: failure.summary,
    error: failure.error,
    ...(failure.headCommit === undefined ? {} : { headCommit: failure.headCommit }),
  }
}
