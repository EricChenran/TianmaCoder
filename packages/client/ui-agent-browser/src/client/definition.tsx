/** Static Agent Browser tab type declaration. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** Agent Browser implementation identity and keyed Slot dispatch key. */
export const AGENT_BROWSER_ID = '@deepseek-ai/dsh-client-ui-agent-browser'

/** Agent Browser tab kind. */
export const AGENT_BROWSER_KIND = 'agent-browser'

/** Build the Agent Browser type with locale-live copy. */
export function agentBrowserDefinition(t: TranslateNS<'agentBrowser'>): SidebarRightTabDefinition {
  return {
    id: AGENT_BROWSER_ID,
    kind: AGENT_BROWSER_KIND,
    multiple: true,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'open', order: 40, title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }
}
