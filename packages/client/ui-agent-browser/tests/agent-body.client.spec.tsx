// @vitest-environment jsdom
/** Agent tab body: the surface rectangle it reports to the Desktop shell, and its status copy. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserState } from '../src/client/store.ts'
import { createAgentBrowserStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { AgentBody } from '../src/client/view/AgentBody.tsx'
import type { AgentBrowserBodyProps } from '../src/client/view/AgentBody.tsx'

/** jsdom has no ResizeObserver; the body only needs observe/disconnect. */
class ObservedResize {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', ObservedResize) })
afterEach(cleanup)

function translate(key: keyof typeof en): string { return en[key] }

/**
 * Build the body's shares around one store and one presenter.
 * @param present - presenter under test; omitted while no Session binding exists.
 * @returns the props and the store the body renders.
 */
function bodyProps(present: AgentBrowserBodyProps['present']): {
  readonly props: AgentBrowserBodyProps
  readonly store: ReturnType<ReturnType<typeof createAgentBrowserStore>['create']>
} {
  const store = createAgentBrowserStore().create()
  const state = (): AgentBrowserState => store.getSnapshot()
  const props = {
    useStore: <Selected,>(selector: (value: AgentBrowserState) => Selected): Selected => selector(state()),
    t: translate,
    present,
  } as AgentBrowserBodyProps
  return { props, store }
}

describe('AgentBody', () => {
  it('reports the measured surface to the shell', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 12, y: 34, width: 700, height: 500, top: 34, left: 12, right: 712, bottom: 534, toJSON: () => ({}),
    })
    const present = vi.fn()
    const { props } = bodyProps(present)
    render(<AgentBody {...props} />)
    expect(present).toHaveBeenCalledWith({ x: 12, y: 34, width: 700, height: 500 })
  })

  it('reports null for a collapsed measurement instead of a one-pixel surface', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
    })
    const present = vi.fn()
    const { props } = bodyProps(present)
    render(<AgentBody {...props} />)
    expect(present).toHaveBeenCalledWith(null)
    expect(present).toHaveBeenCalledTimes(1)
  })

  it('reports once the presenter arrives after the first render', () => {
    const present = vi.fn()
    const withoutPresenter = bodyProps(undefined)
    const view = render(<AgentBody {...withoutPresenter.props} />)
    expect(present).not.toHaveBeenCalled()
    // The renderer supplies an inject face only once the Session binding resolves.
    const { props } = bodyProps(present)
    view.rerender(<AgentBody {...props} />)
    expect(present).toHaveBeenCalledTimes(1)
  })

  it('stops presenting when the body unmounts', () => {
    const present = vi.fn()
    const { props } = bodyProps(present)
    const view = render(<AgentBody {...props} />)
    present.mockClear()
    view.unmount()
    expect(present).toHaveBeenCalledWith(null)
  })

  it('shows the command while busy and the residual state otherwise', () => {
    const { props, store } = bodyProps(vi.fn())
    const view = render(<AgentBody {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en['activity.offscreen'])
    // The framework's selector hook re-renders on a store change; this stub reads the
    // snapshot per render, so the test drives the render the change would cause.
    store.actions.set({ busy: true, presented: false, command: 'navigate' })
    view.rerender(<AgentBody {...props} />)
    expect(screen.getByRole('status').textContent).toContain('navigate')
    store.actions.set({ busy: false, presented: true })
    view.rerender(<AgentBody {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en['activity.idle'])
  })
})
