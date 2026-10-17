/**
 * The runner a chat-answer task executes with: the same headless CLI the coding
 * runner uses, asked one question, in a throwaway directory, with nothing to
 * publish. The platform broadcasts the result `summary` back into the group the
 * question came from, so the answer is the summary — no evidence, no artifacts,
 * no repository, and the node's own ceiling keeps the attempt inside the
 * platform's soft answer deadline.
 *
 * @module @tianma/dsh-mps-executor/chat-runner
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatAnswerOf, WORK_KIND_CHAT_ANSWER } from '@tianma/dsh-mps-exec-core'
import type { ExecLogLine } from '@tianma/dsh-mps-exec-core'
import { RUNNER_STOP_GRACE_MS, readRunEvent, runFailureSummary, runProcess, writeRawLog } from './cli-runner.ts'
import type { RunOutcome } from './cli-runner.ts'
import type { RunLine } from './cli-runner.ts'
import { toError } from './report.ts'
import type { TaskRunContext, TaskRunResult, TaskRunner } from './runner.ts'

/** How long the answer may be, in characters; the group it goes back to is a chat. */
const ANSWER_MAX_CHARS = 2_000

/** Options for {@link chatAnswerRunner}. */
export interface ChatRunnerOptions {
  /** The command and its leading arguments, the same one the coding runner uses. */
  command: readonly string[]
  /** Directory the runner keeps one raw log per attempt under. */
  logsDirectory: string
  /** Extra environment for the run; the node's own environment is inherited. */
  env?: Record<string, string> | undefined
  /** How long to wait after asking a run to stop; defaults to {@link RUNNER_STOP_GRACE_MS}. */
  stopGraceMs?: number | undefined
  /**
   * Whether the run is asked for its event stream (`--json`), whose `answer` event
   * carries the reply; without it the run's stdout is the reply.
   */
  jsonEvents?: boolean | undefined
  /** Current-time source; injectable for tests. */
  now?: (() => Date) | undefined
}

/**
 * Build the runner that answers a chat-answer task with the headless CLI.
 * @param options - the command to run, where its logs go, and its environment.
 * @returns the runner chat-answer attempts execute with.
 */
export function chatAnswerRunner(options: ChatRunnerOptions): TaskRunner {
  const bin = options.command[0]
  if (bin === undefined || bin === '') {
    throw new Error('the chat runner needs the command it starts, such as dsh --profile headless')
  }
  const prefix = options.command.slice(1)
  const stopGraceMs = options.stopGraceMs ?? RUNNER_STOP_GRACE_MS
  const now = options.now ?? (() => new Date())
  const jsonEvents = options.jsonEvents === true

  return {
    async run(context: TaskRunContext): Promise<TaskRunResult> {
      const task = context.task
      if (task.kind !== WORK_KIND_CHAT_ANSWER) {
        throw new Error(`the chat runner answers ${WORK_KIND_CHAT_ANSWER} tasks, not ${JSON.stringify(task.kind)}`)
      }
      const answer = chatAnswerOf(task.payload)
      if (answer === undefined) {
        // The platform's own answerer takes over on `failed`, so a payload this node
        // cannot read is reported at once rather than parked.
        return { outcome: 'failed', summary: 'the answer payload states no readable question' }
      }
      const lines: RunLine[] = []
      let reply: string | undefined
      // A scratch directory of its own: an answer task owns no workspace, and the
      // CLI needs somewhere to stand.
      const directory = mkdtempSync(join(tmpdir(), 'mps-answer-'))
      try {
        await context.reportProgress({ progress: 10, stage: 'coding', message: 'answering the question' })
        await context.reportLog('runner', [{
          at: now().toISOString(),
          level: 'info',
          text: `answering message ${String(answer.message_id)} from ${answer.sender ?? 'the customer'}`,
        }])
        const outcome = await runProcess({
          bin,
          args: [...prefix, ...(jsonEvents ? ['--json'] : []), answerPrompt(answer)],
          directory,
          env: options.env,
          signal: context.signal,
          stopGraceMs,
          now,
          onLines: async (stream, batch) => {
            const reported: ExecLogLine[] = []
            for (const line of batch) {
              const event = jsonEvents && stream === 'stdout' ? readRunEvent(line.text) : undefined
              if (event === undefined) {
                reported.push(line)
                continue
              }
              if (event.answer !== undefined) reply = event.answer
              reported.push({ ...line, text: event.text })
            }
            lines.push(...reported.map(line => ({ stream, line })))
            await context.reportLog(stream, reported)
          },
        })
        writeRawLog(
          join(options.logsDirectory, `${task.task_id}-${String(task.attempt)}.log`),
          lines,
          outcome,
        )
        return settled(outcome, reply, lines, bin)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Turn one finished run into the result the platform reads.
 * @param outcome - how the run settled.
 * @param reply - the answer the event stream carried, when it carried one.
 * @param lines - what the run printed.
 * @param bin - the executable the run was given.
 * @returns the result to submit.
 */
function settled(outcome: RunOutcome, reply: string | undefined, lines: readonly RunLine[], bin: string): TaskRunResult {
  if (outcome.spawnError !== undefined) {
    throw new Error(`could not start ${bin}: ${toError(outcome.spawnError).message}`)
  }
  if (outcome.kind === 'stopped') {
    return { outcome: 'failed', summary: 'the node stopped this run' }
  }
  // Without the event stream the reply is what the run printed, which is what the
  // headless profile's final answer is; an empty one is a failure either way.
  const text = (reply ?? lines.filter(entry => entry.stream === 'stdout').map(entry => entry.line.text).join('\n')).trim()
  if (outcome.code !== 0) {
    return { outcome: 'failed', summary: runFailureSummary(outcome.code, lastStderr(lines)) }
  }
  if (text === '') {
    return { outcome: 'failed', summary: 'the run finished without printing an answer' }
  }
  return { outcome: 'success', summary: text.slice(0, ANSWER_MAX_CHARS) }
}

/**
 * The prompt one answer task runs with.
 * @param answer - the question the platform dispatched.
 * @returns the prompt, as one argument the CLI receives whole.
 */
function answerPrompt(answer: { question: string; sender?: string | undefined }): string {
  const who = answer.sender === undefined ? '客户' : `客户 ${answer.sender}`
  return [
    `你是企业微信客户群的助手。${who}在群里提了一个问题，你的回答会被原样播报回群里。`,
    '要求：直接给出回答；口语、简洁（通常不超过两百字）；可以查看本机可见的信息来核实，但不要执行任何写操作、不要修改任何文件。',
    `问题是：${answer.question}`,
  ].join('\n')
}

/**
 * The last line a run wrote to stderr, as a failure-summary suffix.
 * @param lines - what the run printed.
 * @returns the line with its separator, or nothing.
 */
function lastStderr(lines: readonly RunLine[]): string {
  const last = [...lines].reverse().find(entry => entry.stream === 'stderr')
  return last === undefined ? '' : `: ${last.line.text}`
}
