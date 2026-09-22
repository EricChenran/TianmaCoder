/**
 * Usage-calibration service: samples provider-reported usage against the
 * heuristic estimate, maintains the rolling factor, persists it under the
 * harness home, and exposes the current multiplier so consumers (compaction
 * pressure displays first) can correct CJK under-pricing until an upstream
 * measurement seam accepts factors natively.
 *
 * @module @tianma/dsh-token-meter-calibration/service
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Session } from '@deepseek-ai/dsh-session'
import { CalibrationFactor } from './factor.ts'
import type { CalibrationFactorSnapshot } from './factor.ts'

export { CalibrationFactor } from './factor.ts'
export type { CalibrationFactorSnapshot } from './factor.ts'

/** Persisted document shape. */
export interface CalibrationPersisted {
  readonly version: 1
  readonly factor: CalibrationFactorSnapshot
}

/** One reported usage sample found in a session log. */
export interface UsageSample {
  readonly totalTokens: number
  readonly outputTokens?: number
}

/**
 * Scan a session's event list for provider-reported usage samples. Usage
 * rides `assistant/message` stream chunks (`{type:'usage', usage}`), so the
 * scan is a narrow typed walk, not a JSON fishing trip.
 * @param events - the session's event list, in log order.
 * @returns one sample per usage chunk found.
 */
export function scanSessionUsages(events: ReadonlyArray<{
  type: string
  data: { message?: { stream?: ReadonlyArray<{ type: string; usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }> } }
}>): UsageSample[] {
  const samples: UsageSample[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const stream = event.data.message?.stream
    if (stream === undefined) continue
    for (const chunk of stream) {
      if (chunk.type !== 'usage' || chunk.usage === undefined) continue
      const { totalTokens, inputTokens, outputTokens } = chunk.usage
      const total = totalTokens ?? (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined)
      if (total !== undefined && total > 0) {
        samples.push(outputTokens === undefined ? { totalTokens: total } : { totalTokens: total, outputTokens })
      }
    }
  }
  return samples
}

/** Default persistence path.
 * @param home - harness home override; defaults to \ or ~/.dsh.
 * @returns the calibration state file path.
 */
export function defaultStatePath(home?: string): string {
  const base = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'tianma-calibration.json')
}

/**
 * The calibration service: rolling factor plus file persistence. Pure
 * state container + explicit I/O — no hidden timers, no background work.
 */
export class UsageCalibrator {
  private readonly factor: CalibrationFactor
  private readonly statePath: string

  /**
   * @param statePath - where the factor snapshot persists.
   * @param window - rolling sample window (default 256).
   */
  constructor(statePath?: string, window = 256) {
    this.statePath = statePath ?? defaultStatePath()
    this.factor = new CalibrationFactor(window, this.restore())
  }

  /** Current multiplier (1 before any sample). */
  get factorValue(): number {
    return this.factor.factor
  }

  /**
   * Record one heuristic-vs-reported pair from a routed request.
   * @param estimatedTokens - the heuristic estimate for the request surface.
   * @param reportedTokens - the provider-reported total for the same request.
   */
  record(estimatedTokens: number, reportedTokens: number): void {
    this.factor.addSample(estimatedTokens, reportedTokens)
  }

  /**
   * Scan one session for reported usage samples and record each against the
   * given heuristic estimate of the same request surface.
   * @param session - the session whose log to scan.
   * @param estimateTokens - heuristic estimate per sampled request.
   * @returns how many samples were recorded.
   */
  recordSession(session: Session, estimateTokens: (index: number) => number): number {
    const samples = scanSessionUsages(session.snapshotEvents() as never)
    samples.forEach((sample, index) => {
      this.record(estimateTokens(index), sample.totalTokens)
    })
    return samples.length
  }

  /** Write the current factor snapshot to the state file. */
  persist(): void {
    const document = { version: 1, factor: this.factor.snapshot() } satisfies CalibrationPersisted
    mkdirSync(dirname(this.statePath), { recursive: true })
    writeFileSync(this.statePath, JSON.stringify(document, null, 2), 'utf8')
  }

  /**
   * Read a previously persisted snapshot, if any.
   * @returns the snapshot, or undefined when absent or unreadable.
   */
  private restore(): CalibrationFactorSnapshot | undefined {
    if (!existsSync(this.statePath)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as CalibrationPersisted
      if (parsed.version !== 1) return undefined
      return parsed.factor
    } catch {
      return undefined
    }
  }
}
