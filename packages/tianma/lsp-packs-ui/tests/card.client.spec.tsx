// @vitest-environment jsdom
/** The language-pack card as the Plugins page renders it. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LspPacksCard, type LspPacksCardProps } from '../src/client/LspPacksCard.tsx'
import type { DesktopLspPacksBridge } from '../src/client/bridge.ts'
import { en } from '../src/client/locales.ts'

const desktop = globalThis as { dshDesktop?: { lspPacks?: DesktopLspPacksBridge } }

afterEach(() => {
  cleanup()
  delete desktop.dshDesktop
})

const t = (key: keyof typeof en) => en[key]

/**
 * Render the card against one bridge.
 * @param bridge - bridge the card reads.
 * @returns the bridge for call assertions.
 */
function renderCard(bridge: DesktopLspPacksBridge & { calls: string[] }): DesktopLspPacksBridge & { calls: string[] } {
  desktop.dshDesktop = { lspPacks: bridge }
  render(<LspPacksCard {...({ t, view: 'page' } as unknown as LspPacksCardProps)} />)
  return bridge
}

/** Bridge that starts with one missing pack and flips to installed. */
function missingBridge(): DesktopLspPacksBridge & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    list: async () => {
      calls.push('list')
      return [{ id: 'miniprogram', label: 'WeChat mini-program', state: 'missing', directory: 'C:\\packs\\miniprogram' }]
    },
    install: async (id) => {
      calls.push(`install:${id}`)
      return { id, label: 'WeChat mini-program', state: 'installed', directory: 'C:\\packs\\miniprogram' }
    },
    uninstall: async (id) => {
      calls.push(`uninstall:${id}`)
      return { id, label: 'WeChat mini-program', state: 'missing', directory: 'C:\\packs\\miniprogram' }
    },
  }
}

describe('LspPacksCard', () => {
  it('lists the packs with their state', async () => {
    renderCard(missingBridge())
    await waitFor(() => { expect(screen.getByText('WeChat mini-program')).toBeTruthy() })
    expect(screen.getByText(en.stateMissing)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.install })).toBeTruthy()
  })

  it('installs a missing pack and refreshes the list', async () => {
    const bridge = renderCard(missingBridge())
    const button = await screen.findByRole('button', { name: en.install })
    fireEvent.click(button)
    await waitFor(() => { expect(bridge.calls).toContain('install:miniprogram') })
    await waitFor(() => { expect(bridge.calls.filter(call => call === 'list').length).toBeGreaterThan(1) })
  })

  it('shows the failure message when an install rejects', async () => {
    const bridge = missingBridge()
    bridge.install = async () => { throw new Error('registry unreachable') }
    renderCard(bridge)
    fireEvent.click(await screen.findByRole('button', { name: en.install }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('registry unreachable') })
  })
})
