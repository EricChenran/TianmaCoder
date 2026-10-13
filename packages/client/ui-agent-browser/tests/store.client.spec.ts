/** Agent Browser activity store: init shape and the merge visible to the pane. */
import { describe, expect, it } from 'vitest'
import { createAgentBrowserStore } from '../src/client/store.ts'

describe('createAgentBrowserStore', () => {
  it('starts idle and offscreen', () => {
    const store = createAgentBrowserStore().create()
    expect(store.getSnapshot()).toEqual({ busy: false, presented: false })
  })

  it('keeps the last activity and drops a stale command when the lease goes idle', () => {
    const store = createAgentBrowserStore().create()
    store.actions.set({ busy: true, presented: true, command: 'navigate' })
    expect(store.getSnapshot()).toEqual({ busy: true, presented: true, command: 'navigate' })
    store.actions.set({ busy: false, presented: true })
    expect(store.getSnapshot()).toEqual({ busy: false, presented: true })
    expect('command' in store.getSnapshot()).toBe(false)
  })

  it('records that nothing is presented once the lease is released', () => {
    const store = createAgentBrowserStore().create()
    store.actions.set({ busy: false, presented: false })
    expect(store.getSnapshot()).toEqual({ busy: false, presented: false })
  })
})
