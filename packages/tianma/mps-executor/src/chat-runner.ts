/**
 * The runner a chat-answer task executes with: the same headless CLI the coding
 * runner uses, asked one question, with nothing to publish. The platform
 * broadcasts the result `summary` back into the group the question came from, so
 * the answer is the summary.
 *
 * Where the attempt works follows the platform's contract, in priority order: the
 * session a previous task of the same workspace left (continued in the project
 * area it was reported with), the workspace's own project-area directory (shallow
 * clone on first sight, incremental fetch after that — never a fresh clone per
 * question), and only a workspace the payload binds to neither falls back to a
 * scratch directory, which the result notes state. The payload's repository and
 * last delivery are part of the prompt, so a question about the code is answered
 * from the code and "the thing you just delivered" resolves to the delivery the
 * platform stated.
 * @module @tianma/dsh-mps-executor/chat-runner
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatAnswerOf,
  isChatAnswerTask,
  taskRepository,
  taskSessionHint,
  taskWorkspaceId,
} from '@tianma/dsh-mps-exec-core'
import type { ExecLogLine, TaskRepository } from '@tianma/dsh-mps-exec-core'
import {
  RUNNER_STOP_GRACE_MS,
  readRunEvent,
  runFailureSummary,
  runProcess,
  sessionAdoptionFailure,
  writeRawLog,
} from './cli-runner.ts'
import type { RunOutcome, RunLine } from './cli-runner.ts'
import { toError } from './report.ts'
import { writeAgentPatch } from './agent-patch.ts'
import type { GitRunner } from './git.ts'
import type { TaskRunContext, TaskRunResult, TaskRunner } from './runner.ts'
import type { WorkspaceStore } from './workspace.ts'

/** How long the answer may be, in characters; the group it goes back to is a chat. */
const ANSWER_MAX_CHARS = 2_000

/** How much of a repository failure's reason the answer carries, in characters. */
const REPO_FAILURE_MAX_CHARS = 200

/** Options for {@link chatAnswerRunner}. */
export interface ChatRunnerOptions {
  /** The command and its leading arguments, the same one the coding runner uses. */
  command: readonly string[]
  /** Directory the runner keeps one raw log per attempt under. */
  logsDirectory: string
  /**
   * The workspaces the node keeps, which is where the project-area directory of a bound
   * workspace lives and where the answer attempt's use of it is recorded.
   */
  store: WorkspaceStore
  /** git on this host, for the shallow clone and the incremental fetch. */
  git: GitRunner
  /** Extra environment for the run; the node's own environment is inherited. */
  env?: Record<string, string> | undefined
  /** How long to wait after asking a run to stop; defaults to {@link RUNNER_STOP_GRACE_MS}. */
  stopGraceMs?: number | undefined
  /**
   * Whether the run is asked for its event stream (`--json`), whose `answer` event
   * carries the reply; without it the run's stdout is the reply.
   */
  jsonEvents?: boolean | undefined
  /**
   * Overlay the deployment's model choice resolves to, passed as `--patch` before the
   * prompt so an answer runs on the same model the node's coding tasks do. Absent when
   * the deployment states nothing.
   */
  agentPatch?: string | undefined
  /** Current-time source; injectable for tests. */
  now?: (() => Date) | undefined
}

/**
 * Build the runner that answers a chat-answer task with the headless CLI.
 * @param options - the command to run, where its logs go, the workspace store and git it
 * resolves project-area directories with, and its environment.
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
  const patchPath = options.agentPatch === undefined
    ? undefined
    : writeAgentPatch(options.logsDirectory, options.agentPatch)

  return {
    async run(context: TaskRunContext): Promise<TaskRunResult> {
      const task = context.task
      if (!isChatAnswerTask(task)) {
        throw new Error(`the chat runner answers chat tasks, not ${JSON.stringify(task.kind)}`)
      }
      const answer = chatAnswerOf(task.payload)
      if (answer === undefined) {
        // The platform's own answerer takes over on `failed`, so a payload this node
        // cannot read is reported at once rather than parked.
        return { outcome: 'failed', summary: 'the answer payload states no readable question' }
      }
      // Where this attempt works, by the contract's priority: the session a previous
      // task left, the workspace's project-area repository, a scratch directory.
      const hint = taskSessionHint(task.payload)
      const repository = taskRepository(task.payload)
      const repoUrl = repository?.url
      const workspaceId = taskWorkspaceId(task.payload)
      const notes: string[] = []
      let scratch = false
      let session: string | undefined
      let repoFailure: string | undefined
      let directory: string
      if (hint !== undefined && workspaceId !== undefined) {
        session = hint
        directory = await options.store.ensure(workspaceId, task.task_id)
      } else if (repoUrl !== undefined && workspaceId !== undefined) {
        directory = await options.store.ensure(workspaceId, task.task_id)
        repoFailure = await syncAnswerRepository(options.git, directory, {
          url: repoUrl,
          base_branch: repository?.base_branch,
        })
      } else {
        // A workspace bound to neither a session nor a repository is the one case the
        // contract allows a scratch directory for, and the note is what tells the
        // platform how often that happens.
        directory = mkdtempSync(join(tmpdir(), 'mps-answer-'))
        scratch = true
      }
      const lines: RunLine[] = []
      let reply: string | undefined
      try {
        await context.reportProgress({ progress: 10, stage: 'coding', message: 'answering the question' })
        await context.reportLog('runner', [{
          at: now().toISOString(),
          level: 'info',
          text: `answering message ${String(answer.message_id)} from ${answer.sender ?? 'the customer'} in ${directory}`,
        }])
        const attempt = async (withSession: boolean): Promise<RunOutcome> => await runProcess({
          bin,
          args: [
            ...prefix,
            ...(patchPath === undefined ? [] : ['--patch', patchPath]),
            ...(jsonEvents ? ['--json'] : []),
            ...(withSession && session !== undefined ? ['--session-id', session] : []),
            answerPrompt(answer, {
              directory,
              projectArea: !scratch,
              repository,
              repoFailure,
              lastDelivery: lastDeliveryOf(task.payload),
            }),
          ],
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
        let outcome = await attempt(true)
        if (session !== undefined) {
          const adoption = sessionAdoptionFailure(outcome, lines)
          if (adoption !== undefined) {
            // The session the hint named cannot be continued; the contract's next level is
            // the project-area repository, which this attempt now syncs before trying again.
            notes.push(`session_unusable:${adoption}`)
            await context.reportLog('runner', [{
              at: now().toISOString(),
              level: 'warn',
              text: `session ${session} cannot be continued (${adoption}); answering without it`,
            }])
            if (repoUrl !== undefined) {
              repoFailure = await syncAnswerRepository(options.git, directory, {
                url: repoUrl,
                base_branch: repository?.base_branch,
              })
            }
            session = undefined
            outcome = await attempt(false)
          }
        }
        writeRawLog(
          join(options.logsDirectory, `${task.task_id}-${String(task.attempt)}.log`),
          lines,
          outcome,
        )
        if (scratch) notes.push('scratch_dir:true')
        return {
          ...settled(outcome, reply, lines, bin, repoFailure),
          ...(notes.length === 0 ? {} : { notes: notes.join('\n') }),
        }
      } finally {
        if (scratch) rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Bring the workspace's project-area directory to the state an answer reads: a shallow
 * clone of the bound repository the first time the node sees it, and an incremental
 * fetch with the base branch checked out at its latest after that — never a fresh clone
 * per question. The answer never writes, so a tree that holds someone's changes is left
 * exactly as it is and answered from.
 * @param git - git on this host.
 * @param directory - the workspace's project-area directory.
 * @param repository - the repository the payload bound the workspace to.
 * @returns why the repository could not be brought in, or undefined when it was.
 */
async function syncAnswerRepository(
  git: GitRunner,
  directory: string,
  repository: { url: string; base_branch?: string | undefined },
): Promise<string | undefined> {
  try {
    if (!existsSync(join(directory, '.git'))) {
      await git.run(directory, [
        'clone', '--quiet', '--depth', '1',
        ...(repository.base_branch === undefined ? [] : ['--branch', repository.base_branch]),
        repository.url, '.',
      ])
      return undefined
    }
    const origin = await git.run(directory, ['remote', 'get-url', 'origin'])
    if (origin.stdout.trim() !== repository.url) {
      await git.run(directory, ['remote', 'set-url', 'origin', repository.url])
    }
    await git.run(directory, ['fetch', '--quiet', '--prune', 'origin'])
    if (repository.base_branch !== undefined) {
      const status = await git.run(directory, ['status', '--porcelain'])
      if (status.stdout.trim() !== '') return undefined
      await git.run(directory, ['checkout', '--quiet', '-B', repository.base_branch, `origin/${repository.base_branch}`])
    }
    return undefined
  } catch (error) {
    return toError(error).message
  }
}

/** The delivery the platform states as the workspace's most recent. */
interface LastDelivery {
  /** Task id, the anchor a customer's "the thing you just delivered" resolves to. */
  task_id: string
  title: string
  goal: string
  state: string
  branch: string
  /** Start of the development report, as the platform excerpted it. */
  report_excerpt: string
  /** Artifacts the delivery attached; their paths live on the platform, not here. */
  artifacts: { kind: string; file_name: string }[]
}

/**
 * Read the delivery the payload states as the workspace's most recent, which is what a
 * question about "the thing you just delivered" refers to.
 * @param payload - the payload a claim returned.
 * @returns the delivery, or undefined when the payload states none.
 */
function lastDeliveryOf(payload: Record<string, unknown>): LastDelivery | undefined {
  const context = payload['context']
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return undefined
  const stated = (context as Record<string, unknown>)['last_delivery']
  if (typeof stated !== 'object' || stated === null || Array.isArray(stated)) return undefined
  const record = stated as Record<string, unknown>
  const text = (name: string): string => (typeof record[name] === 'string' ? record[name] : '')
  const taskId = text('task_id')
  if (taskId === '') return undefined
  const artifacts = Array.isArray(record['artifacts'])
    ? (record['artifacts'] as unknown[]).flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
      const artifact = entry as Record<string, unknown>
      const fileName = artifact['file_name']
      if (typeof fileName !== 'string' || fileName === '') return []
      const kind = artifact['kind']
      return [{ kind: typeof kind === 'string' ? kind : '', file_name: fileName }]
    })
    : []
  return {
    task_id: taskId,
    title: text('title'),
    goal: text('goal'),
    state: text('state'),
    branch: text('branch'),
    report_excerpt: text('report_excerpt'),
    artifacts,
  }
}

/**
 * Turn one finished run into the result the platform reads.
 * @param outcome - how the run settled.
 * @param reply - the answer the event stream carried, when it carried one.
 * @param lines - what the run printed.
 * @param bin - the executable the run was given.
 * @param repoFailure - why a bound repository could not be reached, when it could not.
 * @returns the result to submit.
 */
function settled(
  outcome: RunOutcome,
  reply: string | undefined,
  lines: readonly RunLine[],
  bin: string,
  repoFailure: string | undefined,
): TaskRunResult {
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
  // A bound repository this attempt could not reach is stated in the answer itself: with
  // the address in the payload, claiming no repository is mounted here is the one defect
  // the contract names, so the honest state rides with the reply whatever it said.
  if (repoFailure === undefined) return { outcome: 'success', summary: text.slice(0, ANSWER_MAX_CHARS) }
  const reason = repoFailure.slice(0, REPO_FAILURE_MAX_CHARS)
  const note = `（本次未能访问该群绑定的仓库：${reason}）`
  return { outcome: 'success', summary: `${text.slice(0, ANSWER_MAX_CHARS - note.length)}${note}` }
}

/** What one answer attempt's prompt states beside the question. */
interface PromptFacts {
  /** Directory the run works in. */
  directory: string
  /** Whether that directory is the workspace's project area rather than a scratch one. */
  projectArea: boolean
  /** The repository the workspace is bound to, when it is bound to one. */
  repository?: TaskRepository | undefined
  /** Why that repository could not be brought in, when it could not. */
  repoFailure?: string | undefined
  /** The workspace's most recent delivery, when the platform stated one. */
  lastDelivery?: LastDelivery | undefined
}

/**
 * The prompt one answer task runs with.
 * @param answer - the question the platform dispatched.
 * @param facts - the payload context the answer draws on.
 * @returns the prompt, as one argument the CLI receives whole.
 */
function answerPrompt(answer: { question: string; sender?: string | undefined }, facts: PromptFacts): string {
  const who = answer.sender === undefined ? '客户' : `客户 ${answer.sender}`
  const lines: string[] = [
    `你是企业微信客户群的助手。${who}在群里提了一个问题，你的回答会被原样播报回群里。`,
    '要求：直接给出回答；口语、简洁（通常不超过两百字）；可以查看本机可见的信息来核实，但不要执行任何写操作：不修改任何文件、不提交、不推送、不建分支；不要安装依赖或执行构建；如需临时文件请写入系统临时目录，不要落在当前项目目录里。',
  ]
  if (facts.projectArea) {
    lines.push('当前工作目录是本群绑定工作区的项目区目录，可以直接查看其中的内容来回答问题。')
  }
  if (facts.repository?.url !== undefined) {
    lines.push(`本群绑定的代码仓库：${facts.repository.url}${facts.repository.base_branch === undefined ? '' : `（基线分支：${facts.repository.base_branch}）`}。被问"仓库地址是哪个"这类问题时，按这一地址回答。`)
  }
  if (facts.repoFailure !== undefined) {
    lines.push(`注意：本次同步该仓库失败：${facts.repoFailure.slice(0, REPO_FAILURE_MAX_CHARS)}。若问题涉及代码或仓库，请如实说明"仓库访问失败"及上述原因，不要声称本地没有挂载任何代码仓库。`)
  }
  const delivery = facts.lastDelivery
  if (delivery !== undefined) {
    const factsOfDelivery = [
      `任务 ${delivery.task_id}${delivery.title === '' ? '' : `《${delivery.title}》`}`,
      ...(delivery.goal === '' ? [] : [`目标：${delivery.goal}`]),
      ...(delivery.state === '' ? [] : [`状态：${delivery.state}`]),
      ...(delivery.branch === '' ? [] : [`分支：${delivery.branch}`]),
    ].join('，')
    lines.push(`本群最近一次交付（客户提到"刚交付的/这次的东西"等指代时，指它）：${factsOfDelivery}。`)
    if (delivery.report_excerpt !== '') lines.push(`它的开发报告摘录：\n${delivery.report_excerpt}`)
    if (delivery.artifacts.length > 0) {
      const named = delivery.artifacts.map(artifact => `${artifact.file_name}${artifact.kind === '' ? '' : `（${artifact.kind}）`}`).join('、')
      lines.push(`交付附带的产物（存于平台产物库，本机不可读取，仅列名称）：${named}。`)
    }
  }
  lines.push(`问题是：${answer.question}`)
  return lines.join('\n')
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
