/**
 * The approvals module: the four lists, one open document per second-level tab,
 * and the three decisions the employee side accepts.
 *
 * An open document stays mounted while another tab is shown, so its typed
 * comment survives a look at the list or at another request.
 */
import { Fragment, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OaApproval, OaApprovalAction, OaApprovalContent, OaApprovalDetail, OaApprovalTab,
} from '@tianma/dsh-oa-account/types'
import type { OaWorkbenchInjected } from '../contract.ts'
import type { OaWorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

/** Copy and Host reads the module needs. */
export interface OaApprovalsProps {
  /** Localized copy of the workbench namespace. */
  t: (key: OaWorkbenchKey) => string
  /** Read one list. */
  loadApprovals: OaWorkbenchInjected['loadApprovals']
  /** Read one approval with its decision flags. */
  loadApproval: OaWorkbenchInjected['loadApproval']
  /** Apply one decision. */
  actOnApproval: OaWorkbenchInjected['actOnApproval']
}

/** Chip copy per list. */
const TAB_LABEL: Readonly<Record<OaApprovalTab, OaWorkbenchKey>> = {
  pending: 'approvalPending',
  approved: 'approvalHandled',
  cc: 'approvalCopied',
  submitted: 'approvalMine',
}

/** The four lists, in the order the chips show them. */
const TABS = Object.keys(TAB_LABEL) as readonly OaApprovalTab[]

/** Status copy per approval state. */
const STATUS_LABEL: Readonly<Record<string, OaWorkbenchKey>> = {
  pending: 'statusPending',
  approved: 'statusApproved',
  rejected: 'statusRejected',
  cancelled: 'statusCancelled',
  draft: 'statusDraft',
}

/** Field copy per documented content key; an unlisted key keeps its own name. */
const FIELD_LABEL: Readonly<Record<string, OaWorkbenchKey>> = {
  start_date: 'fieldStart',
  end_date: 'fieldEnd',
  reason: 'fieldReason',
  amount: 'fieldAmount',
  project_no: 'fieldProject',
}

/** Which tab is showing. */
type ApprovalView = 'list' | number

/**
 * @param props - localized copy and the three approval reads.
 * @returns the approvals module.
 */
export function OaApprovalsModule({ t, loadApprovals, loadApproval, actOnApproval }: OaApprovalsProps) {
  const [tab, setTab] = useState<OaApprovalTab>('pending')
  const [list, setList] = useState<readonly OaApproval[] | undefined>(undefined)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [docs, setDocs] = useState<readonly number[]>([])
  const [view, setView] = useState<ApprovalView>('list')
  const [details, setDetails] = useState<Readonly<Record<number, OaApprovalDetail>>>({})
  const [comments, setComments] = useState<Readonly<Record<number, string>>>({})
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    setList(undefined)
    setListError(undefined)
    void loadApprovals(tab).then((rows) => {
      if (live) setList(rows)
    }).catch((error: unknown) => {
      if (live) setListError(error instanceof Error ? error.message : '')
    })
    return () => { live = false }
  }, [tab, loadApprovals])

  const open = (id: number): void => {
    setDocs(open => open.includes(id) ? open : [...open, id])
    setView(id)
    setActionError(undefined)
    if (details[id] !== undefined) return
    void loadApproval(id).then((detail) => {
      setDetails(current => ({ ...current, [id]: detail }))
    }).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : '')
    })
  }

  const close = (id: number): void => {
    setDocs(open => open.filter(doc => doc !== id))
    setDetails((current) => {
      const next: Record<number, OaApprovalDetail> = {}
      for (const [key, detail] of Object.entries(current)) {
        if (Number(key) !== id) next[Number(key)] = detail
      }
      return next
    })
    if (view === id) setView('list')
  }

  const decide = async (detail: OaApprovalDetail, action: OaApprovalAction): Promise<void> => {
    const comment = comments[detail.id] ?? ''
    if (action === 'reject' && comment.trim() === '') {
      setActionError(t('rejectNeedsComment'))
      return
    }
    setBusy(true)
    setActionError(undefined)
    try {
      await actOnApproval({ id: detail.id, action, comment })
      const fresh = await loadApproval(detail.id)
      setDetails(current => ({ ...current, [detail.id]: fresh }))
      setList(await loadApprovals(tab))
    } catch (error: unknown) {
      setActionError(error instanceof Error && error.message !== '' ? error.message : t('actionRefused'))
    } finally {
      setBusy(false)
    }
  }

  const contentRows = (content: OaApprovalContent): ReadonlyArray<readonly [string, string]> =>
    Object.entries(content).map(([key, value]) => {
      const label = FIELD_LABEL[key]
      const text = value === null ? '' : Array.isArray(value) ? value.join('、') : String(value)
      return [label === undefined ? key : t(label), text] as const
    })

  const active = typeof view === 'number' ? details[view] : undefined

  return <div className={css.body}>
    <div className={css.subBar} role="tablist">
      <button type="button" role="tab" aria-selected={view === 'list'} className={css.subTab} onClick={() => { setView('list') }}>
        {t(TAB_LABEL[tab])}
      </button>
      {docs.map((id) => {
        const row = (list ?? []).find(item => item.id === id)
        return <span key={id} className={css.docTab}>
          <button type="button" role="tab" aria-selected={view === id} className={css.subTab} onClick={() => { setView(id) }}>
            {row === undefined ? `#${String(id)}` : row.title.slice(0, 12)}
          </button>
          <button type="button" className={css.close} aria-label={t('close')} onClick={() => { close(id) }}>×</button>
        </span>
      })}
    </div>

    <div hidden={view !== 'list'}>
      <div className={css.chips} style={{ marginBottom: 14 }}>
        {TABS.map(id => <button
          key={id}
          type="button"
          className={css.chip}
          aria-pressed={tab === id}
          onClick={() => { setTab(id); setView('list') }}
        >{t(TAB_LABEL[id])}</button>)}
      </div>
      {listError !== undefined
        ? <p className={css.error}>{t('approvalsFailed')} {listError}</p>
        : list === undefined
          ? <p className={css.muted}>{t('loading')}</p>
          : list.length === 0
            ? <p className={css.muted}>{t('noApprovals')}</p>
            : <ul className={css.list}>{list.map(row => <li key={row.id}>
              <button type="button" className={css.row} onClick={() => { open(row.id) }}>
                <span className={css.rowBody}>
                  <span className={css.rowTitle}>{row.title}</span>
                  <span className={css.rowMeta}>{row.applicantName} · {row.department} · {row.createdAt}</span>
                </span>
                <span className={css.doneTag}>{t(STATUS_LABEL[row.status] ?? 'statusUnknown')}</span>
              </button>
            </li>)}</ul>}
    </div>

    {docs.map((id) => {
      const detail = details[id]
      return <article key={id} className={css.doc} hidden={view !== id}>
        {detail === undefined
          ? <p className={css.muted}>{t('loading')}</p>
          : <>
            <h2 className={css.detailTitle}>{detail.title}</h2>
            <p className={css.detailMeta}>
              {detail.applicantName} · {detail.department} · {detail.createdAt}
              {' '}{t(STATUS_LABEL[detail.status] ?? 'statusUnknown')}
            </p>

            <h3 className={css.sectionTitle}>{t('fields')}</h3>
            <dl className={css.kv}>
              {contentRows(detail.content).map(([label, value]) => <Fragment key={label}>
                <dt>{label}</dt><dd>{value}</dd>
              </Fragment>)}
            </dl>

            <h3 className={css.sectionTitle}>{t('nodes')}</h3>
            <ul className={css.list}>
              {detail.nodes.map(node => <li key={node.id} className={css.settingRow}>
                <span className={css.rowBody}>
                  <span className={css.rowTitle}>{node.approverName}</span>
                  <span className={css.rowMeta}>{node.approvedAt ?? node.comment ?? ''}</span>
                </span>
                {node.state === 'pending' ? <span className={css.doneTag}>{t('statusPending')}</span> : null}
              </li>)}
            </ul>

            {detail.ccUsers.length > 0 ? <>
              <h3 className={css.sectionTitle}>{t('copiedTo')}</h3>
              <p className={css.rowMeta}>{detail.ccUsers.map(user => user.userName).join('、')}</p>
            </> : null}

            <h3 className={css.sectionTitle}>{t('commentLabel')}</h3>
            <textarea
              className={css.comment}
              placeholder={t('commentHint')}
              value={comments[detail.id] ?? ''}
              disabled={!detail.canApprove && !detail.canCancel}
              onChange={(event) => {
                const value = event.target.value
                setComments(current => ({ ...current, [detail.id]: value }))
              }}
            />
            <div className={css.actions}>
              {detail.canApprove ? <>
                <Button variant="primary" disabled={busy} onClick={() => { void decide(detail, 'approve') }}>{t('approve')}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => { void decide(detail, 'reject') }}>{t('reject')}</Button>
              </> : <span className={css.muted}>{detail.canCancel ? '' : t('acted')}</span>}
              {detail.canCancel
                ? <Button variant="ghost" disabled={busy} onClick={() => { void decide(detail, 'cancel') }}>{t('cancelRequest')}</Button>
                : null}
            </div>
            {actionError === undefined ? null : <p className={css.error}>{actionError}</p>}
          </>}
      </article>
    })}
    {active === undefined && actionError !== undefined && view === 'list'
      ? <p className={css.error}>{actionError}</p>
      : null}
  </div>
}
