/** Agent browser pane binding and per-lease activity facts for the window. */
import { ipcRenderer } from 'electron'
import type {
  DesktopAgentBrowserActivity,
  DesktopAgentBrowserBridge,
  DesktopAgentBrowserPane,
} from '@deepseek-ai/dsh-client-ui-agent-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns agent browser operations that expose neither IPC nor Electron objects. */
export function createDesktopAgentBrowserBridge(): DesktopAgentBrowserBridge {
  const listeners = new Set<(activity: DesktopAgentBrowserActivity) => void>()
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
    onActivity(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** @returns the activity a shell message carries, or `undefined` for anything malformed. */
function readActivity(message: unknown): DesktopAgentBrowserActivity | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const candidate = message as Record<string, unknown>
  if (typeof candidate.leaseId !== 'string' || typeof candidate.busy !== 'boolean'
    || typeof candidate.presented !== 'boolean') return undefined
  if (candidate.command !== undefined && typeof candidate.command !== 'string') return undefined
  if (candidate.sessionKey !== undefined && typeof candidate.sessionKey !== 'string') return undefined
  return {
    leaseId: candidate.leaseId,
    busy: candidate.busy,
    presented: candidate.presented,
    ...(candidate.sessionKey === undefined ? {} : { sessionKey: candidate.sessionKey }),
    ...(candidate.command === undefined ? {} : { command: candidate.command }),
  }
}
