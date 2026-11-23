/**
 * Contract between the OA account plugin's apply closure and its Cordis-free
 * components: the snapshot one hook publishes and the operations the closure
 * injects. Components receive these as plain data and callbacks.
 *
 * @module @tianma/dsh-oa-account-ui/contract
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  OaApproval,
  OaApprovalActionRequest,
  OaApprovalDetail,
  OaApprovalTab,
  OaAttendanceSummary,
  OaAttendanceToday,
  OaCaptcha,
  OaMessage,
  OaNotificationPreference,
  OaNotificationPreferencePatch,
  OaSchedule,
  OaSessionView,
  OaStats,
  OaTaskGroup,
  OaTodo,
  OaUser,
} from '@tianma/dsh-oa-account/types'

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

/** The workbench modules this panel opens. */
export type OaWorkbenchModule = 'overview' | 'messages' | 'approval' | 'schedules' | 'tasks' | 'attendance' | 'todos'

/** One loaded slice, so a failed read reports itself without clearing the others. */
export interface OaWorkbenchSlice<T> {
  /** The read value, absent until it lands. */
  value: T | undefined
  /** Whether the read is in flight. */
  loading: boolean
  /** The backend's own refusal message, when the read was refused. */
  error: string | undefined
}

/** Everything the workbench panel renders. */
export interface OaWorkbenchSnapshot {
  /** Whether an account is signed in; the panel shows a sign-in notice when not. */
  signedIn: boolean
  /** Personal counters, shared with the Settings page's read. */
  stats: OaWorkbenchSlice<OaStats>
  /** Station messages, newest first. */
  messages: OaWorkbenchSlice<readonly OaMessage[]>
  /** Personal to-dos, unfinished first. */
  todos: OaWorkbenchSlice<readonly OaTodo[]>
  /** Today's attendance. */
  attendance: OaWorkbenchSlice<OaAttendanceToday>
  /** The notification switches. */
  notifications: OaWorkbenchSlice<OaNotificationPreference>
}

/** Host operations injected into the Cordis-free workbench components. */
export interface OaWorkbenchInjected {
  /** Host-owned workbench snapshot observed through framework hooks. */
  hooks: { oaWorkbench: HostObservable<OaWorkbenchSnapshot> }
  /** Open the sign-in dialog owned by the account surfaces. */
  openLogin: () => void
  /** Re-read every slice. */
  refresh: () => Promise<void>
  /**
   * Mark one message read.
   * @param id - the message id.
   */
  readMessage: (id: number) => Promise<void>
  /** Mark every unread message read. */
  readAllMessages: () => Promise<void>
  /**
   * Create one to-do item.
   * @param content - the item text.
   */
  createTodo: (content: string) => Promise<void>
  /**
   * Flip one item's done flag.
   * @param id - the item id.
   */
  toggleTodo: (id: number) => Promise<void>
  /**
   * Punch in for today.
   * @param lunchBreak - whether the lunch break counts toward the required hours.
   */
  checkIn: (lunchBreak: boolean) => Promise<void>
  /** Punch out for today. */
  checkOut: () => Promise<void>
  /**
   * Write the notification switches.
   * @param patch - the switches to change.
   */
  setPreference: (patch: OaNotificationPreferencePatch) => Promise<void>
  /**
   * Read one approval list.
   * @param tab - which list to read.
   * @returns the approvals, newest first.
   * @throws when the backend refuses the read.
   */
  loadApprovals: (tab: OaApprovalTab) => Promise<readonly OaApproval[]>
  /**
   * Read one approval with what this account may do with it.
   * @param id - the approval id.
   * @returns the approval detail.
   * @throws when the backend refuses the read.
   */
  loadApproval: (id: number) => Promise<OaApprovalDetail>
  /**
   * Apply one approval decision.
   * @param request - the approval, the decision, and its comment.
   * @throws when the backend refuses the decision.
   */
  actOnApproval: (request: OaApprovalActionRequest) => Promise<void>
  /**
   * Read today's schedule.
   * @returns today's entries, leave lines included.
   * @throws when the backend refuses the read.
   */
  loadSchedules: () => Promise<readonly OaSchedule[]>
  /**
   * Read this account's task board.
   * @returns the deadline buckets the backend populated.
   * @throws when the backend refuses the read.
   */
  loadTaskBoard: () => Promise<readonly OaTaskGroup[]>
  /**
   * Mark one task complete.
   * @param id - the task id.
   * @throws when the backend refuses the write.
   */
  completeTask: (id: number) => Promise<void>
  /**
   * Read one month's attendance summary.
   * @param period - `YYYY-MM`; absent reads the current month.
   * @returns the summary the backend computed.
   * @throws when the backend refuses the read.
   */
  loadAttendanceSummary: (period?: string) => Promise<OaAttendanceSummary>
}
