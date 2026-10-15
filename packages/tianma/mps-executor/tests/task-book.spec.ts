/**
 * The task book: what one attempt's agent is told, and how the node keeps its own
 * input out of the change it commits.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { TASK_BOOK_FILE, TASK_BOOK_POINTER, taskBook, writeTaskBook } from '@tianma/dsh-mps-executor'
import type { ExecTaskAssignment } from '@tianma/dsh-mps-exec-core'

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

/**
 * One assignment as the platform dispatches it.
 * @param payload - the payload to carry.
 * @returns the assignment.
 */
function assignment(payload: Record<string, unknown>): ExecTaskAssignment {
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

/** A payload stating everything the book can render. */
const FULL: Record<string, unknown> = {
  limits: { max_runtime_seconds: 3600 },
  spec: { raw_instruction: '增加批量下载', source_message_id: 'msg_9' },
  workspace: {
    workspace_id: 'ws_1',
    chat_name: '订单系统需求群',
    access_mode: 'read_write',
    repo: {
      url: 'https://example.invalid/orders.git',
      base_branch: 'main',
      base_commit: 'a1b2c3d',
      work_branch: 'feature/tsk_1',
    },
  },
  constraints: {
    must_stay_in_workspace: true,
    forbidden_paths: ['src/secrets', 'deploy/'],
    branch_pattern: '^feature/.+',
    deadline: '2026-10-16T18:00:00+08:00',
  },
  deliverables: {
    push_required: true,
    build_command: 'npm run build',
    e2e_command: 'npm run test:e2e',
    report_filename: 'REPORT.md',
    min_screenshots: 2,
  },
  context: {
    rules_version: 'rules/v12',
    rules_inline: ['改动只允许落在本工作区内', '不改动 .git 与构建产物'],
    resources: ['art_ctx'],
    chat_transcript: {
      window_from: '2026-10-14T09:00:00.000+08:00',
      truncated: true,
      messages: [
        {
          at: '2026-10-14T09:05:00.000+08:00',
          sender: '张三',
          text: '需要一个批量下载功能',
          resources: [{ artifact_id: 'art_pdf', kind: 'parsed', file_name: '需求说明.pdf' }],
        },
        {
          at: '2026-10-14T09:20:00.000+08:00',
          sender: '李四',
          text: '[合并转发] 2 条消息',
          expanded: [{ at: '2026-10-14T09:18:00.000+08:00', sender: '王五', text: '顺带支持筛选' }],
        },
      ],
    },
    recent_tasks: [
      { task_id: 'tsk_0', title: '交付物列表分页', outcome: 'success', summary: '已上线' },
    ],
  },
}

describe('the task book', () => {
  it('states what the payload says, in the order an agent needs it', () => {
    const book = taskBook(assignment(FULL))

    expect(book).toContain('# 任务书 tsk_1（第 2/3 次尝试）')
    expect(book).toContain('## 需求\n\n增加批量下载')
    expect(book).toContain('## 工作区')
    expect(book).toContain('- 工作区：ws_1（群：订单系统需求群）')
    expect(book).toContain('- 仓库：https://example.invalid/orders.git')
    expect(book).toContain('- 工作分支：feature/tsk_1')
    expect(book).toContain('- 访问模式：read_write')
    expect(book).toContain('## 约束')
    expect(book).toContain('- 改动必须落在本工作区内，不得写到工作区之外')
    expect(book).toContain('- 禁止改动：src/secrets、deploy/')
    expect(book).toContain('- 工作分支名需匹配：^feature/.+')
    expect(book).toContain('- 截止时间：2026-10-16T18:00:00+08:00')
    expect(book).toContain('- 本次运行上限：3600 秒')
    expect(book).toContain('## 交付要求')
    expect(book).toContain('- 改动必须提交并推送：是')
    expect(book).toContain('- 构建命令：npm run build')
    expect(book).toContain('- E2E 命令：npm run test:e2e')
    expect(book).toContain('- 报告文件名：REPORT.md')
    expect(book).toContain('- 至少 2 张截图：写入 .evidence/screenshots/，并在 .evidence/screenshots.json 里逐张声明')
    expect(book).toContain('## 材料\n\n- art_ctx\n- art_pdf')
    expect(book).toContain('## 聊天记录')
    expect(book).toContain('- 起于：2026-10-14T09:00:00.000+08:00')
    expect(book).toContain('- 已截断：更早的消息未包含')
    expect(book).toContain('- [2026-10-14T09:05:00.000+08:00] 张三：需要一个批量下载功能')
    expect(book).toContain('  - 附件：需求说明.pdf（art_pdf）')
    expect(book).toContain('  - [2026-10-14T09:18:00.000+08:00] 王五：顺带支持筛选')
    expect(book).toContain('## 最近完成的任务\n\n- tsk_0（交付物列表分页）：success —— 已上线')
    expect(book).toContain('## 规则（rules/v12）')
    expect(book).toContain('- 改动只允许落在本工作区内')
    expect(book.endsWith('\n')).toBe(true)
  })

  it('names the file each material was written to', () => {
    const book = taskBook(assignment(FULL), [
      { artifact_id: 'art_ctx', path: '.materials/art_ctx', sha256: 's1' },
      { artifact_id: 'art_pdf', file_name: '需求说明.pdf', path: '.materials/art_pdf_需求说明.pdf', sha256: 's2' },
    ])

    expect(book).toContain('- .materials/art_ctx（art_ctx）')
    expect(book).toContain('- .materials/art_pdf_需求说明.pdf（art_pdf）')
  })

  it('leaves out every section the payload says nothing about', () => {
    const book = taskBook(assignment({ spec: { raw_instruction: '只做这一件事' } }))

    expect(book).toContain('## 需求\n\n只做这一件事')
    expect(book).not.toContain('## 工作区')
    expect(book).not.toContain('## 约束')
    // Delivery is the one thing the node always knows: it commits or it does not.
    expect(book).toContain('- 改动必须提交并推送：否')
    expect(book).not.toContain('## 材料')
    expect(book).not.toContain('## 聊天记录')
  })

  it('renders a payload that states the other half of each fact', () => {
    const book = taskBook(assignment({
      spec: { raw_instruction: '继续' },
      workspace: { workspace_id: 'ws_2', chat_name: 7, repo: { url: 'https://example.invalid/a.git' } },
      deliverables: { min_screenshots: '2' },
      context: {
        chat_transcript: {
          messages: [
            { sender: '甲' },
            { text: '只有文本', resources: [{ kind: 'parsed' }, { file_name: '无编号.png' }] },
          ],
        },
        recent_tasks: [{ task_id: 'tsk_9' }],
      },
    }))

    expect(book).toContain('- 工作区：ws_2')
    expect(book).not.toContain('群：')
    expect(book).toContain('- 仓库：https://example.invalid/a.git')
    expect(book).not.toContain('- 基线分支：')
    expect(book).not.toContain('- 工作分支：')
    expect(book).toContain('- [] 甲：')
    expect(book).toContain('- [] ：只有文本')
    expect(book).toContain('  - 附件：无编号.png')
    expect(book).not.toContain('至少')
    expect(book).toContain('## 最近完成的任务\n\n- tsk_9（）：')
    expect(book).toContain('## 聊天记录')
  })

  it('reads nothing out of a payload whose blocks are not the shapes it expects', () => {
    const book = taskBook(assignment({
      spec: { raw_instruction: '还是做这个' },
      workspace: [],
      constraints: { forbidden_paths: 'src/secrets', branch_pattern: '' },
      deliverables: 'none',
      context: { rules_inline: '一条规则', chat_transcript: { messages: '无', recent_tasks: '无' } },
    }))

    expect(book).toContain('## 需求\n\n还是做这个')
    expect(book).not.toContain('## 工作区')
    expect(book).not.toContain('## 约束')
    expect(book).not.toContain('## 聊天记录')
    expect(book).not.toContain('## 最近完成的任务')
    expect(book).not.toContain('## 规则')
    expect(book).toContain('- 改动必须提交并推送：否')
  })

  it('states no requirement when the payload carries no instruction', () => {
    const book = taskBook(assignment({}))

    expect(book).toBe('# 任务书 tsk_1（第 2/3 次尝试）\n\n## 交付要求\n\n- 改动必须提交并推送：否\n')
  })

  it('reads a task the workspace finished with only what it states', () => {
    const book = taskBook(assignment({
      spec: { raw_instruction: '继续' },
      context: { recent_tasks: [{ summary: '只留下总结' }] },
    }))

    expect(book).toContain('- （）： —— 只留下总结')
  })

  it('writes the book into the workspace and keeps it out of the repository', () => {
    const workspace = temporary('mps-book-')
    mkdirSync(join(workspace, '.git', 'info'), { recursive: true })
    writeFileSync(join(workspace, '.git', 'info', 'exclude'), '# local excludes\n', 'utf8')

    const path = writeTaskBook({ directory: workspace, assignment: assignment(FULL) })

    expect(path).toBe(join(workspace, TASK_BOOK_FILE))
    expect(readFileSync(path, 'utf8')).toContain('增加批量下载')
    const exclude = readFileSync(join(workspace, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toBe(`# local excludes\n${TASK_BOOK_FILE}\n`)


    // A second attempt rewrites the book and does not repeat the exclude.
    writeTaskBook({ directory: workspace, assignment: assignment({ spec: { raw_instruction: '再来一次' } }) })
    expect(readFileSync(path, 'utf8')).toContain('再来一次')
    expect(readFileSync(join(workspace, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude)

    // An exclude file that does not end in a newline gains one before the entry.
    writeFileSync(join(workspace, '.git', 'info', 'exclude'), '# no trailing newline', 'utf8')
    writeTaskBook({ directory: workspace, assignment: assignment(FULL) })
    expect(readFileSync(join(workspace, '.git', 'info', 'exclude'), 'utf8'))
      .toBe(`# no trailing newline\n${TASK_BOOK_FILE}\n`)
  })

  it('needs no exclude when the workspace is not a repository', () => {
    const workspace = temporary('mps-book-')

    const path = writeTaskBook({ directory: workspace, assignment: assignment(FULL) })

    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(workspace, '.git'))).toBe(false)
  })

  it('points the prompt at the book it wrote', () => {
    expect(TASK_BOOK_POINTER).toContain(TASK_BOOK_FILE)
  })
})
