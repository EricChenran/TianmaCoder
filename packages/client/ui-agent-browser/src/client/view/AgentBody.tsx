/** Agent tab body: reports its surface rectangle, shows the agent's activity, and drives the page. */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  GuideArtworkBrowser,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAgentBrowserCommandArgs, DesktopAgentBrowserPane } from '../../types.ts'
import type { AgentBrowserState, AgentBrowserStore } from '../store.ts'
import { activityDot, activityWord } from './activity.ts'
import { readSurfaceBox } from './surface-box.ts'
import css from './AgentBody.module.css'

/** How often the pane re-reads its box while it is open; see the sweep below. */
export const SURFACE_SWEEP_MS = 250

/** Viewport sizes the pane's own control offers, in layout viewport pixels. */
export const VIEWPORT_PRESETS = [
  { id: 'mobile', width: 375, height: 667 },
  { id: 'phone', width: 414, height: 896 },
  { id: 'tablet', width: 768, height: 1024 },
  { id: 'desktop', width: 1280, height: 720 },
  { id: 'wide', width: 1920, height: 1080 },
] as const

/** Control value that returns the page viewport to whatever the pane measures. */
const FOLLOW_PANE = 'follow'

/** Control value the pane shows for a viewport the automation set outside the presets. */
const CUSTOM = 'custom'

/** Data the pane injects: binds the Session's guest to this occurrence's surface, and drives it. */
export interface AgentBrowserInjected {
  /** Bind the Session's lease to a surface rectangle, or `null` to stop presenting. */
  readonly present: (pane: DesktopAgentBrowserPane | null) => void
  /** Run one command on the Session's lease; absent outside the Desktop shell. */
  readonly command?: (name: string, args: DesktopAgentBrowserCommandArgs) => void
}

/** Props the Agent Browser body receives from its slot shares. */
export type AgentBrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<AgentBrowserStore>
  & PropsLocale<'agentBrowser'>
  & Partial<AgentBrowserInjected>

/** Stable selector: the pane renders the whole activity state. */
const selectActivity = (state: AgentBrowserState): AgentBrowserState => state

/**
 * What the viewport control shows for the state in force, and the size its own option
 * labels it with: the pane's size, one preset, or a size the automation chose that no
 * preset names.
 * @param activity - activity facts of this Session's lease.
 * @returns The control value, with a label only for a size outside the presets.
 */
function viewportChoice(activity: AgentBrowserState): { readonly value: string; readonly label?: string } {
  const viewport = activity.viewport
  if (activity.follow === true || viewport === undefined) return { value: FOLLOW_PANE }
  const preset = VIEWPORT_PRESETS.find(entry => entry.width === viewport.width && entry.height === viewport.height)
  return preset === undefined
    ? { value: CUSTOM, label: `${String(viewport.width)}×${String(viewport.height)}` }
    : { value: preset.id }
}

/**
 * The shell draws the agent guest over the measured surface, so the strip and the
 * toolbar stay above it. The body only measures and asks for commands; it holds no
 * Electron access and subscribes to nothing.
 * @param props - slot shares; `present` and `command` are absent outside the Desktop shell.
 * @returns the activity strip, the pane's own controls, and the surface the guest occupies.
 */
export function AgentBody(props: AgentBrowserBodyProps): ReactElement {
  const surface = useRef<HTMLDivElement | null>(null)
  /** The last box reported to the shell; `undefined` before the presenter hears anything. */
  const reported = useRef<string | null | undefined>(undefined)
  /** Address the human typed, kept only until the page reports a different address. */
  const [draft, setDraft] = useState<{ readonly url: string | undefined; readonly value: string } | undefined>(undefined)
  const { present, command, t } = props
  const activity = props.useStore(selectActivity)
  // A pane can render before its Session binding resolves, and the presenter then
  // arrives or changes with the resolved Session, so measurement follows its identity
  // instead of running once on mount and reporting under a key no lease ever had.
  useEffect(() => {
    const element = surface.current
    if (element === null || present === undefined) return
    // A presenter that just arrived has been told nothing yet. `undefined` distinguishes
    // that from a pane already known to present nothing (`null`), which must still be said.
    reported.current = undefined
    const report = (): void => {
      const box = readSurfaceBox(element)
      const key = box === null ? null : `${box.x},${box.y},${box.width},${box.height}`
      if (key === reported.current) return
      reported.current = key
      present(box)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    // A pane can move without resizing — the Sidebar slides, re-docks, and takes the
    // column fullscreen — and no resize observer reports a move, so the box is re-read
    // until it settles. Reporting is deduplicated above, so an unchanged pane costs one
    // measure and no message.
    const sweep = window.setInterval(report, SURFACE_SWEEP_MS)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.clearInterval(sweep)
      window.removeEventListener('resize', report)
      present(null)
    }
  }, [present])
  const address = draft !== undefined && draft.url === activity.url ? draft.value : activity.url ?? ''
  const choice = viewportChoice(activity)
  const chooseViewport = (value: string): void => {
    if (value === FOLLOW_PANE) { command?.('viewport', { follow: true }); return }
    const preset = VIEWPORT_PRESETS.find(entry => entry.id === value)
    if (preset !== undefined) command?.('viewport', { width: preset.width, height: preset.height })
  }
  const placeholder = activity.presented ? null : (
    <div className={css.placeholder}>
      <GuideArtworkBrowser size={36} className={css.placeholderArt} />
      <span className={css.placeholderHint}>{t('body.placeholder')}</span>
    </div>
  )
  return (
    <div className={css.root}>
      <div role="status" className={css.strip}>
        <StateDot state={activityDot(activity)} />
        {activityWord(t, activity)}
      </div>
      <form
        className={css.toolbar}
        onSubmit={(event) => {
          event.preventDefault()
          if (address === '') return
          command?.('navigate', { url: address })
        }}
      >
        <button type="button" className={css.tool} aria-label={t('toolbar.back')} title={t('toolbar.back')}
          disabled={command === undefined} onClick={() => { command?.('back', {}) }}>
          <IconChevronLeftOutlineRegular />
        </button>
        <button type="button" className={css.tool} aria-label={t('toolbar.forward')} title={t('toolbar.forward')}
          disabled={command === undefined} onClick={() => { command?.('forward', {}) }}>
          <IconChevronRightOutlineRegular />
        </button>
        <button type="button" className={css.tool} aria-label={t('toolbar.reload')} title={t('toolbar.reload')}
          disabled={command === undefined} onClick={() => { command?.('reload', {}) }}>
          <IconRefreshOutlineRegular />
        </button>
        <div className={css.addressBox}>
          <input
            className={css.address}
            value={address}
            aria-label={t('toolbar.address')}
            placeholder={t('toolbar.addressHint')}
            spellCheck={false}
            disabled={command === undefined}
            onChange={(event) => { setDraft({ url: activity.url, value: event.currentTarget.value }) }}
          />
          <button type="submit" className={[css.tool, css.addressGo].join(' ')}
            aria-label={t('toolbar.go')} title={t('toolbar.go')} disabled={command === undefined}>
            <IconLinkOutlineRegular />
          </button>
        </div>
        <select
          className={css.viewport}
          aria-label={t('toolbar.viewport')}
          title={t('toolbar.viewport')}
          value={choice.value}
          disabled={command === undefined}
          onChange={(event) => { chooseViewport(event.currentTarget.value) }}
        >
          <option value={FOLLOW_PANE}>{t('toolbar.viewportFollow')}</option>
          {VIEWPORT_PRESETS.map(preset => (
            <option key={preset.id} value={preset.id}>
              {`${String(preset.width)}×${String(preset.height)}`}
            </option>
          ))}
          {choice.value === CUSTOM && (
            <option value={CUSTOM}>{`${t('toolbar.viewportCustom')} ${choice.label ?? ''}`}</option>
          )}
        </select>
      </form>
      <div ref={surface} className={css.surface}>{placeholder}</div>
    </div>
  )
}
