/**
 * The schedule, task, and attendance modules: three read-mostly views that share
 * the workbench's hairline rows.
 *
 * Each module owns its own read, so a refused one reports inside its own tab
 * instead of blanking the page.
 */
import { useEffect, useState } from 'react'
import type {
  OaAttendanceSummary, OaAttendanceToday, OaSchedule, OaTaskGroup,
} from '@tianma/dsh-oa-account/types'
import type { OaWorkbenchInjected } from '../contract.ts'
import type { OaWorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

/** Copy and the read the schedule module needs. */
export interface OaSchedulesProps {
  /** Localized copy of the workbench namespace. */
  t: (key: OaWorkbenchKey) => string
  /** Read today's entries. */
  loadSchedules: OaWorkbenchInjected['loadSchedules']
}

/**
 * @param props - localized copy and the schedule read.
 * @returns today's schedule.
 */
export function OaSchedulesModule({ t, loadSchedules }: OaSchedulesProps) {
  const [rows, setRows] = useState<readonly OaSchedule[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    setRows(undefined)
    setError(undefined)
    void loadSchedules().then((entries) => {
      if (live) setRows(entries)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : '')
    })
    return () => { live = false }
  }, [loadSchedules])

  if (error !== undefined) return <p className={css.error}>{t('schedulesFailed')} {error}</p>
  if (rows === undefined) return <p className={css.muted}>{t('loading')}</p>
  if (rows.length === 0) return <p className={css.muted}>{t('noSchedules')}</p>
  return <ul className={css.list}>{rows.map(row => <li key={row.id} className={css.settingRow}>
    <span className={css.rowBody}>
      <span className={css.rowTitle}>{row.title}</span>
      <span className={css.rowMeta}>
        {[row.startTime ?? '', row.endTime ?? '', row.location].filter(part => part !== '').join(' · ')}
      </span>
    </span>
    {row.kind === 'leave' ? <span className={css.doneTag}>{t('leaveCount')}</span> : null}
  </li>)}</ul>
}

/** Copy and the reads the task module needs. */
export interface OaTasksProps {
  /** Localized copy of the workbench namespace. */
  t: (key: OaWorkbenchKey) => string
  /** Read the board. */
  loadTaskBoard: OaWorkbenchInjected['loadTaskBoard']
  /** Complete one task. */
  completeTask: OaWorkbenchInjected['completeTask']
}

/**
 * @param props - localized copy, the board read, and the completion write.
 * @returns the task board grouped by the backend's deadline buckets.
 */
export function OaTasksModule({ t, loadTaskBoard, completeTask }: OaTasksProps) {
  const [groups, setGroups] = useState<readonly OaTaskGroup[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const reload = async (): Promise<void> => {
    setGroups(await loadTaskBoard())
  }
  useEffect(() => {
    let live = true
    setError(undefined)
    void loadTaskBoard().then((boards) => {
      if (live) setGroups(boards)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : '')
    })
    return () => { live = false }
  }, [loadTaskBoard])

  const complete = async (id: number): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await completeTask(id)
      await reload()
    } catch (reason: unknown) {
      setError(reason instanceof Error && reason.message !== '' ? reason.message : t('actionRefused'))
    } finally {
      setBusy(false)
    }
  }

  if (error !== undefined) return <p className={css.error}>{t('tasksFailed')} {error}</p>
  if (groups === undefined) return <p className={css.muted}>{t('loading')}</p>
  if (groups.length === 0) return <p className={css.muted}>{t('noTasks')}</p>
  return <>
    {groups.map(group => <section key={group.name}>
      <h3 className={css.sectionTitle}>{group.name}</h3>
      <ul className={css.list}>{group.tasks.map(task => <li key={task.id} className={css.settingRow}>
        <label className={css.rowBody}>
          <span className={css.rowTitle} data-done={task.status === 'completed' || undefined}>{task.title}</span>
          <span className={css.rowMeta}>
            {[task.typeLabel, task.deadline ?? '', task.overdue ? t('lateCount') : ''].filter(part => part !== '').join(' · ')}
          </span>
        </label>
        <input
          type="checkbox"
          checked={task.status === 'completed'}
          disabled={busy || task.status === 'completed'}
          onChange={() => { void complete(task.id) }}
          aria-label={t('done')}
        />
      </li>)}</ul>
    </section>)}
  </>
}

/** Copy, today's state, and the summary read the attendance module needs. */
export interface OaAttendanceProps {
  /** Localized copy of the workbench namespace. */
  t: (key: OaWorkbenchKey) => string
  /** Today's attendance, already read for the overview. */
  today: OaAttendanceToday | undefined
  /** Read one month's summary. */
  loadAttendanceSummary: OaWorkbenchInjected['loadAttendanceSummary']
}

/**
 * @param props - localized copy, today's state, and the summary read.
 * @returns this month's summary with today's record beneath it.
 */
export function OaAttendanceModule({ t, today, loadAttendanceSummary }: OaAttendanceProps) {
  const [summary, setSummary] = useState<OaAttendanceSummary | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    setError(undefined)
    void loadAttendanceSummary().then((value) => {
      if (live) setSummary(value)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : '')
    })
    return () => { live = false }
  }, [loadAttendanceSummary])

  if (error !== undefined) return <p className={css.error}>{t('attendanceFailed')} {error}</p>
  if (summary === undefined) return <p className={css.muted}>{t('loading')}</p>
  return <>
    <h3 className={css.sectionTitle}>{t('summaryTitle')} · {summary.period}</h3>
    <div className={css.statGrid}>
      {([
        ['workDays', summary.workDays],
        ['attendedDays', summary.actualDays],
        ['lateCount', summary.lateCount],
        ['leaveCount', summary.leaveCount],
      ] as const).map(([label, value]) => <div key={label} className={css.stat}>
        <span className={css.statLabel}>{t(label)}</span>
        <span className={css.statValue}>{String(value)}</span>
      </div>)}
    </div>
    <h3 className={css.sectionTitle}>{t('penalty')}</h3>
    <ul className={css.list}>
      <li className={css.settingRow}>
        <span className={css.rowBody}><span className={css.rowTitle}>{t('penalty')}</span></span>
        <span className={css.rowMeta}>{summary.penaltyTotal}</span>
      </li>
      <li className={css.settingRow}>
        <span className={css.rowBody}><span className={css.rowTitle}>{t('fullAttendance')}</span></span>
        <span className={css.doneTag}>{summary.fullAttendance ? t('yes') : t('no')}</span>
      </li>
    </ul>
    {today?.record == null ? null : <>
      <h3 className={css.sectionTitle}>{t('todayRecord')}</h3>
      <ul className={css.list}>
        <li className={css.settingRow}>
          <span className={css.rowBody}>
            <span className={css.rowTitle}>
              {[today.record.clockInAt ?? '', today.record.clockOutAt ?? ''].filter(part => part !== '').join(' → ')}
            </span>
            <span className={css.rowMeta}>{today.record.workDate} · {today.record.source}</span>
          </span>
          <span className={css.doneTag}>{t('statusPending')}</span>
        </li>
      </ul>
    </>}
  </>
}
