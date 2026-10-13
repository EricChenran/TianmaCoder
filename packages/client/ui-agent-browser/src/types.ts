/** Type-only declarations for the agent browser tab; runtime code lives in `src/client/`. */

/** Pane rectangle in window coordinates that the agent guest should occupy. */
export interface DesktopAgentBrowserPane {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Whether one agent browser lease is executing a command, and which. */
export interface DesktopAgentBrowserActivity {
  /** Lease the fact belongs to. */
  readonly leaseId: string
  /** Session the lease was acquired for; a pane only reacts to its own Session. */
  readonly sessionKey?: string
  /** True while one agent command is executing against this lease. */
  readonly busy: boolean
  /** Command name of the in-flight operation, present only while busy. */
  readonly command?: string
  /** True once the window has bound a pane, so the guest is on screen rather than offscreen. */
  readonly presented: boolean
}

/**
 * Agent browser operations the window may perform. No Electron object or
 * arbitrary IPC crosses this interface: only a pane rectangle and the lease's
 * activity facts.
 */
export interface DesktopAgentBrowserBridge {
  /**
   * Bind this Session's agent browser lease to a pane, or release the binding.
   * @param sessionKey - Session whose lease should be presented.
   * @param pane - pane rectangle in window coordinates, or `null` to stop presenting.
   * @returns Whether a lease matched; `false` means the automation has not opened one yet.
   */
  present(sessionKey: string, pane: DesktopAgentBrowserPane | null): Promise<boolean>
  /**
   * @param listener - receives activity for every lease the shell reports.
   * @returns unsubscribe callback.
   */
  onActivity(listener: (activity: DesktopAgentBrowserActivity) => void): () => void
}
