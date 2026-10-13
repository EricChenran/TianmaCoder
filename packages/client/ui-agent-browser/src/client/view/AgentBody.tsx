/** Agent tab body: reports its surface rectangle and shows the agent's activity. */
import { useEffect, useRef, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAgentBrowserPane } from '../../types.ts'
import type { AgentBrowserState, AgentBrowserStore } from '../store.ts'

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
  const present = useRef(props.present)
  present.current = props.present
  const activity = props.useStore(selectActivity)
  const { t } = props
  useEffect(() => {
    const element = surface.current
    if (element === null || present.current === undefined) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      present.current?.({
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      present.current?.(null)
    }
  }, [])
  const status = activity.busy
    ? (activity.command === undefined ? t('activity.busy') : `${t('activity.busy')} · ${activity.command}`)
    : activity.presented ? t('activity.idle') : t('activity.offscreen')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div role="status">{status}</div>
      <div ref={surface} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
