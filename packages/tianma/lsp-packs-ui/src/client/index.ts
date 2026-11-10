/** Desktop language packs, browser half: list, install, and remove packs from the Plugins page. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { LspPacksCard } from './LspPacksCard.tsx'
import { en, zh, type LspPacksLocaleKey } from './locales.ts'
import { desktopLspPacks } from './bridge.ts'

export type { LspPacksCardProps } from './LspPacksCard.tsx'
export type { LspPacksLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Language-pack card copy. */
    'settings.lsp-packs': LspPacksLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.lsp-packs'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the language-pack card while the desktop shell exposes its pack API.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lsp-packs-ui: dictionaries')
  if (desktopLspPacks() === undefined) return
  // Boot order: this fiber (slots+locale only) activates before the Plugins
  // page (waiting on remote/configForms/layout) declares 'plugins.item', so a
  // direct register throws "not declared". Defer to each declaration lifetime,
  // like every other Plugins-page card (web-search, subagent).
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'lsp-packs',
    order: 60,
    label: () => t('title'),
    locale: NS,
  }, LspPacksCard))
}
