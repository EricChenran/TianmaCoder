/**
 * Skills page state: the selected Session's catalog, the registry's disabled
 * names, and the writes that move one skill between the two.
 *
 * The catalog is the per-Session `skills/list` read the '/' menu already
 * serves; the disabled list is the skill registry's settings section, so this
 * page writes the single fact the registry filters on. A switch reflects the
 * Host value: a write in flight marks its row busy instead of guessing the
 * outcome, and a refused write leaves the accepted value standing.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  disabledNames, SKILL_DISABLED_FIELD, SKILL_REGISTRY_ENTRY, type SkillRegistrySettings,
} from './skill-registry-settings.ts'

/** Rows past this count get a filter box. */
export const SKILL_FILTER_THRESHOLD = 8

/** One skill the page renders; `name` is the only field a never-seen disabled name has. */
export interface SkillPageRow {
  /** Kebab-case identifier referenced as `/name`. */
  name: string
  /** Routing description, absent until this page has seen the skill in a catalog. */
  description?: string | undefined
  /** Absolute `SKILL.md` path when the provider supplied one. */
  path?: string | undefined
  /** Whether the model is offered this skill as well. */
  modelInvocable: boolean
}

/** What the page renders from: one row list per switch state. */
export interface SkillsPageState {
  /** `no-session` replaces the lists with the empty-selection guidance. */
  status: 'no-session' | 'loading' | 'ready' | 'error'
  /** Diagnostic of the last failed catalog read. */
  error?: string | undefined
  /** Skills the selected Session's composition offers now. */
  available: SkillPageRow[]
  /** Names the Host withholds, in name order. */
  disabled: SkillPageRow[]
  /** Whether the Host document accepts the disabled-list write. */
  writable: boolean
  /** Names whose switch write is in flight. */
  busy: string[]
  /** Whether the last settled write was refused or failed. */
  writeFailed: boolean
}

/** The registration-side face the page's slot entry injects. */
export interface SkillsPageFace {
  hooks: {
    /** Page snapshot bound by the renderer as `useSkillsPage`. */
    skillsPage: SnapshotStore<SkillsPageState>
  }
  /** Follow the selection and read the catalog on the page's first render. */
  ensure: () => void
  /** Re-read the catalog, reaching the Host past the shared per-Session fetch. */
  refresh: () => void
  /** Put a skill into, or take it out of, the registry's disabled list. */
  setEnabled: (name: string, enabled: boolean) => void
  /** Reveal one skill's instruction file in the right Sidebar. */
  openFile: (name: string) => void
}

/** Catalog and file access the page borrows from the plugin's own closure. */
export interface SkillsPagePorts {
  /** Read the Session's catalog through the shared per-Session fetch. */
  loadCatalog: (sessionId: SessionId) => Promise<readonly SkillEntry[]>
  /** Drop that shared fetch so the next read reaches the Host. */
  invalidateCatalog: (sessionId: SessionId) => void
  /** Reveal one skill's instruction file in the right Sidebar. */
  openSkillFile: (sessionId: SessionId, path: string) => void
}

/** The selected Session: the one the main column currently holds. */
function selectedSession(ctx: ClientContext): SessionId | undefined {
  const { byId } = ctx.sessions.list.getSnapshot()
  return Object.values(byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** Diagnostic text for a refused or failed read. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Project one catalog entry onto its row. */
function rowOf(skill: SkillEntry): SkillPageRow {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    modelInvocable: skill.modelInvocable,
  }
}

/** Project a disabled name, reusing the metadata this page still remembers. */
function disabledRowOf(name: string, seen: SkillEntry | undefined): SkillPageRow {
  return {
    name,
    description: seen?.description,
    path: seen?.path,
    modelInvocable: seen?.modelInvocable ?? false,
  }
}

/**
 * Owns the Skills page snapshot and its writes.
 *
 * The controller follows the main column's Session, so a page left open
 * follows the user's next selection; it reads the registry section through the
 * shared settings form, so a concurrent editor (another tab, the CLI) moves the
 * switches too.
 */
export class SkillsPageController {
  readonly store: SnapshotStore<SkillsPageState>
  private readonly form: ConfigForm<SkillRegistrySettings>
  /**
   * Every skill this page has seen, so a row that moves to the off group keeps
   * its text after the registry drops it from the catalog.
   */
  private readonly seen = new Map<string, SkillEntry>()
  private catalog: readonly SkillEntry[] = []
  private sessionId: SessionId | undefined
  private phase: SkillsPageState['status'] = 'no-session'
  private failure: string | undefined
  private generation = 0
  private disposed = false

  /**
   * @param ctx - the browser plugin context owning this page's registrations.
   * @param ports - the shared catalog fetch and the instruction-file reveal.
   */
  constructor(private readonly ctx: ClientContext, private readonly ports: SkillsPagePorts) {
    this.store = createSnapshotStore<SkillsPageState>({
      status: 'no-session',
      error: undefined,
      available: [],
      disabled: [],
      writable: false,
      busy: [],
      writeFailed: false,
    })
    this.form = ctx.configForms.get<SkillRegistrySettings>(SKILL_REGISTRY_ENTRY)
    ctx.effect(() => this.form.subscribe(() => { this.publish() }), 'ui-skill: page settings')
    ctx.effect(() => ctx.sessions.list.subscribe(() => { this.syncSession() }), 'ui-skill: page selection')
    ctx.effect(() => {
      // A preset decides which skill providers an agent reads, and a new
      // connection generation may compose a different registry altogether.
      const stopPreset = ctx.remote.$on('agent-preset/selected', () => { void this.reload(true) })
      const stopReset = ctx.on('connection/reset', () => { void this.reload(true) })
      return () => {
        stopPreset()
        stopReset()
      }
    }, 'ui-skill: page invalidations')
    ctx.effect(() => () => { this.disposed = true }, 'ui-skill: page teardown')
  }

  /** Follow the current selection and read its catalog on the page's first render. */
  ensure(): void {
    this.syncSession()
    if (this.sessionId === undefined) this.publish()
  }

  /** Re-read the catalog, reaching the Host past the shared per-Session fetch. */
  refresh(): void {
    const sessionId = this.sessionId
    if (sessionId === undefined) return
    this.ports.invalidateCatalog(sessionId)
    void this.reload()
  }

  /**
   * Put a skill into, or take it out of, the registry's disabled list.
   * @param name - the skill to switch.
   * @param enabled - whether the skill returns to the catalogs.
   */
  setEnabled(name: string, enabled: boolean): void {
    const sessionId = this.sessionId
    const state = this.store.getSnapshot()
    if (sessionId === undefined || !state.writable || state.busy.includes(name)) return
    const accepted = disabledNames(this.form.getSnapshot().value)
    if (enabled === !accepted.includes(name)) return
    const next = enabled ? accepted.filter(candidate => candidate !== name) : [...accepted, name]
    this.store.update((draft) => {
      draft.busy = [...draft.busy, name]
      draft.writeFailed = false
    })
    const settle = (written: boolean): void => {
      if (this.disposed) return
      this.store.update((draft) => {
        draft.busy = draft.busy.filter(candidate => candidate !== name)
        draft.writeFailed = !written
      })
      if (!written) return
      // The registry dropped or restored the skill in its collected catalog;
      // a cached '/' snapshot must not keep serving the previous answer.
      this.ports.invalidateCatalog(sessionId)
      void this.reload(true)
    }
    this.form.set(SKILL_DISABLED_FIELD, next).then(settle, () => { settle(false) })
  }

  /** Reveal one skill's instruction file in the right Sidebar. */
  openFile(name: string): void {
    const sessionId = this.sessionId
    const path = this.seen.get(name)?.path
    if (sessionId === undefined || path === undefined) return
    this.ports.openSkillFile(sessionId, path)
  }

  /** Follow the main column's Session, loading when it moved. */
  private syncSession(): void {
    const next = selectedSession(this.ctx)
    if (next === this.sessionId) return
    this.sessionId = next
    this.catalog = []
    this.generation += 1
    this.phase = next === undefined ? 'no-session' : 'loading'
    this.failure = undefined
    if (next === undefined) {
      this.publish()
      return
    }
    void this.reload()
  }

  /** Read the selected Session's catalog; `quiet` keeps the current rows visible while it runs. */
  private async reload(quiet = false): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === undefined) return
    const generation = ++this.generation
    if (!quiet) {
      this.phase = 'loading'
      this.failure = undefined
      this.publish()
    }
    try {
      const skills = await this.ports.loadCatalog(sessionId)
      if (this.disposed || generation !== this.generation) return
      this.catalog = skills
      for (const skill of skills) this.seen.set(skill.name, skill)
      this.phase = 'ready'
      this.failure = undefined
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return
      this.failure = describe(error)
      if (!quiet) this.phase = 'error'
    }
    this.publish()
  }

  /** Rebuild both row lists from the accepted disabled names and the last catalog. */
  private publish(): void {
    const section = this.form.getSnapshot()
    const off = new Set(disabledNames(section.value))
    this.store.update((draft) => {
      draft.status = this.phase
      draft.error = this.failure
      draft.writable = section.status === 'ready' && section.writable
      draft.available = this.catalog.filter(skill => !off.has(skill.name)).map(rowOf)
      draft.disabled = [...off].sort()
        .map(name => disabledRowOf(name, this.seen.get(name)))
    })
  }
}
