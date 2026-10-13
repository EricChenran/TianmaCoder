/** Locale-owned Agent Browser tab copy. */
export const zh = {
  'type.label': 'Agent 浏览器',
  'guide.title': 'Agent 浏览器',
  'guide.description': '查看 agent 正在操作的页面',
  'body.placeholder': 'Agent 浏览器就绪；自动化开始后此处显示页面。',
  'activity.busy': 'Agent 正在操作这个页面',
  'activity.idle': '等待 agent 操作',
  'activity.offscreen': '自动化尚未在这里显示页面',
} satisfies Record<string, string>

/** Agent Browser dictionary key union. */
export type AgentBrowserKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  'type.label': 'Agent Browser',
  'guide.title': 'Agent Browser',
  'guide.description': 'Watch the page the agent is driving',
  'body.placeholder': 'Agent browser ready; the page appears here once automation starts.',
  'activity.busy': 'The agent is working on this page',
  'activity.idle': 'Waiting for the agent',
  'activity.offscreen': 'The automation has not shown a page here yet',
} satisfies Record<AgentBrowserKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Browser tab labels and placeholder copy. */
    agentBrowser: AgentBrowserKey
  }
}

/** Namespace used for every Agent Browser dictionary lookup. */
export const AGENT_BROWSER_NAMESPACE = 'agentBrowser'
