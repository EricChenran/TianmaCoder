import type { IconProps } from './icons/props.ts'

/** Native viewBox of the TianmaCoder mark (width and height in user units). */
export const TIANMA_LOGO_VIEWBOX = { width: 128, height: 94 }

/** The signal-M zigzag body, for consumers that compose their own svg (entrance effects, masks) around the same geometry. */
export const TIANMA_LOGO_MAIN_PATH = 'M12 79L40 15L55 79L83 15L97 79'

/** The detached pulse stroke trailing the zigzag. */
export const TIANMA_LOGO_PULSE_PATH = 'M106 15L116 51'

/**
 * Render the TianmaCoder mark (brand/BRAND_GUIDELINES.md §3).
 * @param props.size - width in px (default 24; height keeps the 128:94 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function TianmaLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * TIANMA_LOGO_VIEWBOX.height) / TIANMA_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${TIANMA_LOGO_VIEWBOX.width} ${TIANMA_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth={15} strokeLinecap="round" strokeLinejoin="round">
        <path d={TIANMA_LOGO_MAIN_PATH} />
        <path d={TIANMA_LOGO_PULSE_PATH} />
      </g>
    </svg>
  )
}
