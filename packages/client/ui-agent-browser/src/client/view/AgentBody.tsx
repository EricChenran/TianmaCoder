/** Agent tab body: reports its surface rectangle and shows the agent's activity. */
import { useEffect, useRef, type ReactElement } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAgentBrowserPane } from '../../types.ts'
import type { AgentBrowserState, AgentBrowserStore } from '../store.ts'
import { activityDot, activityWord } from './activity.ts'

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
 * The shell draws the agent guest over the measured surface, so the status strip
 * stays above it. The body only measures; it holds no Electron access and
 * subscribes to nothing.
 * @param props - slot shares; `present` is absent outside the Desktop shell.
 * @returns the status strip and the surface placeholder.
 */
export function AgentBody(props: AgentBrowserBodyProps): ReactElement {
  const surface = useRef<HTMLDivElement | null>(null)
  const { present, t } = props
  const activity = props.useStore(selectActivity)
  // A pane can render before its Session binding resolves, and the presenter then
  // arrives or changes with the resolved Session, so measurement follows its identity
  // instead of running once on mount and reporting under a key no lease ever had.
  useEffect(() => {
    const element = surface.current
    if (element === null || present === undefined) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      // A collapsed measurement is not a surface: presenting one pixel would leave the
      // page laid out in nothing, which breaks every interaction without a symptom.
      if (width < 2 || height < 2) {
        present(null)
        return
      }
      present({ x: Math.round(rect.left), y: Math.round(rect.top), width, height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      present(null)
    }
  }, [present])
  return (
    <div style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StateDot state={activityDot(activity)} />
        {activityWord(t, activity)}
      </div>
      <div ref={surface} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
