/**
 * Browser half of the Tianma OA account plugin: it keeps one account snapshot
 * fed by the Host's `oaAccount` Remote namespace and registers the sidebar
 * launcher and the Settings page.
 *
 * The snapshot is the single source both surfaces read, so the sidebar label and
 * the settings page can never disagree about who is signed in. Every operation
 * goes through the Host: the browser never holds a token, and the composition
 * that mounts no account service simply has no surfaces to render.
 *
 * @module @tianma/dsh-oa-account-ui/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@tianma/dsh-oa-account/remote'
import type { OaSessionView } from '@tianma/dsh-oa-account/types'
import { OaAccountMenu } from './AccountMenu.tsx'
import { OaAccountSection } from './AccountSection.tsx'
import { syncComposerBlock } from './composer-block.ts'
import { en, zh, type OaAccountKey } from './locales.ts'
import { OaWorkbenchPanel } from './workbench/Workbench.tsx'
import { WorkbenchIcon } from './workbench/WorkbenchIcon.tsx'
import { en as workbenchEn, zh as workbenchZh, type OaWorkbenchKey } from './workbench/locales.ts'
import type {
  OaAccountInjected, OaAccountSnapshot, OaWorkbenchInjected, OaWorkbenchSnapshot, OaWorkbenchSlice,
} from './contract.ts'

export type { OaAccountSnapshot, OaAccountInjected, OaProfileDraft } from './contract.ts'
export type { OaAccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oaAccount': OaAccountKey
    'workbench.oa': OaWorkbenchKey
  }
}

/** Services required by the account surfaces. The conversation and session
 * services are declared rather than probed with `ctx.get`: this plugin mounts
 * before `ui-conversation` in the shipped roster, and a probe would see the
 * service absent once at apply time and silently skip the composer gate. */
export const inject = ['slots', 'locale', 'remote', 'remote.oaAccount', 'conversation', 'sessions']

/**
 * Register the account launcher and settings page.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.oaAccount', { en, zh }), 'oa-account: dictionaries')
  ctx.effect(() => ctx.locale.register('workbench.oa', { en: workbenchEn, zh: workbenchZh }), 'oa-account: workbench dictionaries')
  const t = ctx.locale.bind('settings.oaAccount')
  const tWorkbench = ctx.locale.bind('workbench.oa')
  let snapshot: OaAccountSnapshot = {
    session: undefined,
    profile: undefined,
    stats: undefined,
    failed: false,
    loginVisible: false,
    loginPending: false,
    loginError: undefined,
    captcha: undefined,
    loading: false,
    saving: false,
    saveError: undefined,
    saved: false,
  }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<OaAccountSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  // The workbench keeps its own snapshot: it loads five independent reads and a
  // refused one reports itself without clearing the others.
  const emptySlice = <T>(): OaWorkbenchSlice<T> => ({ value: undefined, loading: false, error: undefined })
  let workbench: OaWorkbenchSnapshot = {
    signedIn: false,
    stats: emptySlice(),
    messages: emptySlice(),
    todos: emptySlice(),
    attendance: emptySlice(),
    notifications: emptySlice(),
  }
  const workbenchListeners = new Set<() => void>()
  const publishWorkbench = (patch: Partial<OaWorkbenchSnapshot>): void => {
    workbench = { ...workbench, ...patch }
    for (const listener of workbenchListeners) listener()
  }
  const settle = <T>(result: { ok: true; value: T } | { ok: false; error: { message?: string } }): OaWorkbenchSlice<T> =>
    result.ok
      ? { value: result.value, loading: false, error: undefined }
      : { value: undefined, loading: false, error: result.error.message ?? '' }
  // A refused Remote call carries the backend's own message, which is what the
  // dialog shows; an empty string means "failed without one", and the component
  // then renders its localized copy.
  const failure = (error: { message?: string }): string => error.message ?? ''
  const load = async (): Promise<void> => {
    const session = await ctx.remote.oaAccount.session()
    if (!session.ok) { publish({ failed: true }); return }
    publish({ session: session.value, failed: false, loading: session.value.signedIn })
    publishWorkbench({ signedIn: session.value.signedIn })
    if (!session.value.signedIn) { publish({ profile: undefined, stats: undefined, loading: false }); return }
    const [profile, stats] = await Promise.all([
      ctx.remote.oaAccount.profile(),
      ctx.remote.oaAccount.stats(),
    ])
    publish({
      profile: profile.ok ? profile.value : undefined,
      stats: stats.ok ? stats.value : undefined,
      loading: false,
    })
  }
  const refreshCaptcha = async (): Promise<void> => {
    const result = await ctx.remote.oaAccount.captcha()
    publish({ captcha: result.ok ? result.value : undefined })
  }
  const openLogin = (): void => {
    publish({ loginVisible: true, loginError: undefined })
    void refreshCaptcha()
  }
  const operations: OaAccountInjected = {
    hooks: { oaAccount: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } },
    openLogin,
    closeLogin() { publish({ loginVisible: false, loginError: undefined }) },
    refreshCaptcha,
    async submit(account, password, captcha) {
      publish({ loginPending: true, loginError: undefined })
      const result = await ctx.remote.oaAccount.signIn({
        account, password, captchaId: snapshot.captcha?.captchaId ?? '', captcha,
      })
      if (!result.ok) {
        // A challenge is single-use, so the failed attempt always needs a new one.
        publish({ loginPending: false, loginError: failure(result.error), captcha: undefined })
        void refreshCaptcha()
        throw new Error('oa account sign-in refused')
      }
      publish({
        session: result.value, loginPending: false, loginVisible: false,
        loginError: undefined, saved: false, saveError: undefined,
      })
      await load()
    },
    async signOut() {
      const result = await ctx.remote.oaAccount.signOut()
      if (!result.ok) throw new Error('oa account sign-out refused')
      publish({ session: result.value, profile: undefined, stats: undefined, saved: false, saveError: undefined })
    },
    load,
    async save(draft) {
      publish({ saving: true, saved: false, saveError: undefined })
      const result = await ctx.remote.oaAccount.updateProfile(draft)
      if (!result.ok) {
        publish({ saving: false, saveError: failure(result.error) })
        return
      }
      publish({ saving: false, saved: true, profile: result.value })
    },
  }
  const loadWorkbench = async (): Promise<void> => {
    const [stats, messages, todos, attendance, notifications] = await Promise.all([
      ctx.remote.oaAccount.stats(),
      ctx.remote.oaAccount.messages('all'),
      ctx.remote.oaAccount.todos(),
      ctx.remote.oaAccount.attendanceToday(),
      ctx.remote.oaAccount.notificationPreference(),
    ])
    publishWorkbench({
      stats: settle(stats),
      messages: settle(messages),
      todos: settle(todos),
      attendance: settle(attendance),
      notifications: settle(notifications),
    })
  }
  const reloadMessages = async (): Promise<void> => {
    publishWorkbench({ messages: settle(await ctx.remote.oaAccount.messages('all')) })
  }
  const reloadTodos = async (): Promise<void> => {
    publishWorkbench({ todos: settle(await ctx.remote.oaAccount.todos()) })
  }
  const reloadAttendance = async (): Promise<void> => {
    publishWorkbench({ attendance: settle(await ctx.remote.oaAccount.attendanceToday()) })
  }
  const workbenchOperations: OaWorkbenchInjected = {
    hooks: { oaWorkbench: {
      getSnapshot: () => workbench,
      subscribe: (listener) => {
        workbenchListeners.add(listener)
        return () => { workbenchListeners.delete(listener) }
      },
    } },
    openLogin,
    async refresh() {
      if (!workbench.signedIn) return
      await loadWorkbench()
    },
    async readMessage(id) {
      const result = await ctx.remote.oaAccount.readMessage(id)
      if (result.ok) await reloadMessages()
    },
    async readAllMessages() {
      const result = await ctx.remote.oaAccount.readAllMessages()
      if (result.ok) await reloadMessages()
    },
    async createTodo(content) {
      const result = await ctx.remote.oaAccount.createTodo(content)
      if (result.ok) await reloadTodos()
    },
    async toggleTodo(id) {
      const result = await ctx.remote.oaAccount.toggleTodo(id)
      if (result.ok) await reloadTodos()
    },
    async checkIn(lunchBreak) {
      const result = await ctx.remote.oaAccount.checkIn(lunchBreak)
      if (result.ok) await reloadAttendance()
    },
    async checkOut() {
      const result = await ctx.remote.oaAccount.checkOut()
      if (result.ok) await reloadAttendance()
    },
    async setPreference(patch) {
      publishWorkbench({ notifications: settle(await ctx.remote.oaAccount.setNotificationPreference(patch)) })
    },
    async loadApprovals(tab) {
      const result = await ctx.remote.oaAccount.approvals(tab)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    async loadApproval(id) {
      const result = await ctx.remote.oaAccount.approval(id)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    async actOnApproval(request) {
      const result = await ctx.remote.oaAccount.approvalAction(request)
      if (!result.ok) throw new Error(result.error.message)
    },
    async loadSchedules() {
      const result = await ctx.remote.oaAccount.todaySchedules()
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    async loadTaskBoard() {
      const result = await ctx.remote.oaAccount.taskBoard()
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    async completeTask(id) {
      const result = await ctx.remote.oaAccount.completeTask(id)
      if (!result.ok) throw new Error(result.error.message)
    },
    async loadAttendanceSummary(period) {
      const result = await ctx.remote.oaAccount.attendanceSummary(period)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
  }
  const WORKBENCH_ID = 'oa-workbench' as MainPanelId
  const stream = ctx.remote.$stream<OaSessionView>({
    name: 'oaAccount',
    open: signal => ctx.remote.oaAccount.watch(signal),
    ended: () => new Error('oa account stream ended'),
  })
  let disposed = false
  ctx.effect(() => () => { disposed = true; return stream.dispose() }, 'oa-account: session stream')
  void (async () => {
    for await (const frame of stream) {
      publish({ session: frame.value, failed: false })
      frame.accept()
      await load()
    }
  })().catch(() => { if (!disposed) publish({ failed: true }) })
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: 'settings.oaAccount', inject: () => operations,
  }, OaAccountMenu))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'oa-account', order: -10, label: () => t('nav'),
    locale: 'settings.oaAccount', inject: () => operations,
  }, OaAccountSection))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: WORKBENCH_ID, locale: 'workbench.oa', inject: () => workbenchOperations,
  }, OaWorkbenchPanel))
  // The workbench is the first entry of the sidebar's panel list: it is the
  // surface a signed-in employee opens before starting any conversation.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: WORKBENCH_ID, order: -10, label: () => tWorkbench('panel'),
    locale: 'workbench.oa',
  }, WorkbenchIcon))
  // The composer cannot read this plugin (the dependency runs one way), so the
  // gate is pushed: while no account is signed in, every live session's input is
  // inert and names the reason, and signing in clears it again. The Host refuses
  // the same prompt on its own, so this is the client half of one decision.
  const conversation = ctx.get('conversation')
  const sessions = ctx.get('sessions')
  if (conversation !== undefined && sessions !== undefined) {
    const sync = (): void => {
      syncComposerBlock(
        conversation,
        sessions.list.getSnapshot(),
        snapshot.session?.signedIn === true ? undefined : t('signInToSend'),
      )
    }
    listeners.add(sync)
    ctx.effect(() => {
      const stop = sessions.list.subscribe(sync)
      sync()
      return () => {
        stop()
        syncComposerBlock(conversation, sessions.list.getSnapshot(), undefined)
      }
    }, 'oa-account: composer block')
  }
}
