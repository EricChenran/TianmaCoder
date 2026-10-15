/**
 * The evidence a task's deliverables require: which commands the node runs, what it keeps
 * from them, and when it stops instead of reporting a delivery the platform would reject.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { EVIDENCE_DIRECTORY, collectEvidence } from '@tianma/dsh-mps-executor'
import type { EvidenceCommandOutcome } from '@tianma/dsh-mps-executor'

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

/** A shell that answers from a script and records the lines it was given. */
class ScriptedShell {
  readonly lines: string[] = []
  readonly answers = new Map<string, EvidenceCommandOutcome>()

  async run(line: string): Promise<EvidenceCommandOutcome> {
    this.lines.push(line)
    return this.answers.get(line) ?? { exit_code: 0, output: `ran ${line}\n` }
  }
}

/**
 * A clock that advances one second per reading, so a duration is a stated number.
 * @returns the clock.
 */
function tickingClock(): () => number {
  let now = 1_000
  return () => {
    now += 1_000
    return now
  }
}

describe('collecting evidence', () => {
  it('runs the build and the end-to-end command and keeps what they printed', async () => {
    const directory = temporary('mps-evidence-')
    mkdirSync(join(directory, '.git', 'info'), { recursive: true })
    writeFileSync(join(directory, '.git', 'info', 'exclude'), '# local excludes\n', 'utf8')
    const shell = new ScriptedShell()
    shell.answers.set('npm run build', { exit_code: 0, output: 'built 12 files\n' })
    shell.answers.set('npm run test:e2e', { exit_code: 0, output: '24 passed\n' })
    writeFileSync(join(directory, '开发报告.md'), '# 报告\n', 'utf8')

    const collected = await collectEvidence({
      directory,
      payload: {
        deliverables: {
          require_build: true,
          build_command: 'npm run build',
          require_e2e: true,
          e2e_command: 'npm run test:e2e',
          require_report: true,
          report_filename: '开发报告.md',
        },
      },
      run: async line => await shell.run(line),
      now: tickingClock(),
    })

    expect(shell.lines).toEqual(['npm run build', 'npm run test:e2e'])
    expect(collected.failure).toBeUndefined()
    expect(collected.build).toEqual({
      command: 'npm run build',
      exit_code: 0,
      duration_ms: 1_000,
      log_path: join(EVIDENCE_DIRECTORY, 'build.log'),
    })
    expect(collected.e2e?.exit_code).toBe(0)
    expect(collected.report_path).toBe('开发报告.md')
    // The log names the command it came from, so the platform reads it alone.
    expect(readFileSync(join(directory, EVIDENCE_DIRECTORY, 'build.log'), 'utf8'))
      .toBe('npm run build\nbuilt 12 files\n')
    // The evidence is the node's own output, so the commit never carries it.
    expect(readFileSync(join(directory, '.git', 'info', 'exclude'), 'utf8'))
      .toBe(`# local excludes\n${EVIDENCE_DIRECTORY}/\n`)
  })

  it('stops at a failed build without running the end-to-end command', async () => {
    const directory = temporary('mps-evidence-')
    const shell = new ScriptedShell()
    shell.answers.set('npm run build', { exit_code: 2, output: 'error TS2304\nfound 3 errors\n' })

    const collected = await collectEvidence({
      directory,
      payload: {
        deliverables: {
          require_build: true,
          build_command: 'npm run build',
          require_e2e: true,
          e2e_command: 'npm run test:e2e',
        },
      },
      run: async line => await shell.run(line),
      now: tickingClock(),
    })

    expect(shell.lines).toEqual(['npm run build'])
    expect(collected.build?.exit_code).toBe(2)
    expect(collected.e2e).toBeUndefined()
    expect(collected.failure).toEqual({ what: 'build', message: 'the build failed with exit code 2: found 3 errors' })
  })

  it('reports an end-to-end run that failed', async () => {
    const directory = temporary('mps-evidence-')
    const shell = new ScriptedShell()
    shell.answers.set('npm run test:e2e', { exit_code: 1, output: '1 failed\n' })

    const collected = await collectEvidence({
      directory,
      payload: { deliverables: { require_e2e: true, e2e_command: 'npm run test:e2e' } },
      run: async line => await shell.run(line),
    })

    expect(collected.failure).toEqual({
      what: 'e2e',
      message: 'the end-to-end run failed with exit code 1: 1 failed',
    })
  })

  it('refuses a report the attempt did not write', async () => {
    const directory = temporary('mps-evidence-')

    const collected = await collectEvidence({
      directory,
      payload: { deliverables: { require_report: true, report_filename: '开发报告.md' } },
      run: async () => ({ exit_code: 0, output: '' }),
    })

    expect(collected.report_path).toBeUndefined()
    expect(collected.failure).toEqual({
      what: 'report',
      message: 'the task requires a report at 开发报告.md, which the attempt did not write',
    })
  })

  it('refuses a report name that leaves the workspace', async () => {
    const directory = temporary('mps-evidence-')

    const collected = await collectEvidence({
      directory,
      payload: { deliverables: { require_report: true, report_filename: '../outside.md' } },
      run: async () => ({ exit_code: 0, output: '' }),
    })

    expect(collected.failure).toEqual({
      what: 'report',
      message: 'the task requires a report at ../outside.md, which the attempt did not write',
    })
  })

  it('refuses a required deliverable that states no command', async () => {
    const directory = temporary('mps-evidence-')

    const build = await collectEvidence({
      directory,
      payload: { deliverables: { require_build: true } },
      run: async () => ({ exit_code: 0, output: '' }),
    })
    const e2e = await collectEvidence({
      directory,
      payload: { deliverables: { require_e2e: true } },
      run: async () => ({ exit_code: 0, output: '' }),
    })
    const report = await collectEvidence({
      directory,
      payload: { deliverables: { require_report: true } },
      run: async () => ({ exit_code: 0, output: '' }),
    })

    expect(build.failure?.what).toBe('build')
    expect(e2e.failure?.what).toBe('e2e')
    expect(report.failure?.what).toBe('report')
  })

  it('collects nothing when the task requires no evidence', async () => {
    const directory = temporary('mps-evidence-')
    const shell = new ScriptedShell()

    const collected = await collectEvidence({
      directory,
      payload: { deliverables: { push_required: true } },
      run: async line => await shell.run(line),
    })

    expect(collected).toEqual({})
    expect(shell.lines).toEqual([])
    expect(existsSync(join(directory, EVIDENCE_DIRECTORY))).toBe(false)
  })
})
