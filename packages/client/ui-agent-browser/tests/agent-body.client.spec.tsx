// @vitest-environment jsdom
/** Agent tab body: the surface rectangle it reports to the Desktop shell, and its status copy. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserState } from '../src/client/store.ts'
import { createAgentBrowserStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { SURFACE_SWEEP_MS, AgentBody } from '../src/client/view/AgentBody.tsx'
import type { AgentBrowserBodyProps } from '../src/client/view/AgentBody.tsx'

/** jsdom has no ResizeObserver; the body only needs observe/disconnect. */
class ObservedResize {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ObservedResize)
  // jsdom has no `checkVisibility`; the pane's own spec covers the browser-grade API.
  ;(Element.prototype as { checkVisibility: (options?: object) => boolean }).checkVisibility = () => true
})
afterEach(cleanup)

function translate(key: keyof typeof en): string { return en[key] }

/**
 * Build the body's shares around one store and one presenter.
 * @param present - presenter under test; omitted while no Session binding exists.
 * @param command - command face under test; omitted outside the Desktop shell.
 * @returns the props and the store the body renders.
 */
function bodyProps(
  present: AgentBrowserBodyProps['present'],
  command?: AgentBrowserBodyProps['command'],
): {
  readonly props: AgentBrowserBodyProps
  readonly store: ReturnType<ReturnType<typeof createAgentBrowserStore>['create']>
} {
  const store = createAgentBrowserStore().create()
  const state = (): AgentBrowserState => store.getSnapshot()
  const props = {
    useStore: <Selected,>(selector: (value: AgentBrowserState) => Selected): Selected => selector(state()),
    t: translate,
    present,
    ...(command === undefined ? {} : { command }),
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

  it('reports again when the pane moves without resizing', () => {
    vi.useFakeTimers()
    try {
      const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 1290, y: 40, width: 575, height: 721, top: 40, left: 1290, right: 1865, bottom: 761, toJSON: () => ({}),
      })
      const present = vi.fn()
      render(<AgentBody {...bodyProps(present).props} />)
      expect(present).toHaveBeenCalledTimes(1)
      // The Sidebar takes the column fullscreen and then hides it: same size, new place,
      // and no resize event, so only the sweep can notice.
      spy.mockReturnValue({
        x: 0, y: 40, width: 575, height: 721, top: 40, left: 0, right: 575, bottom: 761, toJSON: () => ({}),
      })
      vi.advanceTimersByTime(SURFACE_SWEEP_MS + 50)
      expect(present).toHaveBeenLastCalledWith({ x: 0, y: 40, width: 575, height: 721 })
      // An unchanged pane is measured again without sending anything.
      const settled = present.mock.calls.length
      vi.advanceTimersByTime(SURFACE_SWEEP_MS * 2)
      expect(present).toHaveBeenCalledTimes(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops presenting while the pane is hidden but keeps its box', () => {
    ;(Element.prototype as { checkVisibility: (options?: object) => boolean }).checkVisibility = () => false
    const present = vi.fn()
    render(<AgentBody {...bodyProps(present).props} />)
    expect(present).toHaveBeenCalledWith(null)
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

describe('AgentBody pane controls', () => {
  it('navigates to the address the human typed, and follows the page afterwards', () => {
    const command = vi.fn()
    const { props, store } = bodyProps(vi.fn(), command)
    const view = render(<AgentBody {...props} />)
    const field = screen.getByLabelText(en['toolbar.address']) as HTMLInputElement
    // An empty address asks for nothing.
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    expect(command).not.toHaveBeenCalled()
    store.actions.set({ busy: false, presented: true, url: 'https://example.com/' })
    view.rerender(<AgentBody {...props} />)
    expect(field.value).toBe('https://example.com/')
    fireEvent.change(field, { target: { value: 'https://example.com/docs' } })
    // The typed address stands while the page still reports the old one.
    view.rerender(<AgentBody {...props} />)
    expect(field.value).toBe('https://example.com/docs')
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    expect(command).toHaveBeenCalledWith('navigate', { url: 'https://example.com/docs' })
    // A page that reports a different address takes the field back from the draft.
    store.actions.set({ busy: false, presented: true, url: 'https://example.com/other' })
    view.rerender(<AgentBody {...props} />)
    expect(field.value).toBe('https://example.com/other')
  })

  it('runs back, forward, and reload on the Session\u2019s lease', () => {
    const command = vi.fn()
    render(<AgentBody {...bodyProps(vi.fn(), command).props} />)
    fireEvent.click(screen.getByLabelText(en['toolbar.back']))
    fireEvent.click(screen.getByLabelText(en['toolbar.forward']))
    fireEvent.click(screen.getByLabelText(en['toolbar.reload']))
    expect(command.mock.calls).toEqual([['back', {}], ['forward', {}], ['reload', {}]])
  })

  it('disables every control when the shell offers no command face', () => {
    render(<AgentBody {...bodyProps(vi.fn()).props} />)
    expect(screen.getByLabelText<HTMLButtonElement>(en['toolbar.back']).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en['toolbar.address']).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(en['toolbar.viewport']).disabled).toBe(true)
  })

  it('shows the viewport in force and asks for the chosen one', () => {
    const command = vi.fn()
    const { props, store } = bodyProps(vi.fn(), command)
    const view = render(<AgentBody {...props} />)
    const select = screen.getByLabelText(en['toolbar.viewport']) as HTMLSelectElement
    expect(select.value).toBe('follow')
    store.actions.set({ busy: false, presented: true, viewport: { width: 375, height: 667 }, follow: false })
    view.rerender(<AgentBody {...props} />)
    expect(select.value).toBe('mobile')
    fireEvent.change(select, { target: { value: 'tablet' } })
    expect(command).toHaveBeenCalledWith('viewport', { width: 768, height: 1024 })
    fireEvent.change(select, { target: { value: 'follow' } })
    expect(command).toHaveBeenLastCalledWith('viewport', { follow: true })
  })

  it('names a viewport the automation chose outside the presets', () => {
    const command = vi.fn()
    const { props, store } = bodyProps(vi.fn(), command)
    const view = render(<AgentBody {...props} />)
    store.actions.set({ busy: false, presented: true, viewport: { width: 1000, height: 700 }, follow: false })
    view.rerender(<AgentBody {...props} />)
    const select = screen.getByLabelText(en['toolbar.viewport']) as HTMLSelectElement
    expect(select.value).toBe('custom')
    expect(screen.getByRole('option', { name: `${en['toolbar.viewportCustom']} 1000×700` })).toBeDefined()
    // Choosing the entry already in force asks for nothing.
    fireEvent.change(select, { target: { value: 'custom' } })
    expect(command).not.toHaveBeenCalled()
  })
})
