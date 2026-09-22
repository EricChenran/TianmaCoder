/**
 * Measurement rescaling.
 *
 * The token meter's measurement mixes provider-reported usage — ground truth —
 * with heuristic prices. Calibration corrects only the heuristic part: node
 * prices, the surface total, the signed surface delta, and an estimated
 * baseline all scale, while a `usage` baseline passes through untouched. The
 * measure's own invariants survive the rewrite: `surfaceTokens` stays the sum
 * of the node prices, and `totalTokens` stays `baseline + surfaceDeltaTokens`
 * floored at zero.
 *
 * @module @tianma/dsh-token-meter-calibration/measure
 */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { TokenMeasurement, TokenMeasurementBaseline } from '@deepseek-ai/dsh-token-meter'

/** Scale one token count, keeping it a non-negative integer. */
function scaleTokens(tokens: number, multiplier: number): number {
  return Math.max(0, Math.round(tokens * multiplier))
}

/**
 * Rescale a measurement's heuristic prices by one multiplier.
 * @param measurement - a measurement from the token meter, left unmutated.
 * @param multiplier - density correction times rolling calibration factor.
 * @returns a detached deeply immutable measurement with the same shape.
 */
export function rescaleMeasurement(measurement: TokenMeasurement, multiplier: number): TokenMeasurement {
  const nodes = measurement.nodes.map(node => ({
    seq: node.seq,
    tokens: scaleTokens(node.tokens, multiplier),
    heuristicTokens: scaleTokens(node.heuristicTokens, multiplier),
  }))
  const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)

  let baseline: TokenMeasurementBaseline
  if (measurement.baseline.kind === 'estimated') {
    baseline = { kind: 'estimated', tokens: scaleTokens(measurement.baseline.tokens, multiplier) }
  } else {
    // `none` is zero by definition and `usage` is provider-reported ground
    // truth; neither is a heuristic estimate to correct.
    baseline = measurement.baseline
  }
  const surfaceDeltaTokens = scaleTokens(measurement.surfaceDeltaTokens, multiplier)

  return deepFreeze({
    logRevision: measurement.logRevision,
    baseline,
    surfaceDeltaTokens,
    totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
    surfaceTokens,
    nodes,
  })
}
