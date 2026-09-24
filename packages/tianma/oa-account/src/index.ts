/**
 * Tianma OA account service at `ctx.oaAccount`: captcha sign-in, the
 * dual-token session kept in the credential seam's records, the silent
 * single re-sign that recovers an expired access token, and the signed-in
 * decision that gates starting a conversation.
 *
 * The session lives in `$DSH_HOME/.credentials.yaml` as one grant record owned
 * by this plugin, so it survives restarts, is written atomically under a
 * cross-process lock, and never reaches browser JavaScript. Account state is
 * re-read from storage on every call, so a sign-out in one process is visible
 * to the next call in another.
 *
 * The OA backend keeps no token revocation list: signing out discards the
 * local record, and the account-state check the backend performs on every
 * request is what actually ends a disabled or banned session.
 *
 * @module @tianma/dsh-oa-account
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PromptAdmission, PromptAdmissionRefusal } from '@deepseek-ai/dsh-api-session-controller/types'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import {
  OaAccountError,
  fetchCaptcha,
  fetchProfile,
  fetchStats,
  oaBaseUrl,
  postRefresh,
  postSignIn,
  postSignOut,
  putProfile,
} from './protocol.ts'
import type {
  OaCaptcha,
  OaGateDecision,
  OaProfilePatch,
  OaSessionView,
  OaSignInRequest,
  OaStats,
  OaUser,
} from './types.ts'

export type * from './types.ts'
export { OaAccountError } from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oaAccount: OaAccountService
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * The OA API base URL, including its version segment. Deployment-specific, so
   * it has no default here: a composition supplies it from its own environment.
   */
  baseUrl: string
  /**
   * Deadline for one OA request in milliseconds. The backend issues
   * two-hour access tokens, so this only bounds a single round trip.
   */
  requestTimeoutMs: number
  /**
   * Whether starting a conversation requires a signed-in account whose status
   * is `active`. Turning this off mounts the account surfaces without gating
   * the product, which a development composition may want.
   */
  requireSignIn: boolean
}

/** The stored session this plugin owns. */
const SESSION_KEY = credentialKey('tianma-oa-account', 'session')

/** Durable form of one stored account holder. */
const storedUser = zod.object({
  id: zod.number(),
  account: zod.string(),
  name: zod.string(),
  code: zod.string(),
  phone: zod.string(),
  department: zod.string(),
  position: zod.string(),
  level: zod.string(),
  avatar: zod.string(),
  hireDate: zod.string(),
  employmentType: zod.string(),
  role: zod.string(),
  status: zod.string(),
  wxBound: zod.boolean(),
  createdAt: zod.string(),
})

/** Durable form of the stored session, versioned so a later shape can migrate. */
const storedSession = zod.object({
  version: zod.literal(1),
  token: zod.string().min(1),
  refreshToken: zod.string().min(1),
  user: storedUser,
})

/** The session as this service holds it in memory. */
type Session = zod.infer<typeof storedSession>

/**
 * Whether a server-reported status lets the account proceed. Anything outside
 * the documented `active` state — including a state this build has never seen —
 * is refused, so an unknown value can never widen access.
 * @param status - server-reported account state.
 * @returns true only for `active`.
 */
export function isActiveStatus(status: string | null): boolean {
  return status === 'active'
}

/**
 * Reads and writes the OA session and answers whether a conversation may start.
 * Requires the credential seam; the record it owns is `tianma-oa-account/session`.
 */
export class OaAccountService extends TypertRemoteService {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config = z.object({
    baseUrl: z.string().required(),
    requestTimeoutMs: z.number().default(30_000),
    requireSignIn: z.boolean().default(true),
  })

  static inject = ['credentials']

  private readonly base: URL
  private readonly requestTimeoutMs: number
  private readonly requireSignIn: boolean
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - Host carrying the credential seam.
   * @param config - composition-supplied base URL, deadline, and gate switch.
   * @throws {OaAccountError} code `rejected` when the configured base URL is unusable.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'oaAccount')
    this.base = oaBaseUrl(config.baseUrl)
    this.requestTimeoutMs = config.requestTimeoutMs
    this.requireSignIn = config.requireSignIn
  }

  /**
   * Mount the prompt-admission check once this service exists. Done here rather
   * than in the constructor so the child plugin — which waits for `oaAccount` —
   * is created after this service is constructed, and a deployment that mounts
   * the account row always gets the extension point the prompt path reads.
   */
  [Service.init](): void {
    this.ctx.plugin(OaPromptAdmission)
  }

  /**
   * Read the current session projection without contacting the backend.
   * @returns the stored session, or a signed-out view.
   */
  @Remote
  async session(): Promise<OaSessionView> {
    const session = await this.read()
    if (session === undefined) return this.signedOut()
    return { signedIn: true, user: session.user, status: session.user.status, assetOrigin: this.base.origin }
  }

  /**
   * Read one captcha challenge for the sign-in form.
   * @returns the challenge id and its renderable image.
   * @throws {OaAccountError} the classified failure of the request.
   */
  @Remote
  captcha(): Promise<OaCaptcha> {
    return fetchCaptcha(this.base, this.requestTimeoutMs)
  }

  /**
   * Sign in with a solved challenge and keep the resulting session.
   * @param request - account, password, and the solved challenge.
   * @returns the signed-in projection.
   * @throws {OaAccountError} code `rejected` with the backend's reason, or a classified transport failure.
   */
  @Remote
  async signIn(request: OaSignInRequest): Promise<OaSessionView> {
    const result = await postSignIn(this.base, request, this.requestTimeoutMs)
    if (!isActiveStatus(result.user.status)) {
      // The backend refuses a non-active account before issuing tokens; this
      // guard keeps a backend that changes that order from storing a session
      // the gate would then have to refuse.
      throw new OaAccountError('rejected', `oa account status "${result.user.status}" cannot sign in`)
    }
    await this.write({ version: 1, token: result.token, refreshToken: result.refreshToken, user: result.user })
    this.notify()
    return { signedIn: true, user: result.user, status: result.user.status, assetOrigin: this.base.origin }
  }

  /**
   * Discard the stored session. The backend has no revocation list, so the
   * local deletion is what signs the user out; the backend call is advisory
   * and its failure does not restore the session.
   * @returns the signed-out projection.
   */
  @Remote
  async signOut(): Promise<OaSessionView> {
    const session = await this.read()
    await this.ctx.credentials.deleteRecord(SESSION_KEY)
    this.notify()
    if (session !== undefined) {
      try {
        await postSignOut(this.base, session.token, this.requestTimeoutMs)
      } catch (error: unknown) {
        // Advisory only: the stored record is already gone, so a backend that
        // refuses the call leaves the user signed out either way. The code is
        // reported for diagnosis; no token is.
        console.info(`oa-account: backend sign-out refused (${error instanceof OaAccountError ? error.code : 'unknown'})`)
      }
    }
    return this.signedOut()
  }

  /**
   * Read the account holder, re-signing once when the access token has expired.
   * @returns the account holder.
   * @throws {OaAccountError} code `unauthenticated` when no usable session remains.
   */
  @Remote
  profile(): Promise<OaUser> {
    return this.authorized(token => fetchProfile(this.base, token, this.requestTimeoutMs))
  }

  /**
   * Read the personal workbench counters, re-signing once when the access token has expired.
   * @returns the counters.
   * @throws {OaAccountError} code `unauthenticated` when no usable session remains.
   */
  @Remote
  stats(): Promise<OaStats> {
    return this.authorized(token => fetchStats(this.base, token, this.requestTimeoutMs))
  }

  /**
   * Write the fields a user may change on their own profile.
   * @param patch - the fields to change; an absent field is left unchanged.
   * @returns the account holder after the write.
   * @throws {OaAccountError} code `unauthenticated` when no usable session remains.
   */
  @Remote
  async updateProfile(patch: OaProfilePatch): Promise<OaUser> {
    const body: Record<string, string> = {}
    if (patch.name !== undefined) body.name = patch.name
    if (patch.phone !== undefined) body.phone = patch.phone
    if (patch.avatar !== undefined) body.avatar = patch.avatar
    const user = await this.authorized(token => putProfile(this.base, token, body, this.requestTimeoutMs))
    const session = await this.read()
    // The write is the newest account fact this process holds; keeping it in
    // the session stops the sidebar from showing the pre-edit name.
    if (session !== undefined) await this.write({ ...session, user })
    this.notify()
    return user
  }

  /**
   * Decide whether a conversation may start.
   * @returns the decision, naming the reason when it refuses.
   */
  @Remote
  async gate(): Promise<OaGateDecision> {
    if (!this.requireSignIn) return { allowed: true }
    const session = await this.read()
    if (session === undefined) return { allowed: false, reason: 'signed-out' }
    if (!isActiveStatus(session.user.status)) return { allowed: false, reason: 'inactive-account' }
    return { allowed: true }
  }

  /**
   * Refuse the current operation unless a conversation may start. This is the
   * Host-side enforcement point: a client that never asks {@link gate} — or a
   * caller that reaches a session without a browser at all — still cannot put a
   * user message into a session.
   * @throws {OaAccountError} code `unauthenticated`, whose message names the gate denial.
   */
  async assertMayStartConversation(): Promise<void> {
    const decision = await this.gate()
    if (!decision.allowed) {
      throw new OaAccountError('unauthenticated', `oa account gate refused: ${decision.reason}`)
    }
  }

  /**
   * Stream the session projection, starting from the current value.
   * @param signal - stream lifetime; ending it stops the stream without signing out.
   * @returns the current projection followed by every change.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<OaSessionView> {
    return this.follow(signal)
  }

  /**
   * Run one protected request, re-signing once when the access token has expired.
   * @param run - the request to run with a usable access token.
   * @returns the request's result.
   * @throws {OaAccountError} code `unauthenticated` when no usable session remains.
   */
  private async authorized<T>(run: (token: string) => Promise<T>): Promise<T> {
    const session = await this.read()
    if (session === undefined) throw new OaAccountError('unauthenticated', 'oa account is not signed in')
    try {
      return await run(session.token)
    } catch (error: unknown) {
      if (!(error instanceof OaAccountError) || error.code !== 'unauthenticated') throw error
      const token = await this.reSign(session)
      return await run(token)
    }
  }

  /**
   * Exchange the stored refresh token for a fresh access token, discarding the
   * session when the backend refuses. The shipped backend does not rotate the
   * refresh token, so the stored one is kept.
   * @param session - the session whose access token expired.
   * @returns the new access token.
   * @throws {OaAccountError} code `unauthenticated` carrying the backend's reason.
   */
  private async reSign(session: Session): Promise<string> {
    let token: string
    try {
      token = await postRefresh(this.base, session.refreshToken, this.requestTimeoutMs)
    } catch (error: unknown) {
      await this.ctx.credentials.deleteRecord(SESSION_KEY)
      this.notify()
      if (error instanceof OaAccountError && error.code === 'unauthenticated') {
        throw new OaAccountError('unauthenticated', error.message)
      }
      throw error
    }
    await this.write({ ...session, token })
    return token
  }

  /** @returns the signed-out projection for this deployment's origin. */
  private signedOut(): OaSessionView {
    return { signedIn: false, user: null, status: null, assetOrigin: this.base.origin }
  }

  /**
   * Read the stored session, treating an unreadable record as signed out.
   * @returns the session, or undefined when none is stored or the record is not this plugin's shape.
   */
  private async read(): Promise<Session | undefined> {
    const record = await this.ctx.credentials.readRecord(SESSION_KEY)
    if (record === undefined || record.kind !== 'grant') return undefined
    const parsed = storedSession.safeParse(record.payload)
    return parsed.success ? parsed.data : undefined
  }

  /**
   * Replace the stored session.
   * @param session - the session to store.
   */
  private async write(session: Session): Promise<void> {
    await this.ctx.credentials.modifyRecord(SESSION_KEY, () => Promise.resolve({ kind: 'grant', payload: session }))
  }

  /**
   * Yield the session projection on every change.
   * @param signal - stream lifetime.
   * @returns the current projection followed by each change.
   */
  private async *follow(signal: AbortSignal): AsyncIterable<OaSessionView> {
    yield await this.session()
    while (!signal.aborted) {
      const changed = await this.waitForChange(signal)
      if (!changed) return
      yield await this.session()
    }
  }

  /**
   * Wait for the next session change or the end of the stream.
   * @param signal - stream lifetime.
   * @returns true when the session changed, false when the stream ended.
   */
  private waitForChange(signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (changed: boolean): void => {
        this.listeners.delete(listener)
        signal.removeEventListener('abort', onAbort)
        resolve(changed)
      }
      const listener = (): void => { done(true) }
      const onAbort = (): void => { done(false) }
      this.listeners.add(listener)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Wake every open stream. */
  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export default OaAccountService

/**
 * Prompt admission for this deployment: a conversation may start only while a
 * signed-in account is active. Mounted as `ctx.promptAdmission`, the extension
 * point the browser prompt path consults.
 */
export class OaPromptAdmission extends Service implements PromptAdmission {
  static inject = ['oaAccount']

  /** @param ctx - Host carrying the account service this check reads. */
  constructor(ctx: Context) {
    super(ctx, 'promptAdmission')
  }

  /**
   * Decide whether a conversation may start.
   * @returns undefined while the account may proceed, or the refusal to report to the caller.
   */
  async admitPrompt(): Promise<PromptAdmissionRefusal | undefined> {
    const decision = await this.ctx.oaAccount.gate()
    if (decision.allowed) return undefined
    return decision.reason === 'signed-out'
      ? { code: 'sign-in-required', message: 'sign in to start a conversation' }
      : { code: 'account-inactive', message: 'this account is not active' }
  }
}
