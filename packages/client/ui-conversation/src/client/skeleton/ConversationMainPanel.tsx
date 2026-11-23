import type { ConversationSlotProps } from '../contract/slots.ts'
import { conversationPanelPhase, conversationPhase } from '../contract/snapshot.ts'
import { ConversationWidthControls } from './ConversationWidthControls.tsx'
import css from './ConversationRoot.module.css'

const CONTENT_SLOTS = { widthControls: ConversationWidthControls }

/**
 * Render the existing main Conversation frame around the extracted content.
 * @param props - the original `main.conversation` Slot props.
 * @returns the unchanged root, Header, content, and width-control subtree.
 */
export function ConversationMainPanel(props: ConversationSlotProps) {
  const { sessionId, useSession, useSessions, useConversation, renderSlot, renderFactorySlot } = props
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const { phase, hero } = conversationPanelPhase({
    hasSession: sessionId !== undefined,
    shellPhase,
    openState: session?.openState,
    summaryBlank,
    parentAvailabilityPending,
  })

  return (
    <div className={css.root} data-phase={phase}>
      {renderSlot('conversation.header', {})}
      {renderFactorySlot('conversation.content', {
        variant: 'main',
        phase,
        hero,
      }, {
        slots: CONTENT_SLOTS,
      })}
    </div>
  )
}
