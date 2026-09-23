// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SkillPageRow, SkillsPageState } from '../src/client/skills-page.ts'
import { SKILL_FILTER_THRESHOLD } from '../src/client/skills-page.ts'
import { SkillsPanel, type SkillsPanelProps } from '../src/client/SkillsPanel.tsx'
import { SkillsPanelIcon } from '../src/client/SkillsPanelIcon.tsx'
import { en, type SkillKey as SkillLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const translate = (dict: typeof en): SkillsPanelProps['t'] => ((key: SkillLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), dict[key])) as SkillsPanelProps['t']

const t = translate(en)

const unusedStandardHook = (): never => { throw new Error('Skills panel fixture does not provide global state') }

function state(overrides: Partial<SkillsPageState> = {}): SkillsPageState {
  return {
    status: 'ready', error: undefined, available: [], disabled: [], writable: true, busy: [], writeFailed: false,
    ...overrides,
  }
}

function row(name: string, overrides: Partial<SkillPageRow> = {}): SkillPageRow {
  return { name, description: `${name} description`, modelInvocable: true, ...overrides }
}

function mount(page: SkillsPageState, actions: Partial<Pick<SkillsPanelProps, 'ensure' | 'refresh' | 'setEnabled' | 'openFile'>> = {}) {
  const store = createSnapshotStore(page)
  const props: SkillsPanelProps = {
    usePanelInfo: unusedStandardHook,
    useWorkspaces: unusedStandardHook,
    useSessions: unusedStandardHook,
    useSessionStatus: unusedStandardHook,
    useSessionRetainInfo: unusedStandardHook,
    useResource: unusedStandardHook,
    t,
    useSkillsPage: bindSnapshotSelector(store),
    ensure: vi.fn(),
    refresh: vi.fn(),
    setEnabled: vi.fn(),
    openFile: vi.fn(),
    ...actions,
  }
  render(<SkillsPanel {...props} />)
  return props
}

const switchOf = (name: string): HTMLButtonElement =>
  screen.getByRole('switch', { name: t('row.toggle', { name }) }) as HTMLButtonElement

describe('SkillsPanel', () => {
  it('reads the page on mount and renders the available group with its tags and actions', () => {
    const ensure = vi.fn()
    const openFile = vi.fn()
    mount(state({
      available: [row('a', { path: '/x/a/SKILL.md' }), { ...row('b'), modelInvocable: false }],
    }), { ensure, openFile })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: t('page.title') })).toBeTruthy()
    expect(screen.getByText('a description')).toBeTruthy()
    expect(screen.getByText(t('menu.userOnly'))).toBeTruthy()
    // Only a row with a known instruction file offers the reveal.
    const inspect = screen.getAllByRole('button', { name: t('row.file', { name: 'a' }) })
    expect(inspect).toHaveLength(1)
    fireEvent.click(inspect[0]!)
    expect(openFile).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('button', { name: t('row.file', { name: 'b' }) })).toBeNull()
    expect(screen.getByText(t('page.count', { total: '2', off: '0' }))).toBeTruthy()
  })

  it('switches a skill off and on through the page face', () => {
    const setEnabled = vi.fn()
    mount(state({ available: [row('a')], disabled: [row('b')] }), { setEnabled })
    fireEvent.click(switchOf('a'))
    expect(setEnabled).toHaveBeenCalledWith('a', false)
    fireEvent.click(switchOf('b'))
    expect(setEnabled).toHaveBeenCalledWith('b', true)
  })

  it('marks a busy row and locks every switch when the Host is read-only', () => {
    mount(state({ available: [row('a'), row('b')], busy: ['a'], writable: false }))
    expect(switchOf('a').disabled).toBe(true)
    expect(switchOf('b').disabled).toBe(true)
    expect(screen.getByText(t('state.readOnly'))).toBeTruthy()
  })

  it('names the row whose write failed', () => {
    mount(state({ available: [row('a')], writeFailed: true }))
    expect(screen.getByText(t('state.writeFailed'))).toBeTruthy()
  })

  it('shows the selection guidance while no session is open', () => {
    mount(state({ status: 'no-session' }))
    expect(screen.getByText(t('state.noSession.title'))).toBeTruthy()
    expect(screen.getByText(t('state.noSession.body'))).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders the loading state', () => {
    mount(state({ status: 'loading' }))
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(t('state.loading'))).toBeTruthy()
  })

  it('renders the failure with its diagnostic and retries through refresh', () => {
    const refresh = vi.fn()
    mount(state({ status: 'error', error: 'catalog unavailable' }), { refresh })
    expect(screen.getByText(t('state.error.title'))).toBeTruthy()
    expect(screen.getByText('catalog unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('state.error.retry') }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('renders the empty composition', () => {
    mount(state())
    expect(screen.getByText(t('state.empty.title'))).toBeTruthy()
    expect(screen.getByText(t('state.empty.body'))).toBeTruthy()
  })

  it('refreshes from the toolbar and stays idle while not ready', () => {
    const refresh = vi.fn()
    mount(state({ available: [row('a')] }), { refresh })
    const refreshButton = screen.getByRole('button', { name: t('page.refresh') })
    fireEvent.click(refreshButton)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('offers the filter box past the threshold and matches names and descriptions', () => {
    const available = Array.from({ length: SKILL_FILTER_THRESHOLD + 1 }, (_, index) => row(`skill-${index}`))
    const props = mount(state({ available, disabled: [row('zzz-off'), { name: 'bare-off', description: undefined, modelInvocable: false }] }))
    const filter = screen.getByRole('searchbox', { name: t('page.filter.label') }) as HTMLInputElement
    fireEvent.change(filter, { target: { value: 'skill-1' } })
    // A name hit keeps only its own row; the off rows leave the list.
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    fireEvent.change(filter, { target: { value: 'zzz-off description' } })
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    fireEvent.change(filter, { target: { value: 'no such skill' } })
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByText(t('state.noMatch'))).toBeTruthy()
    expect(props.ensure).toHaveBeenCalledTimes(1)
  })

  it('keeps the filter box hidden under the threshold', () => {
    mount(state({ available: [row('a')] }))
    expect(screen.queryByRole('searchbox', { name: t('page.filter.label') })).toBeNull()
  })

  it('renders the sidebar glyph at the size the rail asks for', () => {
    const unread = (): never => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<SkillsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
  })
})
