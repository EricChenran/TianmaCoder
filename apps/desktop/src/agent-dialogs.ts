/** JavaScript dialogs a guest opens, which the shell observes and answers. */

/** One dialog the page is waiting on. */
export interface AgentDialogEvent {
  /** Id the shell uses to answer this dialog. */
  readonly id: string
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  /** Text the page showed. */
  readonly message: string
  /** Text a prompt pre-filled. */
  readonly defaultPrompt?: string
  /** Frame that opened the dialog. */
  readonly url?: string
}

/** One tracked dialog: the event plus the tab it blocks. */
export interface AgentDialogRecord {
  readonly event: AgentDialogEvent
  readonly tabId: string
  readonly openedAt: number
}

/** Chrome DevTools Protocol method a page dialog is announced with. */
export const DIALOG_OPENED_METHOD = 'Page.javascriptDialogOpening'

/** Chrome DevTools Protocol method a page dialog closes when the view is closed or the page answers it. */
export const DIALOG_CLOSED_METHOD = 'Page.javascriptDialogClosed'

/** Chrome DevTools Protocol method that answers the open dialog. */
export const DIALOG_ANSWER_METHOD = 'Page.handleJavaScriptDialog'

/** Dialog types the page can open; anything else is reported as an alert. */
const DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt', 'beforeunload'])

/**
 * Narrow one `Page.javascriptDialogOpening` payload.
 * @param params - protocol parameters.
 * @param id - id the shell assigns to this dialog.
 * @returns The dialog, or `undefined` when the payload names no dialog.
 */
export function readDialogOpening(params: unknown, id: string): AgentDialogEvent | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const parsed = params as Record<string, unknown>
  const type = typeof parsed.type === 'string' && DIALOG_TYPES.has(parsed.type) ? parsed.type : 'alert'
  return {
    id,
    type: type as AgentDialogEvent['type'],
    message: typeof parsed.message === 'string' ? parsed.message : '',
    ...(typeof parsed.defaultPrompt === 'string' ? { defaultPrompt: parsed.defaultPrompt } : {}),
    ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
  }
}

/** @returns the dialog facts the model may see, without the shell's tracking fields. */
export function dialogSummary(record: AgentDialogRecord): Record<string, string | number> {
  return {
    id: record.event.id,
    type: record.event.type,
    message: record.event.message,
    tabId: record.tabId,
    ...(record.event.defaultPrompt === undefined ? {} : { defaultPrompt: record.event.defaultPrompt }),
    ...(record.event.url === undefined ? {} : { url: record.event.url }),
  }
}
