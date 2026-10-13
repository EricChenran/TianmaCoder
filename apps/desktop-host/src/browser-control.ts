/** Host-side registration of the browser control seam carried on the shared Host IPC. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BROWSER_CONTROL_TIMEOUT_MS, BrowserControlError, isBrowserControlMessage,
  type BrowserControlEvent, type BrowserControlJson,
  type BrowserControlRequestInput, type DesktopBrowserControl,
} from '@deepseek-ai/dsh-host-browser-control'

export * from '@deepseek-ai/dsh-host-browser-control'

/**
 * Register the browser control client on the owning Host context and route shell answers to it.
 * @param ctx - Booted Desktop profile context; disposal rejects in-flight and future requests.
 * @param send - Transport that delivers one message object to the Electron shell.
 * @returns Router for `browser-result` and `browser-event` messages arriving from the shell;
 *   `false` means the message was not a browser control message.
 */
export function installDesktopBrowserControl(ctx: Context, send: (message: object) => Promise<void>): (message: unknown) => boolean {
  let stopped = false
  let nextRequestId = 1
  const pending = new Map<number, {
    resolve: (result: BrowserControlJson) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout> | undefined
  }>()
  const listeners = new Set<(event: BrowserControlEvent) => void>()
  ctx.effect(() => () => {
    stopped = true
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer)
      request.reject(new Error('desktop browser: Host is stopping'))
    }
    pending.clear()
    listeners.clear()
  })
  declareDesktopBrowserControl(ctx, {
    async request<T extends BrowserControlJson>(request: BrowserControlRequestInput,
      options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<T> {
      const deadlineMs = options.timeoutMs ?? BROWSER_CONTROL_TIMEOUT_MS
      if (stopped) throw new Error('desktop browser: Host is stopping')
      options.signal?.throwIfAborted()
      const requestId = nextRequestId++
      const answer = await new Promise<BrowserControlJson>((resolve, reject) => {
        const abort = (): void => { reject(new Error('desktop browser: request aborted')) }
        const entry = {
          resolve: (result: BrowserControlJson) => { resolve(result) },
          reject: (error: Error) => { reject(error) },
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
        }
        pending.set(requestId, entry)
        const timer = setTimeout(() => { reject(new Error('desktop browser: shell did not answer in time')) }, deadlineMs)
        entry.timer = timer
        options.signal?.addEventListener('abort', abort, { once: true })
        void send({ type: 'browser', requestId, ...request }).catch((error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      }).finally(() => {
        const entry = pending.get(requestId)
        if (entry?.timer !== undefined) clearTimeout(entry.timer)
        pending.delete(requestId)
      })
      return answer as T
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return (message: unknown): boolean => {
    if (!isBrowserControlMessage(message)) return false
    if (message.type === 'browser-event') {
      for (const listener of listeners) {
        try { listener(message) } catch (error) { console.error('desktop browser: event listener failed', error) }
      }
      return true
    }
    const request = pending.get(message.requestId)
    if (request === undefined) return true
    if (message.ok) request.resolve(message.result)
    else request.reject(new BrowserControlError(message.error, message.code))
    return true
  }
}

/** Service key under which the client is exposed to Host plugins. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopBrowserControl: DesktopBrowserControl
  }
}

function declareDesktopBrowserControl(ctx: Context, client: DesktopBrowserControl): void {
  ctx.provide('desktopBrowserControl', client)
}
