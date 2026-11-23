/**
 * Session preview: the resource that retains a dropped Session, the tab type it
 * opens as, and the two bodies that render it beside the selected Conversation.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightTabDefinition } from '../src/client/tab-registry.ts'
import {
  parseSessionPreviewAddress, registerSessionPreview, SESSION_PREVIEW_ID, SESSION_PREVIEW_KIND,
  sessionPreviewAddress, sessionPreviewResourceProvider,
} from '../src/client/session-preview.tsx'

const PREVIEWED = 's-previewed' as SessionId

describe('session preview address', () => {
  it('round-trips one Session and rejects every other resource', () => {
    expect(parseSessionPreviewAddress(sessionPreviewAddress(PREVIEWED))).toBe(PREVIEWED)
    expect(parseSessionPreviewAddress('dsh-resource://file/session/s/a.txt')).toBeUndefined()
    expect(parseSessionPreviewAddress('dsh-resource://sessionpreview/other/s-a')).toBeUndefined()
    expect(parseSessionPreviewAddress('dsh-resource://sessionpreview/session')).toBeUndefined()
    expect(parseSessionPreviewAddress('not an address')).toBeUndefined()
  })
})

describe('session preview resource', () => {
  it('retains the dropped Session, pins its view, and releases both when the tab closes', async () => {
    const release = vi.fn()
    const retain = vi.fn(() => ({ ready: Promise.resolve(), release }))
    const pin = vi.fn()
    const unpin = vi.fn()
    const provider = sessionPreviewResourceProvider({ retain } as never, pin, unpin)
    const controller = new AbortController()
    const opened = provider.open(sessionPreviewAddress(PREVIEWED), { signal: controller.signal })[Symbol.asyncIterator]()

    const first = await opened.next()
    expect(first.value).toMatchObject({ ok: true, value: { sessionId: PREVIEWED } })
    expect(retain).toHaveBeenCalledWith(PREVIEWED, expect.objectContaining({ source: 'sessionPreview' }))
    expect(pin).toHaveBeenCalledWith(PREVIEWED)

    controller.abort()
    await opened.next()
    expect(release).toHaveBeenCalledOnce()
    expect(unpin).toHaveBeenCalledWith(PREVIEWED)
  })

  it('rejects an address that does not name a previewed Session', async () => {
    const provider = sessionPreviewResourceProvider({ retain: vi.fn() } as never, vi.fn(), vi.fn())
    const opened = provider.open('dsh-resource://sessionpreview/other/s-a', { signal: new AbortController().signal })[Symbol.asyncIterator]()
    await expect(opened.next()).rejects.toThrow('invalid session preview address')
  })
})

describe('session preview registration', () => {
  it('registers the tab type, its resource, and both bodies', () => {
    const definitions: SidebarRightTabDefinition[] = []
    const bodies: { name: string; key?: string; component: unknown }[] = []
    const registerResource = vi.fn(() => () => {})
    const ctx = {
      effect: (run: () => unknown) => { run(); return () => {} },
      resources: { register: registerResource },
      sidebarRightTabs: { register: (definition: SidebarRightTabDefinition) => { definitions.push(definition); return () => {} } },
      slots: {
        inject: (_name: string, run: () => unknown) => run(),
        register: (options: { name: string; key?: string }, component: unknown) => {
          bodies.push({ ...options, component })
          return () => {}
        },
      },
      sessions: { list: { getSnapshot: () => ({ byId: { [PREVIEWED]: { title: 'The previewed one' } } }) } },
    } as never

    registerSessionPreview(ctx, key => key, vi.fn(), vi.fn())

    expect(registerResource).toHaveBeenCalledOnce()
    const definition = definitions[0]
    expect(definition).toMatchObject({ id: SESSION_PREVIEW_ID, kind: SESSION_PREVIEW_KIND, priority: 'builtin' })
    expect(definition?.patterns).toEqual(['dsh-resource://sessionpreview/session/**'])
    expect(definition?.canOpen?.(sessionPreviewAddress(PREVIEWED))).toBe(true)
    expect(definition?.canOpen?.('sidebar://guide')).toBe(false)
    expect(definition?.title?.(sessionPreviewAddress(PREVIEWED))).toBe('The previewed one')
    expect(definition?.title?.(sessionPreviewAddress('s-unknown' as SessionId))).toBe('s-unknown')
    expect(definition?.title?.('sidebar://guide')).toBe('tab.sessionPreview')
    expect(bodies.map(body => [body.name, body.key])).toEqual([
      ['sidebar.right.pane.tab', SESSION_PREVIEW_ID],
      ['sidebar.session-preview.conversation', undefined],
    ])
  })
})
