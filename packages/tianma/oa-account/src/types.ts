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
