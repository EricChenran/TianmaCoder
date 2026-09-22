/**
 * Session-surface density pricing.
 *
 * `session.deriveMessages()` already owns the model-visible surface fold and
 * caches it, so this module prices that surface under both densities rather
 * than replaying the session log. The quotient is the density correction the
 * token meter applies to its own measurement: flat and calibrated prices share
 * every structural overhead, so only the text-density difference survives, and
 * a surface whose text is entirely non-CJK yields exactly 1.
 *
 * Tool schemas are outside the priced surface here. They are JSON-dominated
 * and usually a small share of request pressure, so the message ratio is
 * applied to them unchanged.
 *
 * @module @tianma/dsh-token-meter-calibration/surface
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { estimateMessageTokens } from './estimate.ts'

/** One message set priced under both densities. */
export interface DensityPrices {
  /** Tokens under the CJK split density. */
  readonly calibratedTokens: number
  /** Tokens under the meter's fixed 4 chars/token density. */
  readonly flatTokens: number
}

/**
 * Price an explicit message list under both densities.
 * @param messages - messages to price without mutation.
 * @returns both totals over the same messages.
 */
export function priceMessages(messages: readonly Message[]): DensityPrices {
  let flatTokens = 0
  let calibratedTokens = 0
  for (const message of messages) {
    flatTokens += estimateMessageTokens(message, 'flat')
    calibratedTokens += estimateMessageTokens(message, 'calibrated')
  }
  return { calibratedTokens, flatTokens }
}

/**
 * Price one session's current model-visible message surface under both densities.
 * @param session - session whose derived history to price.
 * @returns both totals over that surface.
 */
export function priceSession(session: Session): DensityPrices {
  return priceMessages(session.deriveMessages())
}

/**
 * Density correction for one session.
 * @param session - session whose derived history to price.
 * @returns calibrated/flat tokens, or 1 when the surface prices to zero.
 */
export function densityRatio(session: Session): number {
  const prices = priceSession(session)
  if (prices.flatTokens === 0) return 1
  return prices.calibratedTokens / prices.flatTokens
}
