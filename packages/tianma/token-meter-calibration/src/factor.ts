/**
 * Rolling usage-calibration factor.
 *
 * The density split fixes the cold start; this factor closes the residual
 * gap against the provider's reported usage. Each request contributes one
 * (estimated, reported) sample; the factor is the running median of the
 * reported/estimated ratios, clamped so a pathological sample can never
 * push pricing more than 4× in either direction. Serialization carries a
 * version field so persisted factors can migrate.
 *
 * @module @tianma/dsh-token-meter-calibration/factor
 */

/** Clamp bounds for the factor — calibration, not replacement. */
const FACTOR_MIN = 0.25
const FACTOR_MAX = 4

/** Serialized shape written to non-session storage. */
export interface CalibrationFactorSnapshot {
  readonly version: 1
  readonly sampleCount: number
  readonly factor: number
}

/**
 * Rolling median-of-ratios calibration over a bounded sample window.
 * Stateless between calls: everything lives in the snapshot passed in.
 */
export class CalibrationFactor {
  private readonly ratios: number[] = []
  private readonly window: number

  constructor(window = 256, seed?: CalibrationFactorSnapshot) {
    if (!Number.isInteger(window) || window < 1) {
      throw new Error(`CalibrationFactor: window (${window}) must be a positive integer`)
    }
    this.window = window
    if (seed !== undefined) {
      if (seed.version !== 1) {
        throw new Error(`CalibrationFactor: unsupported snapshot version ${String(seed.version)}`)
      }
      // A seeded factor replays as one equivalent aggregate sample so the
      // window bound holds across restarts.
      this.ratios.push(clamp(seed.factor))
    }
  }

  /**
   * Record one (estimated, reported) request sample.
   * @param estimatedTokens - heuristic estimate for the request's model-visible surface.
   * @param reportedTokens - provider-reported usage for the same request.
   */
  addSample(estimatedTokens: number, reportedTokens: number): void {
    if (estimatedTokens <= 0 || reportedTokens <= 0) return
    this.ratios.push(clamp(reportedTokens / estimatedTokens))
    if (this.ratios.length > this.window) this.ratios.shift()
  }

  /** Current multiplier; 1 before any sample (pure density pricing). */
  get factor(): number {
    if (this.ratios.length === 0) return 1
    const sorted = [...this.ratios].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const low = sorted[middle - 1] ?? 0
    // `middle` is below `sorted.length` for every non-empty window, so the
    // fallback is unreachable; it satisfies indexed-access typing only.
    /* v8 ignore next -- unreachable fallback for indexed access on a non-empty window */
    const high = sorted[middle] ?? low
    return sorted.length % 2 === 1 ? high : (low + high) / 2
  }

  /** Number of retained samples. */
  get sampleCount(): number {
    return this.ratios.length
  }

  /**
   * Persistable snapshot with a version field.
   * @returns the current factor and sample count for storage.
   */
  snapshot(): CalibrationFactorSnapshot {
    return { version: 1, sampleCount: this.ratios.length, factor: this.factor }
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, value))
}
