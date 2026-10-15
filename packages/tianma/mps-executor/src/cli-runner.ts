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
import { toError } from './report.ts'
import type { ExecLogLine } from '@tianma/dsh-mps-exec-core'
import type { TaskRunContext, TaskRunResult, TaskRunner } from './runner.ts'
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

      if (outcome.spawnError !== undefined) {
        throw new Error(`could not start ${bin}: ${outcome.spawnError.message}`)
      }
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
      return {
        outcome: 'success',
        summary: `changed ${String(published.changed_files.length)} file(s)${published.pushed ? ' and pushed them' : ''}`,
        notes,
      }
    },
  }
}

/**
 * A run the node can stop.
 */
export interface StoppableRun {
  /**
   * Ask the run to end.
   * @param signal - the signal to send.
   * @returns whether the request was delivered.
   */
  kill(signal?: NodeJS.Signals | number): boolean
}

/**
 * Stop a run: ask it to end, then kill it if it has not ended within the grace
 * period. Windows has no signals, so the first request terminates the process there
 * either way; the escalation is what saves a run on a host that ignores it.
 * @param run - the run to stop.
 * @param graceMs - how long the run is given to end on its own.
 */
export function stopRun(run: StoppableRun, graceMs: number): void {
  run.kill()
  const timer = setTimeout(() => { run.kill('SIGKILL') }, graceMs)
  timer.unref()
}

/** What one run settled as. */
interface RunOutcome {
  /** Why the run ended. */
  kind: 'exited' | 'stopped'
  /** Exit code, or undefined when the node stopped the run. */
  code: number | undefined
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
      resolve({ kind: 'exited', code: undefined, spawnError: error })
    })
    child.on('close', (code: number | null) => {
      for (const stream of ['stdout', 'stderr'] as const) flush(stream, buffers[stream])
      void Promise.all(pending).then(() => {
        resolve({ kind: stopped ? 'stopped' : 'exited', code: code ?? undefined })
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
export function runFailureSummary(code: number | undefined, lastStderr: string): string {
  const shown = code === undefined ? 'without an exit code' : `with code ${String(code)}`
  return `the run exited ${shown}${lastStderr}`
}

/**
 * Write what the run printed beside the node's logs.
 * @param path - the log file.
 * @param lines - everything the run printed.
 * @param outcome - how the run settled.
 */
function writeRawLog(path: string, lines: RunLine[], outcome: RunOutcome): void {
  const header = `# ${path}\n# ended: ${outcome.kind}${outcome.code === undefined ? '' : ` with code ${String(outcome.code)}`}`
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
