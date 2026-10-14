/** Register the Agent Browser tab type in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {
  DesktopAgentBrowserBridge,
  DesktopAgentBrowserCommandArgs,
  DesktopAgentBrowserPane,
} from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { agentBrowserDefinition, AGENT_BROWSER_ID } from './definition.tsx'
import { AGENT_BROWSER_NAMESPACE, en, zh } from './locales.ts'
import { createAgentBrowserStore } from './store.ts'
import { AgentBody } from './view/AgentBody.tsx'
import { AgentBrowserTitle } from './view/AgentBrowserTitle.tsx'

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
  // The agent opens its own tab: the pane is where the human watches it work, and an
  // unopened pane leaves the guest without a surface any command can use. A request that
  // cannot open now — another Session is on screen, or the column has no surface yet and
  // `openTab` refuses without one — is held and retried as the on-screen Session changes,
  // because dropping it would leave the automation without a surface.
  let pending: string | undefined
  const openFor = (sessionKey: string): void => {
    const mounted = ctx.sidebarRight.mounted.getSnapshot()
    if (mounted === undefined || String(mounted) !== sessionKey) {
      pending = sessionKey
      return
    }
    if (ctx.sidebarRightTabs.get(AGENT_BROWSER_ID) === undefined) {
      pending = sessionKey
      return
    }
    try {
      ctx.sidebarRight.openTab(AGENT_BROWSER_ID)
      pending = undefined
    } catch (error) {
      // The column has no Session surface to open into yet; the retry below runs once it
      // does, and the shell keeps asking until a pane has shown this lease.
      pending = sessionKey
      console.warn('Agent browser tab could not open', error)
    }
  }
  if (bridge !== undefined) {
    ctx.effect(() => bridge.onReveal(openFor), 'ui-agent-browser.reveal')
    ctx.effect(() => ctx.sidebarRight.mounted.subscribe(() => {
      if (pending !== undefined) openFor(pending)
    }), 'ui-agent-browser.reveal-retry')
  }
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
              ...(activity.url === undefined ? {} : { url: activity.url }),
              ...(activity.title === undefined ? {} : { title: activity.title }),
              ...(activity.viewport === undefined ? {} : { viewport: activity.viewport }),
              ...(activity.follow === undefined ? {} : { follow: activity.follow }),
            })
          }))
        }
        return {
          present: (pane: DesktopAgentBrowserPane | null): void => { void bridge.present(key, pane) },
          command: (name: string, args: DesktopAgentBrowserCommandArgs): void => {
            void bridge.command(key, name, args).catch((error: unknown) => {
              console.warn('Agent browser command failed', error)
            })
          },
        }
      },
    }, AgentBody)), 'ui-agent-browser.body')
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: AGENT_BROWSER_ID, locale: AGENT_BROWSER_NAMESPACE, store,
  }, AgentBrowserTitle)), 'ui-agent-browser.title')
}
