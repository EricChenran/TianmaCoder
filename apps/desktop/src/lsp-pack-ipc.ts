/** IPC surface that lets the Web settings page manage desktop language packs. */

import type { IpcMainInvokeEvent } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import type { LspPackStatus } from './lsp-pack-installer.ts'

/** Pack operations the renderer may invoke. */
export interface LspPackOperations {
  /** Report every catalog pack's state. */
  list(): Promise<readonly LspPackStatus[]>
  /** Install one pack by catalog id. */
  install(id: string): Promise<LspPackStatus>
  /** Remove one pack by catalog id. */
  uninstall(id: string): Promise<LspPackStatus>
}

/** Minimal main-process surface used for registration. */
export interface LspPackIpcHost {
  /** Register one invoke handler. */
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
}

/**
 * Register the language-pack channels on the main process.
 * @param host - `ipcMain` or a test double that records handlers.
 * @param operations - installer operations to expose.
 * @param assertSender - rejects requests from frames other than the application window.
 * @returns nothing; handlers stay registered for the process lifetime.
 */
export function registerLspPackIpc(
  host: LspPackIpcHost,
  operations: LspPackOperations,
  assertSender: (event: IpcMainInvokeEvent) => void,
): void {
  host.handle(DESKTOP_IPC.lspPacksList, (event) => {
    assertSender(event)
    return operations.list()
  })
  host.handle(DESKTOP_IPC.lspPacksInstall, (event, id) => {
    assertSender(event)
    return operations.install(packId(id))
  })
  host.handle(DESKTOP_IPC.lspPacksUninstall, (event, id) => {
    assertSender(event)
    return operations.uninstall(packId(id))
  })
}

/**
 * Validate a renderer-supplied pack id.
 * @param value - raw argument from the renderer.
 * @returns the id when it is a non-empty string.
 */
function packId(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('language pack: invalid id')
  return value
}
