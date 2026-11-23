/** Sidebar rail glyph for the workbench entry: the four-panel grid. */

/**
 * @param props - the rail's icon size.
 * @returns the grid glyph.
 */
export function WorkbenchIcon({ size = 18 }: { size?: number }) {
  return <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="7.5" height="9" rx="1.8" />
    <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.8" />
    <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.8" />
    <rect x="3" y="15" width="7.5" height="6" rx="1.8" />
  </svg>
}
