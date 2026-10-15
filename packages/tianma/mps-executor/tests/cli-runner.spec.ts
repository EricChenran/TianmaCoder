/**
 * The runner the node ships: what it hands the CLI, what it streams back, and how it
 * turns a process into a result. The child is a stand-in that prints its arguments and
 * settles on request, so no model and no network are involved.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, afterEach } from 'vitest'
import { runFailureSummary, stopRun, tianmaCliRunner } from '@tianma/dsh-mps-executor'
import type { PublishedChanges, TaskRunContext, TaskRunResult } from '@tianma/dsh-mps-executor'
import type { ExecLogLine, ExecTaskAssignment, TaskProgress } from '@tianma/dsh-mps-exec-core'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix for the directory.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** The stand-in command: this Node runtime, running the fixture. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-child.mjs')

/** An instruction carrying shell metacharacters, to prove the argument array is not a shell line. */
const INSTRUCTION = '增加批量下载 && echo pwned; rm -rf /'

/** What one attempt's context recorded. */
class RecordingContext implements TaskRunContext {
  readonly progresses: TaskProgress[] = []
  readonly logs: { stream: string; lines: ExecLogLine[] }[] = []
  published = 0
  /** What the node publishes, as the fake commit reports it. */
  publishResult: PublishedChanges = { changed_files: ['src/a.ts'], head_commit: 'b2c3d4e', pushed: true }
  publishError: Error | undefined
  readonly controller = new AbortController()
  readonly checkout = undefined

  constructor(readonly workspaceDirectory: string | undefined, readonly task: ExecTaskAssignment) {}

  get signal(): AbortSignal {
    return this.controller.signal
  }

  async reportProgress(progress: TaskProgress): Promise<void> {
    this.progresses.push(progress)
  }

  async reportLog(stream: string, lines: ExecLogLine[]): Promise<void> {
    this.logs.push({ stream, lines })
  }

  async resource(): Promise<never> {
    throw new Error('this attempt downloads no material')
  }

  async uploadArtifact(): Promise<string> {
    throw new Error('this attempt uploads no artifact')
  }

  async reportSession(): Promise<void> {
    throw new Error('this attempt reports no session')
  }

  async publish(): Promise<PublishedChanges> {
    this.published += 1
    if (this.publishError !== undefined) throw this.publishError
    return this.publishResult
  }
}

/**
 * One attempt as the platform dispatches it.
 * @param payload - the payload to carry, defaulting to one instruction.
 * @returns the assignment.
 */
function assignment(payload: Record<string, unknown> = { spec: { raw_instruction: INSTRUCTION } }): ExecTaskAssignment {
  return {
    task_id: 'tsk_1',
    work_item_id: 'wi_1',
    attempt: 2,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2026-10-15T04:16:00.123+08:00',
    lease_renew_seconds: 30,
    payload,
  }
}

/**
 * A runner over the fixture.
 * @param logsDirectory - where the runner keeps its raw logs.
 * @param mode - how the child should settle.
 * @returns the runner.
 */
function runnerFor(logsDirectory: string, mode: string) {
  return tianmaCliRunner({
    command: [process.execPath, FIXTURE, mode],
    logsDirectory,
    now: () => new Date('2026-10-15T04:03:55.123Z'),
  })
}

/**
 * Every line one context reported, with its stream.
 * @param context - the context.
 * @returns the lines.
 */
function reported(context: RecordingContext): string[] {
  return context.logs.flatMap(entry => entry.lines.map(line => `${entry.stream}:${line.text}`))
}

describe('the CLI runner', () => {
  it('runs the command in the attempt workspace and streams what it prints', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())

    const result: TaskRunResult = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('success')
    expect(result.summary).toBe('changed 1 file(s) and pushed them')
    expect(context.published).toBe(1)
    // The argument array carried the instruction literally, with no shell in between.
    expect(reported(context)).toContain(`stdout:instruction=${INSTRUCTION}`)
    expect(reported(context)).toContain(`stdout:cwd=${workspace}`)
    expect(context.progresses).toEqual([{ progress: 10, stage: 'coding', message: 'the agent is working' }])

    const rawLog = join(logs, 'tsk_1-2.log')
    expect(result.notes).toBe(`raw log: ${rawLog}`)
    const written = readFileSync(rawLog, 'utf8')
    expect(written).toContain('ended: exited with code 0')
    expect(written).toContain('[stdout] done')
  })

  it('reports a run that exited non-zero with the line it failed on', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())

    const result = await runnerFor(logs, 'fail').run(context)

    expect(result.outcome).toBe('failed')
    expect(result.summary).toBe('the run exited with code 3: build failed: 3 errors')
    expect(context.published).toBe(0)
    expect(context.logs.some(entry => entry.stream === 'stderr')).toBe(true)
  })

  it('refuses a run that changed nothing', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    context.publishResult = { changed_files: [], head_commit: 'a1b2c3d', pushed: false }

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('failed')
    expect(result.summary).toBe('the run finished without changing any file')
  })

  it('stops a run when the node cancels the attempt', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())

    const running = runnerFor(logs, 'sleep').run(context)
    await waitFor(() => reported(context).includes('stdout:working'))
    context.controller.abort()

    const result = await running

    expect(result.outcome).toBe('failed')
    expect(result.summary).toBe('the node stopped this run')
    expect(context.published).toBe(0)
    expect(readFileSync(join(logs, 'tsk_1-2.log'), 'utf8')).toContain('ended: stopped')
  })

  it('carries the environment it was given and stamps its own clock', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    const runner = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'ok'],
      logsDirectory: logs,
      env: { MPS_TEST_MARK: 'marked' },
    })

    const result = await runner.run(context)

    expect(result.outcome).toBe('success')
    expect(reported(context)).toContain('stdout:env=marked')
    // Without an injected clock the runner stamps the lines itself.
    expect(context.logs[0]?.lines[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
  })

  it('reports a run that changed files without pushing them', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    context.publishResult = { changed_files: ['src/a.ts', 'src/b.ts'], head_commit: 'b2c3d4e', pushed: false }

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.summary).toBe('changed 2 file(s)')
  })

  it('stops a run whose attempt was already cancelled', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    context.controller.abort()

    const result = await runnerFor(logs, 'sleep').run(context)

    expect(result.summary).toBe('the node stopped this run')
    expect(context.published).toBe(0)
  })

  it('flushes a line the run printed without a newline', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())

    const running = runnerFor(logs, 'partial').run(context)
    // The line has no newline, so it is only flushed when the run ends.
    await new Promise(resolve => setTimeout(resolve, 300))
    context.controller.abort()
    const result = await running

    expect(result.summary).toBe('the node stopped this run')
    expect(readFileSync(join(logs, 'tsk_1-2.log'), 'utf8')).toContain('[stdout] a line with no newline yet')
  })

  it('keeps a chunk that carries no newline at all', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())

    const running = runnerFor(logs, 'bare').run(context)
    await new Promise(resolve => setTimeout(resolve, 300))
    context.controller.abort()
    await running

    expect(readFileSync(join(logs, 'tsk_1-2.log'), 'utf8')).toContain('no newline at all')
  })

  it('reports a run something else ended', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())

    const running = runnerFor(logs, 'pid').run(context)
    await waitFor(() => reported(context).some(line => line.startsWith('stdout:pid=')))
    const reportedPid = reported(context).find(line => line.startsWith('stdout:pid='))
    process.kill(Number(reportedPid?.slice('stdout:pid='.length)), 'SIGKILL')

    const result = await running

    expect(result.outcome).toBe('failed')
    expect(result.summary).toMatch(/the run exited with code/u)
  })

  it('says how a run ended, whether or not it left a code', () => {
    expect(runFailureSummary(3, ': build failed')).toBe('the run exited with code 3: build failed')
    expect(runFailureSummary(undefined, '')).toBe('the run exited without an exit code')
  })

  it('asks a run to end before killing it', async () => {
    const kills: (string | number | undefined)[] = []
    const run = {
      kill: (signal?: NodeJS.Signals | number): boolean => {
        kills.push(signal)
        return true
      },
    }

    stopRun(run, 5)
    expect(kills).toEqual([undefined])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(kills).toEqual([undefined, 'SIGKILL'])
  })

  it('fails loudly when the command cannot be started', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    const runner = tianmaCliRunner({ command: ['mps-definitely-not-a-command'], logsDirectory: logs })

    await expect(runner.run(context)).rejects.toThrow(/could not start mps-definitely-not-a-command/)
  })

  it('refuses an attempt it cannot run', async () => {
    const logs = temporary('mps-logs-')
    const runner = runnerFor(logs, 'ok')

    await expect(runner.run(new RecordingContext(undefined, assignment())))
      .rejects.toThrow(/names no workspace to run in/)
    await expect(runner.run(new RecordingContext(temporary('mps-run-'), assignment({}))))
      .rejects.toThrow(/carries no instruction to run/)
  })

  it('refuses to be built without a command', () => {
    expect(() => tianmaCliRunner({ command: [], logsDirectory: temporary('mps-logs-') }))
      .toThrow(/needs the command it starts/)
    expect(() => tianmaCliRunner({ command: [''], logsDirectory: temporary('mps-logs-') }))
      .toThrow(/needs the command it starts/)
  })

  it('carries a platform refusal out of publishing', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    context.publishError = new Error('refusing to publish credentials in leak.env')

    await expect(runnerFor(logs, 'ok').run(context)).rejects.toThrow(/refusing to publish credentials/)
    expect(existsSync(join(logs, 'tsk_1-2.log'))).toBe(true)
  })
})

/**
 * Wait until a condition holds, or fail the test.
 * @param condition - the condition to poll.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('the run never printed what the test waited for')
}
