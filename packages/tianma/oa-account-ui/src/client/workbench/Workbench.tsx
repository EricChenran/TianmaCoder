/**
 * The OA workbench panel: one page holding the modules the sidebar entry opens.
 *
 * Module tabs are the first level; a message opens a second-level tab inside the
 * messages module. Every open tab stays mounted and is hidden rather than
 * destroyed, so a switch back keeps its scroll position and typed draft.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OaMessage } from '@tianma/dsh-oa-account/types'
import { OaApprovalsModule } from './Approvals.tsx'
import type { OaWorkbenchInjected, OaWorkbenchModule } from '../contract.ts'
import type { OaWorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

/** Composed workbench panel props. */
export type OaWorkbenchProps =
  PropsRuntime<'main'> & PropsLocale<'workbench.oa'> & InjectFace<OaWorkbenchInjected>

/** Which messages the list shows. */
type MessageFilter = 'all' | 'unread'

/** A second-level tab inside the messages module. */
type MessageTab = 'list' | 'settings' | `doc:${number}`

/**
 * @param props - localized copy, the workbench snapshot, and its operations.
 * @returns the workbench page.
 */
export function OaWorkbenchPanel({
  useOaWorkbench, refresh, readMessage, readAllMessages, createTodo, toggleTodo,
  checkIn, checkOut, setPreference, loadApprovals, loadApproval, actOnApproval, openLogin, t,
}: OaWorkbenchProps) {
  const snapshot = useOaWorkbench(state => state)
  const [module, setModule] = useState<OaWorkbenchModule>('overview')
  const [filter, setFilter] = useState<MessageFilter>('all')
  const [tab, setTab] = useState<MessageTab>('list')
  const [openDocs, setOpenDocs] = useState<readonly number[]>([])
  const [draft, setDraft] = useState('')
  const [lunch, setLunch] = useState(true)

  useEffect(() => { void refresh() }, [refresh])

  const messages = snapshot.messages.value ?? []
  const unread = messages.filter(message => message.unread).length
  const visible = useMemo(
    () => filter === 'unread' ? messages.filter(message => message.unread) : messages,
    [filter, messages],
  )
  const openMessage = (message: OaMessage): void => {
    setOpenDocs(docs => docs.includes(message.id) ? docs : [...docs, message.id])
    setTab(`doc:${message.id}`)
    if (message.unread) void readMessage(message.id)
  }
  const closeDoc = (id: number): void => {
    setOpenDocs(docs => docs.filter(open => open !== id))
    if (tab === `doc:${id}`) setTab('list')
  }
  const attendance = snapshot.attendance.value

  if (!snapshot.signedIn) {
    return <div className={css.page}>
      <header className={css.head}>
        <h1 className={css.title}>{t('title')}</h1>
        <p className={css.intro}>{t('intro')}</p>
      </header>
      <div className={css.notice}>{t('signInFirst')}</div>
      <div className={css.actions}><Button variant="primary" onClick={openLogin}>{t('moduleMessages')}</Button></div>
    </div>
  }

  return <div className={css.page}>
    <header className={css.head}>
      <div>
        <h1 className={css.title}>{t('title')}</h1>
        <p className={css.intro}>{t('intro')}</p>
      </div>
      <Button variant="ghost" onClick={() => { void refresh() }}>{t('refresh')}</Button>
    </header>

    <div className={css.moduleBar} role="tablist">
      {(['overview', 'messages', 'approval', 'todos'] as const).map(id => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={module === id}
          className={css.moduleTab}
          onClick={() => { setModule(id) }}
        >
          {t(id === 'overview' ? 'moduleOverview' : id === 'messages' ? 'moduleMessages' : id === 'approval' ? 'moduleApproval' : 'moduleTodos')}
          {id === 'messages' && unread > 0 ? <span className={css.count}>{unread}</span> : null}
        </button>
      ))}
    </div>

    <section className={css.body} hidden={module !== 'overview'}>
      <div className={css.card}>
        <div className={css.cardHead}>{t('attendance')}</div>
        {snapshot.attendance.error !== undefined
          ? <p className={css.error}>{t('attendanceFailed')}</p>
          : attendance === undefined
            ? <p className={css.muted}>{t('loading')}</p>
            : <div className={css.punchRow}>
              <div className={css.punchText}>
                <div className={css.punchStrong}>
                  {attendance.noClockRequired
                    ? t('noClockText')
                    : `${attendance.shiftName} ${attendance.workStart}–${attendance.workEnd}`}
                </div>
                <div className={css.muted}>
                  {attendance.checkinWindowText}
                  {attendance.remainingMinutes === null
                    ? null
                    : <> {t('metaSeparator')} {t('remaining')} {Math.floor(attendance.remainingMinutes / 60)}{t('hoursSuffix')}</>}
                </div>
              </div>
              {attendance.noClockRequired
                ? null
                : attendance.checkedOut
                  ? <span className={css.doneTag}>{t('attendanceDone')}</span>
                  : <div className={css.punchActions}>
                    {attendance.checkedIn ? null : <label className={css.lunch}>
                      <input type="checkbox" checked={lunch} onChange={(event) => { setLunch(event.target.checked) }} />
                      {t('shift')}
                    </label>}
                    <Button
                      variant="primary"
                      onClick={() => { void (attendance.checkedIn ? checkOut() : checkIn(lunch)) }}
                    >
                      {attendance.checkedIn ? t('checkOut') : t('checkIn')}
                    </Button>
                  </div>}
            </div>}
      </div>

      <div className={css.statGrid}>
        {[
          ['pendingApprovals', snapshot.stats.value?.approval.pending],
          ['overdueTasks', snapshot.stats.value?.task.overdue],
          ['todayTasks', snapshot.stats.value?.task.today],
          ['unreadMessages', unread],
        ].map(([label, value]) => <div key={String(label)} className={css.stat}>
          <span className={css.statLabel}>{t(label as OaWorkbenchKey)}</span>
          <span className={css.statValue}>{value === undefined ? t('unknownValue') : String(value)}</span>
        </div>)}
      </div>
    </section>

    <section className={css.body} hidden={module !== 'messages'}>
      <div className={css.subBar} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'list'} className={css.subTab} onClick={() => { setTab('list') }}>{t('all')}</button>
        {openDocs.map((id) => {
          const message = messages.find(item => item.id === id)
          if (message === undefined) return null
          const key = `doc:${id}`
          return <span key={id} className={css.docTab}>
            <button type="button" role="tab" aria-selected={tab === key} className={css.subTab} onClick={() => { setTab(key as MessageTab) }}>
              {message.summary.slice(0, 12)}
            </button>
            <button type="button" className={css.close} aria-label={t('close')} onClick={() => { closeDoc(id) }}>×</button>
          </span>
        })}
        <button type="button" role="tab" aria-selected={tab === 'settings'} className={css.subTab} onClick={() => { setTab('settings') }}>{t('notifications')}</button>
      </div>

      <div hidden={tab !== 'list'}>
        <div className={css.tools}>
          <div className={css.chips}>
            <button type="button" className={css.chip} aria-pressed={filter === 'all'} onClick={() => { setFilter('all') }}>{t('all')}</button>
            <button type="button" className={css.chip} aria-pressed={filter === 'unread'} onClick={() => { setFilter('unread') }}>
              {t('unread')}{unread > 0 ? ` ${String(unread)}` : ''}
            </button>
          </div>
          <Button variant="ghost" onClick={() => { void readAllMessages() }}>{t('markAllRead')}</Button>
        </div>
        {snapshot.messages.error !== undefined
          ? <p className={css.error}>{t('messagesFailed')}</p>
          : visible.length === 0
            ? <p className={css.muted}>{messages.length === 0 ? t('noMessages') : t('noUnread')}</p>
            : <ul className={css.list}>{visible.map(message => <li key={message.id}>
              <button type="button" className={css.row} onClick={() => { openMessage(message) }}>
                <span className={css.dot} data-unread={message.unread || undefined} aria-hidden="true" />
                <span className={css.rowBody}>
                  <span className={css.rowTitle}>{message.summary}</span>
                  <span className={css.rowMeta}>{message.time}</span>
                </span>
              </button>
            </li>)}</ul>}
      </div>

      {openDocs.map((id) => {
        const message = messages.find(item => item.id === id)
        if (message === undefined) return null
        return <article key={id} className={css.doc} hidden={tab !== `doc:${id}`}>
          <h2 className={css.docTitle}>{message.summary}</h2>
          <p className={css.muted}>{message.time}</p>
          <dl className={css.kv}>
            {message.payload.approvalTitle === undefined ? null : <><dt>{t('open')}</dt><dd>{message.payload.approvalTitle}</dd></>}
            {message.payload.applicantName === undefined ? null : <><dt>{t('messagesTitle')}</dt><dd>{message.payload.applicantName}</dd></>}
            {message.payload.period === undefined ? null : <><dt>{t('notifications')}</dt><dd>{message.payload.period}</dd></>}
            {message.payload.netPay === undefined ? null : <><dt>{t('remaining')}</dt><dd>{message.payload.netPay}</dd></>}
            {message.payload.fileName === undefined ? null : <><dt>{t('open')}</dt><dd>{message.payload.fileName}</dd></>}
          </dl>
          <Button variant="ghost" onClick={() => { void readMessage(message.id) }}>{t('markAllRead')}</Button>
        </article>
      })}

      <div hidden={tab !== 'settings'}>
        {snapshot.notifications.error !== undefined
          ? <p className={css.error}>{t('notificationsFailed')}</p>
          : snapshot.notifications.value === undefined
            ? <p className={css.muted}>{t('loading')}</p>
            : <ul className={css.list}>
              <li className={css.settingRow}>
                <span className={css.rowBody}>
                  <span className={css.rowTitle}>{t('inApp')}</span>
                  <span className={css.rowMeta}>{t('inAppHint')}</span>
                </span>
                <span className={css.doneTag}>{t('done')}</span>
              </li>
              <li className={css.settingRow}>
                <span className={css.rowBody}>
                  <span className={css.rowTitle}>{t('wechat')}</span>
                  <span className={css.rowMeta}>{t('wechatHint')}</span>
                </span>
                <input
                  type="checkbox"
                  checked={snapshot.notifications.value.externalMessageEnabled}
                  onChange={(event) => { void setPreference({ externalMessageEnabled: event.target.checked }) }}
                />
              </li>
            </ul>}
      </div>
    </section>

    <section className={css.body} hidden={module !== 'approval'}>
      <OaApprovalsModule
        t={t}
        loadApprovals={loadApprovals}
        loadApproval={loadApproval}
        actOnApproval={actOnApproval}
      />
    </section>

    <section className={css.body} hidden={module !== 'todos'}>
      {snapshot.todos.error !== undefined
        ? <p className={css.error}>{t('todosFailed')}</p>
        : <>
          <ul className={css.list}>
            {(snapshot.todos.value ?? []).map(todo => <li key={todo.id}>
              <label className={css.row}>
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => { void toggleTodo(todo.id) }}
                />
                <span className={css.rowBody}>
                  <span className={css.rowTitle} data-done={todo.done || undefined}>{todo.text}</span>
                  <span className={css.rowMeta}>{todo.time}</span>
                </span>
              </label>
            </li>)}
          </ul>
          {(snapshot.todos.value ?? []).length === 0 ? <p className={css.muted}>{t('noTodos')}</p> : null}
          <div className={css.addRow}>
            <Input
              value={draft}
              placeholder={t('addTodo')}
              onChange={(event) => { setDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || draft.trim() === '') return
                void createTodo(draft.trim())
                setDraft('')
              }}
            />
          </div>
        </>}
    </section>
  </div>
}
