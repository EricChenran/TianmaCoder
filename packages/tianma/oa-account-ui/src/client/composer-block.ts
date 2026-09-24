/**
 * The client half of the conversation gate: while no account is signed in,
 * every live session's composer is inert and names the reason.
 *
 * The composer cannot read this plugin — the dependency runs one way — so the
 * block is pushed into the conversation service's registry rather than read by
 * the composer. The Host refuses the same prompt on its own, so the two halves
 * are one decision seen from both planes.
 *
 * @module @tianma/dsh-oa-account-ui/composer-block
 */
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * Push the composer block for every session the client currently lists.
 * @param conversation - the conversation service owning the block registry.
 * @param list - the session list whose ids are the live sessions.
 * @param reason - localized copy to show while input is refused, or undefined to clear the block.
 */
export function syncComposerBlock(
  conversation: { readonly blocks: ComposerBlocks },
  list: SessionListState,
  reason: string | undefined,
): void {
  const block = reason === undefined ? undefined : { reason }
  for (const id of list.ids) conversation.blocks.set(id, block)
}
