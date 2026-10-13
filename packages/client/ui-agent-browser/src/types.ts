/** Type-only declarations for the agent browser tab; runtime code lives in `src/client/`. */

/** Props the Agent Browser body receives from its slot shares. */
export interface AgentBrowserBodyProps {
  /** Session that owns the tab instance. */
  readonly sessionId: string
}
