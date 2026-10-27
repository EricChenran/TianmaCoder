/**
 * Browser half of the Tianma executor-node plugin: it keeps one node snapshot fed
 * by the Host's `mpsNodeControl` Remote namespace and registers the Settings page
 * that starts and stops the node.
 *
 * The snapshot is the single source the surface reads, so the state it shows and
 * the buttons it enables can never disagree. Every operation goes through the
 * Host — the browser never holds the node process — and a composition that mounts
 * no node control simply has no surface to render.
 *
 * @module @tianma/dsh-mps-node-ui/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the session catalog the model selector reads, so the deployment form offers
// the same routes instead of asking for text.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@tianma/dsh-mps-node-control/remote'
import { MpsNodeSection } from './NodeSection.tsx'
import { en, zh, type MpsNodeKey } from './locales.ts'
import type { MpsNodeInjected, MpsNodeSnapshot } from './contract.ts'

export type { MpsNodeInjected, MpsNodeSnapshot } from './contract.ts'
export type { MpsNodeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.mpsNode': MpsNodeKey }
}

/** Services required by the node surface. */
export const inject = ['slots', 'locale', 'remote', 'remote.mpsNodeControl', 'remote.session']

/**
 * Register the execution-node settings page.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.mpsNode', { en, zh }), 'mps-node: dictionaries')
  const t = ctx.locale.bind('settings.mpsNode')
  let snapshot: MpsNodeSnapshot = {
    status: undefined,
    lines: [],
    config: undefined,
    busy: false,
    configBusy: false,
    configSaved: false,
    probeBusy: false,
    probe: undefined,
    tasks: undefined,
    taskBusy: undefined,
    error: undefined,
    configError: undefined,
    unreadable: false,
  }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<MpsNodeSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  // A refused Remote call carries the Host's own message, which is what the
  // section shows; an empty string means "failed without one", and the component
  // then renders its localized copy.
  const failure = (error: { message?: string }): string => error.message ?? ''
  const refresh = async (): Promise<void> => {
    const [status, lines, config, tasks] = await Promise.all([
      ctx.remote.mpsNodeControl.status(),
      ctx.remote.mpsNodeControl.logs(),
      ctx.remote.mpsNodeControl.config(),
      ctx.remote.mpsNodeControl.tasks(),
    ])
    if (!status.ok) {
      publish({ unreadable: true, error: failure(status.error) })
      return
    }
    publish({
      status: status.value,
      lines: lines.ok ? lines.value : [],
      config: config.ok ? config.value : undefined,
      tasks: tasks.ok ? tasks.value : undefined,
      configError: config.ok ? undefined : failure(config.error),
      unreadable: false,
      error: undefined,
    })
  }
  const operations: MpsNodeInjected = {
    hooks: { mpsNode: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } },
    async loadModelCatalog() {
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.value.groups.map(group => ({
        id: group.id,
        name: group.name,
        models: group.models.map(model => ({ id: model.id, name: model.name })),
      }))
    },
    async start() {
      publish({ busy: true, error: undefined })
      const result = await ctx.remote.mpsNodeControl.start()
      if (!result.ok) {
        publish({ busy: false, error: failure(result.error) })
        return
      }
      publish({ busy: false, status: result.value })
      await refresh()
    },
    async stop() {
      publish({ busy: true, error: undefined })
      const result = await ctx.remote.mpsNodeControl.stop()
      if (!result.ok) {
        publish({ busy: false, error: failure(result.error) })
        return
      }
      publish({ busy: false, status: result.value })
      await refresh()
    },
    refresh,
    async saveConfig(form) {
      publish({ configBusy: true, configSaved: false, configError: undefined })
      const result = await ctx.remote.mpsNodeControl.saveConfig(form)
      if (!result.ok) {
        publish({ configBusy: false, configError: failure(result.error) })
        return false
      }
      publish({ configBusy: false, configSaved: true, config: result.value })
      return true
    },
    async probePlatform(form) {
      publish({ probeBusy: true })
      const result = await ctx.remote.mpsNodeControl.probe(form)
      publish({ probeBusy: false, probe: result.ok ? result.value : { reachable: false, kind: 'unreachable', detail: failure(result.error) } })
    },
    async cancelTask(taskId) {
      publish({ taskBusy: taskId })
      const result = await ctx.remote.mpsNodeControl.taskCommand({ action: 'cancel', task_id: taskId })
      publish({ taskBusy: undefined, ...(result.ok ? {} : { configError: failure(result.error) }) })
      await refresh()
    },
    async taskCommand(command) {
      publish({ taskBusy: command.task_id })
      const result = await ctx.remote.mpsNodeControl.taskCommand(command)
      publish({ taskBusy: undefined, ...(result.ok ? {} : { configError: failure(result.error) }) })
      await refresh()
    },
    openSession(sessionId) {
      const workspace = ctx.get('uiWorkspace') as { openSession(target: string): void } | undefined
      workspace?.openSession(sessionId)
    },
    // The workspace UI service is read lazily rather than injected, so this
    // surface still mounts in a composition without the directory picker.
    async browse() {
      // Structurally typed: the workspace UI service is not a compile-time
      // dependency of this surface, so only the one method it needs is named.
      const workspace = ctx.get('uiWorkspace') as { pickDirectory(): Promise<string | null> } | undefined
      if (workspace === undefined) return undefined
      try {
        return await workspace.pickDirectory() ?? undefined
      } catch {
        return undefined
      }
    },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'mps-node', order: -5, label: () => t('nav'),
    locale: 'settings.mpsNode', inject: () => operations,
  }, MpsNodeSection))
  void refresh()
}
