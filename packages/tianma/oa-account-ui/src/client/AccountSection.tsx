/** Settings section: the signed-in OA profile, its workbench counters, and the profile editor. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OaAccountInjected, OaProfileDraft } from './contract.ts'
import type { OaAccountKey } from './locales.ts'
import { avatarUrl } from './AccountMenu.tsx'
import css from './Account.module.css'

/** Composed account section props. */
export type OaAccountSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.oaAccount'> & InjectFace<OaAccountInjected>

/**
 * @param props - localized copy, the account snapshot, and the account operations.
 * @returns the account settings page.
 */
export function OaAccountSection({ useOaAccount, openLogin, load, save, t }: OaAccountSectionProps) {
  const account = useOaAccount(state => state)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [avatar, setAvatar] = useState('')
  const signedIn = account.session?.signedIn === true
  const profile = account.profile
  useEffect(() => { if (signedIn) void load() }, [signedIn, load])
  useEffect(() => {
    if (profile === undefined) return
    setName(profile.name)
    setPhone(profile.phone)
    setAvatar(profile.avatar)
  }, [profile])
  if (!signedIn) {
    return <div className={css.section}>
      <p className={css.notice}>{t('signInDescription')}</p>
      <div className={css.actions}>
        <Button variant="primary" onClick={openLogin}>{t('signIn')}</Button>
      </div>
    </div>
  }
  const image = avatarUrl(profile?.avatar ?? '', account.session?.assetOrigin ?? '')
  const submitEdit = (): void => {
    const draft: OaProfileDraft = {}
    if (name !== (profile?.name ?? '')) draft.name = name
    if (phone !== (profile?.phone ?? '')) draft.phone = phone
    if (avatar !== (profile?.avatar ?? '')) draft.avatar = avatar
    if (Object.keys(draft).length === 0) { setEditing(false); return }
    void save(draft).then(() => { setEditing(false) }, () => undefined)
  }
  return <div className={css.section}>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('profile')}</span>
      {image !== undefined && <img className={css.avatarImage} src={image} alt="" />}
      {profile === undefined
        ? <span className={css.notice}>{account.loading ? t('saving') : t('loadFailed')}</span>
        : <>
          <Row label={t('name')} value={profile.name} />
          <Row label={t('employeeCode')} value={profile.code} />
          <Row label={t('department')} value={profile.department} />
          <Row label={t('position')} value={profile.position} />
          <Row label={t('level')} value={profile.level} />
          <Row label={t('phone')} value={profile.phone} />
          <Row label={t('role')} value={profile.role} />
          <Row label={t('hireDate')} value={profile.hireDate} />
          <div className={css.row}>
            <span className={css.rowLabel}>{t('status')}</span>
            <span className={css.rowValue}>{statusLabel(profile.status, t)}</span>
          </div>
        </>}
    </div>
    <div className={css.group}>
      {editing
        ? <>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('name')}</span>
            <Input value={name} onChange={(event) => { setName(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('phone')}</span>
            <Input value={phone} onChange={(event) => { setPhone(event.target.value) }} />
          </label>
          <div className={css.actions}>
            <Button variant="primary" onClick={submitEdit} disabled={account.saving}>
              {account.saving ? t('saving') : t('save')}
            </Button>
            <Button variant="ghost" onClick={() => { setEditing(false) }} disabled={account.saving}>{t('cancel')}</Button>
            {account.saveError !== undefined
              && <span className={css.error} role="alert">{account.saveError === '' ? t('saveFailed') : account.saveError}</span>}
            {account.saved && <span className={css.notice}>{t('saved')}</span>}
          </div>
        </>
        : <div className={css.actions}>
          <Button variant="outline" onClick={() => { setEditing(true) }}>{t('edit')}</Button>
        </div>}
    </div>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('workbench')}</span>
      {account.stats === undefined
        ? <span className={css.notice}>{t('statsFailed')}</span>
        : <div className={css.stats}>
          <Stat label={t('approvalPending')} value={account.stats.approval.pending} />
          <Stat label={t('approvalMine')} value={account.stats.approval.myApplications} />
          <Stat label={t('approvalRejected')} value={account.stats.approval.rejected} />
          <Stat label={t('taskOverdue')} value={account.stats.task.overdue} />
          <Stat label={t('taskToday')} value={account.stats.task.today} />
          <Stat label={t('taskUpcoming')} value={account.stats.task.upcoming} />
          <Stat label={t('taskWorkHours')} value={account.stats.task.workHours} />
          <Stat label={t('scheduleToday')} value={account.stats.schedule.today} />
        </div>}
    </div>
  </div>
}

/**
 * @param props - the row label and its value.
 * @returns one definition row.
 */
function Row({ label, value }: { label: string; value: string }) {
  return <div className={css.row}>
    <span className={css.rowLabel}>{label}</span>
    <span className={css.rowValue}>{value}</span>
  </div>
}

/**
 * @param props - the counter label and its value.
 * @returns one counter cell.
 */
function Stat({ label, value }: { label: string; value: number }) {
  return <div className={css.stat}>
    <span className={css.statLabel}>{label}</span>
    <span className={css.statValue}>{String(value)}</span>
  </div>
}

/**
 * Map a server-reported account state onto localized copy.
 * @param status - server-reported state.
 * @param t - the namespace's translation seat.
 * @returns the localized state name, or the unknown-state copy.
 */
function statusLabel(status: string, t: (key: OaAccountKey) => string): string {
  if (status === 'active') return t('statusActive')
  if (status === 'disabled') return t('statusDisabled')
  if (status === 'banned') return t('statusBanned')
  return t('statusUnknown')
}
