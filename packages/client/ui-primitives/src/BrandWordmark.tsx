import type { IconProps } from './icons/props.ts'
import { TIANMA_LOGO_MAIN_PATH, TIANMA_LOGO_PULSE_PATH } from './TianmaLogo.tsx'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading signal-M mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Wordmark text metrics: the mark ends at x 24 and the type starts at x 26. */
const WORDMARK_FONT = "'Segoe UI','PingFang SC','Noto Sans SC','Helvetica Neue',Arial,sans-serif"

/**
 * Render the full brand wordmark (brand/BRAND_GUIDELINES.md §3). The artwork is
 * monochrome `currentColor` so host surfaces recolor it; the type rides the
 * system sans stack instead of outlines so no font binary ships with the UI.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading signal-M mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 132 : 106
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 132 24' : '26 0 106 24'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <g
          transform="translate(1 5.4) scale(0.14)"
          stroke="currentColor"
          strokeWidth={15}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={TIANMA_LOGO_MAIN_PATH} />
          <path d={TIANMA_LOGO_PULSE_PATH} />
        </g>
      )}
      <text
        x={26}
        y={17.5}
        fontFamily={WORDMARK_FONT}
        fontSize={15.5}
        fontWeight={700}
        letterSpacing="-0.3"
        fill="currentColor"
      >
        TianmaCoder
      </text>
    </svg>
  )
}
