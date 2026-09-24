/** Operations available to the isolated native welcome renderer. */

import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  saveApiKey: 'dsh-welcome:save-api-key',
  skip: 'dsh-welcome:skip',
} as const

/** Credential writes return a safe outcome without exposing Host diagnostics. */
export type WelcomeSaveResult = { readonly ok: true } | { readonly ok: false }

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /**
   * Store the official provider's key before entering the workspace.
   * @param value - validated, trimmed API key.
   * @returns whether the write completed, without private error details.
   */
  saveApiKey(value: string): Promise<WelcomeSaveResult>
  /**
   * Enter the workspace without writing an onboarding-completion setting.
   * @returns completion after the workspace opens.
   */
  skip(): Promise<void>
}

/** The renderer receives localized copy and the write-only credential action. */
export type WelcomeApi = DesktopLocale & WelcomeOperations

/** Facts that decide the first-run entry. */
export interface WelcomeAuthentication {
  readonly hasApiKey: boolean
}

/**
 * Decide whether a startup requires the welcome entry.
 *
 * The product account is no longer a first-run concern: the workspace opens and
 * the account surfaces own signing in. This gate is about the model credential
 * only, which the first-run window can write.
 * @param authentication - whether a model API key is stored.
 * @returns true only when no model credential is configured.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.hasApiKey
}
