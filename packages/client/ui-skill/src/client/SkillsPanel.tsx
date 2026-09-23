/**
 * Skills page: the main panel the sidebar's Skills entry opens.
 *
 * Two row groups — the skills the selected Session's composition offers and
 * the names the Host registry withholds — each row carrying its switch, its
 * instruction-file reveal, and the tags that say who may invoke it. The filter
 * box is component-local state: it shapes nothing outside this page.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Button, IconRefreshOutlineRegular, IconSkillOutlineRegular, Input, StateDot, Switch, Tag, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SKILL_FILTER_THRESHOLD, type SkillPageRow, type SkillsPageFace, type SkillsPageState } from './skills-page.ts'
import css from './SkillsPanel.module.css'

/** Full component props assembled by the main slot renderer. */
export type SkillsPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<'skill'>
  & InjectFace<SkillsPageFace>

/** Whether one row survives the filter box: a name or description hit. */
function matches(row: SkillPageRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return row.name.toLowerCase().includes(needle) || (row.description ?? '').toLowerCase().includes(needle)
}

/** Props of one rendered row: plain data plus the page's two commands. */
interface RowProps {
  readonly row: SkillPageRow
  readonly enabled: boolean
  readonly busy: boolean
  readonly writable: boolean
  readonly t: SkillsPanelProps['t']
  readonly onToggle: (name: string, enabled: boolean) => void
  readonly onOpen: (name: string) => void
}

/** Render one skill row: glyph, name, description, tags, and its switch. */
function Row({ row, enabled, busy, writable, t, onToggle, onOpen }: RowProps) {
  return (
    <li className={css.rowItem} data-off={enabled ? undefined : 'true'}>
      <span className={css.glyph} aria-hidden="true"><IconSkillOutlineRegular size={16} /></span>
      <div className={css.rowBody}>
        <div className={css.rowHead}>
          <span className={css.rowName}>{row.name}</span>
          {enabled
            ? !row.modelInvocable && <Tag tone="neutral">{t('menu.userOnly')}</Tag>
            : <Tag tone="quiet">{t('row.off')}</Tag>}
        </div>
        {row.description !== undefined && <p className={css.rowDescription}>{row.description}</p>}
      </div>
      <div className={css.rowActions}>
        {row.path !== undefined && (
          <Button size="sm" variant="ghost" aria-label={t('row.file', { name: row.name })} onClick={() => { onOpen(row.name) }}>
            {t('row.instructions')}
          </Button>
        )}
        <Switch
          checked={enabled}
          disabled={busy || !writable}
          label={t('row.toggle', { name: row.name })}
          onChange={(next) => { onToggle(row.name, next) }}
        />
      </div>
    </li>
  )
}

/**
 * Render the Skills page.
 * @param props - main-panel runtime share, the locale seat, and the page face.
 * @returns the skills element tree.
 */
export function SkillsPanel(props: SkillsPanelProps) {
  const { t, ensure } = props
  const state: SkillsPageState = props.useSkillsPage(snapshot => snapshot)
  const [query, setQuery] = useState('')
  useEffect(() => { ensure() }, [ensure])
  const available = useMemo(() => state.available.filter(row => matches(row, query)), [state.available, query])
  const disabled = useMemo(() => state.disabled.filter(row => matches(row, query)), [state.disabled, query])
  const total = state.available.length + state.disabled.length
  const showFilter = total > SKILL_FILTER_THRESHOLD
  const busy = (name: string): boolean => state.busy.includes(name)

  return (
    <section className={css.page} data-skills-panel aria-busy={state.status === 'loading'}>
      <header className={css.pageHead}>
        <div>
          <h1 className={css.pageTitle}>{t('page.title')}</h1>
          <p className={css.pageIntro}>{t('page.intro')}</p>
        </div>
        <div className={css.toolbar}>
          {state.status === 'ready' && <span className={css.count}>{t('page.count', { total: String(total), off: String(state.disabled.length) })}</span>}
          <Button
            size="sm"
            variant="toolbar"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={state.status !== 'ready'}
            aria-label={t('page.refresh')}
            onClick={() => { props.refresh() }}
          >
            {t('page.refresh')}
          </Button>
        </div>
      </header>

      {showFilter && (
        <div className={css.filter}>
          <Input
            type="search"
            value={query}
            placeholder={t('page.filter.placeholder')}
            aria-label={t('page.filter.label')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>
      )}

      {state.status === 'no-session' && (
        <div className={css.state}>
          <h2 className={css.stateTitle}>{t('state.noSession.title')}</h2>
          <p className={css.stateBody}>{t('state.noSession.body')}</p>
        </div>
      )}
      {state.status === 'loading' && (
        <div className={css.state} role="status">
          <StateDot state="ongoing" size={16} />
          <TextShimmer active>{t('state.loading')}</TextShimmer>
        </div>
      )}
      {state.status === 'error' && (
        <div className={css.state}>
          <h2 className={css.stateTitle}>{t('state.error.title')}</h2>
          <p className={css.stateError}>{state.error}</p>
          <Button size="sm" variant="outline" onClick={() => { props.refresh() }}>{t('state.error.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && (
        <div className={css.groups}>
          {!state.writable && <p className={css.notice}>{t('state.readOnly')}</p>}
          {state.writeFailed && <p className={css.notice} data-tone="error">{t('state.writeFailed')}</p>}
          {total === 0 && (
            <div className={css.state}>
              <h2 className={css.stateTitle}>{t('state.empty.title')}</h2>
              <p className={css.stateBody}>{t('state.empty.body')}</p>
            </div>
          )}
          {total > 0 && available.length === 0 && disabled.length === 0 && (
            <p className={css.notice}>{t('state.noMatch')}</p>
          )}
          {available.length > 0 && (
            <section className={css.group} aria-label={t('group.available')}>
              <h2 className={css.groupHead}>{t('group.available')}</h2>
              <ul className={css.list}>
                {available.map(row => (
                  <Row
                    key={row.name}
                    row={row}
                    enabled
                    busy={busy(row.name)}
                    writable={state.writable}
                    t={t}
                    onToggle={props.setEnabled}
                    onOpen={props.openFile}
                  />
                ))}
              </ul>
            </section>
          )}
          {disabled.length > 0 && (
            <section className={css.group} aria-label={t('group.disabled')}>
              <h2 className={css.groupHead}>{t('group.disabled')}</h2>
              <ul className={css.list}>
                {disabled.map(row => (
                  <Row
                    key={row.name}
                    row={row}
                    enabled={false}
                    busy={busy(row.name)}
                    writable={state.writable}
                    t={t}
                    onToggle={props.setEnabled}
                    onOpen={props.openFile}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  )
}
