// @vitest-environment jsdom
/** Agent Browser tab title: the label, the activity dot, and the state word it exposes. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentBrowserState } from '../src/client/store.ts'
import { createAgentBrowserStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { AgentBrowserTitle } from '../src/client/view/AgentBrowserTitle.tsx'
import type { AgentBrowserTitleProps } from '../src/client/view/AgentBrowserTitle.tsx'

afterEach(cleanup)

function translate(key: keyof typeof en): string { return en[key] }

/**
 * Build the title's shares around one store state.
 * @param activity - activity the pane merged for this Session.
 * @returns the props to render.
 */
function titleProps(activity: Partial<AgentBrowserState>): AgentBrowserTitleProps {
  const store = createAgentBrowserStore().create()
  store.actions.set({ busy: false, presented: false, ...activity })
  const state = (): AgentBrowserState => store.getSnapshot()
  return {
    useStore: <Selected,>(selector: (value: AgentBrowserState) => Selected): Selected => selector(state()),
    t: translate,
  } as AgentBrowserTitleProps
}

/** @returns the state the rendered dot names. */
function dotState(): string | null {
  return document.querySelector('[data-state]')?.getAttribute('data-state') ?? null
}

describe('AgentBrowserTitle', () => {
  it('shows the tab label with an idle dot when nothing is presented', () => {
    render(<AgentBrowserTitle {...titleProps({})} />)
    expect(screen.getByLabelText(`${en['type.label']} · ${en['activity.offscreen']}`)).toBeDefined()
    expect(dotState()).toBe('idle')
  })

  it('shows a done dot while the lease presents a page', () => {
    render(<AgentBrowserTitle {...titleProps({ presented: true })} />)
    expect(screen.getByLabelText(`${en['type.label']} · ${en['activity.idle']}`)).toBeDefined()
    expect(dotState()).toBe('done')
  })

  it('shows an ongoing dot and names the command while the agent works', () => {
    render(<AgentBrowserTitle {...titleProps({ busy: true, presented: true, command: 'navigate' })} />)
    expect(screen.getByLabelText(`${en['type.label']} · ${en['activity.busy']} · navigate`)).toBeDefined()
    expect(dotState()).toBe('ongoing')
  })

  it('names the activity alone when a busy lease reports no command', () => {
    render(<AgentBrowserTitle {...titleProps({ busy: true })} />)
    expect(screen.getByLabelText(`${en['type.label']} · ${en['activity.busy']}`)).toBeDefined()
  })
})
