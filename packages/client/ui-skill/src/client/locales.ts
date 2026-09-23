/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '加载技能',
  'row.running': '正在加载 skill',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.inspect': '查看',
  'menu.userOnly': '仅用户',
  'panel': '技能',
  'page.title': '技能',
  'page.intro': '管理当前会话可用的技能。关闭后，技能不再出现在 / 菜单，也不再提供给模型。',
  'page.count': '{total} 项技能，已关闭 {off} 项',
  'page.refresh': '刷新',
  'page.filter.label': '筛选技能',
  'page.filter.placeholder': '筛选技能',
  'group.available': '已启用',
  'group.disabled': '已关闭',
  'row.off': '已关闭',
  'row.toggle': '技能 {name} 的开关',
  'row.file': '查看 {name} 的说明文件',
  'state.loading': '正在读取技能',
  'state.noSession.title': '尚未打开会话',
  'state.noSession.body': '打开一个会话后，即可查看并管理它可调用的技能。',
  'state.empty.title': '没有可用技能',
  'state.empty.body': '当前会话的组成没有提供任何技能。',
  'state.error.title': '无法读取技能',
  'state.error.retry': '重试',
  'state.readOnly': '当前部署不接受技能开关的保存，列表为只读。',
  'state.writeFailed': '技能开关未能保存，请重试。',
  'state.noMatch': '没有匹配的技能',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Skill',
  'row.running': 'Loading skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspect',
  'menu.userOnly': 'user-only',
  'panel': 'Skills',
  'page.title': 'Skills',
  'page.intro': 'Manage the skills this session can invoke. A switched-off skill leaves the / menu and is withheld from the model.',
  'page.count': '{total} skills, {off} switched off',
  'page.refresh': 'Refresh',
  'page.filter.label': 'Filter skills',
  'page.filter.placeholder': 'Filter skills',
  'group.available': 'Enabled',
  'group.disabled': 'Switched off',
  'row.off': 'off',
  'row.toggle': 'Switch for skill {name}',
  'row.file': 'Open the instruction file of {name}',
  'state.loading': 'Reading skills',
  'state.noSession.title': 'No session open',
  'state.noSession.body': 'Open a session to see and manage the skills it can invoke.',
  'state.empty.title': 'No skills available',
  'state.empty.body': 'This session\'s composition offers no skills.',
  'state.error.title': 'Skills could not be read',
  'state.error.retry': 'Retry',
  'state.readOnly': 'This deployment does not accept skill switches; the list is read-only.',
  'state.writeFailed': 'The skill switch could not be saved. Try again.',
  'state.noMatch': 'No matching skill',
} satisfies Record<SkillKey, string>
