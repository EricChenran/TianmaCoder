import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BrowserControlError, installDesktopBrowserControl, isBrowserControlMessage, isBrowserControlRequest,
  type BrowserControlEvent, type DesktopBrowserControl,
} from '../src/browser-control.ts'

let ctx: Context
let sent: object[]
let route: ((message: unknown) => boolean) | undefined
let control: DesktopBrowserControl

beforeEach(() => {
  ctx = new Context()
  sent = []
  route = installDesktopBrowserControl(ctx, async (message) => { sent.push(message) })
  control = ctx.get('desktopBrowserControl')!
})

afterEach(async () => { await ctx.fiber.dispose() })

describe('Desktop browser control guard', () => {
  it('accepts the three operations with their required fields', () => {
    expect(isBrowserControlRequest({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'w' })).toBe(true)
    expect(isBrowserControlRequest({ type: 'browser', requestId: 2, op: 'execute', leaseId: 'l', command: 'navigate', args: {} })).toBe(true)
    expect(isBrowserControlRequest({ type: 'browser', requestId: 3, op: 'release', leaseId: 'l' })).toBe(true)
  })

  it('rejects malformed and unknown messages', () => {
    expect(isBrowserControlRequest(null)).toBe(false)
    expect(isBrowserControlRequest({ type: 'browser', requestId: Number.NaN, op: 'acquire', workspaceKey: 'w' })).toBe(false)
    expect(isBrowserControlRequest({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: '' })).toBe(false)
    expect(isBrowserControlRequest({ type: 'browser', requestId: 1, op: 'destroy', leaseId: 'l' })).toBe(false)
    expect(isBrowserControlRequest({ type: 'ready', url: 'https://x' })).toBe(false)
    expect(isBrowserControlMessage({ type: 'browser', requestId: 1, op: 'acquire', workspaceKey: 'w' })).toBe(false)
  })
})

describe('Desktop browser control client', () => {
  it('correlates one request with its shell answer', async () => {
    const pending = control.request({ op: 'acquire', workspaceKey: 'w' })
    expect(sent).toHaveLength(1)
    const request = sent[0]! as Record<string, unknown>
    expect(request.type).toBe('browser')
    expect(request.op).toBe('acquire')
    const requestId = request.requestId as number
    expect(route!({ type: 'browser-result', requestId, ok: true, result: { leaseId: 'l-1' } })).toBe(true)
    await expect(pending).resolves.toEqual({ leaseId: 'l-1' })
  })

  it('rejects with the shell error and code on a failed result', async () => {
    const pending = control.request({ op: 'release', leaseId: 'gone' })
    route!({ type: 'browser-result', requestId: (sent[0]! as Record<string, unknown>).requestId, ok: false, error: 'lease unknown', code: 'lease_unknown' })
    await expect(pending).rejects.toMatchObject({ message: 'lease unknown', code: 'lease_unknown' })
    await pending.catch((error: unknown) => { expect(error).toBeInstanceOf(BrowserControlError) })
  })

  it('rejects when the shell misses the deadline', async () => {
    await expect(control.request({ op: 'acquire', workspaceKey: 'w' }, { timeoutMs: 5 })).rejects.toThrow('did not answer in time')
  })

  it('rejects an already-aborted signal without sending', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(control.request({ op: 'acquire', workspaceKey: 'w' }, { signal: controller.signal })).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('delivers unsolicited events to listeners until disposal', async () => {
    const events: BrowserControlEvent[] = []
    const dispose = control.onEvent((event) => { events.push(event) })
    expect(route!({ type: 'browser-event', name: 'guest-closed', leaseId: 'l-1', payload: { code: 'gone' } })).toBe(true)
    dispose()
    route!({ type: 'browser-event', name: 'guest-closed', payload: {} })
    expect(events).toHaveLength(1)
    expect(events[0]!.leaseId).toBe('l-1')
  })

  it('ignores results for unknown request ids without failing the router', () => {
    expect(route!({ type: 'browser-result', requestId: 9999, ok: true, result: null })).toBe(true)
  })

  it('rejects in-flight and future requests after disposal', async () => {
    const pending = control.request({ op: 'acquire', workspaceKey: 'w' })
    await ctx.fiber.dispose()
    await expect(pending).rejects.toThrow('Host is stopping')
    await expect(control.request({ op: 'acquire', workspaceKey: 'w' })).rejects.toThrow('Host is stopping')
  })

  it('exposes the client as the declared Host context service', () => {
    const client = ctx.get('desktopBrowserControl')
    expect(typeof client?.request).toBe('function')
    expect(typeof client?.onEvent).toBe('function')
  })
})
