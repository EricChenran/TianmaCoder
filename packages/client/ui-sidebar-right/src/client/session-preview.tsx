/** Right-Sidebar preview of another Session's Conversation, opened by dropping a session row. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { conversationPanelPhase, conversationPhase } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightKey } from './locales.ts'
import type { SidebarRightTabDefinition } from './tab-registry.ts'
import css from './session-preview.module.css'

/** Stable implementation identity for the preview tab type and its body. */
export const SESSION_PREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-right/session-preview'

/** Tab kind one previewed Session opens as. */
export const SESSION_PREVIEW_KIND = 'session-preview'

/** Resource-address prefix for one previewed Session. */
export const SESSION_PREVIEW_ADDRESS = 'dsh-resource://sessionpreview/session/'

/** Value retained by one live preview occurrence. */
export interface SessionPreviewResource {
  readonly sessionId: SessionId
  readonly reference: SessionReference
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    sessionPreview: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    sessionpreview: SessionPreviewResource
  }

  interface SlotMap {
    /** Session-scoped Conversation occurrence hosted by one preview tab. */
    'sidebar.session-preview.conversation': { kind: 'single'; scope: 'session' }
  }
}

/**
 * Address one Session for the right Sidebar's preview tab.
 * @param sessionId - Session the tab shows.
 * @returns canonical preview resource address.
 */
export function sessionPreviewAddress(sessionId: SessionId): string {
  return `${SESSION_PREVIEW_ADDRESS}${encodeURIComponent(sessionId)}`
}

/**
 * Parse one canonical preview address.
 * @param value - possible preview resource address.
 * @returns the Session it names, or undefined for another or malformed resource.
 */
export function parseSessionPreviewAddress(value: string): SessionId | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_invalidUrl) {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'sessionpreview') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  try {
    return SessionId(decodeURIComponent(parts[1] as string))
  } catch (_invalidEncoding) {
    return undefined
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

export function sessionPreviewResourceProvider(
  sessions: ISessions,
  pin: (sessionId: SessionId) => void,
  unpin: (sessionId: SessionId) => void,
): ResourceProvider<'sessionpreview'> {
  return {
    protocol: 'sessionpreview',
    async *open(resourceAddress, { signal }) {
      const sessionId = parseSessionPreviewAddress(resourceAddress)
      if (sessionId === undefined) throw new Error(`ui-sidebar-right: invalid session preview address "${resourceAddress}"`)
      if (signal.aborted) return
      const reference = sessions.retain(sessionId, { source: 'sessionPreview', signal })
      pin(sessionId)
      try {
        yield { ok: true, value: { sessionId, reference } }
        await waitForAbort(signal)
      } finally {
        reference.release()
        unpin(sessionId)
      }
    },
  }
}

/** Fixed Chat selection used by an embedded Conversation occurrence. */
function ChatOnlyView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props supplied to the parent-Session preview tab body. */
export type SessionPreviewTabProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.session-preview.conversation'>

/**
 * Bind a previewed Session's reference around its Conversation slot.
 * @param props - the tab's framework shares and its Conversation seat.
 * @returns the previewed Conversation, or nothing while the resource opens.
 */
export function SessionPreviewTab({ useTabInfo, useResource, renderSlot, SessionProvider }: SessionPreviewTabProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'sessionpreview'>(tab.contentId)
  return (
    <div className={css.root} data-session-preview={resource.value?.sessionId}>
      {resource.value === undefined
        ? null
        : (
          <SessionProvider session={resource.value.reference}>
            {renderSlot('sidebar.session-preview.conversation', {})}
          </SessionProvider>
        )}
    </div>
  )
}

/** Props supplied to the previewed Session's Conversation host. */
export type SessionPreviewConversationProps =
  & PropsRuntime<'sidebar.session-preview.conversation'>
  & PropsRenderFactories

/**
 * Render the previewed Session with the same phase the main panel would use.
 * @param props - the previewed Session's framework shares.
 * @returns the embedded Conversation content.
 */
export function SessionPreviewConversation({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot,
}: SessionPreviewConversationProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const { phase, hero } = conversationPanelPhase({
    hasSession: true,
    shellPhase: conversationPhase(session, conversation),
    openState: session.openState,
    summaryBlank,
    parentAvailabilityPending: session.subagent?.address.mode === 'continuable'
      && session.subagent.parentAvailable === undefined,
  })
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: ChatOnlyView },
  })
}

/**
 * Register the preview resource, its tab type, and its two seat bodies.
 * @param ctx - client root carrying Sessions, resources, slots, and the Sidebar registries.
 * @param t - `sidebarRight` translator used for the tab's fallback title.
 * @param pin - keep the previewed Session's Sidebar view mounted while a preview shows it.
 * @param unpin - release that hold when the preview closes.
 */
export function registerSessionPreview(
  ctx: Context,
  t: (key: SidebarRightKey) => string,
  pin: (sessionId: SessionId) => void,
  unpin: (sessionId: SessionId) => void,
): void {
  ctx.effect(
    () => ctx.resources.register(sessionPreviewResourceProvider(ctx.sessions, pin, unpin)),
    'ui-sidebar-right: session preview resources',
  )
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SESSION_PREVIEW_ID,
    kind: SESSION_PREVIEW_KIND,
    patterns: [`${SESSION_PREVIEW_ADDRESS}**`],
    priority: 'builtin',
    canOpen: address => parseSessionPreviewAddress(address) !== undefined,
    title: (address) => {
      const sessionId = parseSessionPreviewAddress(address)
      if (sessionId === undefined) return t('tab.sessionPreview')
      return ctx.sessions.list.getSnapshot().byId[sessionId]?.title ?? sessionId
    },
  } satisfies SidebarRightTabDefinition), 'ui-sidebar-right: session preview type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SESSION_PREVIEW_ID,
    children: { 'sidebar.session-preview.conversation': { kind: 'single', scope: 'session' } },
  }, SessionPreviewTab)), 'ui-sidebar-right: session preview body')
  ctx.effect(() => ctx.slots.inject('sidebar.session-preview.conversation', () => ctx.slots.register({
    name: 'sidebar.session-preview.conversation',
  }, SessionPreviewConversation)), 'ui-sidebar-right: session preview conversation')
}
