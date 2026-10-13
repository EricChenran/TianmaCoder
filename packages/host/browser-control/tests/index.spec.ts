import { describe, expect, it } from 'vitest'
import {
  BrowserControlError, isBrowserControlMessage, isBrowserControlRequest,
} from '../src/index.ts'

describe('Browser control request guard', () => {
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

describe('Browser control message guard', () => {
  it('accepts results and events, and rejects requests', () => {
    expect(isBrowserControlMessage({ type: 'browser-result', requestId: 1, ok: true, result: null })).toBe(true)
    expect(isBrowserControlMessage({ type: 'browser-result', requestId: 1, ok: false, error: 'x', code: 'c' })).toBe(true)
    expect(isBrowserControlMessage({ type: 'browser-result', requestId: 1, ok: false })).toBe(false)
    expect(isBrowserControlMessage({ type: 'browser-result', requestId: 1, ok: false, error: 'x', code: 3 })).toBe(false)
    expect(isBrowserControlMessage({ type: 'browser-event', name: 'guest-closed', payload: {} })).toBe(true)
    expect(isBrowserControlMessage({ type: 'browser-event', name: '', payload: {} })).toBe(false)
    expect(isBrowserControlMessage({ type: 'browser-event', leaseId: 'l' })).toBe(false)
  })

  it('carries a stable code on its error type', () => {
    expect(new BrowserControlError('boom', 'c').code).toBe('c')
    expect(new BrowserControlError('boom').code).toBeUndefined()
  })
})
