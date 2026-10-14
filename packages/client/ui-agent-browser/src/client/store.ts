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
  /** Address of the lease's active tab, shown in the pane's own address field. */
  url?: string
  /** Title of the lease's active tab. */
  title?: string
  /** Page viewport in force, whether the automation asked for it or the pane decided it. */
  viewport?: { readonly width: number; readonly height: number }
  /** True while the pane's own size decides the page viewport. */
  follow?: boolean
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
        if (state.url === undefined) delete draft.url
        else draft.url = state.url
        if (state.title === undefined) delete draft.title
        else draft.title = state.title
        if (state.viewport === undefined) delete draft.viewport
        else draft.viewport = state.viewport
        if (state.follow === undefined) delete draft.follow
        else draft.follow = state.follow
      },
    },
  })
}

/** Agent Browser store handle shared by the tab registrations. */
export type AgentBrowserStore = ReturnType<typeof createAgentBrowserStore>
