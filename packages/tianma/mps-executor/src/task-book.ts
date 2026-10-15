/**
 * The task book: everything one attempt's agent needs, written where it works.
 *
 * The platform's payload is the node's input, not the agent's: an attempt gets one
 * instruction as its prompt and the rest — constraints, delivery requirements, the
 * materials, the chat it came from, and the rules — as a file in the workspace. The
 * file is excluded from the repository's own index, because everything else in the
 * workspace is what the node commits and hands back as the delivered change.
 * @module @tianma/dsh-mps-executor/task-book
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  taskInstruction,
  taskPolicy,
  taskRepository,
  taskRuntimeLimitMs,
  taskWorkspaceId,
} from '@tianma/dsh-mps-exec-core'
import type { ExecTaskAssignment, TaskRepository } from '@tianma/dsh-mps-exec-core'
import { SCREENSHOTS_DIRECTORY, SCREENSHOT_MANIFEST } from './evidence.ts'
import type { MaterialFile } from './materials.ts'
import { taskMaterials } from './materials.ts'
import { excludeFromRepository } from './paths.ts'

/** File name of the task book inside the coding workspace. */
export const TASK_BOOK_FILE = 'PROMPT.md'

/** What the prompt adds once the task book is written. */
export const TASK_BOOK_POINTER = '完整任务书见本目录 PROMPT.md：需求、约束、交付要求与材料清单都在那里。'

/** One chat message as the payload states it. */
interface ChatMessage {
  at: string
  sender: string
  text: string
  attachments: string[]
  expanded: ChatMessage[]
}

/** One task the workspace finished before this one. */
interface RecentTask {
  task_id: string
  title: string
  outcome: string
  summary: string
}

/** Everything the book renders, read from the payload in one place. */
interface BookFacts {
  instruction: string | undefined
  workspaceId: string | undefined
  chatName: string | undefined
  repository: TaskRepository | undefined
  accessMode: string | undefined
  forbiddenPaths: string[]
  mustStayInWorkspace: boolean
  branchPattern: string | undefined
  pushRequired: boolean
  deadline: string | undefined
  buildCommand: string | undefined
  e2eCommand: string | undefined
  reportFilename: string | undefined
  minScreenshots: number | undefined
  materials: string[]
  rulesVersion: string | undefined
  rules: string[]
  transcriptFrom: string | undefined
  transcriptTruncated: boolean | undefined
  messages: ChatMessage[]
  recentTasks: RecentTask[]
  runtimeSeconds: number | undefined
}

/**
 * Render the task book for one attempt.
 * @param assignment - the assignment a claim returned.
 * @returns the book as markdown.
 */
export function taskBook(assignment: ExecTaskAssignment, materials: MaterialFile[] = []): string {
  const facts = bookFacts(assignment)
  const lines: string[] = [
    `# 任务书 ${assignment.task_id}（第 ${String(assignment.attempt)}/${String(assignment.max_attempts)} 次尝试）`,
    '',
  ]
  section(lines, '需求', facts.instruction === undefined ? [] : [facts.instruction])
  section(lines, '工作区', workspaceLines(facts))
  section(lines, '约束', constraintLines(facts))
  section(lines, '交付要求', deliveryLines(facts))
  section(lines, '材料', materialLines(facts, materials))
  section(lines, '聊天记录', transcriptLines(facts))
  section(lines, '最近完成的任务', facts.recentTasks.map(task =>
    `- ${task.task_id}（${task.title}）：${task.outcome}${task.summary === '' ? '' : ` —— ${task.summary}`}`))
  section(lines, `规则${facts.rulesVersion === undefined ? '' : `（${facts.rulesVersion}）`}`, facts.rules.map(rule => `- ${rule}`))
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Write one attempt's task book into its workspace and keep it out of the repository.
 * @param options - the workspace directory, the assignment, and the materials already
 * brought in.
 * @returns the path of the file written.
 */
export function writeTaskBook(options: {
  directory: string
  assignment: ExecTaskAssignment
  materials?: MaterialFile[] | undefined
}): string {
  const path = join(options.directory, TASK_BOOK_FILE)
  writeFileSync(path, taskBook(options.assignment, options.materials), 'utf8')
  excludeFromRepository(options.directory, TASK_BOOK_FILE)
  return path
}

/**
 * One path as the book shows it: the book is read as text, so its paths read the same on
 * every host.
 * @param path - the path to render.
 * @returns the path with forward slashes.
 */
function slashes(path: string): string {
  return path.replace(/\\/gu, '/')
}

/**
 * Append one section, skipping the ones the payload states nothing for.
 * @param lines - the book so far.
 * @param title - the section heading.
 * @param body - the section's lines.
 */
function section(lines: string[], title: string, body: string[]): void {
  if (body.length === 0) return
  lines.push(`## ${title}`, '', ...body, '')
}

/**
 * The lines describing the workspace and its checkout.
 * @param facts - what the payload states.
 * @returns the lines.
 */
function workspaceLines(facts: BookFacts): string[] {
  const lines: string[] = []
  if (facts.workspaceId !== undefined) {
    lines.push(`- 工作区：${facts.workspaceId}${facts.chatName === undefined ? '' : `（群：${facts.chatName}）`}`)
  }
  const repository = facts.repository
  if (repository?.url !== undefined) lines.push(`- 仓库：${repository.url}`)
  if (repository?.base_branch !== undefined) lines.push(`- 基线分支：${repository.base_branch}`)
  if (repository?.base_commit !== undefined) lines.push(`- 基线提交：${repository.base_commit}`)
  if (repository?.work_branch !== undefined) lines.push(`- 工作分支：${repository.work_branch}`)
  if (facts.accessMode !== undefined) lines.push(`- 访问模式：${facts.accessMode}`)
  return lines
}

/**
 * The lines listing the materials, naming the file each was written to when the node
 * brought it in.
 * @param facts - what the payload states.
 * @param materials - the materials written, if any.
 * @returns the lines.
 */
function materialLines(facts: BookFacts, materials: MaterialFile[]): string[] {
  const written = new Map(materials.map(material => [material.artifact_id, material.path]))
  return facts.materials.map((id) => {
    const path = written.get(id)
    return path === undefined ? `- ${id}` : `- ${slashes(path)}（${id}）`
  })
}

/**
 * The lines describing what the attempt may not do.
 * @param facts - what the payload states.
 * @returns the lines.
 */
function constraintLines(facts: BookFacts): string[] {
  const lines: string[] = []
  if (facts.mustStayInWorkspace) lines.push('- 改动必须落在本工作区内，不得写到工作区之外')
  if (facts.forbiddenPaths.length > 0) lines.push(`- 禁止改动：${facts.forbiddenPaths.join('、')}`)
  if (facts.branchPattern !== undefined) lines.push(`- 工作分支名需匹配：${facts.branchPattern}`)
  if (facts.deadline !== undefined) lines.push(`- 截止时间：${facts.deadline}`)
  if (facts.runtimeSeconds !== undefined) lines.push(`- 本次运行上限：${String(facts.runtimeSeconds)} 秒`)
  return lines
}

/**
 * The lines describing what the attempt has to hand back.
 * @param facts - what the payload states.
 * @returns the lines.
 */
function deliveryLines(facts: BookFacts): string[] {
  const lines: string[] = []
  lines.push(`- 改动必须提交并推送：${facts.pushRequired ? '是' : '否'}`)
  if (facts.buildCommand !== undefined) lines.push(`- 构建命令：${facts.buildCommand}`)
  if (facts.e2eCommand !== undefined) lines.push(`- E2E 命令：${facts.e2eCommand}`)
  if (facts.reportFilename !== undefined) lines.push(`- 报告文件名：${facts.reportFilename}`)
  if (facts.minScreenshots !== undefined) {
    lines.push(
      `- 至少 ${String(facts.minScreenshots)} 张截图：写入 ${slashes(SCREENSHOTS_DIRECTORY)}/，并在 ${slashes(SCREENSHOT_MANIFEST)} 里逐张声明 file、route、caption、width、height`,
    )
  }
  return lines
}

/**
 * The lines rendering the chat the task came from.
 * @param facts - what the payload states.
 * @returns the lines.
 */
function transcriptLines(facts: BookFacts): string[] {
  const header: string[] = []
  if (facts.transcriptFrom !== undefined) header.push(`- 起于：${facts.transcriptFrom}`)
  if (facts.transcriptTruncated === true) header.push('- 已截断：更早的消息未包含')
  const messages = facts.messages.flatMap(message => messageLines(message, ''))
  return [...header, ...messages]
}

/**
 * One message and anything nested under it.
 * @param message - the message.
 * @param indent - the nesting prefix.
 * @returns the lines.
 */
function messageLines(message: ChatMessage, indent: string): string[] {
  const lines = [`${indent}- [${message.at}] ${message.sender}：${message.text}`]
  for (const attachment of message.attachments) lines.push(`${indent}  - 附件：${attachment}`)
  for (const nested of message.expanded) lines.push(...messageLines(nested, `${indent}  `))
  return lines
}

/**
 * Read everything the book renders out of the payload.
 * @param assignment - the assignment a claim returned.
 * @returns the facts.
 */
function bookFacts(assignment: ExecTaskAssignment): BookFacts {
  const payload = assignment.payload
  const policy = taskPolicy(payload)
  const repository = taskRepository(payload)
  const context = record(payload['context'])
  const transcript = record(context['chat_transcript'])
  const workspace = record(payload['workspace'])
  const deliverables = record(payload['deliverables'])
  const limits = taskRuntimeLimitMs(payload)
  return {
    instruction: taskInstruction(payload),
    workspaceId: taskWorkspaceId(payload),
    chatName: text(workspace['chat_name']),
    repository,
    accessMode: policy.access_mode,
    forbiddenPaths: [...(policy.forbidden_paths ?? [])],
    mustStayInWorkspace: policy.must_stay_in_workspace === true,
    branchPattern: policy.branch_pattern,
    pushRequired: policy.push_required === true,
    deadline: policy.deadline,
    buildCommand: text(deliverables['build_command']),
    e2eCommand: text(deliverables['e2e_command']),
    reportFilename: text(deliverables['report_filename']),
    minScreenshots: count(deliverables['min_screenshots']),
    materials: taskMaterials(payload),
    rulesVersion: text(context['rules_version']),
    rules: strings(context['rules_inline']),
    transcriptFrom: text(transcript['window_from']),
    transcriptTruncated: transcript['truncated'] === true,
    messages: list(transcript['messages']).map(readMessage),
    recentTasks: list(context['recent_tasks']).map(readRecentTask),
    runtimeSeconds: limits === undefined ? undefined : limits / 1000,
  }
}

/**
 * Read one chat message.
 * @param value - the message as the payload states it.
 * @returns the message.
 */
function readMessage(value: unknown): ChatMessage {
  const message = record(value)
  return {
    at: text(message['at']) ?? '',
    sender: text(message['sender']) ?? '',
    text: text(message['text']) ?? '',
    attachments: list(message['resources']).flatMap((attachment) => {
      const stated = record(attachment)
      const name = text(stated['file_name'])
      const id = text(stated['artifact_id'])
      return name === undefined ? [] : [`${name}${id === undefined ? '' : `（${id}）`}`]
    }),
    expanded: list(message['expanded']).map(readMessage),
  }
}

/**
 * Read one task the workspace finished earlier.
 * @param value - the task as the payload states it.
 * @returns the task.
 */
function readRecentTask(value: unknown): RecentTask {
  const task = record(value)
  return {
    task_id: text(task['task_id']) ?? '',
    title: text(task['title']) ?? '',
    outcome: text(task['outcome']) ?? '',
    summary: text(task['summary']) ?? '',
  }
}

/**
 * Read one value as a record.
 * @param value - the value.
 * @returns the record, or an empty one when the payload states nothing here.
 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Read one value as a non-empty string.
 * @param value - the value.
 * @returns the string, or undefined.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read one value as a list of non-empty strings.
 * @param value - the value.
 * @returns the strings.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/**
 * Read one value as a list.
 * @param value - the value.
 * @returns the list, or an empty one.
 */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Read one value as a positive count.
 * @param value - the value.
 * @returns the count, or undefined.
 */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
