/** One reading of the activity store: the dot state and the word every surface shows. */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentBrowserState } from '../store.ts'

/** Translate seat the Agent Browser dictionary binds. */
export type AgentBrowserTranslate = PropsLocale<'agentBrowser'>['t']

/**
 * @param activity - the lease activity the right Sidebar merged for this Session.
 * @returns the state dot that names this activity.
 */
export function activityDot(activity: AgentBrowserState): StateDotState {
  if (activity.busy) return 'ongoing'
  return activity.presented ? 'done' : 'idle'
}

/**
 * @param t - the tab's dictionary seat.
 * @param activity - the lease activity the right Sidebar merged for this Session.
 * @returns the status word the tab title and the pane strip both show.
 */
export function activityWord(t: AgentBrowserTranslate, activity: AgentBrowserState): string {
  if (!activity.busy) return activity.presented ? t('activity.idle') : t('activity.offscreen')
  return activity.command === undefined ? t('activity.busy') : `${t('activity.busy')} · ${activity.command}`
}
