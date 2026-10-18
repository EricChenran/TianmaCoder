/**
 * What the chat runner does with one answer task: it asks the CLI the question in
 * a throwaway directory, reports what the run printed, and settles the answer as
 * the result summary. The child these specs run is a real Node process, so the
 * launch, the pipes, and the scratch directory's cleanup are the ones a node gets.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatAnswerRunner } from '@tianma/dsh-mps-executor/src/chat-runner.ts'
import type { TaskRunContext } from '@tianma/dsh-mps-executor'

/** Roots this suite made, removed after each test. */
const scratch: string[] = []

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A script that stands in for the headless CLI: it prints its prompt's last line
 * as the answer and exits.
 * @returns the script's path.
 */
function answerStub(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mps-chat-runner-'))
  scratch.push(directory)
  const path = join(directory, 'answer.mjs')
  writeFileSync(path, [
    'const prompt = process.argv[2] ?? ""',
    "console.log(prompt.split('\\n').at(-1))",
    '',
  ].join('\n'))
  return path
}

/**
 * The run context one answer task carries.
 * @param payload - the task payload.
 * @param kind - the work kind.
 * @returns the context, with its reporting channels recorded.
 */
function contextOf(payload: Record<string, unknown>, kind = 'chat_answer'): TaskRunContext {
  return {
    task: {
      task_id: 'tsk_9',
      work_item_id: 'wi_9',
      attempt: 1,
      max_attempts: 1,
      kind,
      priority: 800,
      lease_expire_at: '2026-10-17T08:00:00.000Z',
      lease_renew_seconds: 30,
      payload,
    },
    workspaceDirectory: undefined,
    checkout: undefined,
    // An answer task must never reach for the delivery channels; the throws keep
    // this suite honest about that.
    publish: () => { throw new Error('an answer task publishes nothing') },
    uploadArtifact: () => { throw new Error('an answer task uploads nothing') },
    resource: () => { throw new Error('an answer task downloads nothing') },
    reportSession: () => { throw new Error('an answer task reports no session') },
    signal: new AbortController().signal,
    reportProgress: async () => {},
    reportLog: async () => {},
  }
}

/** One logs directory the raw log lands in. */
function logsDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mps-chat-logs-'))
  scratch.push(directory)
  return directory
}

describe('chat answer runner', () => {
  it('answers the question with the reply the run printed', async () => {
    const logs = logsDirectory()
    const runner = chatAnswerRunner({ command: [process.execPath, answerStub()], logsDirectory: logs })

    const result = await runner.run(contextOf({
      answer: { chat_id: 'wr1', message_id: 7, question: '现在项目里都有哪些任务在跑？', sender: '陈祖豪' },
    }))

    expect(result).toEqual({ outcome: 'success', summary: '问题是：现在项目里都有哪些任务在跑？' })
    // The raw log of the attempt is kept beside the node's logs.
    expect(readFileSync(join(logs, 'tsk_9-1.log'), 'utf8')).toContain('chat')
  })

  it('fails at once over a payload whose question it cannot read', async () => {
    const runner = chatAnswerRunner({ command: [process.execPath, answerStub()], logsDirectory: logsDirectory() })

    const result = await runner.run(contextOf({}))

    expect(result).toMatchObject({ outcome: 'failed', summary: /no readable question/u })
  })

  it('refuses a task that is not an answer task', async () => {
    const runner = chatAnswerRunner({ command: [process.execPath, answerStub()], logsDirectory: logsDirectory() })

    await expect(runner.run(contextOf({ spec: { raw_instruction: '写代码' } }, 'coding'))).rejects.toThrow(/chat tasks/u)
  })

  it('fails a run that exits without printing an answer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mps-chat-runner-'))
    scratch.push(directory)
    const silent = join(directory, 'silent.mjs')
    writeFileSync(silent, 'process.exit(3)\n')
    const runner = chatAnswerRunner({ command: [process.execPath, silent], logsDirectory: logsDirectory() })

    const result = await runner.run(contextOf({ answer: { chat_id: 'wr1', message_id: 7, question: 'hi' } }))

    expect(result).toMatchObject({ outcome: 'failed', summary: /code 3/u })
  })
})
