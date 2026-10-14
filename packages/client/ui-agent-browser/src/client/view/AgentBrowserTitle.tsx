/** Agent Browser tab title: the tab's icon, label, and the agent's activity state. */
import type { ReactNode } from 'react'
import { IconSparkleRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentBrowserState, AgentBrowserStore } from '../store.ts'
import { activityDot, activityWord } from './activity.ts'

/** Props the Agent Browser title receives from its slot shares. */
export type AgentBrowserTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>
  & PropsStore<AgentBrowserStore>
  & PropsLocale<'agentBrowser'>

/** Stable selector: the title renders the whole activity state. */
const selectActivity = (state: AgentBrowserState): AgentBrowserState => state

/**
 * The tab is narrow, so the state rides on a dot and only its word reaches assistive
 * technology; the pane strip states the same word in full.
 * @param props - slot shares.
 * @returns the icon, label, and activity dot.
 */
export function AgentBrowserTitle(props: AgentBrowserTitleProps): ReactNode {
  const activity = props.useStore(selectActivity)
  const { t } = props
  const label = t('type.label')
  const word = activityWord(t, activity)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} aria-label={`${label} · ${word}`}>
      <IconSparkleRegular />
      {label}
      <StateDot state={activityDot(activity)} />
    </span>
  )
}
