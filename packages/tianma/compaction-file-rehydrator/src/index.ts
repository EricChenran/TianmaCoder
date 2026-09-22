/**
 * Post-compaction file-state rehydration: on every agent creation, registers
 * an agent-scoped system-prompt context that rebuilds the read-file ledger
 * from the append-only session log on each assembly. After a compaction
 * checkpoint lands, the very next request carries the ledger, so the model
 * knows which files it has read and which are stale — the ZCode
 * read-file-state-hydrator behavior, expressed as a prompt section instead of
 * an internal map.
 *
 * @module @tianma/dsh-compaction-file-rehydrator
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the `ctx.systemPrompt` Context declaration into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { buildFileStateView, renderRehydrationSection } from './view.ts'

export { buildFileStateView, renderRehydrationSection } from './view.ts'
export type { FileStateEntry, FileStateView } from './view.ts'

export const name = 'tianma-compaction-file-rehydrator'

/** The stable context name registered per agent. */
export const SECTION_NAME = 'tianma:file-rehydration'

/** Sorts after DEPLOYMENT_PERSONA_PREFIX (0) and the behavioral section (100). */
export const SECTION_ORDER = 200

/** Plugin configuration. */
export interface Config {
  /** Upper bound for the rendered section (default `4096` chars). */
  maxChars?: number
}

/**
 * Plugin body: registers one scoped context per created agent. Scoped
 * registration keeps sessions on other presets untouched, and the provider
 * re-evaluates on every assembly, so a compaction checkpoint that lands
 * mid-session is reflected from the next request on.
 * @param ctx - the Cordis context the plugin mounts in.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxChars = config.maxChars ?? 4_096
  ctx.on('agent/created', ({ agent }) => {
    const systemPrompt = (agent.ctx as Context).systemPrompt
    if (systemPrompt === undefined) return
    systemPrompt.context({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => renderRehydrationSection(buildFileStateView(agent.session.snapshotEvents()), maxChars),
    })
  })
}
