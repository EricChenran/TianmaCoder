/** Sidebar account launcher: who is signed in, and the sign-in or sign-out action. */
import { useState } from 'react'
import {
  IconRightUpOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OaSessionView } from '@tianma/dsh-oa-account/types'
import type { OaAccountInjected } from './contract.ts'
import { SignInDialog } from './SignInDialog.tsx'
import css from './Account.module.css'

/** Composed launcher props. */
export type OaAccountMenuProps =
  PropsRuntime<'settings.launcher'> & PropsLocale<'settings.oaAccount'> & InjectFace<OaAccountInjected>

/**
 * @param props - sidebar geometry, settings navigation, and the account operations.
 * @returns the account launcher and, while open, the sign-in dialog.
 */
export function OaAccountMenu({
  wide, openSettings, useOaAccount, openLogin, closeLogin, refreshCaptcha, submit, signOut, t,
}: OaAccountMenuProps) {
  const account = useOaAccount(state => state)
  const session = account.session
  const signedIn = session?.signedIn === true
  const avatar = avatarUrl(session?.user?.avatar ?? '', session?.assetOrigin ?? '')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const logout = (): void => {
    setBusy(true)
    setFailed(false)
    void signOut().then(() => { setOpen(false) }, () => { setFailed(true) }).finally(() => { setBusy(false) })
  }
  return <div className={css.root}>
    <Menu
      open={open}
      side="top"
      portal
      autoFocus
      className={css.anchor}
      anchor={<button
        type="button"
        className={css.trigger}
        aria-label={t('menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.avatar}>
          {avatar === undefined
            ? <IconUserOutlineMedium size={20} />
            : <img className={css.avatarImage} src={avatar} alt="" />}
        </span>
        {wide && <span className={css.label}>{signedIn ? sessionLabel(session, t('signedIn')) : t('signedOut')}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} /> },
        ...signedIn
          ? [{ id: 'signout', label: t('signOut'), icon: <IconRightUpOutlineMedium size={16} />, disabled: busy }]
          : [{ id: 'signin', label: t('signIn'), icon: <IconUserOutlineMedium size={16} /> }],
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (id === 'settings') { setOpen(false); openSettings() } else if (id === 'signin') { setOpen(false); openLogin() } else logout()
      }}
    />
    {account.loginVisible && <SignInDialog
      account={account}
      close={closeLogin}
      refreshCaptcha={refreshCaptcha}
      submit={submit}
      t={t}
    />}
    {failed && <span className={css.error} role="alert">{t('signOutFailed')}</span>}
  </div>
}

/**
 * Resolve a backend-relative avatar path against the account origin.
 * @param avatar - stored avatar path or absolute URL.
 * @param origin - account origin relative paths resolve against.
 * @returns the displayable URL, or undefined when no avatar is stored.
 */
export function avatarUrl(avatar: string, origin: string): string | undefined {
  if (avatar === '') return undefined
  if (/^[a-z]+:\/\//i.test(avatar)) return avatar
  return origin === '' ? avatar : `${origin}${avatar.startsWith('/') ? '' : '/'}${avatar}`
}

/**
 * @param session - the current session, absent until the first read answers.
 * @param fallback - copy to show while no name is known.
 * @returns the sidebar label for the signed-in account.
 */
function sessionLabel(session: OaSessionView | undefined, fallback: string): string {
  const name = session?.user?.name
  return name === undefined || name === '' ? fallback : name
}
