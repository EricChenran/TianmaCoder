/**
 * Hook trust admission service: a Cordis plugin exposing the trust ledger at
 * `ctx.tianmaHookTrust` so hook runners (the upstream hooks-claude-code /
 * hooks-codex bridges, or an integrator's own runner) can gate execution on
 * a content-hash approval before the first run and after any change.
 *
 * The ledger persists under the harness home (`tianma-hook-trust.json`).
 * `review` is the fail-closed answer for unknown and changed hooks.
 *
 * @module @tianma/dsh-hooks-trust
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HookTrustStore } from './store.ts'
import type { TrustDecision } from './store.ts'

export { HookTrustStore, hookHash } from './store.ts'
export type { TrustDecision, TrustRecord, TrustStoreDocument } from './store.ts'

export const name = 'tianma-hooks-trust'

/** Plugin configuration. */
export interface Config {
  /** Ledger file path (default `<home>/.dsh/tianma-hook-trust.json`). */
  ledgerPath?: string
}

/** The service contract other packages consume. */
export interface HookTrustService {
  /**
   * Evaluate one hook command.
   * @param command - the hook command string.
   * @param source - provenance recorded with a decision.
   * @returns the admission decision.
   */
  evaluate(command: string, source: string): TrustDecision
  /**
   * Record a decision for one hook command.
   * @param command - the hook command string.
   * @param state - the decision.
   * @param source - provenance recorded with the decision.
   */
  decide(command: string, state: 'approved' | 'denied', source: string): void
  /** Whether one command has any record. */
  has(command: string): boolean
}

/** The Cordis service registered under `ctx.tianmaHookTrust`. */
export class TianmaHookTrust extends HookTrustStore {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tianmaHookTrust: TianmaHookTrust
  }
}

/** Default ledger location.
 * @returns the ledger path under the harness home.
 */
export function defaultLedgerPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tianma-hook-trust.json')
}

/**
 * Plugin body: constructs the ledger-backed service and registers it.
 * @param ctx - the Cordis context the plugin mounts in.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.provide('tianmaHookTrust', new TianmaHookTrust(config.ledgerPath ?? defaultLedgerPath()))
}

/** The plugin entry for Cordis loaders. */
export default { name, apply, Config: undefined }
