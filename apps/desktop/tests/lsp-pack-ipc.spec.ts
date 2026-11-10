/** IPC registration for the desktop language-pack installer. */

import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import type { LspPackIpcHost, LspPackOperations } from '../src/lsp-pack-ipc.ts'
import { registerLspPackIpc } from '../src/lsp-pack-ipc.ts'
import type { LspPackStatus } from '../src/lsp-pack-installer.ts'

const status: LspPackStatus = {
  id: 'miniprogram',
  label: 'miniprogram',
  state: 'missing',
  directory: 'C:\\profile\\lsp-packs\\miniprogram',
  requiresJava: false,
}

const event = { senderFrame: { url: 'dsh-app://app/index.html' } } as unknown as IpcMainInvokeEvent

/**
 * Host double that records the handlers main would register.
 */
class RecordingHost implements LspPackIpcHost {
  readonly handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()

  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener)
  }
}

/**
 * Operations double that records the calls it receives.
 * @returns operations plus the call log.
 */
function operations(): { readonly ops: LspPackOperations; readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ops: {
      list: async () => { calls.push('list'); return [status] },
      install: async (id) => { calls.push(`install:${id}`); return { ...status, state: 'installed' } },
      uninstall: async (id) => { calls.push(`uninstall:${id}`); return status },
    },
  }
}

describe('registerLspPackIpc', () => {
  it('registers the three language-pack channels', () => {
    const host = new RecordingHost()
    registerLspPackIpc(host, operations().ops, () => {})
    expect([...host.handlers.keys()].sort()).toEqual([
      DESKTOP_IPC.lspPacksInstall,
      DESKTOP_IPC.lspPacksList,
      DESKTOP_IPC.lspPacksUninstall,
    ].sort())
  })

  it('checks the sender before every operation', async () => {
    const host = new RecordingHost()
    const assertSender = vi.fn()
    registerLspPackIpc(host, operations().ops, assertSender)
    await host.handlers.get(DESKTOP_IPC.lspPacksList)!(event)
    await host.handlers.get(DESKTOP_IPC.lspPacksInstall)!(event, 'miniprogram')
    await host.handlers.get(DESKTOP_IPC.lspPacksUninstall)!(event, 'miniprogram')
    expect(assertSender).toHaveBeenCalledTimes(3)
  })

  it('delegates list and id-carrying operations', async () => {
    const host = new RecordingHost()
    const { ops, calls } = operations()
    registerLspPackIpc(host, ops, () => {})
    await expect(host.handlers.get(DESKTOP_IPC.lspPacksList)!(event)).resolves.toEqual([status])
    await expect(host.handlers.get(DESKTOP_IPC.lspPacksInstall)!(event, 'miniprogram'))
      .resolves.toMatchObject({ state: 'installed' })
    await expect(host.handlers.get(DESKTOP_IPC.lspPacksUninstall)!(event, 'miniprogram')).resolves.toEqual(status)
    expect(calls).toEqual(['list', 'install:miniprogram', 'uninstall:miniprogram'])
  })

  it('rejects malformed pack ids without calling the installer', async () => {
    const host = new RecordingHost()
    const { ops, calls } = operations()
    registerLspPackIpc(host, ops, () => {})
    // ipcMain.handle turns a synchronous throw into a rejected invoke; the test
    // double calls the listener directly, so assert the throw itself.
    expect(() => host.handlers.get(DESKTOP_IPC.lspPacksInstall)!(event, 42)).toThrow(/invalid id/u)
    expect(() => host.handlers.get(DESKTOP_IPC.lspPacksInstall)!(event, '')).toThrow(/invalid id/u)
    expect(() => host.handlers.get(DESKTOP_IPC.lspPacksUninstall)!(event, undefined)).toThrow(/invalid id/u)
    expect(calls).toEqual([])
  })

  it('propagates a rejected sender', async () => {
    const host = new RecordingHost()
    const { ops, calls } = operations()
    registerLspPackIpc(host, ops, () => { throw new Error('rejected IPC from an unowned renderer') })
    expect(() => host.handlers.get(DESKTOP_IPC.lspPacksList)!(event))
      .toThrow(/unowned renderer/u)
    expect(calls).toEqual([])
  })
})
