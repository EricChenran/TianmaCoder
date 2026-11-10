/** Copy for the language-pack card, both languages. */

/** Dictionary keys the card reads. */
export type LspPacksLocaleKey =
  | 'title'
  | 'description'
  | 'stateMissing'
  | 'stateInstalled'
  | 'stateBroken'
  | 'jdkMissing'
  | 'install'
  | 'uninstall'
  | 'working'
  | 'failed'
  | 'restartHint'

/** Simplified Chinese copy. */
export const zh: Record<LspPacksLocaleKey, string> = {
  title: '语言包',
  description: '按需安装额外的代码智能语言包。安装会下载依赖到本机，装完立即生效。',
  stateMissing: '未安装',
  stateInstalled: '已就绪',
  stateBroken: '安装不完整',
  jdkMissing: '需要 JDK（本机未检测到 java）',
  install: '安装',
  uninstall: '卸载',
  working: '处理中…',
  failed: '操作失败，请查看原因后重试。',
  restartHint: '若当前会话里看不到新语言，重新打开一次会话即可。',
}

/** English copy. */
export const en: Record<LspPacksLocaleKey, string> = {
  title: 'Language packs',
  description: 'Install optional code-intelligence packs on demand. Dependencies download to this machine and take effect right away.',
  stateMissing: 'Not installed',
  stateInstalled: 'Ready',
  stateBroken: 'Incomplete install',
  jdkMissing: 'Needs a JDK (no java on PATH)',
  install: 'Install',
  uninstall: 'Remove',
  working: 'Working…',
  failed: 'The operation failed. Check the reason and try again.',
  restartHint: 'If the current conversation does not see the new language yet, open a new one.',
}
