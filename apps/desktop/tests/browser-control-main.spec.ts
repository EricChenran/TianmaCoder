import { describe, expect, it, vi } from 'vitest'
import {
  ShellBrowserControlEndpoint, ShellBrowserControlError, UnsupportedShellBrowserHandler,
  isShellBrowserControlRequest,
} from '../src/browser-control-main.ts'

describe('Shell browser control guard', () => {
  it('accepts validated operations and rejects everything else', () => {
    expect(isShellBrowserControlRequest({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'w' })).toBe(true)
    expect(isShellBrowserControlRequest({ type: 'browser', requestId: 1, op: 'execute', leaseId: 'l', command: 'navigate', args: { url: 'https://x' } })).toBe(true)
    expect(isShellBrowserControlRequest({ type: 'browser-result', requestId: 1, ok: true, result: null })).toBe(false)
    expect(isShellBrowserControlRequest({ type: 'browser', op: 'release', leaseId: 'l' })).toBe(false)
    expect(isShellBrowserControlRequest('browser')).toBe(false)
  })
})

describe('Shell browser control endpoint', () => {
  it('answers a valid acquire with the handler result under the same request id', async () => {
    const messages: object[] = []
    const handler = { acquire: vi.fn(async () => ({ leaseId: 'l-9' })), execute: vi.fn(), release: vi.fn() }
    const endpoint = new ShellBrowserControlEndpoint((message) => { messages.push(message) }, handler)
    expect(endpoint.handle({ type: 'browser', requestId: 7, op: 'acquire', workspaceKey: 'w' })).toBe(true)
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    expect(handler.acquire).toHaveBeenCalledWith(expect.objectContaining({ requestId: 7, workspaceKey: 'w' }))
    expect(messages[0]).toEqual({ type: 'browser-result', requestId: 7, ok: true, result: { leaseId: 'l-9' } })
  })

  it('routes execute and release to their handler methods', async () => {
    const messages: object[] = []
    const handler = { acquire: vi.fn(), execute: vi.fn(async () => 'ran'), release: vi.fn(async () => null) }
    const endpoint = new ShellBrowserControlEndpoint((message) => { messages.push(message) }, handler)
    endpoint.handle({ type: 'browser', requestId: 1, op: 'execute', leaseId: 'l', command: 'navigate', args: {} })
    endpoint.handle({ type: 'browser', requestId: 2, op: 'release', leaseId: 'l' })
    await vi.waitFor(() => { expect(messages).toHaveLength(2) })
    expect(messages[0]).toEqual({ type: 'browser-result', requestId: 1, ok: true, result: 'ran' })
    expect(messages[1]).toEqual({ type: 'browser-result', requestId: 2, ok: true, result: null })
  })

  it('reports handler failures with the classified code', async () => {
    const messages: object[] = []
    const endpoint = new ShellBrowserControlEndpoint((message) => { messages.push(message) },
      { acquire: async () => { throw new ShellBrowserControlError('lease unknown', 'lease_unknown') }, execute: async () => [], release: async () => [] })
    endpoint.handle({ type: 'browser', requestId: 3, op: 'acquire', workspaceKey: 'w' })
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    expect(messages[0]).toEqual({ type: 'browser-result', requestId: 3, ok: false, error: 'lease unknown', code: 'lease_unknown' })
  })

  it('reports unclassified failures without a code', async () => {
    const messages: object[] = []
    const endpoint = new ShellBrowserControlEndpoint((message) => { messages.push(message) },
      { acquire: async () => { throw new Error('boom') }, execute: async () => [], release: async () => [] })
    endpoint.handle({ type: 'browser', requestId: 4, op: 'acquire', workspaceKey: 'w' })
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    expect(messages[0]).toEqual({ type: 'browser-result', requestId: 4, ok: false, error: 'boom' })
  })

  it('answers every operation with browser_unsupported until guest handling ships', async () => {
    const messages: object[] = []
    const endpoint = new ShellBrowserControlEndpoint((message) => { messages.push(message) }, new UnsupportedShellBrowserHandler())
    endpoint.handle({ type: 'browser', requestId: 5, op: 'acquire', workspaceKey: 'w' })
    endpoint.handle({ type: 'browser', requestId: 6, op: 'execute', leaseId: 'l', command: 'navigate', args: {} })
    await vi.waitFor(() => { expect(messages).toHaveLength(2) })
    expect(messages[0]).toMatchObject({ ok: false, code: 'browser_unsupported' })
    expect(messages[1]).toMatchObject({ ok: false, code: 'browser_unsupported' })
  })

  it('ignores messages outside the seam', () => {
    const endpoint = new ShellBrowserControlEndpoint(vi.fn(), new UnsupportedShellBrowserHandler())
    expect(endpoint.handle({ type: 'ready', url: 'https://x' })).toBe(false)
    expect(endpoint.handle(undefined)).toBe(false)
  })
})
