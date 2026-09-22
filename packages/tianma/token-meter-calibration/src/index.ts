/**
 * CJK-aware token-meter calibration.
 *
 * The upstream token meter prices every text span at a fixed 4 chars/token, so
 * Chinese-heavy sessions read 2–3× lighter than the provider bills them:
 * pressure stays low and compaction triggers late. This plugin corrects the
 * meter's own measurement with two factors — the session surface's density
 * ratio (CJK spans at 1.5 chars/token, everything else unchanged) and a rolling
 * residual from reported-versus-estimated usage — and records those usage
 * samples so the residual survives restarts.
 *
 * The correction is the identity for a non-CJK surface with no recorded
 * sample, in which case the meter's own measurement object is returned
 * unchanged.
 *
 * @module @tianma/dsh-token-meter-calibration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { rescaleMeasurement } from './measure.ts'
import { UsageCalibrator, defaultStatePath } from './service.ts'

export {
  CJK_CHARS_PER_TOKEN,
  NON_CJK_CHARS_PER_TOKEN,
  countCjkCodePoints,
  estimateTextTokensCalibrated,
} from './density.ts'
export { estimateMessageTokens } from './estimate.ts'
export type { TextPricing } from './estimate.ts'
export { densityRatio, priceMessages, priceSession } from './surface.ts'
export type { DensityPrices } from './surface.ts'
export { rescaleMeasurement } from './measure.ts'
export { CalibrationFactor } from './factor.ts'
export type { CalibrationFactorSnapshot } from './factor.ts'
export { UsageCalibrator, defaultStatePath, scanSessionUsages } from './service.ts'
export type { CalibrationPersisted, UsageSample } from './service.ts'

export const name = 'tianma-token-calibration'

/**
 * The meter this plugin corrects. Injecting it both orders the plugin after the
 * meter and guarantees `ctx.tokenMeter` resolves at apply time.
 */
export const inject = ['tokenMeter']

/** Rolling sample window kept by a fresh calibration state file. */
export const DEFAULT_WINDOW = 256

const CONFIG_KEYS: ReadonlySet<string> = new Set(['statePath', 'window'])

/** Plugin configuration. */
export interface Config {
  /** Calibration state file path (default `<harness home>/tianma-calibration.json`). */
  statePath?: string
  /** Rolling reported/estimated sample window (default {@link DEFAULT_WINDOW}). */
  window?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tianmaTokenCalibration: UsageCalibrator
  }
}

/**
 * Reject stale or misspelled keys before defaults can hide them.
 * @param config - raw plugin configuration.
 * @returns the resolved state path and sample window.
 * @throws when an unknown key or an empty state path is supplied.
 */
function resolveConfig(config: Config): { statePath: string; window: number } {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`TokenCalibrationConfig: unknown key "${key}" (allowed: statePath, window)`)
    }
  }
  if (config.statePath !== undefined && config.statePath.length === 0) {
    throw new Error('TokenCalibrationConfig: statePath must be a non-empty string')
  }
  return {
    statePath: config.statePath ?? defaultStatePath(),
    window: config.window ?? DEFAULT_WINDOW,
  }
}

/**
 * Every token the provider billed for one call. Reasoning output is already
 * inside `outputTokens`, so the four buckets are disjoint.
 * @param usage - the provider's reported usage for one request.
 * @returns the reported total across input, both cache buckets, and output.
 */
function reportedTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/**
 * Plugin body: registers the calibration service, samples reported usage, and
 * corrects the meter's measurement for the session it is measuring.
 *
 * The measurement correction replaces `tokenMeter.measure` on the service
 * instance for this plugin's lifetime, because the meter publishes no pricing
 * extension point. Disposal restores the original method.
 *
 * @param ctx - the Cordis context the plugin mounts in.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const calibrator = new UsageCalibrator(resolved.statePath, resolved.window)
  ctx.provide('tianmaTokenCalibration', calibrator)

  ctx.effect(() => {
    const meter = ctx.tokenMeter
    const original = meter.measure
    meter.measure = (session: Session, requestHeader) => {
      const measurement = original.call(meter, session, requestHeader)
      const multiplier = calibrator.sessionMultiplier(session)
      return multiplier === 1 ? measurement : rescaleMeasurement(measurement, multiplier)
    }
    return () => {
      meter.measure = original
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return
    const reported = reportedTokens(event.data.usage)
    if (reported <= 0) return
    const estimated = calibrator.estimateSession(session).calibratedTokens
    if (estimated <= 0) return
    calibrator.record(estimated, reported)
  })

  ctx.effect(() => () => {
    calibrator.persist()
  })
}
