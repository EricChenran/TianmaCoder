/**
 * The runner the node ships: it runs the tianmacoder CLI on one attempt, in the
 * attempt's coding workspace, and turns what that process did into a result.
 *
 * The node owns everything around the process — the working directory, the
 * argument array (never a shell string, because a task instruction is external
 * input), cancellation with a grace period before a kill, the raw log kept outside
 * the workspace, and the commit of what the run changed. What the CLI does inside
 * those bounds is the agent's business.
 * @module @tianma/dsh-mps-executor/cli-runner
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { taskInstruction } from '@tianma/dsh-mps-exec-core'
import type { TaskEvidence } from './runner.ts'
import { collectEvidence } from './evidence.ts'
import type { CollectedEvidence, EvidenceCommandOutcome } from './evidence.ts'
import { toError } from './report.ts'
import type { ExecLogLine } from '@tianma/dsh-mps-exec-core'
import type { PublishedChanges, TaskRunContext, TaskRunResult, TaskRunner } from './runner.ts'
import { fetchMaterials } from './materials.ts'
import type { MaterialFile } from './materials.ts'
import { TASK_BOOK_POINTER, writeTaskBook } from './task-book.ts'

/** How long a run is given to stop before the node kills it. */
export const RUNNER_STOP_GRACE_MS = 3000

/** Most log lines one reported batch carries. */
const LOG_BATCH_LINES = 200

/** Options for {@link tianmaCliRunner}. */
export interface CliRunnerOptions {
  /**
   * The command and its leading arguments, such as `['dsh', '--profile', 'headless']`;
   * the instruction is appended to it.
   */
  command: readonly string[]
  /**
   * Directory the runner keeps one raw log per attempt under. It sits outside the
   * coding workspace on purpose: everything inside the workspace is what the node
   * commits, and a run log is not part of the delivered change.
   */
  logsDirectory: string
  /** Extra environment for the run; the node's own environment is inherited. */
  env?: Record<string, string> | undefined
  /** How long to wait after asking a run to stop; defaults to {@link RUNNER_STOP_GRACE_MS}. */
  stopGraceMs?: number | undefined
  /** Current-time source; injectable for tests. */
  now?: (() => Date) | undefined
}

/** One line the run produced, kept for the raw log. */
interface RunLine {
  stream: 'stdout' | 'stderr'
  line: ExecLogLine
}

/**
 * Build the runner that executes an attempt with the tianmacoder CLI.
 * @param options - the command to run, where its logs go, and its environment.
 * @returns the runner the node executes with.
 */
export function tianmaCliRunner(options: CliRunnerOptions): TaskRunner {
  const bin = options.command[0]
  if (bin === undefined || bin === '') {
    throw new Error('the runner needs the command it starts, such as dsh --profile headless')
  }
  const prefix = options.command.slice(1)
  const stopGraceMs = options.stopGraceMs ?? RUNNER_STOP_GRACE_MS
  const now = options.now ?? (() => new Date())

  return {
    async run(context: TaskRunContext): Promise<TaskRunResult> {
      const directory = context.workspaceDirectory
      if (directory === undefined) throw new Error('this attempt names no workspace to run in')
      const instruction = taskInstruction(context.task.payload)
      if (instruction === undefined) throw new Error('this task carries no instruction to run')

      // The materials come in first: the book names the file each was written to, and an
      // attempt that cannot read what the platform attached is one that would have to
      // guess, which is what `blocked` is for.
      let materials: MaterialFile[] = []
      try {
        materials = await fetchMaterials({
          directory,
          assignment: context.task,
          source: { resource: async (artifactId: string) => await context.resource(artifactId) },
          signal: context.signal,
        })
      } catch (error) {
        return {
          outcome: 'blocked',
          summary: `could not bring in the task's materials: ${toError(error).message}`,
        }
      }
      // The instruction is the prompt; everything else the attempt needs — constraints,
      // delivery requirements, the chat it came from, the rules — is the task book.
      const book = writeTaskBook({ directory, assignment: context.task, materials })
      const lines: RunLine[] = []
      await context.reportProgress({ progress: 10, stage: 'coding', message: 'the agent is working' })
      await context.reportLog('runner', [{
        at: now().toISOString(),
        level: 'info',
        text: materials.length === 0
          ? `task book: ${book}`
          : `task book: ${book}（材料 ${String(materials.length)} 份）`,
      }])
      const outcome = await runProcess({
        bin,
        args: [...prefix, `${instruction}\n\n${TASK_BOOK_POINTER}`],
        directory,
        env: options.env,
        signal: context.signal,
        stopGraceMs,
        now,
        onLines: async (stream, batch) => {
          lines.push(...batch.map(line => ({ stream, line })))
          await context.reportLog(stream, batch)
        },
      })

      const rawLog = join(options.logsDirectory, `${context.task.task_id}-${String(context.task.attempt)}.log`)
      writeRawLog(rawLog, lines, outcome)
      const notes = `raw log: ${rawLog}`

      assertStarted(outcome, bin)
      if (outcome.kind === 'stopped') {
        return { outcome: 'failed', summary: 'the node stopped this run', notes }
      }
      if (outcome.code !== 0) {
        return {
          outcome: 'failed',
          summary: runFailureSummary(outcome.code, lastLine(lines, 'stderr')),
          notes,
        }
      }
      const published = await context.publish()
      if (published.changed_files.length === 0) {
        return { outcome: 'failed', summary: 'the run finished without changing any file', notes }
      }
      // The evidence comes after the commit: a build writes output the delivered change
      // must not carry, and the platform reads these results against what was pushed.
      await context.reportProgress({ progress: 80, stage: 'collecting_evidence', message: 'collecting evidence' })
      const collected = await collectEvidence({
        directory,
        payload: context.task.payload,
        run: async line => await runShellLine(line, {
          directory,
          env: options.env,
          signal: context.signal,
          stopGraceMs,
          now,
          lines,
          context,
        }),
      })
      if (collected.failure !== undefined) {
        return {
          outcome: 'failed',
          summary: `${collected.failure.what} evidence: ${collected.failure.message}`,
          notes,
        }
      }
      const evidence = await uploadEvidence(context, collected)
      await context.reportProgress({ progress: 100, stage: 'uploading', message: 'evidence reported' })
      return {
        outcome: 'success',
        summary: `changed ${String(published.changed_files.length)} file(s)${pushedNote(published)}${evidenceNote(collected)}`,
        ...(evidence === undefined ? {} : { evidence }),
        notes,
      }
    },
  }
}

/**
 * A run the node can stop.
 */
export interface StoppableRun {
  /** Process id the host gave the run, when it started one. */
  pid?: number | undefined
  /**
   * Ask the run to end.
   * @param signal - the signal to send.
   * @returns whether the request was delivered.
   */
  kill(signal?: NodeJS.Signals | number): boolean
}

/**
 * Stop a run: the plan the host calls for, applied at once.
 * @param run - the run to stop.
 * @param graceMs - how long a run that takes signals is given to end on its own.
 * @param platform - the host platform; defaults to this one.
 */
export function stopRun(run: StoppableRun, graceMs: number, platform: NodeJS.Platform = process.platform): void {
  const plan = stopPlan(run, platform)
  if (plan.kind === 'taskkill') {
    spawn('taskkill', ['/pid', String(plan.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    return
  }
  run.kill()
  const timer = setTimeout(() => { run.kill('SIGKILL') }, graceMs)
  timer.unref()
}

/** How the node stops a run that does not end when it is asked to. */
export type StopPlan =
  | { kind: 'taskkill'; pid: number }
  | { kind: 'signals' }

/**
 * The way one run is stopped. Windows has no signal to escalate from, and a command the
 * node started through a shell outlives that shell, so the whole tree goes at once there;
 * elsewhere the run is asked to end and killed after the grace period.
 * @param run - the run, whose process id the host gave when it started one.
 * @param platform - the host platform.
 * @returns the plan the node applies.
 */
export function stopPlan(run: { pid?: number | undefined }, platform: NodeJS.Platform): StopPlan {
  if (platform === 'win32' && run.pid !== undefined) return { kind: 'taskkill', pid: run.pid }
  return { kind: 'signals' }
}

/**
 * Run one command line the payload stated, in the delivered workspace, keeping what it
 * prints in the attempt's log as well as in the evidence file.
 *
 * The payload states a shell command (`npm run build`), so the line runs through the
 * host shell rather than an argument array: the node interpolates nothing into it, and
 * the platform that dispatched the task stated it.
 * @param line - the command line.
 * @param options - the workspace, the environment, cancellation, and the attempt's log.
 * @returns the exit code and everything the command printed.
 */
async function runShellLine(line: string, options: {
  directory: string
  env?: Record<string, string> | undefined
  signal: AbortSignal
  stopGraceMs: number
  now: () => Date
  lines: RunLine[]
  context: TaskRunContext
  platform?: NodeJS.Platform | undefined
}): Promise<EvidenceCommandOutcome> {
  const printed: string[] = []
  const shell = shellFor(line, options.platform ?? process.platform)
  const outcome = await runProcess({
    bin: shell.bin,
    args: shell.args,
    directory: options.directory,
    env: options.env,
    signal: options.signal,
    stopGraceMs: options.stopGraceMs,
    now: options.now,
    onLines: async (stream, batch) => {
      options.lines.push(...batch.map(entry => ({ stream, line: entry })))
      for (const entry of batch) printed.push(entry.text)
      await options.context.reportLog(stream, batch)
    },
  })
  assertStarted(outcome, line)
  return { exit_code: exitCodeOf(outcome), output: printed.join('\n') }
}

/**
 * The shell one command line runs through: the platform's own, because the payload states
 * a shell command rather than an argument array.
 * @param line - the command line.
 * @param platform - the host platform.
 * @returns the executable and the arguments that run the line.
 */
export function shellFor(line: string, platform: NodeJS.Platform): { bin: string; args: string[] } {
  return platform === 'win32'
    ? { bin: 'cmd.exe', args: ['/d', '/s', '/c', line] }
    : { bin: '/bin/sh', args: ['-c', line] }
}

/**
 * Upload what the evidence collected and report it the way the protocol names it.
 * @param context - the attempt's context, which carries the upload.
 * @param collected - what the attempt collected.
 * @returns the evidence for the result, or undefined when the task required none.
 */
async function uploadEvidence(
  context: TaskRunContext,
  collected: CollectedEvidence,
): Promise<TaskEvidence | undefined> {
  const evidence: TaskEvidence = {}
  if (collected.build !== undefined) {
    const id = await context.uploadArtifact('log', collected.build.log_path, { command: collected.build.command })
    evidence.build = { ...collected.build, log_artifact_id: id }
  }
  if (collected.e2e !== undefined) {
    const id = await context.uploadArtifact('log', collected.e2e.log_path, { command: collected.e2e.command })
    evidence.e2e = { ...collected.e2e, result_artifact_id: id }
  }
  if (collected.report_path !== undefined) {
    evidence.report_artifact_id = await context.uploadArtifact('report', collected.report_path)
  }
  return Object.keys(evidence).length === 0 ? undefined : evidence
}

/**
 * How one attempt describes the evidence it collected.
 * @param collected - what the attempt collected.
 * @returns the clause the summary appends.
 */
function evidenceNote(collected: CollectedEvidence): string {
  const parts: string[] = []
  if (collected.build !== undefined) parts.push('build')
  if (collected.e2e !== undefined) parts.push('e2e')
  if (collected.report_path !== undefined) parts.push('report')
  return parts.length === 0 ? '' : `; evidence: ${parts.join(', ')}`
}

/**
 * The exit code one command reports. A command that ended without one — the node stopped
 * it, or something else did — reports -1, because the platform's evidence carries a number.
 * @param outcome - what the run settled as.
 * @returns the code the evidence reports.
 */
export function exitCodeOf(outcome: { code?: number | null | undefined }): number {
  return outcome.code ?? -1
}

/**
 * How one published attempt describes what it did with its work.
 * @param published - what the attempt published.
 * @returns the clause the summary appends.
 */
function pushedNote(published: PublishedChanges): string {
  if (published.bundle !== undefined) return ' and handed them back as a bundle'
  return published.pushed ? ' and pushed them' : ''
}

/**
 * Refuse a run whose process never started.
 * @param outcome - what the run settled as.
 * @param bin - the executable the run was given.
 * @throws Error naming the executable and why it could not start.
 */
function assertStarted(outcome: RunOutcome, bin: string): void {
  if (outcome.spawnError !== undefined) {
    throw new Error(`could not start ${bin}: ${outcome.spawnError.message}`)
  }
}

/** What one run settled as. */
interface RunOutcome {
  /** Why the run ended. */
  kind: 'exited' | 'stopped'
  /** Exit code the host reported; null when the run ended without one. */
  code: number | null
  /** Failure the process could not be started with. */
  spawnError?: Error | undefined
}

/** What one run needs to start and settle. */
interface RunRequest {
  bin: string
  args: string[]
  directory: string
  env?: Record<string, string> | undefined
  signal: AbortSignal
  stopGraceMs: number
  now: () => Date
  onLines: (stream: 'stdout' | 'stderr', lines: ExecLogLine[]) => Promise<void>
}

/**
 * Run the command once and stream what it prints.
 * @param request - the command, its directory, and where its lines go.
 * @returns how the run settled.
 */
async function runProcess(request: RunRequest): Promise<RunOutcome> {
  return await new Promise<RunOutcome>((resolve, reject) => {
    const child = spawn(request.bin, request.args, {
      cwd: request.directory,
      env: request.env === undefined ? process.env : { ...process.env, ...request.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // `stdio: 'pipe'` gives the child both output pipes, so they are always there.
    const pipes = { stdout: child.stdout as Readable, stderr: child.stderr as Readable }
    let stopped = false
    const pending: Promise<void>[] = []

    const flush = (stream: 'stdout' | 'stderr', text: string): void => {
      const batch = text.split(/\r?\n/u).filter(line => line !== '').map(line => ({
        at: request.now().toISOString(),
        level: stream === 'stderr' ? 'warn' : 'info',
        text: line,
      }))
      if (batch.length === 0) return
      for (let start = 0; start < batch.length; start += LOG_BATCH_LINES) {
        pending.push(request.onLines(stream, batch.slice(start, start + LOG_BATCH_LINES)))
      }
    }

    const buffers = { stdout: '', stderr: '' }
    for (const stream of ['stdout', 'stderr'] as const) {
      pipes[stream].setEncoding('utf8')
      pipes[stream].on('data', (chunk: string) => {
        const text = buffers[stream] + chunk
        const cut = text.lastIndexOf('\n')
        if (cut === -1) {
          buffers[stream] = text
          return
        }
        buffers[stream] = text.slice(cut + 1)
        flush(stream, text.slice(0, cut + 1))
      })
    }

    const stop = (): void => {
      stopped = true
      stopRun(child, request.stopGraceMs)
    }
    if (request.signal.aborted) stop()
    else request.signal.addEventListener('abort', stop, { once: true })

    // The first settlement wins: resolving after the promise settled changes nothing,
    // so a close that follows a failed start needs no guard of its own.
    child.on('error', (error: Error) => {
      resolve({ kind: 'exited', code: null, spawnError: error })
    })
    child.on('close', (code: number | null) => {
      for (const stream of ['stdout', 'stderr'] as const) flush(stream, buffers[stream])
      void Promise.all(pending).then(() => {
        resolve({ kind: stopped ? 'stopped' : 'exited', code })
      }, reject)
    })
  })
}

/**
 * The summary one finished run reports. A run that ended without an exit code was
 * killed by something other than the node, which is worth saying rather than showing
 * an absent code.
 * @param code - the exit code, or undefined when the run ended without one.
 * @param lastStderr - the last line the run wrote to stderr, with its separator.
 * @returns the summary.
 */
export function runFailureSummary(code: number | null | undefined, lastStderr: string): string {
  const shown = code === undefined || code === null ? 'without an exit code' : `with code ${String(code)}`
  return `the run exited ${shown}${lastStderr}`
}

/**
 * Write what the run printed beside the node's logs.
 * @param path - the log file.
 * @param lines - everything the run printed.
 * @param outcome - how the run settled.
 */
function writeRawLog(path: string, lines: RunLine[], outcome: RunOutcome): void {
  const header = `# ${path}\n# ended: ${outcome.kind} with code ${String(exitCodeOf(outcome))}`
  const body = lines.map(entry => `${entry.line.at} [${entry.stream}] ${entry.line.text}`).join('\n')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${header}\n${body}\n`, 'utf8')
}

/**
 * The last line one stream printed, as a summary suffix.
 * @param lines - everything the run printed.
 * @param stream - the stream to read.
 * @returns the suffix, empty when the stream printed nothing.
 */
function lastLine(lines: RunLine[], stream: 'stdout' | 'stderr'): string {
  const found = [...lines].reverse().find(entry => entry.stream === stream)
  return found === undefined ? '' : `: ${found.line.text}`
}
