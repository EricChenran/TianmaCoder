/** Sign-in dialog: an OA account, its password, and one solved captcha challenge. */
import { useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OaAccountSnapshot } from './contract.ts'
import css from './Account.module.css'

/** Composed sign-in dialog props. */
export interface SignInDialogProps extends PropsLocale<'settings.oaAccount'> {
  /** Current snapshot: the captcha challenge, the in-flight state, and the last failure. */
  account: OaAccountSnapshot
  /** Dismiss the dialog. */
  close: () => void
  /** Load a fresh captcha challenge. */
  refreshCaptcha: () => Promise<void>
  /** Submit one attempt; entered values stay on failure. */
  submit: (account: string, password: string, captcha: string) => Promise<void>
}

/**
 * @param props - localized copy, the account snapshot, and the dialog operations.
 * @returns the sign-in dialog.
 */
export function SignInDialog({ account, close, refreshCaptcha, submit, t }: SignInDialogProps) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [captcha, setCaptcha] = useState('')
  const busy = account.loginPending
  const incomplete = name === '' || password === '' || captcha === ''
  const submitForm = (): void => {
    void submit(name, password, captcha).then(() => { setCaptcha('') }, () => undefined)
  }
  return <Modal
    open
    onClose={close}
    title={t('signInTitle')}
    closeLabel={t('cancel')}
    description={t('signInDescription')}
    footer={<>
      <Button variant="ghost" onClick={close} disabled={busy}>{t('cancel')}</Button>
      <Button variant="primary" onClick={submitForm} disabled={busy || incomplete}>
        {busy ? t('submitting') : t('submit')}
      </Button>
    </>}
  >
    <div className={css.form}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('account')}</span>
        <Input
          value={name}
          autoComplete="username"
          onChange={(event) => { setName(event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('password')}</span>
        <Input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => { setPassword(event.target.value) }}
        />
      </label>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('captcha')}</span>
        <span className={css.captchaRow}>
          <Input
            value={captcha}
            aria-label={t('captcha')}
            onChange={(event) => { setCaptcha(event.target.value) }}
          />
          {account.captcha === undefined
            ? <span className={css.captchaMissing}>{t('captchaFailed')}</span>
            : <img
              className={css.captcha}
              src={account.captcha.image}
              alt={t('captchaAlt')}
              title={t('captchaRefresh')}
              onClick={() => { void refreshCaptcha() }}
            />}
        </span>
      </div>
      {account.loginError !== undefined
        && <p className={css.error} role="alert">{account.loginError === '' ? t('loginFailed') : account.loginError}</p>}
    </div>
  </Modal>
}
