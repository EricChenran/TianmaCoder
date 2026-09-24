/**
 * Contract between the OA account plugin's apply closure and its Cordis-free
 * components: the snapshot one hook publishes and the operations the closure
 * injects. Components receive these as plain data and callbacks.
 *
 * @module @tianma/dsh-oa-account-ui/contract
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { OaCaptcha, OaSessionView, OaStats, OaUser } from '@tianma/dsh-oa-account/types'

/** Everything the account surfaces render. */
export interface OaAccountSnapshot {
  /** Latest session projection, absent until the first read answers. */
  session: OaSessionView | undefined
  /** Account holder read from the backend, absent while loading or signed out. */
  profile: OaUser | undefined
  /** Workbench counters, absent while loading or signed out. */
  stats: OaStats | undefined
  /** Whether the session stream reported a terminal failure. */
  failed: boolean
  /** Whether the sign-in dialog is open. */
  loginVisible: boolean
  /** Whether a sign-in request is in flight. */
  loginPending: boolean
  /**
   * Sign-in failure to show: the backend's own message, or an empty string when
   * the request failed without one — the dialog then renders localized copy.
   * Absent when the last attempt did not fail.
   */
  loginError: string | undefined
  /** Current captcha challenge for the dialog. */
  captcha: OaCaptcha | undefined
  /** Whether profile and counters are being (re)loaded. */
  loading: boolean
  /** Whether a profile write is in flight. */
  saving: boolean
  /** Profile write outcome: absent before the first save, otherwise its message or an empty string. */
  saveError: string | undefined
  /** Whether the last profile write succeeded. */
  saved: boolean
}

/** Profile fields the account owner may change. */
export interface OaProfileDraft {
  /** New display name. */
  name?: string
  /** New phone number. */
  phone?: string
  /** New avatar path or URL. */
  avatar?: string
}

/** Host operations injected into the Cordis-free account components. */
export interface OaAccountInjected {
  /** Host-owned account snapshot observed through framework hooks. */
  hooks: { oaAccount: HostObservable<OaAccountSnapshot> }
  /** Open the sign-in dialog and load a fresh challenge. */
  openLogin: () => void
  /** Close the sign-in dialog. */
  closeLogin: () => void
  /** Load a fresh captcha challenge. */
  refreshCaptcha: () => Promise<void>
  /**
   * Submit one sign-in attempt; the dialog keeps the entered values on failure.
   * @param account - login account name.
   * @param password - account password.
   * @param captcha - the solved challenge answer.
   */
  submit: (account: string, password: string, captcha: string) => Promise<void>
  /** Discard the stored session. */
  signOut: () => Promise<void>
  /** Re-read the account holder and the counters. */
  load: () => Promise<void>
  /**
   * Write the changed profile fields.
   * @param draft - the fields to write; omitted fields stay unchanged.
   */
  save: (draft: OaProfileDraft) => Promise<void>
}
