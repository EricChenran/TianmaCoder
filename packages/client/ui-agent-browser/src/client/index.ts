/** Register the Agent Browser tab type in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { agentBrowserDefinition, AGENT_BROWSER_ID } from './definition.tsx'
import { AGENT_BROWSER_NAMESPACE, en, zh } from './locales.ts'
import { AgentBody } from './view/AgentBody.tsx'

/** Required Agent Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register the Agent Browser type, localized copy, body, and title. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(AGENT_BROWSER_NAMESPACE)
  ctx.effect(() => ctx.locale.register(AGENT_BROWSER_NAMESPACE, { zh, en }), 'ui-agent-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register(agentBrowserDefinition(t)), 'ui-agent-browser.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: AGENT_BROWSER_ID, locale: AGENT_BROWSER_NAMESPACE,
  }, AgentBody)), 'ui-agent-browser.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: AGENT_BROWSER_ID, locale: AGENT_BROWSER_NAMESPACE,
  }, () => t('type.label'))), 'ui-agent-browser.title')
}
