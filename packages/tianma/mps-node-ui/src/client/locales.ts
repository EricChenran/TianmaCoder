/**
 * Locale dictionaries for the Tianma executor-node surface. Product copy lives
 * here so components stay free of hardcoded text.
 *
 * @module @tianma/dsh-mps-node-ui/locales
 */

/** English copy. */
export const en = {
  'nav': 'Execution node',
  'title': 'Execution node',
  'description': 'The node claims tasks from the platform and works them in this machine\'s coding workspaces. It runs as a separate process, which this page starts and stops.',
  'phase': 'State',
  'phaseStopped': 'Stopped',
  'phaseStarting': 'Starting…',
  'phaseRunning': 'Running',
  'phaseFailed': 'Could not start',
  'profile': 'Profile',
  'pid': 'Process',
  'startedAt': 'Started',
  'lastExit': 'Last exit',
  'exitCode': 'Exit code',
  'exitSignal': 'Signal',
  'exitAt': 'Ended',
  'start': 'Start node',
  'stop': 'Stop node',
  'refresh': 'Refresh',
  'logs': 'Recent output',
  'noLogs': 'The node has printed nothing yet.',
  'readFailed': 'The node state is unavailable.',
  'startFailed': 'The node could not be started.',
  'stopFailed': 'The node could not be stopped.',
  'unknown': '—',
} as const

/** Every copy key of this namespace. */
export type MpsNodeKey = keyof typeof en

/** Chinese copy; the type keeps the two dictionaries in step. */
export const zh: Record<MpsNodeKey, string> = {
  'nav': '执行节点',
  'title': '执行节点',
  'description': '节点从平台领取任务，并在本机的编码工作区里执行。它以独立进程运行，这一页负责启停它。',
  'phase': '状态',
  'phaseStopped': '已停止',
  'phaseStarting': '正在启动…',
  'phaseRunning': '运行中',
  'phaseFailed': '无法启动',
  'profile': 'Profile',
  'pid': '进程',
  'startedAt': '启动于',
  'lastExit': '上次退出',
  'exitCode': '退出码',
  'exitSignal': '信号',
  'exitAt': '结束于',
  'start': '启动节点',
  'stop': '停止节点',
  'refresh': '刷新',
  'logs': '最近输出',
  'noLogs': '节点还没有输出任何内容。',
  'readFailed': '读不到节点状态。',
  'startFailed': '节点启动失败。',
  'stopFailed': '节点停止失败。',
  'unknown': '—',
}
