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
import type {} from '@tianma/dsh-oa-account/remote'
import type { OaSessionView } from '@tianma/dsh-oa-account/types'
import { OaAccountMenu } from './AccountMenu.tsx'
import { OaAccountSection } from './AccountSection.tsx'
import { en, zh, type OaAccountKey } from './locales.ts'
import type { OaAccountInjected, OaAccountSnapshot } from './contract.ts'

export type { OaAccountSnapshot, OaAccountInjected, OaProfileDraft } from './contract.ts'
export type { OaAccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.oaAccount': OaAccountKey }
}

/** Services required by the account surfaces. */
export const inject = ['slots', 'locale', 'remote', 'remote.oaAccount']

/**
 * Register the account launcher and settings page.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.oaAccount', { en, zh }), 'oa-account: dictionaries')
  const t = ctx.locale.bind('settings.oaAccount')
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
  // A refused Remote call carries the backend's own message, which is what the
  // dialog shows; an empty string means "failed without one", and the component
  // then renders its localized copy.
  const failure = (error: { message?: string }): string => error.message ?? ''
  const load = async (): Promise<void> => {
    const session = await ctx.remote.oaAccount.session()
    if (!session.ok) { publish({ failed: true }); return }
    publish({ session: session.value, failed: false, loading: session.value.signedIn })
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
  const operations: OaAccountInjected = {
    hooks: { oaAccount: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } },
    openLogin() {
      publish({ loginVisible: true, loginError: undefined })
      void refreshCaptcha()
    },
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
}
