// @vitest-environment jsdom
/** The pane's surface reading: what counts as a surface, and what counts as gone. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SURFACE_SIDE, readSurfaceBox } from '../src/client/view/surface-box.ts'

/** jsdom has no `checkVisibility`; the browser-grade API is stubbed to the measured case. */
beforeEach(() => {
  (Element.prototype as { checkVisibility: (options?: object) => boolean }).checkVisibility = () => true
})

/** @returns a rect object shaped like a DOMRect for one box. */
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) }
}

/** @returns an element whose box and visibility the test decides. */
function surface(width: number, height: number, x = 0, y = 0): HTMLElement {
  const element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(x, y, width, height))
  return element
}

describe('readSurfaceBox', () => {
  it('reads the rounded window rectangle of a shown pane', () => {
    expect(readSurfaceBox(surface(575.4, 721.6, 1290.2, 40.8))).toEqual({ x: 1290, y: 41, width: 575, height: 722 })
  })

  it('reports no surface for a pane collapsed below one usable side', () => {
    expect(readSurfaceBox(surface(MIN_SURFACE_SIDE - 1, 500))).toBeNull()
    expect(readSurfaceBox(surface(500, MIN_SURFACE_SIDE - 1))).toBeNull()
  })

  it('reports no surface while the pane is hidden but keeps its box', () => {
    ;(Element.prototype as { checkVisibility: (options?: object) => boolean }).checkVisibility = () => false
    expect(readSurfaceBox(surface(575, 721))).toBeNull()
  })
})
