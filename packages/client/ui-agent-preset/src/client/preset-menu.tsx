/**
 * The new-session picker's rows.
 *
 * The roster is one flat list, but a person reading it there answers three
 * different questions: how the agent calls tools, whose standards it works to,
 * and whether it may extend DSH itself. Grouping states that classification
 * once per group instead of leaving a shared sentence on every row — "keeps
 * Standard mode's capabilities", previously carried by three of six rows, is
 * now the team heading.
 *
 * A preset the deployment authored is not classified: it keeps the copy it
 * published and gets its own group, so it stays reachable rather than being
 * filed under a heading that does not describe it. The two groups that name a
 * question are the shipped ids' alone.
 */

import type { ReactNode } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { presetDisplayText, type AgentPresetSettingsKey } from './locales.ts'
import { presetIcon } from './preset-icons.tsx'
import type { AgentPresetOption } from './settings-store.ts'
import css from './AgentPresetSeat.module.css'

/**
 * Row id of the disclosure that opens the demoted group. Activation arrives
 * through `Menu.onSelect` like any other row's, so it must not collide with a
 * preset id: presets declare their ids in composition, and none is `preset-*`.
 */
export const MORE_ROW_ID = 'preset-more'

/** One group of the picker: the shipped presets that answer one question. */
interface PresetGroup {
  /** Shipped ids in this group, in the order the picker shows them. */
  ids: readonly string[]
  /** Heading dictionary key; the heading also carries the group's shared premise. */
  headingKey: AgentPresetSettingsKey
  /** Optional per-row label repeating what the heading claims, when the row needs it alone. */
  tagKey?: AgentPresetSettingsKey
}

/** The groups, in the order the picker asks them. */
const GROUPS: readonly PresetGroup[] = [
  { ids: ['standard', 'ptc'], headingKey: 'presetGroupWork' },
  { ids: ['tech', 'business'], headingKey: 'presetGroupTeam', tagKey: 'presetTeamTag' },
]

/** Presets the picker keeps behind {@link MORE_ROW_ID}: not everyday choices. */
const DEMOTED_IDS: readonly string[] = ['minimal', 'cordis']

/**
 * One line per shipped preset saying when to pick it.
 *
 * A shipped preset's menu row reads this key rather than the description the
 * shared display fold resolves, which is the settings card's longer claim. A
 * preset this table does not know — one a deployment authored — keeps whatever
 * it published.
 */
const SUMMARY_KEYS: Readonly<Partial<Record<string, AgentPresetSettingsKey>>> = {
  standard: 'presetStandardSummary',
  ptc: 'presetPtcSummary',
  minimal: 'presetMinimalSummary',
  cordis: 'presetCordisSummary',
  tech: 'presetTechSummary',
  business: 'presetBusinessSummary',
}

/**
 * Whether the picker shows a preset behind its disclosure.
 * @param id - preset id.
 * @returns true for a preset the picker demotes.
 */
export function isDemotedPreset(id: string): boolean {
  return DEMOTED_IDS.includes(id)
}

/**
 * Which row the picker marks as chosen.
 *
 * A collapsed disclosure stands in for the preset behind it, so folding the
 * group away never hides the current choice; once open, the row itself carries
 * the mark.
 * @param current - the staged preset's id.
 * @param moreOpen - whether the demoted group is open.
 * @returns the row id to mark.
 */
export function presetMenuSelectedId(current: string, moreOpen: boolean): string {
  return !moreOpen && isDemotedPreset(current) ? MORE_ROW_ID : current
}

/** One mode's two-line row: its name, over the line that says when to pick it. */
function optionRow(
  option: AgentPresetOption,
  t: (key: AgentPresetSettingsKey) => string,
  tag?: AgentPresetSettingsKey,
): ReactNode {
  const text = presetDisplayText(option, t)
  const summaryKey = SUMMARY_KEYS[option.id]
  const summary = summaryKey === undefined ? text.description : t(summaryKey)
  return (
    <span className={css.item}>
      <span className={css.itemName}>
        {text.name}
        {tag === undefined ? null : <span className={css.itemTag}>{t(tag)}</span>}
      </span>
      <span className={css.itemDesc}>{summary ?? t('noDescription')}</span>
    </span>
  )
}

/** One selectable row for a preset. */
function presetRow(
  option: AgentPresetOption,
  t: (key: AgentPresetSettingsKey) => string,
  tag?: AgentPresetSettingsKey,
): MenuEntry {
  return { id: option.id, icon: presetIcon(option.id, 14), label: optionRow(option, t, tag) }
}

/** What the picker's rows are built from. */
export interface PresetMenuInput {
  /** Healthy presets, in roster order. */
  options: readonly AgentPresetOption[]
  /** Localized text for one dictionary key. */
  t: (key: AgentPresetSettingsKey) => string
  /** Whether the demoted group is open. */
  moreOpen: boolean
}

/**
 * Build the picker's rows.
 * @param input - roster options, locale lookup, and disclosure state.
 * @returns the entries in render order: the caption, one block per group that
 * has rows, the demoted group's disclosure, then the deployment's own presets.
 */
export function presetMenuEntries({ options, t, moreOpen }: PresetMenuInput): MenuEntry[] {
  const remaining = new Map(options.map(option => [option.id, option]))
  // Taking by id both selects and consumes, so an id claimed by no group is
  // exactly what is left over for the authored group — one pass, no filtering.
  const take = (ids: readonly string[]): AgentPresetOption[] => {
    const rows: AgentPresetOption[] = []
    for (const id of ids) {
      const option = remaining.get(id)
      if (option === undefined) continue
      remaining.delete(id)
      rows.push(option)
    }
    return rows
  }

  const entries: MenuEntry[] = [
    // Two headings can read as two independent choices; the grouping is a
    // classification of one choice, and this says so once.
    { type: 'label', id: 'picker-intro', text: t('presetPickerIntro') },
  ]

  for (const group of GROUPS) {
    const rows = take(group.ids)
    // A deployment composes only some presets: an empty group is no heading.
    if (rows.length === 0) continue
    entries.push({ type: 'separator', id: `before-${group.headingKey}` })
    entries.push({ type: 'label', id: group.headingKey, text: t(group.headingKey) })
    for (const option of rows) entries.push(presetRow(option, t, group.tagKey))
  }

  const demoted = take(DEMOTED_IDS)
  if (demoted.length > 0) {
    entries.push({ type: 'separator', id: 'before-more' })
    entries.push({
      id: MORE_ROW_ID,
      icon: (
        <IconChevronRightOutlineRegular
          size={14}
          className={moreOpen ? css.moreChevronOpen : css.moreChevron}
        />
      ),
      label: (
        <span className={css.moreRow}>
          <span>{t('presetMore')}</span>
          <span className={css.moreHint}>{t('presetMoreHint')}</span>
        </span>
      ),
    })
    if (moreOpen) {
      for (const option of demoted) entries.push(presetRow(option, t))
    }
  }

  const authored = [...remaining.values()]
  if (authored.length > 0) {
    entries.push({ type: 'separator', id: 'before-authored' })
    entries.push({ type: 'label', id: 'heading-authored', text: t('customGroup') })
    for (const option of authored) entries.push(presetRow(option, t))
  }

  return entries
}
