/**
 * Token-meter calibration cores: CJK-aware density pricing and a rolling
 * usage-calibration factor. Pure functions and state containers only — the
 * integration step (listening to request usage, wrapping the `tokenMeter`
 * measurement, persisting factors through the storage seam) is deliberately
 * a separate change so this core lands reviewable and CI-pinned first.
 *
 * @module @tianma/dsh-token-meter-calibration
 */

export {
  CJK_CHARS_PER_TOKEN,
  NON_CJK_CHARS_PER_TOKEN,
  countCjkCodePoints,
  estimateTextTokensCalibrated,
} from './density.ts'
export { CalibrationFactor } from './factor.ts'
export type { CalibrationFactorSnapshot } from './factor.ts'
