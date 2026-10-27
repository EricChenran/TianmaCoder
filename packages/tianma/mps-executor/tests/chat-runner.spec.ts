/**
 * What the chat runner does with one answer task: it asks the CLI the question in the
 * directory the platform's contract resolves — the session a previous task left, the
 * workspace's project-area repository, or a scratch directory the result notes — and
 * settles the answer as the result summary, stating a repository it could not reach
 * rather than claiming none is mounted. The child these specs run is a real Node
 * process, so the launch, the pipes, and the scratch directory's cleanup are the ones
 * a node gets; the clone and fetch specs run the machine's real git.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatAnswerRunner } from '@tianma/dsh-mps-executor/src/chat-runner.ts'
import { WorkspaceStore, cliGit } from '@tianma/dsh-mps-executor'
import type { GitRunner, TaskRunContext, TaskRunner } from '@tianma/dsh-mps-executor'

/** Roots this suite made, removed after each test. */
const scratch: string[] = []

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * The workspace store one test resolves project-area directories with.
 * @returns the store, over its own root.
 */
function storeOf(): WorkspaceStore {
  const root = mkdtempSync(join(tmpdir(), 'mps-chat-store-'))
  scratch.push(root)
  return new WorkspaceStore({ root })
}

/** The git commands one fake runner recorded. */
function fakeGit(): { git: GitRunner; commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    git: {
      async run(_directory: string, args: readonly string[]) {
        commands.push(args.join(' '))
        return { stdout: '', stderr: '' }
      },
    },
  }
}

/**
 * A real local repository a workspace binds to, with one commit on `main`.
 * @returns the repository's path.
 */
async function sourceRepository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'mps-chat-source-'))
  scratch.push(directory)
  const git = cliGit()
  await git.run(directory, ['init', '--quiet', '-b', 'main'])
  writeFileSync(join(directory, 'README.md'), '# one\n', 'utf8')
  await git.run(directory, ['config', 'user.email', 'test@localhost'])
  await git.run(directory, ['config', 'user.name', 'test'])
  await git.run(directory, ['add', '.'])
  await git.run(directory, ['commit', '--quiet', '-m', 'one'])
  return directory
}

/**
 * A script that stands in for the headless CLI.
 * @param body - the script's statements; `prompt` holds the prompt and `argv` the arguments.
 * @returns the script's path.
 */
function cliStub(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'mps-chat-runner-'))
  scratch.push(directory)
  const path = join(directory, 'answer.mjs')
  writeFileSync(path, `const argv = process.argv.slice(2)\nconst prompt = argv.at(-1) ?? ""\n${body}\n`, 'utf8')
  return path
}

/**
 * A script that prints its prompt's last line as the answer, the way the headless
 * profile's final line reads.
 * @returns the script's path.
 */
function answerStub(): string {
  return cliStub("console.log(prompt.split('\\n').at(-1))")
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

/**
 * The runner one test builds: a scratch store and a fake git, unless the test brings
 * its own.
 * @param bin - the stub CLI's path.
 * @param overrides - the store or git the test states.
 * @returns the runner.
 */
function runnerOf(
  bin: string,
  overrides: { store?: WorkspaceStore | undefined; git?: GitRunner | undefined } = {},
): TaskRunner {
  return chatAnswerRunner({
    command: [process.execPath, bin],
    logsDirectory: logsDirectory(),
    store: overrides.store ?? storeOf(),
    git: overrides.git ?? fakeGit().git,
  })
}

describe('chat answer runner', () => {
  it('answers the question with the reply the run printed, noting its scratch directory', async () => {
    const logs = logsDirectory()
    const runner = chatAnswerRunner({
      command: [process.execPath, answerStub()],
      logsDirectory: logs,
      store: storeOf(),
      git: fakeGit().git,
    })

    const result = await runner.run(contextOf({
      answer: { chat_id: 'wr1', message_id: 7, question: '现在项目里都有哪些任务在跑？', sender: '陈祖豪' },
    }))

    expect(result).toMatchObject({ outcome: 'success', summary: '问题是：现在项目里都有哪些任务在跑？' })
    // A workspace bound to neither a session nor a repository is the one scratch case,
    // and the note is what tells the platform it happened.
    expect(result.notes).toBe('scratch_dir:true')
    // The raw log of the attempt is kept beside the node's logs.
    expect(readFileSync(join(logs, 'tsk_9-1.log'), 'utf8')).toContain('chat')
  })

  it('fails at once over a payload whose question it cannot read', async () => {
    const result = await runnerOf(answerStub()).run(contextOf({}))

    expect(result).toMatchObject({ outcome: 'failed', summary: /no readable question/u })
  })

  it('refuses a task that is not an answer task', async () => {
    await expect(runnerOf(answerStub()).run(contextOf({ spec: { raw_instruction: '写代码' } }, 'coding'))).rejects.toThrow(/chat tasks/u)
  })

  it('fails a run that exits without printing an answer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mps-chat-runner-'))
    scratch.push(directory)
    const silent = join(directory, 'silent.mjs')
    writeFileSync(silent, 'process.exit(3)\n')
    const result = await runnerOf(silent).run(contextOf({ answer: { chat_id: 'wr1', message_id: 7, question: 'hi' } }))

    expect(result).toMatchObject({ outcome: 'failed', summary: /code 3/u })
  })

  it('works in the project area of a bound workspace and reuses it across questions', async () => {
    const store = storeOf()
    const where = cliStub('console.log(process.cwd())')
    const url = await sourceRepository()
    const runner = chatAnswerRunner({
      command: [process.execPath, where],
      logsDirectory: logsDirectory(),
      store,
      git: cliGit(),
    })
    const payload = {
      workspace: { workspace_id: 'ws_1', repo: { url, base_branch: 'main' } },
      answer: { chat_id: 'wr1', message_id: 7, question: '第一个问题' },
    }

    const first = await runner.run(contextOf(payload))
    const second = await runner.run(contextOf({
      ...payload,
      answer: { chat_id: 'wr1', message_id: 8, question: '第二个问题' },
    }))

    // The attempt stands in the workspace's own directory under the coding root, and
    // the second question finds it there: no fresh directory, no fresh clone.
    expect(first.summary).toContain(join(store.root, 'ws_1'))
    expect(second.summary).toBe(first.summary)
    expect(existsSync(join(store.root, 'ws_1', '.git'))).toBe(true)
  })

  it('continues the session the hint names, without touching the repository', async () => {
    const store = storeOf()
    const fake = fakeGit()
    const session = cliStub([
      'const withSession = argv.includes("--session-id")',
      'console.log(`${process.cwd()} session=${withSession ? argv[argv.indexOf("--session-id") + 1] : "none"}`)',
    ].join('\n'))
    const runner = chatAnswerRunner({
      command: [process.execPath, session],
      logsDirectory: logsDirectory(),
      store,
      git: fake.git,
    })

    const result = await runner.run(contextOf({
      workspace: { workspace_id: 'ws_1', repo: { url: 'https://example.invalid/a.git', base_branch: 'main' } },
      limits: { session_hint: { mode: 'reuse', previous_session_ref: 'dsh-s-1' } },
      answer: { chat_id: 'wr1', message_id: 7, question: '接着上次的看' },
    }))

    expect(result.outcome).toBe('success')
    expect(result.summary).toContain(join(store.root, 'ws_1'))
    expect(result.summary).toContain('session=dsh-s-1')
    // The session's directory arrives as it was: no fetch, no checkout under it.
    expect(fake.commands).toEqual([])
    expect(result.notes).toBeUndefined()
  })

  it('answers without the session and notes why when the CLI cannot adopt it', async () => {
    const store = storeOf()
    const url = await sourceRepository()
    const flaky = cliStub([
      'if (argv.includes("--session-id")) {',
      '  console.error("session dsh-s-1 does not exist; omit --session-id")',
      '  process.exit(1)',
      '}',
      'console.log("在的，已重新同步仓库。")',
    ].join('\n'))
    const runner = chatAnswerRunner({
      command: [process.execPath, flaky],
      logsDirectory: logsDirectory(),
      store,
      git: cliGit(),
    })

    const result = await runner.run(contextOf({
      workspace: { workspace_id: 'ws_2', repo: { url, base_branch: 'main' } },
      limits: { session_hint: { mode: 'reuse', previous_session_ref: 'dsh-s-1' } },
      answer: { chat_id: 'wr1', message_id: 7, question: '在吗' },
    }))

    expect(result).toMatchObject({ outcome: 'success', summary: '在的，已重新同步仓库。' })
    // The degradation the contract states: the note names the session, and the
    // project-area repository — the next level — was brought in for the retry.
    expect(result.notes).toContain('session_unusable:missing')
    expect(existsSync(join(store.root, 'ws_2', '.git'))).toBe(true)
  })

  it('states in the answer why a bound repository could not be reached', async () => {
    const runner = chatAnswerRunner({
      command: [process.execPath, answerStub()],
      logsDirectory: logsDirectory(),
      store: storeOf(),
      git: cliGit(),
    })

    const result = await runner.run(contextOf({
      workspace: {
        workspace_id: 'ws_9',
        repo: { url: join(tmpdir(), 'mps-chat-no-such-repository'), base_branch: 'main' },
      },
      answer: { chat_id: 'wr1', message_id: 7, question: '你们的仓库地址是哪个' },
    }))

    // The answer carries the honest state itself: with the address in the payload,
    // claiming no repository is mounted is the one defect the contract names.
    expect(result.outcome).toBe('success')
    expect(result.summary).toContain('问题是：你们的仓库地址是哪个')
    expect(result.summary).toContain('本次未能访问该群绑定的仓库')
    expect(result.summary).not.toContain('没有挂任何代码仓库')
  })

  it('resolves the last delivery the payload states into the prompt', async () => {
    const echo = cliStub('console.log(prompt)')
    const runner = chatAnswerRunner({
      command: [process.execPath, echo],
      logsDirectory: logsDirectory(),
      store: storeOf(),
      git: fakeGit().git,
    })

    const result = await runner.run(contextOf({
      workspace: { workspace_id: 'ws_1', repo: { url: 'https://github.com/EricChenran/xxx.git', base_branch: 'main' } },
      context: {
        last_delivery: {
          task_id: 'T1047',
          title: '首页改版',
          goal: '把首页换成新版设计',
          state: '已推送',
          branch: 'feature/ws_1-T1047',
          report_excerpt: '本次交付完成了首页新版布局与登录入口。',
          artifacts: [{ kind: 'screenshot', file_name: 'home.png', path: 'ws_1/T1047/home.png', size_kb: 120 }],
        },
      },
      answer: { chat_id: 'wr1', message_id: 7, question: '刚交付的东西怎么用' },
    }))

    expect(result.outcome).toBe('success')
    // The prompt names the delivery's anchor, its branch, and its report, so "the
    // thing you just delivered" has something to resolve to.
    expect(result.summary).toContain('T1047')
    expect(result.summary).toContain('feature/ws_1-T1047')
    expect(result.summary).toContain('首页新版布局与登录入口')
    expect(result.summary).toContain('home.png')
    // The repository the workspace is bound to is stated with it.
    expect(result.summary).toContain('https://github.com/EricChenran/xxx.git')
    // Artifact paths live on the platform, never on this machine.
    expect(result.summary).not.toContain('ws_1/T1047/home.png')
  })
})
