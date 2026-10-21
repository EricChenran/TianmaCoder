/**
 * The runner the node ships: what it hands the CLI, what it streams back, and how it
 * turns a process into a result. The child is a stand-in that prints its arguments and
 * settles on request, so no model and no network are involved.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, afterEach } from 'vitest'
import {
  AGENT_PATCH_FILENAME,
  decodeCommandLine,
  exitCodeOf,
  readRunEvent,
  sessionAdoptionFailure,
  runFailureSummary,
  shellFor,
  stopPlan,
  stopRun,
  tianmaCliRunner,
  TURN_PROGRESS_CEILING,
} from '@tianma/dsh-mps-executor'
import type { PublishedChanges, TaskRunContext, TaskRunResult } from '@tianma/dsh-mps-executor'
import type { ExecLogLine, ExecResource, ExecTaskAssignment, TaskProgress } from '@tianma/dsh-mps-exec-core'
import type { RunLine } from '@tianma/dsh-mps-executor'

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
  /** Materials the platform answers with, by artifact id. */
  readonly materials = new Map<string, Uint8Array>()
  /** Failure the platform answers a material request with. */
  materialError: Error | undefined
  /** Artifacts this attempt uploaded, in order. */
  readonly uploads: { kind: string; path: string; meta?: Record<string, unknown> | undefined }[] = []
  /** Sessions this attempt reported, in order. */
  readonly sessions: string[] = []

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

  async uploadArtifact(kind: string, path: string, meta?: Record<string, unknown> | undefined): Promise<string> {
    this.uploads.push({ kind, path, meta })
    return `art-${String(this.uploads.length)}`
  }

  async resource(artifactId: string): Promise<ExecResource> {
    if (this.materialError !== undefined) throw this.materialError
    const bytes = this.materials.get(artifactId)
    if (bytes === undefined) throw new Error('this attempt downloads no material')
    return { bytes, sha256: `sha-of-${artifactId}` }
  }

  async reportSession(sessionRef: string): Promise<void> {
    this.sessions.push(sessionRef)
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
  it('keeps both ends of a long run and says what it dropped', async () => {
    const logs = temporary('mps-logs-')
    const workspace = temporary('mps-workspace-')
    const context = new RecordingContext(workspace, assignment())
    const run = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'many'],
      logsDirectory: logs,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      rawLogMaxLines: 4,
    })

    const result = await run.run(context)
    // Whatever attempt number the run settled on, it wrote one raw log for it.
    const written = readdirSync(logs).filter(name => name.endsWith('.log'))
    expect(written).toHaveLength(1)
    const raw = readFileSync(join(logs, String(written[0])), 'utf8')

    // The platform received every line; what the node keeps on disk has both ends, and says
    // how much of the middle it did not keep, so a failure at either end is still readable.
    expect(context.logs.flatMap(entry => entry.lines).filter(line => /^line \d+$/u.test(line.text))).toHaveLength(10)
    expect(raw).toContain('# dropped 6 line(s) from the middle of this run')
    expect(raw).toContain('line 1')
    expect(raw).toContain('line 2')
    expect(raw).toContain('line 9')
    expect(raw).toContain('line 10')
    expect(raw).not.toContain('line 5')
    expect(result.outcome).toBe('success')

    // A deployment can keep no raw lines at all; the run still reaches the platform whole.
    const none = temporary('mps-logs-')
    const bare = new RecordingContext(workspace, assignment())
    const withoutLog = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'many'],
      logsDirectory: none,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      rawLogMaxLines: 0,
    })

    await withoutLog.run(bare)

    const kept = readFileSync(join(none, String(readdirSync(none)[0])), 'utf8')
    expect(kept).toContain('# dropped 10 line(s) from the middle of this run')
    expect(kept).not.toContain('line 1')
    expect(bare.logs.flatMap(entry => entry.lines).filter(line => /^line \d+$/u.test(line.text))).toHaveLength(10)
  })

  it('moves a run\'s progress with the turns it narrates, and stops short of the end', async () => {
    const logs = temporary('mps-logs-')
    const workspace = temporary('mps-workspace-')
    const context = new RecordingContext(workspace, assignment())
    // The runner the platform talks to reads the CLI's event stream, which is what carries
    // the turns.
    const run = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'turns'],
      logsDirectory: logs,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      jsonEvents: true,
    })

    const result = await run.run(context)

    // The platform watches this number: a run that reports one turn and then nothing looks
    // stalled for as long as the agent keeps working, and a run that counts to a hundred
    // before it has delivered anything is claiming something it cannot know.
    expect(context.progresses.filter(progress => progress.stage === 'coding')).toEqual([
      { progress: 10, stage: 'coding', message: 'the agent is working' },
      { progress: 15, stage: 'coding', message: 'the agent is on turn 1' },
      { progress: 20, stage: 'coding', message: 'the agent is on turn 2' },
      { progress: 25, stage: 'coding', message: 'the agent is on turn 3' },
      { progress: TURN_PROGRESS_CEILING, stage: 'coding', message: 'the agent is on turn 20' },
    ])
    expect(result.outcome).toBe('success')
  })

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
    expect(context.progresses).toEqual([
      { progress: 10, stage: 'coding', message: 'the agent is working' },
      { progress: 80, stage: 'collecting_evidence', message: 'collecting evidence' },
      { progress: 100, stage: 'uploading', message: 'evidence reported' },
    ])

    const rawLog = join(logs, 'tsk_1-2.log')
    expect(result.notes).toBe(`raw log: ${rawLog}`)
    const written = readFileSync(rawLog, 'utf8')
    expect(written).toContain('ended: exited with code 0')
    expect(written).toContain('[stdout] done')
  })

  it('writes the task book and points the prompt at it', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      constraints: { must_stay_in_workspace: true },
    }))

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('success')
    const book = readFileSync(join(workspace, 'PROMPT.md'), 'utf8')
    expect(book).toContain('## 需求')
    expect(book).toContain(INSTRUCTION)
    expect(book).toContain('## 约束')
    // The instruction stays the prompt, and the prompt says where the rest is.
    expect(reported(context)).toContain(`stdout:instruction=${INSTRUCTION}`)
    expect(reported(context).some(line => line.includes('PROMPT.md'))).toBe(true)
    expect(reported(context)).toContain(`runner:task book: ${join(workspace, 'PROMPT.md')}`)
  })

  it('brings the task materials in and names them in the book', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      context: {
        resources: ['art_1'],
        chat_transcript: { messages: [{ resources: [{ artifact_id: 'art_2', file_name: '需求说明.pdf' }] }] },
      },
    }))
    context.materials.set('art_1', new TextEncoder().encode('材料一'))
    context.materials.set('art_2', new TextEncoder().encode('材料二'))

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('success')
    expect(readFileSync(join(workspace, '.materials', 'art_1'), 'utf8')).toBe('材料一')
    expect(readFileSync(join(workspace, '.materials', 'art_2_需求说明.pdf'), 'utf8')).toBe('材料二')
    const book = readFileSync(join(workspace, 'PROMPT.md'), 'utf8')
    expect(book).toContain('- .materials/art_1（art_1）')
    expect(book).toContain('- .materials/art_2_需求说明.pdf（art_2）')
    expect(reported(context).some(line => line.includes('材料 2 份'))).toBe(true)
  })

  it('reports a task whose materials cannot be brought in', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      context: { resources: ['art_9'] },
    }))
    context.materialError = new Error('RESOURCE_NOT_IN_SCOPE: not in scope')

    const result = await runnerFor(logs, 'ok').run(context)

    // Missing inputs are what `blocked` is for: the run never starts.
    expect(result.outcome).toBe('blocked')
    expect(result.summary).toBe("could not bring in the task's materials: RESOURCE_NOT_IN_SCOPE: not in scope")
    // The reason travels as evidence too: the platform writes its human confirmation from it.
    expect(result.evidence?.blockedReason)
      .toBe("could not bring in the task's materials: RESOURCE_NOT_IN_SCOPE: not in scope")
    expect(reported(context).some(line => line.startsWith('stdout:cwd='))).toBe(false)
    expect(context.published).toBe(0)
  })

  it('runs the deliverables the task requires and reports their evidence', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      deliverables: {
        require_build: true,
        build_command: 'node --version',
        require_e2e: true,
        e2e_command: 'node --version',
        require_report: true,
        report_filename: 'REPORT.md',
        require_screenshots: true,
        min_screenshots: 1,
      },
    }))
    writeFileSync(join(workspace, 'REPORT.md'), '# 报告\n', 'utf8')
    mkdirSync(join(workspace, '.evidence', 'screenshots'), { recursive: true })
    writeFileSync(join(workspace, '.evidence', 'screenshots', 'detail.png'), 'PNG-ish bytes\n', 'utf8')
    writeFileSync(join(workspace, '.evidence', 'screenshots.json'), JSON.stringify([
      { file: '.evidence/screenshots/detail.png', route: '/orders/123', caption: '批量下载入口', width: 1440, height: 900 },
    ]), 'utf8')

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('success')
    expect(result.evidence?.build).toMatchObject({ command: 'node --version', exit_code: 0, log_artifact_id: 'art-1' })
    expect(result.evidence?.e2e).toMatchObject({ command: 'node --version', exit_code: 0, result_artifact_id: 'art-2' })
    expect(result.evidence?.report_artifact_id).toBe('art-3')
    expect(context.uploads.map(upload => upload.kind)).toEqual(['log', 'log', 'report', 'screenshot'])
    expect(context.uploads[3]?.meta).toMatchObject({ route: '/orders/123', width: 1440, height: 900 })
    expect(result.evidence?.screenshots).toEqual([
      { artifact_id: 'art-4', route: '/orders/123', caption: '批量下载入口' },
    ])
    expect(result.summary).toContain('evidence: build, e2e, report, screenshots')
    // The evidence is the node's own output, so the commit never carries it.
    expect(readFileSync(join(workspace, '.evidence', 'build.log'), 'utf8')).toContain('node --version')
  })

  it('reports a build the node stopped without an exit code', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      deliverables: { require_build: true, build_command: 'node sleeper.mjs' },
    }))
    writeFileSync(join(workspace, 'sleeper.mjs'), 'setInterval(() => {}, 1000)\n', 'utf8')

    const running = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'ok'],
      logsDirectory: logs,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      stopGraceMs: 200,
    }).run(context)
    // The agent's run ends at once, so the build is what this abort lands on.
    await new Promise(resolve => setTimeout(resolve, 700))
    context.controller.abort()
    const result = await running

    expect(result.outcome).toBe('failed')
    expect(result.summary).toMatch(/^build evidence: the build failed with exit code /u)
  })

  it('fails an attempt whose required build fails', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      deliverables: { require_build: true, build_command: 'node -e process.exit(3)' },
    }))

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('failed')
    expect(result.summary).toBe('build evidence: the build failed with exit code 3')
    expect(context.uploads).toEqual([])
  })

  it('turns the event stream into the log the platform reads', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    const runner = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'json'],
      logsDirectory: logs,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      jsonEvents: true,
    })

    const result = await runner.run(context)

    expect(result.outcome).toBe('success')
    // The run was asked for events, and each one reaches the platform as a line.
    expect(reported(context)).toContain('stdout:args=json --json ' + INSTRUCTION)
    expect(reported(context)).toContain('stdout:session dsh-session-01H8Z')
    expect(reported(context)).toContain('stdout:status turn_start turn 1 step ')
    expect(reported(context)).toContain('stdout:thinking: 先看需求')
    expect(reported(context)).toContain('stdout:我来改这个文件')
    expect(reported(context)).toContain('stdout:tool read {"path":"readme.md"}')
    expect(reported(context)).toContain('stdout:tool call_1 completed: ok')
    expect(reported(context)).toContain('stdout:final: 已增加批量下载')
    // The node reports the session it worked in, and keeps the answer for the operator.
    expect(context.sessions).toEqual(['dsh-session-01H8Z'])
    expect(result.notes).toContain('answer: 已增加批量下载')
  })

  it('continues the session the platform names and reports it', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      limits: { session_hint: { previous_session_ref: 'dsh-session-previous' } },
    }))

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('success')
    expect(context.sessions).toEqual(['dsh-session-previous'])
    expect(reported(context)).toContain('stdout:args=ok --session-id dsh-session-previous ' + INSTRUCTION)
    expect(reported(context)).toContain('runner:continuing session dsh-session-previous')
  })

  it('reads one event line, and leaves anything else alone', () => {
    expect(readRunEvent('{"type":"session","sessionId":"s_1"}')).toEqual({ text: 'session s_1', session: 's_1' })
    expect(readRunEvent('{"type":"final","text":"答案"}')).toEqual({ text: 'final: 答案', answer: '答案' })
    expect(readRunEvent('{"type":"unknown"}')).toEqual({ text: 'event unknown' })
    expect(readRunEvent('{"type":"status","phase":"step_end","turn":2,"step":3}'))
      .toEqual({ text: 'status step_end turn 2 step 3' })
    // An event that states less than it should still reaches the platform.
    expect(readRunEvent('{"type":"session"}')).toEqual({ text: 'session ', session: undefined })
    expect(readRunEvent('{"type":"text"}')).toEqual({ text: '' })
    expect(readRunEvent('{"type":"tool_call"}')).toEqual({ text: 'tool  {}' })
    expect(readRunEvent('{"type":"tool_result"}')).toEqual({ text: 'tool  : ' })
    expect(readRunEvent('{"type":"final"}')).toEqual({ text: 'final: ', answer: undefined })
    expect(readRunEvent('{"type":"thinking"}')).toEqual({ text: 'thinking: ' })
    // A line that is not an event is the answer of a CLI without the flag.
    expect(readRunEvent('已增加批量下载')).toBeUndefined()
    expect(readRunEvent('[1,2]')).toBeUndefined()
  })

  it('starts a new session when the one the platform named is gone', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      limits: { session_hint: { previous_session_ref: 'dsh-session-gone' } },
    }))
    const runner = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'session-gone'],
      logsDirectory: logs,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      jsonEvents: true,
    })

    const result = await runner.run(context)

    expect(result.outcome).toBe('success')
    // The first run was asked for the platform's session, the second started a new one.
    expect(reported(context)).toContain('stdout:args=session-gone --json --session-id dsh-session-gone ' + INSTRUCTION)
    expect(reported(context)).toContain('stdout:args=session-gone --json ' + INSTRUCTION)
    expect(reported(context)).toContain('runner:session dsh-session-gone is gone; starting a new one')
    // Both sessions are reported: the platform learns the one it named is gone.
    expect(context.sessions).toEqual(['dsh-session-gone', 'dsh-session-fresh'])
    expect(result.notes).toContain('answer: 新会话完成')
  })

  it('starts a new session when another run still owns the one the platform named', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment({
      spec: { raw_instruction: INSTRUCTION },
      limits: { session_hint: { previous_session_ref: 'dsh-session-owned' } },
    }))
    const runner = tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'session-owned'],
      logsDirectory: logs,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      jsonEvents: true,
    })

    const result = await runner.run(context)

    expect(result.outcome).toBe('success')
    expect(reported(context)).toContain('stdout:args=session-owned --json --session-id dsh-session-owned ' + INSTRUCTION)
    expect(reported(context)).toContain('stdout:args=session-owned --json ' + INSTRUCTION)
    // The operator reads the reason it actually was: a handle another run still holds,
    // not a session that no longer exists.
    expect(reported(context)).toContain(
      'runner:session dsh-session-owned is still owned by another write handle; starting a new one',
    )
    expect(context.sessions).toEqual(['dsh-session-owned', 'dsh-session-fresh'])
    expect(result.notes).toContain('answer: 新会话完成')
    // The platform acts on this one: the reference it holds is stuck, so it resets the
    // workspace's session rather than handing the same one back to be failed on again.
    expect(result.error?.code).toBe('session_in_use')
  })

  it('reads which session failure stopped a run', () => {
    const line = (text: string): RunLine => ({
      stream: 'stderr',
      line: { at: '2026-10-15T04:03:55.123Z', level: 'warn', text },
    })
    const gone = 'dsh: session "dsh-session-gone" does not exist; omit --session-id to start a new Session'
    const owned = 'dsh: session "session-7d747633-c58d-4c1b-ba05-471f6a81de4c" is already owned by an active write handle'

    expect(sessionAdoptionFailure({ kind: 'exited', code: 1 }, [line(gone)])).toBe('missing')
    // A session another still-active handle owns is as unusable as a gone one: the work
    // never started, and only a new session can run it.
    expect(sessionAdoptionFailure({ kind: 'exited', code: 1 }, [line(owned)])).toBe('owned')
    expect(sessionAdoptionFailure({ kind: 'exited', code: 1 }, [line('build failed')])).toBeUndefined()
    expect(sessionAdoptionFailure({ kind: 'exited', code: 0 }, [line(gone)])).toBeUndefined()
    expect(sessionAdoptionFailure({ kind: 'exited', code: null }, [line(gone)])).toBeUndefined()
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
    expect(result.error?.code).toBe('no_changes')
  })

  it('hands back a repeat whose work the branch already holds', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    // The publisher re-pushed the branch the task already delivered on: nothing new to
    // commit is idempotence, not an attempt that did no work.
    context.publishResult = { changed_files: [], head_commit: 'b2c3d4e', pushed: true }

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.outcome).toBe('success')
    expect(result.summary).toContain('no new changes: the branch already holds what this task delivered')
    expect(result.error).toBeUndefined()
  })

  it('starts the run on the model the deployment chose', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    const patch = [
      '- id: agent-default-model',
      '  config:',
      '    provider: "deepseek-official"',
      '    model: "deepseek-v4-pro"',
      '',
    ].join('\n')

    const result = await tianmaCliRunner({
      command: [process.execPath, FIXTURE, 'ok'],
      logsDirectory: logs,
      agentPatch: patch,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
    }).run(context)

    expect(result.outcome).toBe('success')
    // The overlay sits beside the raw logs, outside the workspace the attempt delivers,
    // and the launcher's own flag carries it ahead of the app's arguments.
    const overlay = join(logs, AGENT_PATCH_FILENAME)
    expect(readFileSync(overlay, 'utf8')).toBe(patch)
    expect(reported(context)).toContain(`stdout:args=ok --patch ${overlay} ${INSTRUCTION}`)
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
    // The host reports what a killed process settled with, so the code is its business.
    expect(readFileSync(join(logs, 'tsk_1-2.log'), 'utf8')).toMatch(/ended: stopped with code /u)
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

  it('reports work handed back as a bundle', async () => {
    const workspace = temporary('mps-run-')
    const logs = temporary('mps-logs-')
    const context = new RecordingContext(workspace, assignment())
    context.publishResult = {
      changed_files: ['src/a.ts'],
      head_commit: 'b2c3d4e',
      pushed: false,
      bundle: { path: '.bundles/feature-tsk_1-b2c3d4e.bundle', sha256: 'sha' },
    }

    const result = await runnerFor(logs, 'ok').run(context)

    expect(result.summary).toBe('changed 1 file(s) and handed them back as a bundle')
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

  it('runs an evidence command through the shell the host has', () => {
    expect(shellFor('npm run build', 'win32')).toEqual({
      bin: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm run build'],
    })
    expect(shellFor('npm run build', 'linux')).toEqual({ bin: '/bin/sh', args: ['-c', 'npm run build'] })
  })

  it('decodes a command line as UTF-8, falling back to the GBK a localized shell prints', () => {
    expect(decodeCommandLine(Buffer.from('npm run build', 'utf8'))).toBe('npm run build')
    expect(decodeCommandLine(Buffer.from('构建完成', 'utf8'))).toBe('构建完成')
    // `系统找不到指定的文件。` in GBK, the bytes cmd.exe writes on a zh-CN host.
    const gbk = [
      0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8,
      0xb6, 0xa8, 0xb5, 0xc4, 0xce, 0xc4, 0xbc, 0xfe, 0xa1, 0xa3,
    ]
    expect(decodeCommandLine(Buffer.from(gbk))).toBe('系统找不到指定的文件。')
  })

  it('reports an exit code even when a command left none', () => {
    expect(exitCodeOf({ code: 3 })).toBe(3)
    expect(exitCodeOf({ code: null })).toBe(-1)
    expect(exitCodeOf({})).toBe(-1)
  })

  it('stops a shell-spawned run by killing its tree on Windows', () => {
    expect(stopPlan({ pid: 41 }, 'win32')).toEqual({ kind: 'taskkill', pid: 41 })
    // A run the host gave no process id for, or a host without taskkill, takes signals.
    expect(stopPlan({}, 'win32')).toEqual({ kind: 'signals' })
    expect(stopPlan({ pid: 41 }, 'linux')).toEqual({ kind: 'signals' })
  })

  it('asks a run to end before killing it', async () => {
    const kills: (string | number | undefined)[] = []
    const run = {
      kill: (signal?: NodeJS.Signals | number): boolean => {
        kills.push(signal)
        return true
      },
    }

    stopRun(run, 5, 'linux')
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
