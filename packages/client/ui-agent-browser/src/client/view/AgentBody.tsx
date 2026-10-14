/** Agent tab body: reports its surface rectangle and shows the agent's activity. */
import { useEffect, useRef, type ReactElement } from 'react'
import { GuideArtworkBrowser, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAgentBrowserPane } from '../../types.ts'
import type { AgentBrowserState, AgentBrowserStore } from '../store.ts'
import { activityDot, activityWord } from './activity.ts'
import { readSurfaceBox } from './surface-box.ts'
import css from './AgentBody.module.css'

/** How often the pane re-reads its box while it is open; see the sweep below. */
export const SURFACE_SWEEP_MS = 250

/** Data the pane injects: binds the Session's guest to this occurrence's surface. */
export interface AgentBrowserInjected {
  /** Bind the Session's lease to a surface rectangle, or `null` to stop presenting. */
  readonly present: (pane: DesktopAgentBrowserPane | null) => void
}

/** Props the Agent Browser body receives from its slot shares. */
export type AgentBrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<AgentBrowserStore>
  & PropsLocale<'agentBrowser'>
  & Partial<AgentBrowserInjected>

/** Stable selector: the pane renders the whole activity state. */
const selectActivity = (state: AgentBrowserState): AgentBrowserState => state

/**
 * The shell draws the agent guest over the measured surface, so the strip stays above
 * it. The body only measures; it holds no Electron access and subscribes to nothing.
 * @param props - slot shares; `present` is absent outside the Desktop shell.
 * @returns the activity strip and the surface the guest occupies.
 */
export function AgentBody(props: AgentBrowserBodyProps): ReactElement {
  const surface = useRef<HTMLDivElement | null>(null)
  /** The last box reported to the shell; `undefined` before the presenter hears anything. */
  const reported = useRef<string | null | undefined>(undefined)
  const { present, t } = props
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
      <div ref={surface} className={css.surface}>{placeholder}</div>
    </div>
  )
}
