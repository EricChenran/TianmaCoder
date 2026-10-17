/**
 * The task lifecycle over a recording platform: what the node claims, what it does
 * when the platform withdraws a lease or aborts a task, how it bounds the attempt
 * with the runtime ceiling, and how it gets the outcome across.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecResponseError, recoveryForCode } from '@tianma/dsh-mps-exec-core'
import type {
  ExecAbortAckRequest,
  ExecClaimRequest,
  ExecLeaseResult,
  ExecLogRequest,
  ExecProgressRequest,
  ExecResultRequest,
  ExecResultResponse,
  ExecRunningTask,
  ExecTaskAssignment,
} from '@tianma/dsh-mps-exec-core'
import {
  ArtifactTooLargeError,
  LOG_BATCH_MAX_LINES,
  LOG_LINE_MAX_BYTES,
  TaskOrchestrator,
  boundLogLine,
  resolveExecutorSettings,
} from '@tianma/dsh-mps-executor'
import type { ExecResource } from '@tianma/dsh-mps-exec-core'
import type { TaskSessionReporter, TaskWorkspaceAllocator } from '@tianma/dsh-mps-executor'
import type {
  ExecutorReport,
  ExecutorSettings,
  TaskArtifactRequest,
  TaskCheckout,
  TaskOrchestratorHooks,
  TaskPlatformClient,
  TaskPublishRequest,
  TaskRunContext,
  TaskRunResult,
  TaskRunner,
  TaskSessionRequest,
} from '@tianma/dsh-mps-executor'

afterEach(() => { vi.useRealTimers() })

/** A platform that records what it was asked and answers from scripted queues. */
class FakePlatform implements TaskPlatformClient {
  readonly claims: ExecClaimRequest[] = []
  readonly leases: string[] = []
  readonly progresses: ExecProgressRequest[] = []
  readonly logs: ExecLogRequest[] = []
  readonly results: ExecResultRequest[] = []
  readonly abortAcks: ExecAbortAckRequest[] = []
  readonly resources: { taskId: string; artifactId: string }[] = []
  readonly assignments: (ExecTaskAssignment | undefined)[] = []
  readonly leaseAnswers: (ExecLeaseResult | Error)[] = []
  readonly resultAnswers: (ExecResultResponse | Error)[] = []
  claimError: Error | undefined
  /** Held lease answers, released by the test that gates them. */
  leaseGate: Promise<void> | undefined
  /** Failure the platform answers an abort acknowledgement with. */
  abortAckError: Error | undefined
  /** Failure the platform answers a material download with. */
  resourceError: Error | undefined

  async resource(taskId: string, artifactId: string): Promise<ExecResource> {
    this.resources.push({ taskId, artifactId })
    if (this.resourceError !== undefined) throw this.resourceError
    return { bytes: new TextEncoder().encode(`# ${artifactId}\n`), sha256: 'sha-of-material' }
  }

  /** Runs while a claim is being answered, so a test can change the world mid-poll. */
  claimHook: (() => void) | undefined

  async claim(body: ExecClaimRequest): Promise<ExecTaskAssignment | undefined> {
    this.claims.push(body)
    this.claimHook?.()
    if (this.claimError !== undefined) throw this.claimError
    return this.assignments.shift()
  }

  async lease(taskId: string): Promise<ExecLeaseResult> {
    this.leases.push(taskId)
    await this.leaseGate
    const answer = this.leaseAnswers.shift()
    if (answer instanceof Error) throw answer
    return answer ?? { lease_expire_at: '2026-10-15T04:16:00.123+08:00', should_continue: true }
  }

  async progress(_taskId: string, body: ExecProgressRequest): Promise<void> {
    this.progresses.push(body)
  }

  async log(_taskId: string, body: ExecLogRequest): Promise<void> {
    this.logs.push(body)
  }

  async result(_taskId: string, body: ExecResultRequest): Promise<ExecResultResponse> {
    this.results.push(body)
    const answer = this.resultAnswers.shift()
    if (answer instanceof Error) throw answer
    return answer ?? {
      task_id: 'tsk_1',
      accepted: true,
      already_final: false,
      work_item_state: 'done',
      next: 'verify',
    }
  }

  async abortAck(_taskId: string, body: ExecAbortAckRequest): Promise<void> {
    this.abortAcks.push(body)
    if (this.abortAckError !== undefined) throw this.abortAckError
  }
}

/** The node-side hooks one test observed. */
class FakeHooks implements TaskOrchestratorHooks {
  readonly started: ExecRunningTask[] = []
  readonly progresses: [string, number, string][] = []
  readonly finished: string[] = []
  slots = 1

  taskStarted(task: ExecRunningTask): void {
    this.started.push(task)
  }

  taskProgress(taskId: string, progress: number, stage: string): void {
    this.progresses.push([taskId, progress, stage])
  }

  taskFinished(taskId: string): void {
    this.finished.push(taskId)
  }

  availableSlots(): number {
    return this.slots
  }
}

/** A task payload shaped as the protocol's example is. */
function assignment(overrides: Partial<ExecTaskAssignment> = {}): ExecTaskAssignment {
  return {
    task_id: 'tsk_1',
    work_item_id: 'wi_1',
    attempt: 1,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2026-10-15T04:16:00.123+08:00',
    lease_renew_seconds: 30,
    payload: {
      limits: { max_runtime_seconds: 60 },
      workspace: { workspace_id: 'ws_1', repo: { base_commit: 'a1b2c3d', work_branch: 'feature/x' } },
    },
    ...overrides,
  }
}

/** One node's resolved settings. */
function settings(): ExecutorSettings {
  // The tools are stated so this suite reads the same on every machine; a node that
  // states none probes the ones it has. The roots are this suite's own: a node's coding
  // root is where it writes its spools, and the default resolves against the working
  // directory, which here is the repository.
  const root = mkdtempSync(join(tmpdir(), 'mps-orchestrator-'))
  scratch.push(root)
  return resolveExecutorSettings(
    { platformHost: '10.0.0.7', nodeId: 'node-1', tools: ['node'], workspaceRoot: root, codingRoot: join(root, 'coding') },
    'test-host',
  )
}

/** Roots this suite made, removed after each test. */
const scratch: string[] = []

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A runner that runs the given body. */
function runnerOf(run: (context: TaskRunContext) => Promise<TaskRunResult>): TaskRunner {
  return { run }
}

/** A runner that waits for its attempt to be cancelled and reports what it was told to. */
function waitingRunner(result: (context: TaskRunContext) => TaskRunResult): TaskRunner {
  return runnerOf(async (context) => {
    await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
    return result(context)
  })
}

/** One orchestrator over a recording platform. */
function orchestratorWith(options: {
  platform: FakePlatform
  runner: TaskRunner
  chatRunner?: TaskRunner
  hooks?: FakeHooks
  reports?: ExecutorReport[]
  settings?: ExecutorSettings
  canClaim?: () => boolean
  sessions?: TaskSessionReporter
  workspaces?: TaskWorkspaceAllocator
  logBatchMaxLines?: () => number
}): { orchestrator: TaskOrchestrator; hooks: FakeHooks; reports: ExecutorReport[] } {
  const hooks = options.hooks ?? new FakeHooks()
  const reports = options.reports ?? []
  const orchestrator = new TaskOrchestrator({
    client: options.platform,
    settings: options.settings ?? settings(),
    runner: options.runner,
    ...(options.chatRunner === undefined ? {} : { chatRunner: options.chatRunner }),
    hooks,
    report: (report) => { reports.push(report) },
    canClaim: options.canClaim,
    sessions: options.sessions,
    workspaces: options.workspaces,
    logBatchMaxLines: options.logBatchMaxLines,
    now: () => new Date('2026-10-15T04:03:55.123Z'),
  })
  return { orchestrator, hooks, reports }
}

describe('task lifecycle', () => {
  it('replays the log a previous process spooled before the platform went away', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'mps-restart-'))
    const codingRoot = join(root, 'coding')

    // The first process: the platform takes nothing, so the batch ends up on disk and the
    // process goes away with it still there.
    const down = new FakePlatform()
    down.assignments.push(assignment())
    down.log = async () => { throw new Error('the platform is unreachable') }
    const first = orchestratorWith({
      platform: down,
      settings: { ...settings(), codingRoot },
      reports: [],
      runner: runnerOf(async (context) => {
        await context.reportLog('stdout', [{ at: '2026-10-15T04:03:55.123Z', level: 'info', text: '崩前最后一行' }])
        return { outcome: 'success', summary: 'done' }
      }),
    })
    first.orchestrator.start()
    await vi.advanceTimersByTimeAsync(5_000)
    first.orchestrator.stop()

    const spooled = readFileSync(join(codingRoot, '.buffers', 'tsk_1.jsonl'), 'utf8')
    expect(spooled).toContain('崩前最后一行')

    // The next process: a fresh orchestrator over the same coding root, and a platform that
    // is back. The first claim offers what the last one could not.
    const back = new FakePlatform()
    back.assignments.push(assignment())
    const second = orchestratorWith({
      platform: back,
      settings: { ...settings(), codingRoot },
      reports: [],
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })
    second.orchestrator.start()
    await vi.advanceTimersByTimeAsync(5_000)
    second.orchestrator.stop()
    rmSync(root, { recursive: true, force: true })

    expect(back.logs.some(entry => entry.lines.some(line => line.text.includes('崩前最后一行')))).toBe(true)
    expect(existsSync(join(codingRoot, '.buffers', 'tsk_1.jsonl'))).toBe(false)
  })

  it('carries on when a session report does not reach the platform', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      // A prepared workspace, so the report has everything it needs but the platform.
      workspaces: {
        async prepare() {
          return { directory: join('coding', 'ws_1'), checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' } }
        },
      },
      sessions: {
        async report() { throw new Error('the platform is unreachable') },
      },
      runner: runnerOf(async (context) => {
        await context.reportSession('dsh-session-test')
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    // The node recorded the session beside its workspace first, so the report can wait.
    expect(reports.some(report => report.message.includes('the session report for tsk_1 did not reach the platform'))).toBe(true)
    expect(platform.results[0]).toMatchObject({ outcome: 'success' })
  })

  it('reports a renewal that keeps failing once, while its wording stays the same', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      // An attempt that stays running: a runner that settles clears the renewal timer this
      // case is about before the platform can ever fail one.
      runner: runnerOf(async (context) => {
        await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
        return { outcome: 'cancelled', summary: 'stopped' }
      }),
    })

    orchestrator.start()
    // The attempt is taken first; then exactly two renewals, each answered with a failure: the
    // first reports, and the second must be suppressed as the same wording.
    await vi.advanceTimersByTimeAsync(1_000)
    platform.leaseAnswers.push(new Error('the platform is unreachable'), new Error('the platform is unreachable'))
    await vi.advanceTimersByTimeAsync(70_000)
    orchestrator.stop()

    // The case only means something if the renewal really was attempted more than once.
    expect(platform.leases.length).toBeGreaterThan(1)
    expect(reports.filter(report => report.message.includes('lease renewal failed'))).toHaveLength(1)
  }, 60_000)

  it('reports the same claim failure once, and a different one when it changes', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    let failure = 'the platform is unreachable'
    platform.claim = async () => { throw new Error(failure) }
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({ platform, reports, runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })) })

    // A node that cannot claim retries every five seconds; reporting each one would fill its
    // own file with the same line, so the failure is reported once and again only when it
    // changes. Its heartbeat is what shows it is still alive.
    orchestrator.start()
    await vi.advanceTimersByTimeAsync(60_000)
    failure = 'the token expired'
    await vi.advanceTimersByTimeAsync(60_000)
    orchestrator.stop()

    expect(reports.map(report => report.message)).toEqual([
      'claim failed: the platform is unreachable',
      'claim failed: the token expired',
    ])
  }, 60_000)

  it('names a task it has no room for instead of starting or silently dropping it', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    // Room when the claim was made, none by the time the work arrives: a claim waits a long
    // poll, and the disk can fill while it does.
    let room = true
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      canClaim: () => room,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })
    // The room is gone between the precondition and the answer.
    platform.claimHook = () => { room = false }

    await expect(orchestrator.claimOnce()).resolves.toBe(false)
    await orchestrator.drain()

    expect(platform.results).toHaveLength(0)
    expect(reports.some(report => report.message.includes('no room for it; leaving it to its lease'))).toBe(true)
  })

  it('keeps claiming when a spool cannot be offered', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'mps-stuck-spool-'))
    const codingRoot = join(root, 'coding')
    const buffers = join(codingRoot, '.buffers')
    mkdirSync(buffers, { recursive: true })
    // A batch still to send, and something in the way of writing it back: the flush fails
    // where it cannot help it, and the loop has to carry on claiming rather than leave a
    // node that looks online and works on nothing.
    writeFileSync(join(buffers, 'tsk_9.jsonl'), '{"batch_id":"b","stream":"stdout","lines":[{"at":"t","level":"info","text":"x"}],"truncated":false}\n', 'utf8')
    mkdirSync(join(buffers, 'tsk_9.jsonl.writing'))
    const platform = new FakePlatform()
    platform.log = async () => { throw new Error('the platform is unreachable') }
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      settings: { ...settings(), codingRoot },
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    orchestrator.start()
    await vi.advanceTimersByTimeAsync(10_000)
    orchestrator.stop()
    rmSync(root, { recursive: true, force: true })

    expect(platform.claims.length).toBeGreaterThan(0)
    expect(reports.some(report => report.message.includes('could not offer what the platform has not taken yet'))).toBe(true)
  })

  it('keeps an outcome the platform could not take, and a restarted node submits it', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'mps-results-'))
    const codingRoot = join(root, 'coding')

    // The first process: every submission attempt fails with no answer at all.
    const down = new FakePlatform()
    down.assignments.push(assignment())
    // Unreachable for as long as this process runs: a queue would run dry and let a later
    // attempt through, which is not what an outage looks like.
    const submissions: ExecResultRequest[] = []
    down.result = async (_taskId, body) => {
      submissions.push(body)
      throw new Error('the platform is unreachable')
    }
    const reports: ExecutorReport[] = []
    const first = orchestratorWith({
      platform: down,
      reports,
      settings: { ...settings(), codingRoot },
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })
    first.orchestrator.start()
    // Long enough for the submission's own retries and their backoff.
    await vi.advanceTimersByTimeAsync(30_000)
    first.orchestrator.stop()

    // The outcome was kept, not lost, and the operator can see why.
    expect(submissions.length).toBeGreaterThan(1)
    expect(existsSync(join(codingRoot, '.results', 'tsk_1.json'))).toBe(true)
    expect(reports.some(report => report.message.includes('kept for later'))).toBe(true)

    // The next process: the platform is back and still leases the attempt, so the result
    // the last process could not hand over is submitted by this one.
    const back = new FakePlatform()
    // The lease cannot be checked at all: no answer is not a withdrawal, so the result is
    // offered rather than thrown away.
    back.leaseAnswers.push(new Error('no answer'))
    const second = orchestratorWith({
      platform: back,
      settings: { ...settings(), codingRoot },
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })
    second.orchestrator.start()
    await vi.advanceTimersByTimeAsync(30_000)
    second.orchestrator.stop()
    rmSync(root, { recursive: true, force: true })

    expect(back.results.map(entry => entry.summary)).toEqual(['done'])
    expect(back.results[0]).toMatchObject({ outcome: 'success', attempt: 1 })
  })

  it('leaves a result the platform already holds as it stands', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    // The platform says it already has this task's result, which is what a duplicate
    // submission earns. Asking again would only earn the same answer, and the operator
    // must not be told the platform refused something it is holding.
    platform.resultAnswers.push(new ExecResponseError('already final', { code: 'ALREADY_FINAL', httpStatus: 409 }))
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results).toHaveLength(1)
    expect(reports.some(report => report.message.includes("already holds this task's result"))).toBe(true)
    expect(reports.some(report => report.message.includes('refused the success result'))).toBe(false)
  })

  it('carries on when a progress report does not reach the platform', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    platform.progress = async () => { throw new Error('the platform is unreachable') }
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      runner: runnerOf(async (context) => {
        await context.reportProgress({ progress: 30, stage: 'coding', message: '3/10' })
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    // Progress is a report, not the work: the attempt finished and was submitted.
    expect(reports.some(report => report.message.includes('progress for tsk_1 did not reach the platform'))).toBe(true)
    expect(platform.results[0]).toMatchObject({ outcome: 'success' })
  })

  it('keeps and resends a log batch the platform could not take', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'mps-orch-spool-'))
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    let failures = 1
    const delivered = platform.log.bind(platform)
    platform.log = async (taskId, body) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('the platform is unreachable')
      }
      await delivered(taskId, body)
    }
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      reports,
      settings: { ...settings(), codingRoot: root },
      runner: runnerOf(async (context) => {
        await context.reportLog('stdout', [{ at: '2026-10-15T04:03:55.123Z', level: 'info', text: '改了 feature.txt' }])
        return { outcome: 'success', summary: 'done' }
      }),
    })

    orchestrator.start()
    await vi.advanceTimersByTimeAsync(5_000)
    orchestrator.stop()
    rmSync(root, { recursive: true, force: true })

    // The batch was refused once, so it waited on disk and the next claim offered it again.
    expect(platform.logs.length).toBeGreaterThan(0)
    expect(platform.logs.some(entry => entry.lines.some(line => line.text.includes('改了 feature.txt')))).toBe(true)
    expect(reports.some(report => report.message.includes('kept 1 log line(s)'))).toBe(true)
  })

  it('keeps the claim loop paused until the node says it has room', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    let room = false
    const { orchestrator } = orchestratorWith({
      platform,
      canClaim: () => room,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    orchestrator.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(platform.claims).toEqual([])

    room = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(platform.claims.length).toBeGreaterThan(0)
    orchestrator.stop()
  })

  it('claims nothing while the node says it has no room', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    let room = false
    const { orchestrator } = orchestratorWith({
      platform,
      canClaim: () => room,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    expect(await orchestrator.claimOnce()).toBe(false)
    expect(platform.claims).toEqual([])

    // Room comes back, and so does the work.
    room = true
    expect(await orchestrator.claimOnce()).toBe(true)
    expect(platform.claims).toHaveLength(1)
  })

  it('runs a claimed task and submits the outcome it reached', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator, hooks } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: '批量下载做好，构建通过' })),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.claims).toEqual([{
      available_slots: 1,
      capabilities: { lanes: ['coding', 'chat_answer'], tools: ['node'] },
      max_wait_seconds: settings().claimLongPollSeconds,
    }])
    expect(hooks.started).toEqual([{
      task_id: 'tsk_1',
      attempt: 1,
      started_at: '2026-10-15T12:03:55.123+08:00',
      progress: 0,
      stage: 'preparing',
    }])
    expect(platform.results).toEqual([{
      attempt: 1,
      outcome: 'success',
      started_at: '2026-10-15T12:03:55.123+08:00',
      finished_at: '2026-10-15T12:03:55.123+08:00',
      summary: '批量下载做好，构建通过',
      evidence: {
        changed_files: [],
        branch: 'feature/x',
        base_commit: 'a1b2c3d',
        head_commit: 'a1b2c3d',
        pushed: false,
      },
    }])
    expect(hooks.finished).toEqual(['tsk_1'])
    expect(orchestrator.runningTaskIds()).toEqual([])
  })

  it('keeps claiming while every slot is busy, but starts no coding task it cannot hold', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const hooks = new FakeHooks()
    hooks.slots = 0
    const reports: ExecutorReport[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      hooks,
      reports,
      runner: runnerOf(async () => ({ outcome: 'success', summary: '' })),
    })

    expect(await orchestrator.claimOnce()).toBe(false)
    // The claim was sent — an answer task needs no slot, so the node keeps asking —
    // but a coding dispatch at zero slots is named and left to its lease.
    expect(platform.claims).toHaveLength(1)
    expect(platform.claims[0]?.available_slots).toBe(0)
    expect(hooks.started).toEqual([])
    expect(reports.some(report => /every coding slot was busy/u.test(report.message))).toBe(true)
  })

  it('starts a chat answer while every slot is busy, with no workspace and its own runner', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      kind: 'chat_answer',
      priority: 800,
      payload: { answer: { chat_id: 'wr1', message_id: 7, question: '现在有哪些任务在跑？', sender: '陈祖豪' } },
    }))
    const hooks = new FakeHooks()
    hooks.slots = 0
    const workspaces: TaskWorkspaceAllocator = {
      prepare: async () => { throw new Error('an answer task must not prepare a workspace') },
    }
    const { orchestrator } = orchestratorWith({
      platform,
      hooks,
      workspaces,
      runner: runnerOf(async () => { throw new Error('the coding runner must not run an answer task') }),
      chatRunner: runnerOf(async (context) => {
        expect(context.workspaceDirectory).toBeUndefined()
        expect(context.checkout).toBeUndefined()
        return { outcome: 'success', summary: '现在共 2 个任务在跑。' }
      }),
    })

    expect(await orchestrator.claimOnce()).toBe(true)
    await orchestrator.drain()

    expect(hooks.started).toHaveLength(1)
    expect(platform.results[0]).toMatchObject({
      outcome: 'success',
      summary: '现在共 2 个任务在跑。',
    })
    expect(orchestrator.chatAnswerCount()).toBe(0)
  })

  it('reports an answer task as failed at once when no chat runner is composed', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ kind: 'chat_answer', payload: { answer: { chat_id: 'wr1', message_id: 7, question: 'hi' } } }))
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => { throw new Error('the coding runner must not run an answer task') }),
    })

    expect(await orchestrator.claimOnce()).toBe(true)
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({ outcome: 'failed', summary: /no runner for chat answers/u })
  })

  it('treats an empty long poll as no work', async () => {
    const platform = new FakePlatform()
    const hooks = new FakeHooks()
    const { orchestrator } = orchestratorWith({
      platform,
      hooks,
      runner: runnerOf(async () => ({ outcome: 'success', summary: '' })),
    })

    expect(await orchestrator.claimOnce()).toBe(false)
    expect(hooks.started).toEqual([])
  })

  it('carries a runner outcome and its notes and evidence through', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({
        outcome: 'blocked',
        summary: '缺少需求说明',
        notes: '需要客户补充截图',
        evidence: {
          build: { command: 'npm run build', exit_code: 0, duration_ms: 5, log_artifact_id: 'art_log' },
          report_artifact_id: 'art_report',
        },
      })),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({
      outcome: 'blocked',
      notes: '需要客户补充截图',
      evidence: {
        build: { log_artifact_id: 'art_log' },
        report_artifact_id: 'art_report',
        // The delivery facts stay the node's own, and it published nothing here.
        changed_files: [],
        pushed: false,
      },
    })
  })

  it('aborts a running task and acknowledges it, reporting cancelled', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    let observed: TaskRunContext | undefined
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        observed = context
        await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
        return { outcome: 'success', summary: 'finished before noticing' }
      }),
    })

    await orchestrator.claimOnce()
    expect(orchestrator.abort('tsk_1', '管理员中止')).toBe(true)
    expect(observed?.signal.aborted).toBe(true)
    expect(orchestrator.abort('tsk_missing')).toBe(false)
    await orchestrator.drain()

    expect(platform.abortAcks).toEqual([{
      attempt: 1,
      aborted_at: '2026-10-15T12:03:55.123+08:00',
      note: 'the runner settled after the abort command',
    }])
    expect(platform.results[0]?.outcome).toBe('cancelled')
    expect(reports.some(report => report.message.includes('aborted by the platform'))).toBe(true)
    expect(orchestrator.runningTaskIds()).toEqual([])
  })

  it('discards an attempt whose lease the platform withdrew', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ lease_renew_seconds: 10 }))
    platform.leaseAnswers.push({ lease_expire_at: '2026-10-15T04:16:00.123+08:00', should_continue: false })
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: waitingRunner(() => ({ outcome: 'success', summary: 'late work' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    await orchestrator.drain()

    expect(platform.results).toEqual([])
    expect(platform.logs).toHaveLength(1)
    expect(platform.logs[0]?.stream).toBe('stderr')
    expect(platform.logs[0]?.lines[0]?.text).toContain("withdrew this task's lease")
    expect(reports.some(report => report.message.includes('no longer leased'))).toBe(true)
    expect(orchestrator.runningTaskIds()).toEqual([])
  })

  it('stops an attempt at the runtime ceiling the payload states', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ payload: { limits: { max_runtime_seconds: 5 } } }))
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: waitingRunner(() => ({ outcome: 'success', summary: 'kept going' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    await orchestrator.drain()

    expect(platform.results[0]?.outcome).toBe('failed')
    expect(reports.some(report => report.message.includes('runtime ceiling'))).toBe(true)
  })

  it('stops an answer attempt at the answer ceiling, which stays under the coding one', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    // No payload limit: the answer ceiling is the settings' own.
    platform.assignments.push(assignment({
      kind: 'chat_answer',
      payload: { answer: { chat_id: 'wr1', message_id: 7, question: 'hi' } },
    }))
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: runnerOf(async () => { throw new Error('the coding runner must not run an answer task') }),
      chatRunner: waitingRunner(() => ({ outcome: 'success', summary: 'late answer' })),
    })

    await orchestrator.claimOnce()
    // The coding ceiling is hours; the answer one is 55 seconds by default.
    await vi.advanceTimersByTimeAsync(55_000)
    await orchestrator.drain()

    expect(platform.results[0]?.outcome).toBe('failed')
    expect(reports.some(report => report.message.includes('runtime ceiling'))).toBe(true)
  })

  it('renews the lease on the claimed period and survives a failed renewal', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ lease_renew_seconds: 10 }))
    platform.leaseAnswers.push(new Error('network down'))
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: waitingRunner(() => ({ outcome: 'blocked', summary: 'stopped' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(platform.leases).toEqual(['tsk_1'])
    expect(reports.some(report => report.message.includes('lease renewal failed'))).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(platform.leases).toEqual(['tsk_1', 'tsk_1'])

    orchestrator.stop()
    await orchestrator.drain()
    expect(platform.results[0]?.outcome).toBe('blocked')
  })

  it('does not renew a lease when the claim states no renewal period', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ lease_renew_seconds: 0, payload: { limits: { max_runtime_seconds: 3600 } } }))
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: waitingRunner(() => ({ outcome: 'failed', summary: 'gave up' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(platform.leases).toEqual([])
    orchestrator.stop()
    await orchestrator.drain()
    expect(platform.results[0]?.outcome).toBe('failed')
    expect(reports).toEqual([])
  })

  it('reports a failed attempt when the runner throws', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => { throw new Error('the worktree is gone') }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({
      outcome: 'failed',
      summary: 'the attempt threw: the worktree is gone',
    })
  })

  it('reports progress through the node and the platform', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator, hooks } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        await context.reportProgress({ progress: 45, stage: 'coding', message: '3/7 个文件', eta_seconds: 600 })
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(hooks.progresses).toEqual([['tsk_1', 45, 'coding']])
    expect(platform.progresses).toEqual([{
      attempt: 1,
      progress: 45,
      stage: 'coding',
      message: '3/7 个文件',
      eta_seconds: 600,
    }])
  })

  it('redacts, bounds, and batches submitted log lines', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const long = 'x'.repeat(LOG_LINE_MAX_BYTES + 10)
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        const lines = Array.from({ length: LOG_BATCH_MAX_LINES + 1 }, (_value, index) => ({
          at: '2026-10-15T12:03:55.123+08:00',
          level: 'info',
          text: `line ${String(index)}`,
        }))
        lines[0] = { at: '2026-10-15T12:03:55.123+08:00', level: 'info', text: 'api_key=abc123' }
        lines[1] = { at: '2026-10-15T12:03:55.123+08:00', level: 'info', text: long }
        await context.reportLog('stdout', lines)
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.logs).toHaveLength(2)
    expect(platform.logs[0]?.lines).toHaveLength(LOG_BATCH_MAX_LINES)
    expect(platform.logs[1]?.lines).toHaveLength(1)
    expect(platform.logs[0]?.lines[0]?.text).toBe('api_key=[REDACTED]')
    expect(platform.logs[0]?.lines[1]?.text).toHaveLength(LOG_LINE_MAX_BYTES)
    expect(platform.logs[0]?.truncated).toBe(true)
    expect(platform.logs[1]?.truncated).toBe(false)
    expect(platform.logs[0]?.batch_id).not.toBe(platform.logs[1]?.batch_id)
    expect(platform.logs[0]?.batch_id.startsWith('log-')).toBe(true)
  })

  it('bounds every batch by the cap the platform states, and names the attempt', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      logBatchMaxLines: () => 2,
      runner: runnerOf(async (context) => {
        await context.reportLog('stdout', Array.from({ length: 5 }, (_value, index) => ({
          at: '2026-10-15T12:03:55.123+08:00',
          level: 'info',
          text: `line ${String(index)}`,
        })))
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    // The platform refuses a batch over the cap it states, so no batch may exceed it.
    expect(platform.logs.map(batch => batch.lines.length)).toEqual([2, 2, 1])
    // Every batch names its attempt, which is how the platform keeps two attempts apart.
    expect(platform.logs.map(batch => batch.attempt)).toEqual([1, 1, 1])
  })

  it('reports a result the platform refused on its contents instead of repeating it', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    platform.resultAnswers.push(new ExecResponseError('INVALID_CHANGED_FILES: must be relative', {
      code: 'INVALID_CHANGED_FILES',
      httpStatus: 422,
    }))
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    // The same body is refused identically every time, so it is submitted once and reported.
    expect(platform.results).toHaveLength(1)
    expect(reports.some(report => report.level === 'error' && report.message.includes(
      'the platform refused the success result for tsk_1 on its contents, so it was not repeated',
    ))).toBe(true)
  })

  it('submits no batch for an empty log submission', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        await context.reportLog('stdout', [])
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.logs).toEqual([])
  })

  it('retries result submission while the platform answer allows it', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    platform.resultAnswers.push(new ExecResponseError('gateway is busy', { code: 'RATE_LIMITED', httpStatus: 429, requestId: 'r1' }))
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    await orchestrator.drain()

    expect(platform.results).toHaveLength(2)
  })

  it('stops retrying when the platform refuses the result for good', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    expect(recoveryForCode('TASK_NOT_FOUND')).not.toBe('retry')
    platform.resultAnswers.push(new ExecResponseError('no such task', { code: 'TASK_NOT_FOUND', httpStatus: 404, requestId: 'r1' }))
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results).toHaveLength(1)
    expect(reports.some(report => report.level === 'error' && report.message.includes('refused'))).toBe(true)
  })

  it('reports a result it could not submit at all', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const retryable = new ExecResponseError('gateway is busy', { code: 'RATE_LIMITED', httpStatus: 429, requestId: 'r1' })
    for (let attempt = 0; attempt < 6; attempt += 1) platform.resultAnswers.push(retryable)
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'failed', summary: 'gave up' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    await orchestrator.drain()

    expect(platform.results).toHaveLength(5)
    expect(reports.some(report => report.level === 'error' && report.message.includes('after 5 attempts'))).toBe(true)
    expect(orchestrator.runningTaskIds()).toEqual([])
  })

  it('runs with the defaults the caller did not state', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const hooks = new FakeHooks()
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: waitingRunner(() => ({ outcome: 'success', summary: 'done' })),
      hooks,
    })

    await orchestrator.claimOnce()
    expect(orchestrator.abort('tsk_1')).toBe(true)
    await orchestrator.drain()

    expect(platform.results[0]?.outcome).toBe('cancelled')
    expect(hooks.finished).toEqual(['tsk_1'])
  })

  it('applies its own runtime ceiling when the payload states none', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ payload: {} }))
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(2000)
    await orchestrator.drain()

    expect(platform.results[0]?.outcome).toBe('success')
  })

  it('ignores a lease answer that arrives after the attempt settled', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ lease_renew_seconds: 10 }))
    platform.leaseAnswers.push(
      { lease_expire_at: '2026-10-15T04:16:00.123+08:00', should_continue: false },
      { lease_expire_at: '2026-10-15T04:16:00.123+08:00', should_continue: false },
    )
    let releaseLease: (() => void) | undefined
    let settleAttempt: (() => void) | undefined
    platform.leaseGate = new Promise<void>((resolve) => { releaseLease = resolve })
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => {
        await new Promise<void>((resolve) => { settleAttempt = resolve })
        return { outcome: 'success', summary: 'done' }
      }),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(platform.leases).toEqual(['tsk_1', 'tsk_1'])
    settleAttempt?.()
    await orchestrator.drain()
    releaseLease?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(platform.results).toHaveLength(1)
    expect(platform.logs).toHaveLength(1)
  })

  it('reports an abort acknowledgement it could not deliver', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    platform.abortAckError = new Error('connection reset')
    const { orchestrator, reports } = orchestratorWith({
      platform,
      runner: waitingRunner(() => ({ outcome: 'success', summary: 'late work' })),
    })

    await orchestrator.claimOnce()
    orchestrator.abort('tsk_1', '管理员中止')
    await orchestrator.drain()

    expect(reports.some(report => report.message.includes('abort acknowledgement failed'))).toBe(true)
    expect(platform.results[0]?.outcome).toBe('cancelled')
  })

  it('retries a result submission that failed without an envelope code', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    platform.resultAnswers.push(new Error('socket closed'))
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    await orchestrator.drain()

    expect(platform.results).toHaveLength(2)
  })

  it('keeps claiming while it runs and stops when asked', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator, hooks, reports } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    orchestrator.start()
    orchestrator.start()
    expect(orchestrator.claiming).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(hooks.started).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1500)
    expect(platform.claims.length).toBeGreaterThan(1)

    platform.claimError = new Error('connection reset')
    await vi.advanceTimersByTimeAsync(6000)
    expect(reports.some(report => report.message.includes('claim failed: connection reset'))).toBe(true)

    platform.claimError = undefined
    orchestrator.stop()
    expect(orchestrator.claiming).toBe(false)
    await orchestrator.drain()
    const settled = platform.claims.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(platform.claims).toHaveLength(settled)
  })

  it('gives the attempt the directory and checkout its workspace has', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      payload: { limits: { max_runtime_seconds: 60 }, workspace: { workspace_id: 'ws_1' } },
    }))
    const prepared: string[] = []
    const seen: { directory: string | undefined; checkout: TaskCheckout | undefined }[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        seen.push({ directory: context.workspaceDirectory, checkout: context.checkout })
        return { outcome: 'success', summary: 'done' }
      }),
      workspaces: {
        prepare: async (task) => {
          prepared.push(task.task_id)
          return {
            directory: join('coding', 'ws_1'),
            checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
          }
        },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(prepared).toEqual(['tsk_1'])
    expect(seen).toEqual([{
      directory: join('coding', 'ws_1'),
      checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
    }])
  })

  it('fails the attempt when its workspace cannot be prepared', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ payload: { workspace: { workspace_id: 'ws_1' } } }))
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'never runs' })),
      workspaces: { prepare: async () => { throw new Error('the disk is full') } },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({ outcome: 'failed', summary: 'the attempt threw: the disk is full' })
  })

  it('never starts work for an attempt cancelled while its workspace was prepared', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ payload: { workspace: { workspace_id: 'ws_1' } } }))
    let releasePrepare: (() => void) | undefined
    const ran: string[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async () => {
        ran.push('ran')
        return { outcome: 'success', summary: 'done' }
      }),
      workspaces: {
        prepare: async () => {
          await new Promise<void>((resolve) => { releasePrepare = resolve })
          return { directory: join('coding', 'ws_1') }
        },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    expect(orchestrator.abort('tsk_1', '管理员中止')).toBe(true)
    releasePrepare?.()
    await orchestrator.drain()

    expect(ran).toEqual([])
    expect(platform.results[0]).toMatchObject({ outcome: 'cancelled', summary: 'the attempt was stopped before its work started' })
    expect(platform.abortAcks).toHaveLength(1)
  })

  it('discards an attempt whose lease was withdrawn while its workspace was prepared', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ lease_renew_seconds: 10, payload: { workspace: { workspace_id: 'ws_1' } } }))
    platform.leaseAnswers.push({ lease_expire_at: '2026-10-15T04:16:00.123+08:00', should_continue: false })
    let releasePrepare: (() => void) | undefined
    const ran: string[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async () => {
        ran.push('ran')
        return { outcome: 'success', summary: 'done' }
      }),
      workspaces: {
        prepare: async () => {
          await new Promise<void>((resolve) => { releasePrepare = resolve })
          return { directory: join('coding', 'ws_1') }
        },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    releasePrepare?.()
    await orchestrator.drain()

    expect(ran).toEqual([])
    expect(platform.results).toEqual([])
    expect(platform.logs).toHaveLength(1)
  })

  it('leaves the workspace unnamed when the payload names none', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ payload: {} }))
    const seen: (TaskCheckout | undefined)[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        seen.push(context.checkout)
        return { outcome: 'success', summary: 'done' }
      }),
      workspaces: { prepare: async () => undefined },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(seen).toEqual([undefined])
    expect(platform.results[0]?.evidence?.branch).toBe('')
  })

  it('publishes through the node and reports what it published', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      payload: {
        limits: { max_runtime_seconds: 60 },
        workspace: { workspace_id: 'ws_1', repo: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' } },
      },
    }))
    const requests: TaskPublishRequest[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        const published = await context.publish()
        return { outcome: 'success', summary: `pushed ${String(published.pushed)}` }
      }),
      workspaces: {
        prepare: async () => ({
          directory: join('coding', 'ws_1'),
          checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        }),
      },
      publisher: {
        publish: async (request) => {
          requests.push(request)
          return { changed_files: ['src/a.ts'], head_commit: 'b2c3d4e', pushed: true }
        },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ directory: join('coding', 'ws_1'), checkout: { work_branch: 'feature/tsk_1' } })
    expect(requests[0]?.assignment.task_id).toBe('tsk_1')
    expect(platform.results[0]?.summary).toBe('pushed true')
    expect(platform.results[0]?.evidence).toEqual({
      changed_files: ['src/a.ts'],
      branch: 'feature/tsk_1',
      base_commit: 'a1b2c3d',
      head_commit: 'b2c3d4e',
      pushed: true,
    })
  })

  it('reports an attempt that has nothing to publish', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        await context.publish()
        return { outcome: 'success', summary: 'never reached' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({
      outcome: 'failed',
      summary: 'the attempt threw: this attempt has no prepared checkout to publish',
    })
  })

  it('keeps the evidence a runner reports when nothing was published', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async () => ({
        outcome: 'success',
        summary: 'done',
        evidence: {
          report_artifact_id: 'art_report',
        },
      })),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    // The runner knows the report; the delivery facts stay what the node published.
    expect(platform.results[0]?.evidence?.report_artifact_id).toBe('art_report')
    expect(platform.results[0]?.evidence?.changed_files).toEqual([])
  })

  it('uploads the bundle a read_only attempt hands back and reports it as the change', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      payload: {
        constraints: { access_mode: 'read_only' },
        workspace: {
          workspace_id: 'ws_1',
          repo: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        },
      },
    }))
    const uploads: TaskArtifactRequest[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        const published = await context.publish()
        return {
          outcome: 'success',
          summary: `changed ${String(published.changed_files.length)} file(s)`,
        }
      }),
      workspaces: {
        prepare: async () => ({
          directory: join('coding', 'ws_1'),
          checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        }),
      },
      artifacts: {
        upload: async (request: TaskArtifactRequest) => {
          uploads.push(request)
          return 'art_bundle'
        },
      },
      publisher: {
        publish: async () => ({
          changed_files: ['src/a.ts'],
          head_commit: 'b2c3d4e',
          pushed: false,
          bundle: { path: join('.bundles', 'feature-tsk_1-b2c3d4e.bundle'), sha256: 'sha-bundle' },
        }),
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.kind).toBe('bundle')
    expect(uploads[0]?.path).toBe(join('.bundles', 'feature-tsk_1-b2c3d4e.bundle'))
    expect(uploads[0]?.meta).toMatchObject({ branch: 'feature/tsk_1', head_commit: 'b2c3d4e', sha256: 'sha-bundle' })
    expect(platform.results[0]?.evidence).toMatchObject({
      pushed: false,
      patch_artifact_id: 'art_bundle',
      head_commit: 'b2c3d4e',
    })
  })

  it('keeps the evidence a runner collected beside the node own facts', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      payload: {
        workspace: {
          workspace_id: 'ws_1',
          repo: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        },
      },
    }))
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        await context.publish()
        return {
          outcome: 'success',
          summary: 'done',
          evidence: {
            build: { command: 'npm run build', exit_code: 0, duration_ms: 12, log_artifact_id: 'art_log' },
            report_artifact_id: 'art_report',
          },
        }
      }),
      workspaces: {
        prepare: async () => ({
          directory: join('coding', 'ws_1'),
          checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        }),
      },
      publisher: {
        publish: async () => ({ changed_files: ['src/a.ts'], head_commit: 'b2c3d4e', pushed: true }),
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]?.evidence).toMatchObject({
      changed_files: ['src/a.ts'],
      head_commit: 'b2c3d4e',
      pushed: true,
      build: { log_artifact_id: 'art_log' },
      report_artifact_id: 'art_report',
    })
  })

  it('reports the session a runner names through the node', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      payload: {
        workspace: {
          workspace_id: 'ws_1',
          repo: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        },
      },
    }))
    const reports: TaskSessionRequest[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        await context.reportSession('dsh-session-01H8Z')
        return { outcome: 'success', summary: 'done' }
      }),
      workspaces: {
        prepare: async () => ({
          directory: join('coding', 'ws_1'),
          checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        }),
      },
      sessions: {
        report: async (request) => { reports.push(request) },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      directory: join('coding', 'ws_1'),
      sessionRef: 'dsh-session-01H8Z',
      baseCommit: 'a1b2c3d',
    })
    expect(reports[0]?.assignment.task_id).toBe('tsk_1')
    expect(platform.results[0]?.outcome).toBe('success')
  })

  it('reports an attempt that has no workspace to name a session for', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        await context.reportSession('dsh-session-01H8Z')
        return { outcome: 'success', summary: 'never reached' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({
      outcome: 'failed',
      summary: 'the attempt threw: this attempt has no prepared workspace to report a session for',
    })
  })

  it('uploads what a runner produced through the node', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({
      payload: {
        workspace: {
          workspace_id: 'ws_1',
          repo: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        },
      },
    }))
    const uploads: TaskArtifactRequest[] = []
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        const artifact = await context.uploadArtifact('screenshot', 'shots/detail.png', { width: 1440 })
        return { outcome: 'success', summary: `uploaded ${artifact}` }
      }),
      workspaces: {
        prepare: async () => ({
          directory: join('coding', 'ws_1'),
          checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        }),
      },
      artifacts: {
        upload: async (request) => {
          uploads.push(request)
          return 'art_01H8Z'
        },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({
      taskId: 'tsk_1',
      directory: join('coding', 'ws_1'),
      kind: 'screenshot',
      path: 'shots/detail.png',
      meta: { width: 1440 },
    })
    expect(platform.results[0]?.summary).toBe('uploaded art_01H8Z')
  })

  it('reports an attempt that has no workspace to upload from', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        await context.uploadArtifact('report', 'report.md')
        return { outcome: 'success', summary: 'never reached' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({
      outcome: 'failed',
      summary: 'the attempt threw: this attempt has no prepared workspace to upload from',
    })
  })

  it('submits a failed result when an artifact is over the ceiling, naming its size', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const orchestrator = new TaskOrchestrator({
      client: platform,
      settings: settings(),
      runner: runnerOf(async (context) => {
        await context.uploadArtifact('report', 'report.md')
        return { outcome: 'success', summary: 'never reached' }
      }),
      workspaces: {
        prepare: async () => ({
          directory: join('coding', 'ws_1'),
          checkout: { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' },
        }),
      },
      artifacts: {
        upload: async () => {
          throw new ArtifactTooLargeError(
            'refusing to upload report.md: it is 600000000 bytes, over the 524288000 bytes this node uploads',
            { path: 'report.md', sizeBytes: 600000000, ceilingBytes: 524288000 },
          )
        },
      },
      hooks: new FakeHooks(),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    // The platform hears this attempt's outcome rather than waiting for the lease to lapse.
    expect(platform.results[0]).toMatchObject({
      outcome: 'failed',
      summary:
        'the attempt could not deliver report.md: refusing to upload report.md: it is 600000000 bytes, over the 524288000 bytes this node uploads',
    })
  })

  it('downloads a material a runner asks for', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        const material = await context.resource('art_01H8Z')
        return { outcome: 'success', summary: `read ${new TextDecoder().decode(material.bytes).trim()}` }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.resources).toEqual([{ taskId: 'tsk_1', artifactId: 'art_01H8Z' }])
    expect(platform.results[0]?.summary).toBe('read # art_01H8Z')
  })

  it('reports an attempt whose material the platform refuses', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment())
    platform.resourceError = new Error('RESOURCE_NOT_IN_SCOPE: not in scope')
    const { orchestrator } = orchestratorWith({
      platform,
      runner: runnerOf(async (context) => {
        await context.resource('art_9')
        return { outcome: 'success', summary: 'never reached' }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.drain()

    expect(platform.results[0]).toMatchObject({
      outcome: 'failed',
      summary: 'the attempt threw: RESOURCE_NOT_IN_SCOPE: not in scope',
    })
  })

  it('keeps two attempts running at once within the slot budget', async () => {
    const platform = new FakePlatform()
    platform.assignments.push(assignment({ task_id: 'tsk_1' }), assignment({ task_id: 'tsk_2' }))
    const hooks = new FakeHooks()
    hooks.slots = 2
    const settle: (() => void)[] = []
    const { orchestrator } = orchestratorWith({
      platform,
      hooks,
      runner: runnerOf(async (context) => {
        await new Promise<void>((resolve) => { settle.push(resolve) })
        return { outcome: 'success', summary: context.task.task_id }
      }),
    })

    await orchestrator.claimOnce()
    await orchestrator.claimOnce()
    expect(orchestrator.runningTaskIds()).toEqual(['tsk_1', 'tsk_2'])

    settle[0]?.()
    settle[1]?.()
    await orchestrator.drain()

    expect(hooks.finished).toEqual(['tsk_1', 'tsk_2'])
    expect(platform.results.map(result => result.summary)).toEqual(['tsk_1', 'tsk_2'])
  })

  it('keeps asking while every slot is busy, so an answer task is not kept waiting', async () => {
    vi.useFakeTimers()
    const platform = new FakePlatform()
    const hooks = new FakeHooks()
    hooks.slots = 0
    const { orchestrator } = orchestratorWith({
      platform,
      hooks,
      runner: runnerOf(async () => ({ outcome: 'success', summary: 'done' })),
    })

    orchestrator.start()
    await vi.advanceTimersByTimeAsync(3000)
    // The platform answered every long poll empty, and the node asked again each
    // time, with zero slots on offer: an answer dispatch needs none.
    expect(platform.claims.length).toBeGreaterThan(1)
    expect(platform.claims.every(claim => claim.available_slots === 0)).toBe(true)
    orchestrator.stop()
    await orchestrator.drain()
  })
})

describe('log line bounds', () => {
  it('leaves a line within the limit untouched', () => {
    expect(boundLogLine('短行')).toEqual({ text: '短行', truncated: false })
    expect(boundLogLine('x'.repeat(LOG_LINE_MAX_BYTES))).toEqual({ text: 'x'.repeat(LOG_LINE_MAX_BYTES), truncated: false })
  })

  it('cuts an oversized line and keeps the result valid UTF-8', () => {
    const line = '中'.repeat(LOG_LINE_MAX_BYTES)
    const bounded = boundLogLine(line)
    expect(bounded.truncated).toBe(true)
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES)
    expect(bounded.text.endsWith('\uFFFD')).toBe(false)
    expect(bounded.text).toBe('中'.repeat(LOG_LINE_MAX_BYTES / 3))
  })
})
