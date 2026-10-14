/** Agent browser pane binding and per-lease activity facts for the window. */
import { ipcRenderer } from 'electron'
import type {
  DesktopAgentBrowserActivity,
  DesktopAgentBrowserBridge,
  DesktopAgentBrowserCommandArgs,
  DesktopAgentBrowserCommandResult,
  DesktopAgentBrowserPane,
} from '@deepseek-ai/dsh-client-ui-agent-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns agent browser operations that expose neither IPC nor Electron objects. */
export function createDesktopAgentBrowserBridge(): DesktopAgentBrowserBridge {
  const listeners = new Set<(activity: DesktopAgentBrowserActivity) => void>()
  const revealListeners = new Set<(sessionKey: string) => void>()
  ipcRenderer.on(DESKTOP_IPC.agentBrowserReveal, (_event, message: unknown) => {
    const sessionKey = readSessionKey(message)
    if (sessionKey === undefined) return
    for (const listener of [...revealListeners]) {
      try { listener(sessionKey) }
      catch (error) { console.error('Desktop agent browser reveal handler failed', error) }
    }
  })
  ipcRenderer.on(DESKTOP_IPC.agentBrowserActivity, (_event, message: unknown) => {
    const activity = readActivity(message)
    if (activity === undefined) return
    for (const listener of [...listeners]) {
      try { listener(activity) }
      catch (error) { console.error('Desktop agent browser activity handler failed', error) }
    }
  })
  return {
    present: (sessionKey: string, pane: DesktopAgentBrowserPane | null) =>
      ipcRenderer.invoke(DESKTOP_IPC.agentBrowserPresent, { sessionKey, pane }) as Promise<boolean>,
    command: (sessionKey: string, command: string, args: DesktopAgentBrowserCommandArgs) =>
      ipcRenderer.invoke(DESKTOP_IPC.agentBrowserCommand, { sessionKey, command, args }) as Promise<DesktopAgentBrowserCommandResult>,
    onActivity(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onReveal(listener) {
      revealListeners.add(listener)
      return () => { revealListeners.delete(listener) }
    },
  }
}

/** @returns the Session key a reveal message carries, or `undefined` for anything malformed. */
function readSessionKey(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const candidate = message as Record<string, unknown>
  return typeof candidate.sessionKey === 'string' && candidate.sessionKey.length > 0
    ? candidate.sessionKey
    : undefined
}

/** @returns the activity a shell message carries, or `undefined` for anything malformed. */
function readActivity(message: unknown): DesktopAgentBrowserActivity | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const candidate = message as Record<string, unknown>
  if (typeof candidate.leaseId !== 'string' || typeof candidate.busy !== 'boolean'
    || typeof candidate.presented !== 'boolean') return undefined
  if (candidate.command !== undefined && typeof candidate.command !== 'string') return undefined
  if (candidate.sessionKey !== undefined && typeof candidate.sessionKey !== 'string') return undefined
  if (candidate.url !== undefined && typeof candidate.url !== 'string') return undefined
  if (candidate.title !== undefined && typeof candidate.title !== 'string') return undefined
  if (candidate.follow !== undefined && typeof candidate.follow !== 'boolean') return undefined
  const viewport = readViewport(candidate.viewport)
  if (candidate.viewport !== undefined && viewport === undefined) return undefined
  return {
    leaseId: candidate.leaseId,
    busy: candidate.busy,
    presented: candidate.presented,
    ...(candidate.sessionKey === undefined ? {} : { sessionKey: candidate.sessionKey }),
    ...(candidate.command === undefined ? {} : { command: candidate.command }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(candidate.follow === undefined ? {} : { follow: candidate.follow }),
  }
}

/** @returns the viewport size a message carries, or `undefined` when it carries none or a malformed one. */
function readViewport(value: unknown): { width: number; height: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { width?: unknown; height?: unknown }
  return typeof candidate.width === 'number' && typeof candidate.height === 'number'
    ? { width: candidate.width, height: candidate.height }
    : undefined
}
