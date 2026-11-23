/** The drag payload a session row leaves behind for the right Sidebar's preview drop. */
import { SessionId } from '@deepseek-ai/dsh-session/types'

/** Media type the session rows write; it doubles as the sidebar's own drag marker. */
export const PREVIEW_DRAG_TYPE = 'text/plain'

/**
 * Resolve the Session a drop would preview.
 * @param transfer - the drop's data transfer, narrowed to the members the check reads.
 * @param isSession - whether the payload names a Session this client knows.
 * @returns the Session identity, or undefined when the drag is not a session row.
 */
export function previewSessionId(
  transfer: Pick<DataTransfer, 'types' | 'getData'>,
  isSession: (id: string) => boolean,
): SessionId | undefined {
  if (!transfer.types.includes(PREVIEW_DRAG_TYPE)) return undefined
  const raw = transfer.getData(PREVIEW_DRAG_TYPE).trim()
  if (raw === '' || !isSession(raw)) return undefined
  return SessionId(raw)
}
