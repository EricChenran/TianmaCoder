/** Live activity the Agent Browser pane shows for its Session's agent lease. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Activity facts the pane renders for one Session. */
export interface AgentBrowserState {
  /** True while one agent command is executing against this Session's lease. */
  busy: boolean
  /** True once the shell bound this pane, so the guest is on screen here. */
  presented: boolean
  /** Command name of the in-flight operation, present only while busy. */
  command?: string
}

type AgentBrowserActions = {
  set: (draft: AgentBrowserState, state: AgentBrowserState) => void
}

/**
 * Declare the Agent Browser activity store, shared by the tab's title and body.
 * @returns a fresh store handle for Slot registration.
 */
export function createAgentBrowserStore(): EngineStoreHandle<AgentBrowserState, AgentBrowserActions> {
  return defineStore({
    init: (): AgentBrowserState => ({ busy: false, presented: false }),
    actions: {
      set: (draft, state) => {
        draft.busy = state.busy
        draft.presented = state.presented
        if (state.command === undefined) delete draft.command
        else draft.command = state.command
      },
    },
  })
}

/** Agent Browser store handle shared by the tab registrations. */
export type AgentBrowserStore = ReturnType<typeof createAgentBrowserStore>
