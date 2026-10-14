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
  /** Address of the lease's active tab, as the pane's own controls show it. */
  readonly url?: string
  /** Title of the lease's active tab. */
  readonly title?: string
  /** Page viewport in force, whether the automation asked for it or the pane decided it. */
  readonly viewport?: { readonly width: number; readonly height: number }
  /** True while the pane's own size decides the page viewport. */
  readonly follow?: boolean
}

/** Arguments the pane's own controls pass to one agent browser command. */
export type DesktopAgentBrowserCommandArgs = Readonly<Record<string, string | number | boolean>>

/** Result of a command the pane asked for: the command's JSON result, or absence. */
export type DesktopAgentBrowserCommandResult = Readonly<Record<string, unknown>> | undefined

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
   * Run one command on this Session's agent browser, so the pane's own controls drive
   * the same guest the automation does.
   * @param sessionKey - Session whose pane asks.
   * @param command - command name: `back`, `forward`, `reload`, `navigate`, `viewport`, or `getState`.
   * @param args - command arguments, such as a navigation `url`.
   * @returns The command result, or `undefined` when no lease holds this Session.
   */
  command(sessionKey: string, command: string, args: DesktopAgentBrowserCommandArgs): Promise<DesktopAgentBrowserCommandResult>
  /**
   * @param listener - receives activity for every lease the shell reports.
   * @returns unsubscribe callback.
   */
  onActivity(listener: (activity: DesktopAgentBrowserActivity) => void): () => void
  /**
   * The shell asks the Session's pane to open when an automation acquires a lease:
   * the tab is where the human watches the agent work, and an unopened tab leaves the
   * guest with a one-pixel surface no command can use.
   * @param listener - receives the Session key whose pane should open.
   * @returns unsubscribe callback.
   */
  onReveal(listener: (sessionKey: string) => void): () => void
}
