/**
 * Public types of the Tianma OA account service: the account projection the
 * Web GUI renders, the sign-in inputs it collects, and the failure vocabulary
 * every caller branches on. Wire field names stay in `protocol.ts`; these types
 * are the service's own camel-case vocabulary.
 *
 * @module @tianma/dsh-oa-account/types
 */

/**
 * Account states the OA backend documents. A status outside this set is not
 * active: callers treat an unknown state exactly like a disabled account
 * rather than assuming the account may proceed.
 */
export type OaUserStatus = 'active' | 'disabled' | 'banned'

/** One OA account holder as the backend reports it. */
export interface OaUser {
  /** Backend user id. */
  id: number
  /** Login account name. */
  account: string
  /** Display name. */
  name: string
  /** Employee number. */
  code: string
  /** Phone number, already masked by the backend when it masks at all. */
  phone: string
  /** Department name. */
  department: string
  /** Job title. */
  position: string
  /** Job grade. */
  level: string
  /** Avatar path or URL; a path is relative to the OA origin. */
  avatar: string
  /** Hire date. */
  hireDate: string
  /** Employment kind: `formal` or `intern`. */
  employmentType: string
  /** Role name: `employee`, `admin`, or `super_admin` on the shipped backend. */
  role: string
  /** Server-reported account state; compare with {@link OaUserStatus}. */
  status: string
  /** Whether WeChat is bound to this account. */
  wxBound: boolean
  /** Creation timestamp as the backend reports it. */
  createdAt: string
}

/** One captcha challenge: the id to return with the sign-in request, and its image. */
export interface OaCaptcha {
  /** Opaque challenge id, echoed back by {@link OaSignInRequest.captchaId}. */
  captchaId: string
  /** Renderable image URL, a `data:` URL on the shipped backend. */
  image: string
}

/** The credentials one sign-in attempt submits. */
export interface OaSignInRequest {
  /** Login account name. */
  account: string
  /** Account password; never stored and never logged. */
  password: string
  /** Challenge id from the captcha the human just solved. */
  captchaId: string
  /** The human's answer to that challenge. */
  captcha: string
}

/** The signed-in account projection the GUI renders. */
export interface OaSessionView {
  /** Whether a stored, still-usable session exists. */
  signedIn: boolean
  /** The account holder while signed in. */
  user: OaUser | null
  /** Server-reported account state while signed in; null when signed out. */
  status: string | null
  /** Origin that relative asset paths such as {@link OaUser.avatar} resolve against. */
  assetOrigin: string
}

/** Fields a user may change on their own profile; an absent field is left unchanged. */
export interface OaProfilePatch {
  /** New display name. */
  name?: string
  /** New phone number. */
  phone?: string
  /** New avatar path or URL. */
  avatar?: string
}

/** Personal workbench counters. */
export interface OaStats {
  /** Approval counters. */
  approval: {
    /** Requests waiting for this user. */
    pending: number
    /** This user's own submitted applications. */
    myApplications: number
    /** This user's rejected applications. */
    rejected: number
  }
  /** Task counters. */
  task: {
    /** Overdue tasks. */
    overdue: number
    /** Tasks due today. */
    today: number
    /** Tasks coming up. */
    upcoming: number
    /** Recorded work hours. */
    workHours: number
  }
  /** Schedule counters. */
  schedule: {
    /** Entries scheduled for today. */
    today: number
  }
}

/**
 * Failure vocabulary of the account service. Every caller branches on this
 * closed set instead of matching backend text.
 *
 * - `unauthenticated` — no usable token; the caller must sign in again.
 * - `rejected` — the backend refused the request and its message is shown.
 * - `forbidden` — authenticated but not allowed.
 * - `rate-limited` — the backend is throttling this client.
 * - `network` — the request never reached the backend.
 * - `timeout` — the request exceeded its deadline.
 * - `protocol` — the backend answered outside the documented envelope.
 */
export type OaAccountErrorCode =
  | 'unauthenticated'
  | 'rejected'
  | 'forbidden'
  | 'rate-limited'
  | 'network'
  | 'timeout'
  | 'protocol'

/** Why a conversation start was refused. */
export type OaGateDenial =
  | 'signed-out'
  | 'inactive-account'

/**
 * Whether a conversation may start, and why not when it may not. The Host and
 * the browser client both read this decision, so a client-side check and the
 * authoritative one can never disagree about the reason.
 */
export type OaGateDecision =
  | { allowed: true }
  | { allowed: false; reason: OaGateDenial }

/* ────────────────────────── 工作台：消息 ────────────────────────── */

/**
 * What a station message announces. The shipped backend names the kind in
 * `system`; a value this build has never seen reads as `other` rather than
 * failing the whole list.
 */
export type OaMessageKind =
  | 'salary-slip'
  | 'approval-request'
  | 'approval-approved'
  | 'approval-rejected'
  | 'approval-copy'
  | 'schedule-share'
  | 'schedule-reply'
  | 'task-assigned'
  | 'cloud-file'
  | 'other'

/**
 * Business data a message carries for the client to jump with. Every field is
 * optional because the backend sends `{}` for kinds that have no target.
 */
export interface OaMessagePayload {
  /** Approval this message points at. */
  approvalId?: number
  /** Title of that approval. */
  approvalTitle?: string
  /** Name of the applicant the message is about. */
  applicantName?: string
  /** Salary slip this message announces. */
  salarySlipId?: number
  /** Pay period of that slip, `YYYY-MM`. */
  period?: string
  /** Net pay of that slip, as the backend formats it. */
  netPay?: string
  /** Name of a pushed file. */
  fileName?: string
  /** Stored path of that file. */
  filePath?: string
  /** Kind of that file. */
  fileType?: string
  /** Size of that file in bytes. */
  fileSize?: number
  /** Download path of that file, relative to the OA origin. */
  downloadUrl?: string
}

/** One station message. */
export interface OaMessage {
  /** Message id. */
  id: number
  /** What the message announces. */
  kind: OaMessageKind
  /** One-line summary as the backend wrote it. */
  summary: string
  /** Human time: `HH:MM` today, `MM-DD` within a week, `YYYY-MM-DD` before. */
  time: string
  /** Whether the message is still unread. */
  unread: boolean
  /** Business data to jump with. */
  payload: OaMessagePayload
}

/** Which messages to read. */
export type OaMessageTab = 'all' | 'unread'

/** The notification switches this deployment exposes. */
export interface OaNotificationPreference {
  /** Whether WeChat subscription messages are enabled. */
  externalMessageEnabled: boolean
  /** Whether a pending approval notifies its approver. */
  approvalRequestEnabled: boolean
  /** Whether the account has a bound WeChat identity. */
  wxBound: boolean
  /** Whether the backend has a subscription template configured. */
  templateConfigured: boolean
}

/** The switches a client may change; an absent field is left as it is. */
export interface OaNotificationPreferencePatch {
  /** New value for the WeChat subscription switch. */
  externalMessageEnabled?: boolean
  /** New value for the approval-notification switch. */
  approvalRequestEnabled?: boolean
}

/* ────────────────────────── 工作台：待办 ────────────────────────── */

/** One personal to-do item. */
export interface OaTodo {
  /** To-do id. */
  id: number
  /** Item text. */
  text: string
  /** Whether the item is done. */
  done: boolean
  /** Human time the backend formats for the list. */
  time: string
}

/* ────────────────────────── 工作台：审批 ────────────────────────── */

/** Which approval list to read. */
export type OaApprovalTab = 'pending' | 'approved' | 'cc' | 'submitted'

/** Approval state as the backend reports it; an unlisted value reads as `unknown`. */
export type OaApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'draft' | 'unknown'

/** One approval node's state; `transferred` exists in reads but has no write path. */
export type OaApprovalNodeState = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'transferred' | 'unknown'

/** One scalar, or one list of scalars, in an approval's category-defined content. */
export type OaApprovalContentValue = string | number | boolean | null | readonly string[]

/**
 * Category-defined fields of one approval. Keys are the backend's own
 * snake-case names (`start_date`, `reason`, …) because the client renders them
 * per category and must round-trip them unchanged on a draft write.
 */
export type OaApprovalContent = Readonly<Record<string, OaApprovalContentValue>>

/** One approval level. */
export interface OaApprovalNode {
  /** Node id. */
  id: number
  /** Level this node belongs to, starting at 1. */
  level: number
  /** Node state. */
  state: OaApprovalNodeState
  /** Approver's comment, absent until the node is handled. */
  comment: string | null
  /** Approver's display name. */
  approverName: string
  /** Approver's avatar path. */
  approverAvatar: string
  /** Chinese-format time the node was handled. */
  approvedAt: string | null
}

/** One user copied on an approval. */
export interface OaApprovalCopy {
  /** Copy row id. */
  id: number
  /** Copied user's display name. */
  userName: string
  /** Copied user's department. */
  department: string
  /** When that user first opened the approval, absent until then. */
  readAt: string | null
  /** When the copy was created. */
  createdAt: string
}

/** One approval as the employee side lists and reads it. */
export interface OaApproval {
  /** Approval id. */
  id: number
  /** Title the applicant gave it. */
  title: string
  /** Category name, which is also the submit key. */
  type: string
  /** Applicant's department. */
  department: string
  /** Project name, when the category asks for one. */
  projectName: string | null
  /** Project number, when the category asks for one. */
  projectNo: string | null
  /** Chinese-format submission time. */
  createdAt: string
  /** Applicant's display name. */
  applicantName: string
  /** Applicant's avatar path. */
  applicantAvatar: string
  /** Human arrival sentence the backend formats. */
  arrivalTime: string
  /** Approval state. */
  status: OaApprovalStatus
  /** Category-defined content. */
  content: OaApprovalContent
  /** Level currently awaiting an approver. */
  currentLevel: number
  /** Number of levels this approval has. */
  totalLevels: number
  /** Levels in ascending order. */
  nodes: readonly OaApprovalNode[]
  /** Users copied on this approval. */
  ccUsers: readonly OaApprovalCopy[]
}

/**
 * One approval plus what the reader may do with it. Reading a detail writes the
 * copier's `read_at` on the backend, so the client reads it on demand rather
 * than to decorate a list.
 */
export interface OaApprovalDetail extends OaApproval {
  /** Whether the reader is the current level's pending approver. */
  canApprove: boolean
  /** Whether the reader is a copier on this approval. */
  isCc: boolean
  /** Whether the reader may cancel it now. */
  canCancel: boolean
  /** Why cancelling is blocked, when it is. */
  cancelDisabledReason: string | null
}

/** The three approval decisions the employee side accepts. */
export type OaApprovalAction = 'approve' | 'reject' | 'cancel'

/** One decision applied to one approval. */
export interface OaApprovalActionRequest {
  /** Approval id. */
  id: number
  /** The decision to apply. */
  action: OaApprovalAction
  /** Decision comment; the backend records `申请人撤销` for an empty cancel reason. */
  comment: string
}

/** One approval category the submit form renders. */
export interface OaApprovalType {
  /** Category id. */
  id: number
  /** Category name, echoed as the submit's `type`. */
  name: string
  /** Group: `attendance`, `finance`, or `admin`. */
  group: string
  /** Whether the form needs a project number. */
  requiresProject: boolean
  /** Whether the form needs an amount. */
  requiresAmount: boolean
  /** Whether the form needs an attachment. */
  requiresAttachment: boolean
  /** Whether the form needs a start and end date. */
  requiresDateRange: boolean
  /** Whether the form needs a flexible-work window. */
  requiresFlexibleTime: boolean
  /** Default approvers the category pre-fills. */
  defaultApproverIds: readonly number[]
}

/** One approval to submit, or to keep as a draft. */
export interface OaApprovalSubmitRequest {
  /** Category name. */
  type: string
  /** Title; drafts default to `未命名草稿` on the backend. */
  title: string
  /** Applicant department the form pre-fills. */
  department?: string
  /** Project number, when the category requires one. */
  projectNo?: string
  /** Category-defined content, sent as-is. */
  content: OaApprovalContent
  /** Approvers by user id; absent falls back to the category default, then to the department. */
  approverIds?: readonly number[]
  /** Copiers by user id. */
  ccUserIds?: readonly number[]
}

/* ────────────────────────── 工作台：日程 ────────────────────────── */

/**
 * What one today entry is. A shared meeting is an `event`; a leave line derived
 * from an approved request is a `leave` entry, whose id is a composite string.
 */
export type OaScheduleKind = 'event' | 'leave'

/** One entry in today's schedule. */
export interface OaSchedule {
  /** Entry id: a number for events, `approval-<id>-<date>` for leave lines. */
  id: string
  /** Whether this is a real event or a leave line derived from an approval. */
  kind: OaScheduleKind
  /** Title as the backend composed it. */
  title: string
  /** Display text; the leave line's own label. */
  text: string
  /** Start time `HH:MM:SS`, absent on an all-day leave line. */
  startTime: string | null
  /** End time `HH:MM:SS`, absent on an all-day leave line. */
  endTime: string | null
  /** Room, or the leave label on a derived line. */
  location: string
  /** This account's invitation state, absent when it is not a participant. */
  myInvite: string | null
  /** Whether this account may open the detail: true for events it can read, and for its own leave. */
  mine: boolean
}

/* ────────────────────────── 工作台：任务 ────────────────────────── */

/** Task state as the backend reports it; an unlisted value reads as `unknown`. */
export type OaTaskStatus = 'ongoing' | 'completed' | 'deleted' | 'unknown'

/** One assignee of a task. */
export interface OaTaskAssignee {
  /** User id. */
  id: number
  /** Display name. */
  name: string
  /** Avatar path. */
  avatar: string
}

/** One task. */
export interface OaTask {
  /** Task id. */
  id: number
  /** Title. */
  title: string
  /** `系统任务` or `自建任务`, as the backend decides from `type`. */
  typeLabel: string
  /** Deadline sentence such as `11月23日 18:00`, absent when there is none. */
  deadline: string | null
  /** Whether the deadline has passed; the backend computes it, there is no stored state. */
  overdue: boolean
  /** Task state. */
  status: OaTaskStatus
  /** Estimated hours, absent when the task tracks none. */
  estimatedHours: number | null
  /** Recorded hours. */
  actualHours: number | null
  /** Description. */
  description: string
  /** Everyone executing this task. */
  assignees: readonly OaTaskAssignee[]
}

/** One deadline bucket of the task board. */
export interface OaTaskGroup {
  /** Bucket name the backend fixed: `已超期`, `今天`, `未来7天`, `更远`, `无截止时间`, `已完成`. */
  name: string
  /** Tasks in this bucket, deadline ascending and undated last. */
  count: number
  /** Tasks in this bucket. */
  tasks: readonly OaTask[]
}

/* ────────────────────────── 工作台：考勤 ────────────────────────── */

/** One duty shift. */
export interface OaAttendanceShift {
  /** Shift name. */
  name: string
  /** Shift start `HH:MM`. */
  workStart: string
  /** Shift end `HH:MM`. */
  workEnd: string
  /** Grace minutes before a check-in counts late. */
  lateGraceMinutes: number
  /** Grace minutes before a check-out counts early. */
  earlyGraceMinutes: number
  /** Whether the shift allows flexible hours. */
  isFlexible: boolean
}

/** Day status as the backend judges it; an unlisted value reads as `unknown`. */
export type OaAttendanceDayStatus =
  | 'normal'
  | 'late'
  | 'early'
  | 'absent'
  | 'makeup'
  | 'leave'
  | 'rest'
  | 'unknown'

/** One day's attendance record. */
export interface OaAttendanceRecord {
  /** Record id. */
  id: number
  /** Business date `YYYY-MM-DD`. */
  workDate: string
  /** Clock-in time `YYYY-MM-DD HH:MM:SS`, absent before the first punch. */
  clockInAt: string | null
  /** Clock-out time, absent before the second punch. */
  clockOutAt: string | null
  /** `normal` or `late` once the day is judged. */
  clockInStatus: string | null
  /** `normal` or `early` once the day is judged. */
  clockOutStatus: string | null
  /** Day status. */
  dayStatus: OaAttendanceDayStatus
  /** Record source: `app`, `makeup`, or `system`. */
  source: string
  /** Administrator remark. */
  remark: string | null
  /** When this day's required work completes, derived from the clock-in and the lunch plan. */
  requiredCheckoutAt: string | null
  /** Minutes still owed today. */
  remainingMinutes: number | null
}

/** Today's attendance as one read returns it. */
export interface OaAttendanceToday {
  /** Business date. */
  date: string
  /** Current shift name, empty when none is configured. */
  shiftName: string
  /** Shift start `HH:MM`. */
  workStart: string
  /** Shift end `HH:MM`. */
  workEnd: string
  /** Whether the clock-in punch exists. */
  checkedIn: boolean
  /** Whether the clock-out punch exists. */
  checkedOut: boolean
  /** Whether today needs no punch at all. */
  noClockRequired: boolean
  /** Why no punch is needed, as the backend words it. */
  noClockText: string
  /** Today's record, absent before the first punch. */
  record: OaAttendanceRecord | null
  /** When today's required work completes. */
  requiredCheckoutAt: string | null
  /** Minutes still owed today. */
  remainingMinutes: number | null
  /** The punch window the backend allows, as one sentence. */
  checkinWindowText: string
}

/** One month's attendance summary. */
export interface OaAttendanceSummary {
  /** Period `YYYY-MM`. */
  period: string
  /** Working days that required attendance. */
  workDays: number
  /** Working days with a record. */
  actualDays: number
  /** Late arrivals. */
  lateCount: number
  /** Early departures. */
  earlyCount: number
  /** Absent working days. */
  absentCount: number
  /** Leave days. */
  leaveCount: number
  /** Whether the full-attendance bonus was earned. */
  fullAttendance: boolean
  /** Total penalty the backend computed, as text. */
  penaltyTotal: string
  /** Comp-leave days accrued this month. */
  compLeaveDays: number
}
