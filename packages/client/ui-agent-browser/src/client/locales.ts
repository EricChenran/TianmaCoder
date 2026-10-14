/** Locale-owned Agent Browser tab copy. */
export const zh = {
  'type.label': 'Agent 浏览器',
  'guide.title': 'Agent 浏览器',
  'guide.description': '查看 agent 正在操作的页面',
  'body.placeholder': 'Agent 浏览器就绪；自动化开始后此处显示页面。',
  'activity.busy': 'Agent 正在操作这个页面',
  'activity.idle': '等待 agent 操作',
  'activity.offscreen': '自动化尚未在这里显示页面',
  'toolbar.back': '后退',
  'toolbar.forward': '前进',
  'toolbar.reload': '刷新',
  'toolbar.address': '网页地址',
  'toolbar.addressHint': '输入地址后回车',
  'toolbar.go': '打开这个地址',
  'toolbar.viewport': '视口',
  'toolbar.viewportFollow': '跟随窗格',
  'toolbar.viewportCustom': '自定义',
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
  'toolbar.back': 'Back',
  'toolbar.forward': 'Forward',
  'toolbar.reload': 'Reload',
  'toolbar.address': 'Page address',
  'toolbar.addressHint': 'Type an address and press Enter',
  'toolbar.go': 'Open this address',
  'toolbar.viewport': 'Viewport',
  'toolbar.viewportFollow': 'Follow the pane',
  'toolbar.viewportCustom': 'Custom',
} satisfies Record<AgentBrowserKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Browser tab labels and placeholder copy. */
    agentBrowser: AgentBrowserKey
  }
}

/** Namespace used for every Agent Browser dictionary lookup. */
export const AGENT_BROWSER_NAMESPACE = 'agentBrowser'
