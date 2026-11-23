/**
 * Production client composition without the page: mount the Loader over a
 * module system, create every manifest row, wait for quiescence, and audit
 * activation. `AppWebEntry` and the whole-client test carrier both call it.
 * @module @deepseek-ai/dsh-client-web/src/boot-client
 */
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { BootManifest, ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { STATE_LABELS } from './loader-status.ts'

/** Entry state label as the boot page renders it. */
export type EntryStateLabel = (typeof STATE_LABELS)[keyof typeof STATE_LABELS] | 'loading' | 'failed'

/** Inputs of {@link bootClient}. */
export interface ClientBootOptions {
  /** Fresh root Context that will own the plugin tree. */
  readonly ctx: Context
  /** Module system installed as `loader.internal`. */
  readonly modules: ClientModuleLoader
  /** Parsed manifest whose `plugins` rows become Loader entries (entry name = row id). */
  readonly manifest: BootManifest
  /** Per-entry state reporting (the boot page); omitted when no one renders progress. */
  readonly onEntryState?: (name: string, state: EntryStateLabel) => void
}

/**
 * Compose the client: `ctx.plugin(Loader)`, `loader.internal = modules`, one
 * `loader.create({ name })` per manifest row, `loader.await()`, then
 * {@link assertEntriesActive}. A row whose module cannot be imported is marked
 * failed; the Loader logs its import error, the module system records it, and
 * the audit rejects startup with that error text per entry.
 * @param options - context, module system, manifest, optional progress sink.
 * @returns resolves after every entry is active; rejects with the audit report otherwise.
 */
export async function bootClient(options: ClientBootOptions): Promise<void> {
  const { ctx, manifest, onEntryState } = options
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.internal = options.modules as never

  ctx.on('internal/status', (fiber) => {
    const entry = fiber.entry
    if (entry === undefined || entry.fiber === undefined) return
    onEntryState?.(entry.options.name, STATE_LABELS[entry.fiber.state])
  })

  const rows = manifest.plugins.map(row => row.id)
  for (const name of rows) onEntryState?.(name, 'loading')
  await options.modules.entries.start(loader, manifest)
  for (const entry of loader.entries()) {
    if (entry.fiber === undefined) onEntryState?.(entry.options.name, 'failed')
  }

  await loader.await()
  assertEntriesActive(ctx, options.modules)
}

/**
 * Client entries the page cannot work without: the shell, the session
 * transport, and the surfaces every session renders through. A row outside this
 * set may fail without taking the page down, so a third-party or optional
 * plugin cannot blank the whole client.
 */
export const requiredClientEntryNames: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-workspace',
])

/**
 * Name why one Loader entry is not active, or `undefined` when it is.
 * @param ctx - root Context carrying the Loader.
 * @param name - entry name (the manifest row id, which is the package name).
 * @param fiber - the entry fiber, absent when its module never imported.
 * @param modules - the module system whose recorded import failures name why an entry has no fiber.
 * @returns the diagnostic text, or `undefined` for an active entry.
 */
function inactiveReason(
  ctx: Context,
  name: string,
  fiber: Entry['fiber'],
  modules: Pick<ClientModuleLoader, 'importError'>,
): string | undefined {
  if (fiber === undefined) {
    const importError = modules.importError(name)
    return importError === undefined
      ? 'import failed (see console for the import error)'
      : `import failed: ${importError.message}`
  }
  const state = STATE_LABELS[fiber.state]
  if (state === 'active') return undefined
  if (state !== 'pending') return state
  const missing = Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
  return `pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`
}

/**
 * Reject entries that failed import/apply or still wait on missing services.
 * Required rows ({@link requiredClientEntryNames}) reject startup with their
 * reason; every other row is reported through `console.warn` and boot continues.
 * @param ctx - root Context carrying the Loader.
 * @param modules - the module system whose recorded import failures name why an entry
 *   has no fiber; a row with no record points at the console.
 * @throws {Error} listing every inactive required entry with its reason.
 */
export function assertEntriesActive(ctx: Context, modules: Pick<ClientModuleLoader, 'importError'>): void {
  const failures: string[] = []
  const skipped: string[] = []
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    const reason = inactiveReason(ctx, name, entry.fiber, modules)
    if (reason === undefined) continue
    if (requiredClientEntryNames.has(name)) failures.push(`${name} (required): ${reason}`)
    else skipped.push(`${name}: ${reason}`)
  }
  for (const line of skipped) console.warn(`web boot: optional entry did not activate: ${line}`)
  if (failures.length > 0) {
    const skippedNote = skipped.length === 0 ? '' : `\n(${String(skipped.length)} optional entr${skipped.length === 1 ? 'y' : 'ies'} skipped)`
    throw new Error(`web boot: ${String(failures.length)} required entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}${skippedNote}`)
  }
}
