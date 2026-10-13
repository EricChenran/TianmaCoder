import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDesktopBrowserControl, isBrowserControlMessage, isBrowserControlRequest } from '../../desktop-host/src/browser-control.ts'
import { isShellBrowserControlRequest, ShellBrowserControlEndpoint, UnsupportedShellBrowserHandler } from '../src/browser-control-main.ts'

/**
 * Pins the two independently declared sides of the browser control seam to the
 * same wire shapes: one request crosses the seam in both directions through the
 * real guards. Protocol definitions move to a shared package with the provider;
 * this spec fails the moment either side drifts before then.
 */

let ctx: Context
let shellInbox: object[]
let hostInbox: object[]
let route: (message: unknown) => boolean

beforeEach(() => {
  ctx = new Context()
  shellInbox = []
  hostInbox = []
  route = installDesktopBrowserControl(ctx, async (message) => { shellInbox.push(message) })
})

afterEach(async () => { await ctx.fiber.dispose() })

describe('Browser control seam contract', () => {
  it('drives one acquire across both sides and both guards', async () => {
    const client = ctx.get('desktopBrowserControl')!
    const endpoint = new ShellBrowserControlEndpoint((message) => { hostInbox.push(message) },
      { acquire: async () => ({ leaseId: 'l-1' }), execute: async () => 'ok', release: async () => null })
    const pending = client.request({ op: 'acquire', workspaceKey: 'ws-1' })
    const wireRequest = shellInbox[0]
    expect(isBrowserControlRequest(wireRequest)).toBe(true)
    expect(isShellBrowserControlRequest(wireRequest)).toBe(true)
    endpoint.handle(wireRequest)
    await vi.waitFor(() => { expect(hostInbox).toHaveLength(1) })
    route(hostInbox[0])
    await expect(pending).resolves.toEqual({ leaseId: 'l-1' })
    expect(hostInbox[0]).toEqual({ type: 'browser-result', requestId: 1, ok: true, result: { leaseId: 'l-1' } })
    expect(isBrowserControlMessage(hostInbox[0])).toBe(true)
  })

  it('carries the shell structured failure and code back to the client error', async () => {
    const client = ctx.get('desktopBrowserControl')!
    const endpoint = new ShellBrowserControlEndpoint((message) => { hostInbox.push(message) },
      new UnsupportedShellBrowserHandler())
    const pending = client.request({ op: 'execute', leaseId: 'l-1', command: 'navigate', args: { url: 'https://example.com' } })
    endpoint.handle(shellInbox[0])
    await vi.waitFor(() => { expect(hostInbox).toHaveLength(1) })
    route(hostInbox[0])
    await expect(pending).rejects.toMatchObject({ code: 'browser_unsupported' })
    expect(hostInbox[0]).toMatchObject({ type: 'browser-result', requestId: 1, ok: false, code: 'browser_unsupported' })
  })

  it('routes non-seam traffic to neither side', () => {
    const client = ctx.get('desktopBrowserControl')!
    const endpoint = new ShellBrowserControlEndpoint(() => {}, new UnsupportedShellBrowserHandler())
    expect(route({ type: 'ready', url: 'https://x' })).toBe(false)
    expect(endpoint.handle({ type: 'ready', url: 'https://x' })).toBe(false)
    expect(typeof client.request).toBe('function')
  })
})
