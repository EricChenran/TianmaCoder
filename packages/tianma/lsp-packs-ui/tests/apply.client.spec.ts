// @vitest-environment jsdom
/** What the language-pack card registers, and that it stays out of plain browsers. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { DesktopLspPacksBridge } from '../src/client/bridge.ts'

const desktop = globalThis as { dshDesktop?: { lspPacks?: DesktopLspPacksBridge } }

afterEach(() => { delete desktop.dshDesktop })

/** Bridge double the plugin only checks for presence. */
const bridge: DesktopLspPacksBridge = {
  list: async () => [],
  install: async () => ({ id: 'miniprogram', label: 'miniprogram', state: 'installed', directory: '', requiresJava: false }),
  uninstall: async () => ({ id: 'miniprogram', label: 'miniprogram', state: 'missing', directory: '', requiresJava: false }),
}

/**
 * Boot a slot registry and a Chinese locale.
 * @returns the context and its slot registry.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/**
 * Declare the Plugins page item slot the card registers into.
 * @param slots - the slot registry.
 * @returns the disposer.
 */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('lsp-packs-ui apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers nothing outside the desktop shell', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('registers the card when the desktop bridge exists, titled in the active locale', async () => {
    desktop.dshDesktop = { lspPacks: bridge }
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entries = slots.entries('plugins.item')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.options).toMatchObject({ id: 'lsp-packs', order: 60 })
    expect(resolveSlotLabel(entry.options.label)).toBe('语言包')
    expect(entry.locale).toBe(NS)
  })
})
