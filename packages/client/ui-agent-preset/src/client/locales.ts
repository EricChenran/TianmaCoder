/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'presetTechName'
  | 'presetTechDescription'
  | 'presetBusinessName'
  | 'presetBusinessDescription'
  | 'presetPickerIntro'
  | 'presetGroupWork'
  | 'presetGroupTeam'
  | 'presetTeamTag'
  | 'presetMore'
  | 'presetMoreHint'
  | 'presetStandardSummary'
  | 'presetPtcSummary'
  | 'presetMinimalSummary'
  | 'presetCordisSummary'
  | 'presetTechSummary'
  | 'presetBusinessSummary'
  | 'inUse'
  | 'selectionOffDefault'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'close'
  | 'creatorDraft'
  | 'showPicker'
  | 'showPickerBeta'
  | 'showPickerDescription'
  | 'enablePickerToSetDefault'
  | 'enablePickerToCreate'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro: 'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to DSH.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',

  presetStandardName: 'Standard mode',
  presetStandardDescription:
    'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',
  presetTechName: 'Engineering mode',
  presetTechDescription:
    'A fixed team mode for engineering work. Keeps Standard mode capabilities and adds the department standard for backend, frontend, and server operations, including its delivery checks.',
  presetBusinessName: 'Business mode',
  presetBusinessDescription:
    'A fixed team mode for commercial work. Keeps Standard mode capabilities and adds the department standard for requirement documents, quotations, and case retrieval, with its own document scripts.',

  // The picker's groups and its one-line rows. A shipped preset publishes no
  // name and no description, so these dictionaries are the only copy its menu
  // rows have; the longer `preset*Description` above stays the settings card's.
  presetPickerIntro: 'Choose this task’s mode (one only)',
  presetGroupWork: 'Work style · how the agent calls tools',
  presetGroupTeam: 'Team standard · standard tools plus department rules',
  presetTeamTag: 'Department',
  presetMore: 'More modes',
  presetMoreHint: 'Minimal · Creator',
  presetStandardSummary: 'Calls tools directly for everyday tasks',
  presetPtcSummary: 'Runs tools from one program, fewer round trips',
  presetMinimalSummary: 'One terminal only, the plainest agent',
  presetCordisSummary: 'Lets the agent write plugins and extend DSH',
  presetTechSummary: 'Backend, frontend and ops discipline',
  presetBusinessSummary: 'Requirement documents, quotations, case retrieval',

  inUse: 'New task default',
  selectionOffDefault: 'Application default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',

  showPicker: 'Choose a mode for new tasks',
  showPickerBeta: 'Beta',
  showPickerDescription:
    'When enabled, each new task can choose a mode and the default is set here. When disabled, new tasks use the application default preset. Existing tasks are unaffected.',
  enablePickerToSetDefault: 'Turn on mode selection for new tasks to choose a default',
  enablePickerToCreate: 'Turn on mode selection for new tasks to start Creator mode',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 DSH 的能力用「创造模式」。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',

  presetStandardName: '标准模式',
  presetStandardDescription: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
  presetTechName: '技术部',
  presetTechDescription: '固定技术团队模式。保留标准模式的能力，并加入技术部规范：后端、前端、运维三类工程纪律与交付自检。',
  presetBusinessName: '商务部',
  presetBusinessDescription: '固定商务团队模式。保留标准模式的能力，并加入商务部规范：需求文档、报价单、案例检索，自带文档生成脚本。',

  presetPickerIntro: '选择本任务使用的模式（单选）',
  presetGroupWork: '工作方式 · 决定工具怎么调',
  presetGroupTeam: '团队规范 · 能力同标准模式，另加部门规范',
  presetTeamTag: '部门规范',
  presetMore: '更多模式',
  presetMoreHint: '极简 · 创造',
  presetStandardSummary: '直接调用工具，完成日常任务',
  presetPtcSummary: '写一段程序批量调用工具，来回更少',
  presetMinimalSummary: '只给一个终端，能力最简',
  presetCordisSummary: '让 Agent 编写插件，扩展 DSH',
  presetTechSummary: '后端／前端／运维的工程纪律与交付自检',
  presetBusinessSummary: '需求文档、报价单、案例检索',

  inUse: '新任务默认',
  selectionOffDefault: '应用默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',

  showPicker: '新任务可选择模式',
  showPickerBeta: 'Beta',
  showPickerDescription: '开启后，可为每个新任务选择模式，并在这里设置默认值。关闭后，新任务使用应用配置的默认预设。已有任务不受影响。',
  enablePickerToSetDefault: '请先开启新任务模式选择，再设置默认值',
  enablePickerToCreate: '请先开启新任务模式选择，再启动创造模式',
}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
