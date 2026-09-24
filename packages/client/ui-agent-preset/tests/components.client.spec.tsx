// @vitest-environment jsdom
/**
 * The two conversation-adjacent surfaces: the new-session chip naming the
 * next session's preset, and the session header's read-only label. The split
 * is the host's rule — a session's history is produced under its preset's
 * tools, so the choice is only ever offered before one starts.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionRetainInfo } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelProps } from '../src/client/AgentPresetLabel.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatProps } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import type { AgentPresetOption } from '../src/client/settings-store.ts'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { MORE_ROW_ID, presetMenuEntries, presetMenuSelectedId } from '../src/client/preset-menu.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROSTER_READY: AgentPresetSettingsState = {
  status: 'ready',
  error: null,
  options: [{ id: 'standard' }, { id: 'mine' }],
}

const SEAT_READY: AgentPresetSeatState = {
  showPicker: true,
  current: 'standard',
  options: [
    { id: 'standard' },
    { id: 'mine' },
  ],
  busy: false,
  error: null,
  introduce: false,
}

const useSessionRetainInfo = <Selected,>(selector: (value: undefined) => Selected): Selected => selector(undefined)

/** The runtime's own `{name}` substitution, so a test reads the shown text. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function renderSeat(
  state: Partial<AgentPresetSeatState> = {},
  select: () => Promise<string | undefined> = () => Promise.resolve(undefined),
  session?: { id: string; retainInfo: SessionRetainInfo | undefined },
) {
  const store = createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, ...state })
  const developerTools = createSnapshotStore(true)
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn(select), introduced: vi.fn() }
  render(<AgentPresetSeat {...({
    ...actions,
    sessionId: session === undefined ? undefined : SessionId(session.id),
    useShowPresetPicker: bindSnapshotSelector(developerTools),
    useAgentPresetSeat: bindSnapshotSelector(store),
    useSessionRetainInfo: session === undefined
      ? useSessionRetainInfo
      : <Selected,>(selector: (value: SessionRetainInfo | undefined) => Selected) => selector(session.retainInfo),
    t: translate,
  } as unknown as AgentPresetSeatProps)} />)
  return { ...actions, developerTools }
}

function renderLabel(
  summary: { blank: boolean; projectionValues?: { agentPreset?: string | null } } | undefined,
  roster: Partial<AgentPresetSettingsState> = {},
) {
  // The chip and the label read the same roster, metadata included.
  const store = createSnapshotStore<AgentPresetSettingsState>({
    ...ROSTER_READY, options: SEAT_READY.options, ...roster,
  })
  const sessions = createSnapshotStore({ byId: summary === undefined ? {} : { s1: summary } })
  const load = vi.fn(() => Promise.resolve())
  const view = render(<AgentPresetLabel {...({
    load,
    sessionId: 's1',
    useSessions: bindSnapshotSelector(sessions),
    useAgentPresets: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetLabelProps)} />)
  return { load, view }
}

describe('the new-session chip', () => {
  it('renders nothing while the picker is disabled', () => {
    renderSeat({ showPicker: false })

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders only for a Session retained by the main view', () => {
    renderSeat({}, undefined, {
      id: 's1', retainInfo: { referenceCount: 1, retainedBy: { mainView: 1 } },
    })
    expect(screen.getByRole('button')).toBeTruthy()
    cleanup()

    renderSeat({}, undefined, { id: 's1', retainInfo: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads the roster once and shows the staged preset by name', async () => {
    const actions = renderSeat()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
    expect(screen.getByRole('button').getAttribute('title')).toBe(en.seatHint)
  })

  it('offers each preset with what it is for', () => {
    renderSeat()

    fireEvent.click(screen.getByRole('button'))

    // The id alone never said what a preset does; the description is the
    // whole reason a preset can publish metadata at all. A shipped preset's row
    // reads the picker's one-line summary, not the settings card's longer claim.
    expect(screen.getByText(en.presetStandardSummary)).toBeTruthy()
    // A preset that published none still reads as a row, with its id standing
    // in for the name.
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    expect(screen.getByText('mine')).toBeTruthy()
  })

  it('closes the picker immediately when developer tools turn off without changing the staged preset', () => {
    const actions = renderSeat()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(en.presetStandardSummary)).toBeTruthy()
    act(() => { actions.developerTools.set(false) })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(en.presetStandardSummary)).toBeNull()
    expect(actions.select).not.toHaveBeenCalled()
    act(() => { actions.developerTools.set(true) })
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
  })

  it('falls back to the id when the staged preset published no name', () => {
    renderSeat({ current: 'mine' })

    expect(screen.getByRole('button').textContent).toContain('mine')
  })

  it('shows the staged id until a stale roster contains it', () => {
    renderSeat({ current: 'arriving' })

    expect(screen.getByRole('button').textContent).toContain('arriving')
  })

  it('stages the picked preset and closes the menu', () => {
    const actions = renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByText('mine'))

    expect(actions.select).toHaveBeenCalledWith('mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('disables the trigger while a switch is in flight', () => {
    renderSeat({ busy: true })

    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
  })

  it('shows a refused switch on the trigger', () => {
    renderSeat({ error: 'session has already started' })

    expect(screen.getByRole('button').getAttribute('title')).toBe('session has already started')
  })

  it('renders nothing before the roster arrives or when there is none', () => {
    const empty = renderSeat({ options: [] })
    expect(empty).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()

    renderSeat({ current: '' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('closes on an outside dismissal', () => {
    renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the picker’s groups', () => {
  /** Every shipped preset, so each group has rows. */
  const shipped: readonly AgentPresetOption[] = [
    { id: 'standard' }, { id: 'ptc' }, { id: 'minimal' },
    { id: 'cordis' }, { id: 'tech' }, { id: 'business' },
  ]

  it('asks how tools are called before whose standards they follow', () => {
    renderSeat({ options: shipped })
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText(en.presetPickerIntro)).toBeTruthy()
    expect(screen.getByText(en.presetGroupWork)).toBeTruthy()
    expect(screen.getByText(en.presetGroupTeam)).toBeTruthy()
    // The heading's claim also rides its own rows, so a row read on its own
    // still says which group it belongs to.
    expect(screen.getAllByText(en.presetTeamTag)).toHaveLength(2)

    const text = document.body.textContent ?? ''
    expect(text.indexOf(en.presetGroupWork)).toBeLessThan(text.indexOf(en.presetGroupTeam))
    expect(text.indexOf(en.presetTechSummary)).toBeLessThan(text.indexOf(en.presetBusinessSummary))
  })

  it('leaves the demoted modes closed until their row is opened', () => {
    const actions = renderSeat({ options: shipped })
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText(en.presetMoreHint)).toBeTruthy()
    expect(screen.queryByText(en.presetMinimalSummary)).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(en.presetMore) }))

    // Opening the group is not a pick: nothing is staged and the picker stays
    // up, so a mode inside it is still one click away.
    expect(actions.select).not.toHaveBeenCalled()
    expect(screen.getByText(en.presetMinimalSummary)).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(en.presetMinimalSummary) }))

    expect(actions.select).toHaveBeenCalledWith('minimal')
  })

  it('closes the demoted group again with the picker', () => {
    renderSeat({ options: shipped })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(en.presetMore) }))
    expect(screen.getByText(en.presetMinimalSummary)).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button'))

    expect(screen.queryByText(en.presetMinimalSummary)).toBeNull()
  })

  it('gives a deployment’s own presets their own group, with the copy they published', () => {
    renderSeat({
      options: [...shipped, { id: 'mine', name: 'My mode', description: 'Deployment copy.' }],
    })
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText(en.customGroup)).toBeTruthy()
    expect(screen.getByText('My mode')).toBeTruthy()
    expect(screen.getByText('Deployment copy.')).toBeTruthy()
  })
})

describe('the picker’s row rules', () => {
  it('marks the collapsed disclosure while the current preset is behind it', () => {
    // Folding the group away must not hide which mode is in force.
    expect(presetMenuSelectedId('minimal', false)).toBe(MORE_ROW_ID)
    // Open, the row itself carries the mark.
    expect(presetMenuSelectedId('minimal', true)).toBe('minimal')
    expect(presetMenuSelectedId('tech', false)).toBe('tech')
  })

  it('omits a group the deployment composes no presets for', () => {
    const entries = presetMenuEntries({ options: [{ id: 'standard' }], t: translate, moreOpen: false })

    const labels = entries.flatMap(entry => 'type' in entry && entry.type === 'label' ? [entry.text] : [])
    const rowIds = entries.flatMap(entry => 'type' in entry ? [] : [entry.id])

    expect(labels).toEqual([en.presetPickerIntro, en.presetGroupWork])
    expect(rowIds).toEqual(['standard'])
  })
})

describe('the mode glyph', () => {
  /** The chip's leading glyph, drawn for one staged preset. */
  function chipGlyph(current: string): string | undefined {
    renderSeat({ current })
    const drawn = screen.getByRole('button').querySelector('svg')?.innerHTML
    cleanup()
    return drawn
  }

  it('follows the mode, and falls back to the generic agent glyph', () => {
    const standard = chipGlyph('standard')

    expect(chipGlyph('tech')).not.toBe(standard)
    expect(chipGlyph('ptc')).not.toBe(chipGlyph('business'))
    // A preset this package does not know keeps the generic glyph.
    expect(chipGlyph('mine')).toBe(standard)
  })

  it('draws the same glyph in the session header', () => {
    const headerGlyph = (id: string): string | undefined => {
      const { view } = renderLabel({ blank: false, projectionValues: { agentPreset: id } })
      const drawn = view.container.querySelector('svg')?.innerHTML
      cleanup()
      return drawn
    }

    expect(headerGlyph('tech')).toBe(chipGlyph('tech'))
    expect(headerGlyph('standard')).not.toBe(headerGlyph('tech'))
  })
})

describe('a refused switch', () => {
  it('announces the reason instead of letting the label snap back in silence', async () => {
    // The banner's own timer has to be a fake one from the start, or the
    // lifetime assertion below would wait out its real nine seconds.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const reason = 'failed to import loader entry live-on-mac (@deepseek-ai/dsh-also-gone)'
      renderSeat({}, () => Promise.resolve(reason))

      fireEvent.click(screen.getByRole('button'))
      fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

      // The host refuses a mount discovery reported healthy, so this banner is
      // the only place the cause appears — the chip has already reverted and
      // the settings row shows the preset as fine.
      const banner = await screen.findByRole('alert')
      expect(banner.textContent).toContain(reason)
      expect(banner.textContent).toContain('mine')

      // Transient by design: it holds long enough to read a cause that names
      // packages, then leaves rather than sitting over the screen.
      act(() => { vi.advanceTimersByTime(9001) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the switch lands', async () => {
    const actions = renderSeat()

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

    await waitFor(() => { expect(actions.select).toHaveBeenCalledWith('mine') })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the chip introduce cue', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Character spans carry inline animation delays; nothing else does. */
  function delayedChars(): HTMLElement[] {
    return Array.from(screen.getByRole('button').querySelectorAll<HTMLElement>('[style]'))
  }

  it('reveals a long Latin name inside the shared window, then acknowledges', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: 'CreatorMode' }],
      introduce: true,
    })

    // Eleven characters split the 200ms window into 20ms steps, where the
    // fixed 40ms tick would have doubled the run for a Latin name.
    const chars = delayedChars()
    expect(chars.map(span => span.textContent).join('')).toBe('CreatorMode')
    expect(chars[0]!.style.animationDelay).toBe('150ms')
    expect(chars[1]!.style.animationDelay).toBe('170ms')
    expect(chars[10]!.style.animationDelay).toBe('350ms')

    // 150 delay + 200 window + 400 fade: acknowledged only once the last
    // character has settled, and the label is plain text again after.
    act(() => { vi.advanceTimersByTime(749) })
    expect(actions.introduced).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('keeps the per-tick cap for a short CJK name', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: '创造模式' }],
      introduce: true,
    })

    // Four characters fit under the window, so the 40ms tick applies as-is.
    const chars = delayedChars()
    expect(chars).toHaveLength(4)
    expect(chars[1]!.style.animationDelay).toBe('190ms')
    expect(chars[3]!.style.animationDelay).toBe('270ms')
  })

  it('starts a one-character name with no stagger at all', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: 'C' }],
      introduce: true,
    })

    expect(delayedChars()[0]!.style.animationDelay).toBe('150ms')
    act(() => { vi.advanceTimersByTime(550) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
  })

  it('skips the run under reduced motion and acknowledges at once', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const actions = renderSeat({ introduce: true })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('acknowledges an empty staged name without arming a run', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: '' }],
      introduce: true,
    })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })
})

describe('the session-header label', () => {
  it('names the preset the session runs, and never offers a switch', async () => {
    const { load } = renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    })

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    // A control here would promise a switch the host refuses outright.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTitle(en.presetStandardDescription).textContent).toBe(en.presetStandardName)
  })

  it('falls back to the id, and to the generic hint, when metadata is absent', () => {
    renderLabel({ blank: true, projectionValues: { agentPreset: 'mine' } })

    expect(screen.getByTitle(en.headerHint).textContent).toBe('mine')
  })

  it('shows the id until the roster resolves it', () => {
    renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    }, { options: [] })

    // The session's own summary is the authority on which preset it runs; the
    // roster only supplies the display name, and its arrival is a later frame.
    expect(screen.getByTitle(en.headerHint).textContent).toBe('standard')
  })

  it('renders nothing, and reads no roster, when the session records no preset', async () => {
    const absent = renderLabel({ blank: true })
    expect(absent.view.container.firstChild).toBeNull()
    cleanup()

    // A session the list has not caught up to is the same answer: a deployment
    // that composes no presets must not pay for a roster read per header.
    const unknown = renderLabel(undefined)
    expect(unknown.view.container.firstChild).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(absent.load).not.toHaveBeenCalled()
    expect(unknown.load).not.toHaveBeenCalled()
  })
})
