/** Register the Agent Browser tab type in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopAgentBrowserBridge, DesktopAgentBrowserPane } from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { agentBrowserDefinition, AGENT_BROWSER_ID } from './definition.tsx'
import { AGENT_BROWSER_NAMESPACE, en, zh } from './locales.ts'
import { createAgentBrowserStore } from './store.ts'
import { AgentBody } from './view/AgentBody.tsx'

/** Required Agent Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** @returns the Desktop agent browser carrier, or `undefined` in the Web profile. */
function desktopCarrier(): DesktopAgentBrowserBridge | undefined {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly agentBrowser?: DesktopAgentBrowserBridge }
  }).dshDesktop
  return carrier?.protocolVersion === 1 ? carrier.agentBrowser : undefined
}

/** Register the Agent Browser type, localized copy, body, and title. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(AGENT_BROWSER_NAMESPACE)
  const bridge = desktopCarrier()
  const store = createAgentBrowserStore()
  /** One activity subscription per Session occurrence; all of them end with the plugin. */
  const subscribed = new Map<string, () => void>()
  ctx.effect(() => () => {
    for (const unsubscribe of subscribed.values()) unsubscribe()
    subscribed.clear()
  }, 'ui-agent-browser.activity')
  ctx.effect(() => ctx.locale.register(AGENT_BROWSER_NAMESPACE, { zh, en }), 'ui-agent-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register(agentBrowserDefinition(t)), 'ui-agent-browser.type')
  // The Desktop shell places the guest over the pane the body measures; the Web profile has no carrier.
  const body = { name: 'sidebar.right.pane.tab', key: AGENT_BROWSER_ID, locale: AGENT_BROWSER_NAMESPACE, store } as const
  if (bridge === undefined) {
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab',
      () => ctx.slots.register(body, AgentBody)), 'ui-agent-browser.body')
  } else {
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      ...body,
      inject: (sessionId, actions) => {
        const key = String(sessionId)
        if (!subscribed.has(key)) {
          subscribed.set(key, bridge.onActivity((activity) => {
            if (activity.sessionKey !== key) return
            actions.set({
              busy: activity.busy,
              presented: activity.presented,
              ...(activity.command === undefined ? {} : { command: activity.command }),
            })
          }))
        }
        return {
          present: (pane: DesktopAgentBrowserPane | null): void => { void bridge.present(key, pane) },
        }
      },
    }, AgentBody)), 'ui-agent-browser.body')
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: AGENT_BROWSER_ID, locale: AGENT_BROWSER_NAMESPACE, store,
  }, () => t('type.label'))), 'ui-agent-browser.title')
}
