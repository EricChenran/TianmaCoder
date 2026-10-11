/**
 * The leading glyph each shipped preset shows on the surfaces that name it.
 *
 * One glyph per mode, so the picker's rows, the new-session chip, and the
 * session header all say which mode is which before its name is read. The
 * roster carries no such fact, and every mode drew the same agent glyph before
 * this table — which is why a department mode was indistinguishable from a
 * change of tool-calling style once selected.
 */

import type { ReactNode } from 'react'
import {
  IconAgentPresetOutlineRegular,
  IconChecklistOutlineRegular,
  IconCodeOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconDeliverDocRegular,
  IconPlayOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Shipped preset id → the glyph its surfaces draw. */
const MODE_ICONS: Readonly<Partial<Record<string, (props: IconProps) => ReactNode>>> = {
  /** Tools are called one at a time, the roster's own default behaviour. */
  standard: IconAgentPresetOutlineRegular,
  /** Tools are called from a program the model writes. */
  ptc: IconCodeOutlineRegular,
  /** One terminal tool and nothing else: the comparison baseline. */
  minimal: IconPlayOutlineRegular,
  /** The agent may extend DSH itself. */
  cordis: IconCordisPluginOutlineRegular,
  /** Engineering discipline and the delivery self-check. */
  tech: IconChecklistOutlineRegular,
  /** Documents delivered to a customer. */
  business: IconDeliverDocRegular,
}

/**
 * Draw the glyph for one preset.
 * @param id - preset id, as declared in composition.
 * @param size - square edge in px.
 * @param className - layout class for the placement (the chip's motion, the header's opacity).
 * @returns the mode's glyph, or the generic agent glyph for a preset this table does not know.
 */
export function presetIcon(id: string, size: number, className?: string): ReactNode {
  const Glyph = MODE_ICONS[id] ?? IconAgentPresetOutlineRegular
  return <Glyph size={size} className={className} />
}
