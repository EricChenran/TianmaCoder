/**
 * The evidence a task's deliverables require: the build, the end-to-end run, and the
 * report the platform checks before it accepts a delivery.
 *
 * The platform states which of them a task needs and the command to run for each, so the
 * node runs them in the delivered workspace after the agent's run, keeps each command's
 * output as a file the platform can read, and reports the outcome per command. A command
 * the payload requires but that fails stops the dependent work: the platform's gates read
 * these results, so reporting a delivery without them would be reporting work it cannot
 * accept.
 * @module @tianma/dsh-mps-executor/evidence
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { excludeFromRepository, resolveWithinWorkspace } from './paths.ts'

/** Directory inside the workspace where the node keeps the evidence it collected. */
export const EVIDENCE_DIRECTORY = '.evidence'

/** One command the node ran for evidence. */
export interface EvidenceCommand {
  /** Command line the payload stated. */
  command: string
  /** Exit code the command settled with. */
  exit_code: number
  /** How long it ran, in milliseconds. */
  duration_ms: number
  /** Path of the output, relative to the workspace. */
  log_path: string
}

/** Why an attempt could not collect the evidence its deliverables require. */
export interface EvidenceFailure {
  /** Which deliverable failed. */
  what: 'build' | 'e2e' | 'report'
  /** What to tell the operator. */
  message: string
}

/** What one attempt collected. */
export interface CollectedEvidence {
  /** The build, when the payload required one. */
  build?: EvidenceCommand | undefined
  /** The end-to-end run, when the payload required one. */
  e2e?: EvidenceCommand | undefined
  /** The report the agent wrote, when the payload required one. */
  report_path?: string | undefined
  /** Set when a required deliverable could not be produced. */
  failure?: EvidenceFailure | undefined
}

/** What one evidence command settled as. */
export interface EvidenceCommandOutcome {
  /** Exit code the command settled with. */
  exit_code: number
  /** What the command printed, in order. */
  output: string
}

/** What collecting evidence needs. */
export interface CollectEvidenceOptions {
  /** The workspace the attempt delivered from. */
  directory: string
  /** The payload a claim returned. */
  payload: Record<string, unknown>
  /**
   * Run one command line in the workspace and collect what it printed.
   * @param line - the command line the payload stated.
   * @returns the exit code and the output.
   */
  run: (line: string) => Promise<EvidenceCommandOutcome>
  /** Clock in milliseconds; defaults to the wall clock. */
  now?: (() => number) | undefined
}

/**
 * Collect the evidence one attempt's deliverables require.
 * @param options - the workspace, the payload, the command runner, and a clock.
 * @returns what was collected, and why it stopped when a deliverable failed.
 */
export async function collectEvidence(options: CollectEvidenceOptions): Promise<CollectedEvidence> {
  const deliverables = record(options.payload['deliverables'])
  const now = options.now ?? (() => Date.now())
  const collected: CollectedEvidence = {}
  if (deliverables['require_build'] === true) {
    const command = text(deliverables['build_command'])
    if (command === undefined) {
      return { failure: { what: 'build', message: 'the task requires a build but states no command to run' } }
    }
    const build = await runEvidenceCommand(options, command, 'build', now)
    collected.build = build.command
    if (build.command.exit_code !== 0) {
      return {
        ...collected,
        failure: {
          what: 'build',
          message: `the build failed with exit code ${String(build.command.exit_code)}${lastLine(build.output)}`,
        },
      }
    }
  }
  if (deliverables['require_e2e'] === true) {
    const command = text(deliverables['e2e_command'])
    if (command === undefined) {
      return { ...collected, failure: { what: 'e2e', message: 'the task requires an end-to-end run but states no command to run' } }
    }
    const e2e = await runEvidenceCommand(options, command, 'e2e', now)
    collected.e2e = e2e.command
    if (e2e.command.exit_code !== 0) {
      return {
        ...collected,
        failure: {
          what: 'e2e',
          message: `the end-to-end run failed with exit code ${String(e2e.command.exit_code)}${lastLine(e2e.output)}`,
        },
      }
    }
  }
  if (deliverables['require_report'] === true) {
    const stated = text(deliverables['report_filename'])
    if (stated === undefined) {
      return { ...collected, failure: { what: 'report', message: 'the task requires a report but states no file name' } }
    }
    // A report name that leaves the workspace names no file this node reads.
    const path = await resolveWithinWorkspace(options.directory, stated).catch(() => undefined)
    if (path === undefined || !existsSync(path)) {
      return {
        ...collected,
        failure: { what: 'report', message: `the task requires a report at ${stated}, which the attempt did not write` },
      }
    }
    collected.report_path = stated
  }
  return collected
}

/**
 * Run one evidence command and keep its output.
 * @param options - the workspace and the command runner.
 * @param command - the command line the payload stated.
 * @param name - which deliverable this is, used for the file name.
 * @param now - the clock.
 * @returns the command's record and what it printed.
 */
async function runEvidenceCommand(
  options: CollectEvidenceOptions,
  command: string,
  name: 'build' | 'e2e',
  now: () => number,
): Promise<{ command: EvidenceCommand; output: string }> {
  mkdirSync(join(options.directory, EVIDENCE_DIRECTORY), { recursive: true })
  excludeFromRepository(options.directory, `${EVIDENCE_DIRECTORY}/`)
  const started = now()
  const outcome = await options.run(command)
  const log_path = join(EVIDENCE_DIRECTORY, `${name}.log`)
  // The log names the command it came from, so the platform reads it without the payload.
  writeFileSync(join(options.directory, log_path), `${command}\n${outcome.output}`, 'utf8')
  return {
    command: { command, exit_code: outcome.exit_code, duration_ms: now() - started, log_path },
    output: outcome.output,
  }
}

/**
 * The last non-empty line of a command's output, with its separator.
 * @param output - what the command printed.
 * @returns the suffix to append, or an empty string.
 */
function lastLine(output: string): string {
  const lines = output.split(/\r?\n/u).filter(line => line.trim() !== '')
  const last = lines.at(-1)
  return last === undefined ? '' : `: ${last}`
}

/**
 * Read one value as a record.
 * @param value - the value.
 * @returns the record, or an empty one.
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
