/** Reading the pane surface the agent's guest should occupy. */
import type { DesktopAgentBrowserPane } from '../../types.ts'

/** Smallest surface worth presenting; anything thinner is a measurement mid-layout. */
export const MIN_SURFACE_SIDE = 2

/**
 * Read the rectangle the guest should occupy.
 *
 * Size alone does not say whether the pane is showing: the Sidebar hides a pane by
 * `visibility` and re-docks a column without resizing it, so both keep the element's
 * box. A hidden or collapsed pane therefore reports no surface at all, which is what
 * makes the shell park the guest instead of leaving it drawn where the pane used to be.
 * @param element - the surface element the pane measures.
 * @returns the rectangle in window coordinates, or `null` when nothing is presented.
 */
export function readSurfaceBox(element: HTMLElement): DesktopAgentBrowserPane | null {
  const rect = element.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < MIN_SURFACE_SIDE || height < MIN_SURFACE_SIDE) return null
  if (!element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return null
  return { x: Math.round(rect.left), y: Math.round(rect.top), width, height }
}
