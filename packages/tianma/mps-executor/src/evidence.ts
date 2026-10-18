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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanStatedPath } from './filenames.ts'
import { excludeFromRepository, resolveWithinWorkspace } from './paths.ts'

/** Directory inside the workspace where the node keeps the evidence it collected. */
export const EVIDENCE_DIRECTORY = '.evidence'

/** Directory inside the evidence where an attempt leaves the screenshots it captured. */
export const SCREENSHOTS_DIRECTORY = join(EVIDENCE_DIRECTORY, 'screenshots')

/** File the attempt declares its screenshots in, relative to the workspace. */
export const SCREENSHOT_MANIFEST = join(EVIDENCE_DIRECTORY, 'screenshots.json')

/** Smallest width the platform accepts for a screenshot. */
export const SCREENSHOT_MIN_WIDTH = 800

/** Smallest height the platform accepts for a screenshot. */
export const SCREENSHOT_MIN_HEIGHT = 600

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
  what: 'build' | 'e2e' | 'report' | 'screenshots'
  /** What to tell the operator. */
  message: string
}

/** One screenshot an attempt captured and declared. */
export interface EvidenceScreenshot {
  /** Path of the file, relative to the workspace. */
  path: string
  /** Route the screenshot shows. */
  route: string
  /** Caption the platform shows beside it. */
  caption: string
  /** What the platform keeps beside the artifact. */
  meta: Record<string, unknown>
}

/** What one attempt collected. */
export interface CollectedEvidence {
  /** The build, when the payload required one. */
  build?: EvidenceCommand | undefined
  /** The end-to-end run, when the payload required one. */
  e2e?: EvidenceCommand | undefined
  /** The report the agent wrote, when the payload required one. */
  report_path?: string | undefined
  /** The screenshots the attempt captured, when the payload required any. */
  screenshots?: EvidenceScreenshot[] | undefined
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
    // The platform states this name as a literal and its gate looks for that name, so the
    // node reads the file the platform asked for and never renames it. Cleaning belongs to
    // the paths an attempt writes for itself.
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
  if (deliverables['require_screenshots'] === true) {
    const screenshots = await readScreenshots(options.directory, deliverables)
    if ('failure' in screenshots) return { ...collected, failure: screenshots.failure }
    collected.screenshots = screenshots.screenshots
  }
  return collected
}

/**
 * Read the screenshots an attempt declared. The node cannot capture them — the browser
 * that did knows the viewport and the route — so the attempt declares each one and the
 * node checks what it can before the platform sees it.
 * @param directory - the workspace the attempt delivered from.
 * @param deliverables - the payload's deliverables block.
 * @returns the screenshots, or why they cannot be handed over.
 */
async function readScreenshots(
  directory: string,
  deliverables: Record<string, unknown>,
): Promise<{ screenshots: EvidenceScreenshot[] } | { failure: EvidenceFailure }> {
  const minimum = count(deliverables['min_screenshots']) ?? 1
  let declared: unknown
  try {
    declared = JSON.parse(readFileSync(join(directory, SCREENSHOT_MANIFEST), 'utf8'))
  } catch {
    // No manifest is the same answer as no screenshots: the attempt declared none.
    declared = undefined
  }
  const entries = Array.isArray(declared) ? declared : []
  if (entries.length < minimum) {
    return {
      failure: {
        what: 'screenshots',
        message: `the task requires ${String(minimum)} screenshot(s) at ${SCREENSHOT_MANIFEST}, and the attempt declared ${String(entries.length)}`,
      },
    }
  }
  const screenshots: EvidenceScreenshot[] = []
  for (const entry of entries) {
    const stated = record(entry)
    const file = text(stated['file'])
    const route = text(stated['route'])
    if (file === undefined || route === undefined) {
      return {
        failure: {
          what: 'screenshots',
          message: `${SCREENSHOT_MANIFEST} declares a screenshot without a file and a route`,
        },
      }
    }
    const width = count(stated['width'])
    const height = count(stated['height'])
    if (width !== undefined && height !== undefined && (width < SCREENSHOT_MIN_WIDTH || height < SCREENSHOT_MIN_HEIGHT)) {
      return {
        failure: {
          what: 'screenshots',
          message: `${file} is ${String(width)}x${String(height)}, under the ${String(SCREENSHOT_MIN_WIDTH)}x${String(SCREENSHOT_MIN_HEIGHT)} the platform accepts`,
        },
      }
    }
    // The manifest is written by the attempt, so its file names get the same cleaning a
    // report name does before they name a file the node reads.
    const cleaned = cleanStatedPath(file)
    if (cleaned === '') {
      return {
        failure: {
          what: 'screenshots',
          message: `${SCREENSHOT_MANIFEST} declares ${file}, which names no usable file name`,
        },
      }
    }
    const path = await resolveWithinWorkspace(directory, cleaned).catch(() => undefined)
    if (path === undefined || !existsSync(path)) {
      return {
        failure: {
          what: 'screenshots',
          message: `${SCREENSHOT_MANIFEST} declares ${cleaned}, which the attempt did not write`,
        },
      }
    }
    screenshots.push({
      path: cleaned,
      route,
      caption: text(stated['caption']) ?? route,
      meta: {
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(text(stated['viewport']) === undefined ? {} : { viewport: text(stated['viewport']) }),
        route,
        ...(text(stated['captured_at']) === undefined ? {} : { captured_at: text(stated['captured_at']) }),
        ...(text(stated['scenario']) === undefined ? {} : { scenario: text(stated['scenario']) }),
      },
    })
  }
  return { screenshots }
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

/**
 * Read one value as a positive count.
 * @param value - the value.
 * @returns the count, or undefined.
 */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
