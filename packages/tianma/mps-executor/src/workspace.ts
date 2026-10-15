/**
 * The node's coding workspaces: one directory per bound workspace under the coding
 * root, kept across tasks because it carries what the workspace learned, plus the
 * sidecar file that survives a restart. Only a platform release removes a
 * directory — a task ending never does — and every removal is refused unless the
 * directory really sits inside the coding root, so a mistaken path or a symlink
 * cannot make the node delete something else.
 * @module @tianma/dsh-mps-executor/workspace
 */

import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import { formatRfc3339 } from '@tianma/dsh-mps-exec-core'
import type { ExecutorReport } from './report.ts'
import { toError } from './report.ts'

/** Sidecar file at the coding root holding what the node kept across restarts. */
export const WORKSPACE_STATE_FILE = '.state.json'

/** Format version of that sidecar file. */
export const WORKSPACE_STATE_VERSION = 1

/** The dsh session serving one coding workspace. */
export interface WorkspaceSession {
  /** Session reference the node reported for this workspace. */
  ref: string
  /** Baseline commit the directory held when the session was reported. */
  base_commit: string
  /** Task the session was reported for. */
  last_task_id: string
}

/** One coding workspace the node keeps for a bound platform workspace. */
export interface WorkspaceRecord {
  /** Platform workspace id. */
  workspace_id: string
  /** Directory under the coding root. */
  directory: string
  /** Session serving this workspace, once one was reported. */
  session?: WorkspaceSession | undefined
  /** Task this workspace served most recently. */
  last_task_id?: string | undefined
  /** When the workspace was last used, as an RFC 3339 string. */
  last_used_at: string
}

/** What the sidecar file holds. */
interface WorkspaceStateFile {
  version: number
  workspaces: WorkspaceRecord[]
}

/**
 * Name the coding workspaces a node holds, so a report about a full disk tells an operator
 * what could be released. The platform decides which to release; a node never deletes a
 * workspace the platform still binds.
 * @param records - the workspaces the node keeps.
 * @returns their ids, comma separated, or `none` when it keeps none.
 */
export function releasableWorkspaces(records: readonly { workspace_id: string }[]): string {
  return records.map(record => record.workspace_id).join(', ') || 'none'
}

/** Options for {@link WorkspaceStore}. */
export interface WorkspaceStoreOptions {
  /** Directory every coding workspace lives under. */
  root: string
  /** Clock; injectable for tests. */
  now?: (() => Date) | undefined
  /** Report node events; defaults to silence. */
  report?: ((report: ExecutorReport) => void) | undefined
}

/**
 * Whether a path sits strictly inside the root.
 * @param root - the resolved root.
 * @param target - the resolved path to test.
 * @returns true when the path is below the root.
 */
function isInside(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/**
 * Validate a workspace id into the directory name it may become.
 * @param workspaceId - the platform's workspace id.
 * @returns the same id.
 * @throws TypeError when the id could name something outside the coding root.
 */
function checkedWorkspaceId(workspaceId: string): string {
  const id = workspaceId.trim()
  if (id === '' || id === '.' || id === '..' || !/^[A-Za-z0-9._-]+$/u.test(id)) {
    throw new TypeError(`coding workspace id must be one path segment, got ${JSON.stringify(workspaceId)}`)
  }
  return id
}

/**
 * Whether a failure is a file that is not there, which is an ordinary first start.
 * @param error - the thrown value.
 * @returns true when the error carries the missing-file code.
 */
function isMissingFile(error: unknown): boolean {
  return toError(error).message.includes('ENOENT')
}

/** Keeps the workspaces this node holds and the state that survives a restart. */
export class WorkspaceStore {
  /** Directory every coding workspace lives under. */
  readonly root: string

  readonly #now: () => Date
  readonly #report: (report: ExecutorReport) => void
  #records = new Map<string, WorkspaceRecord>()
  #loaded = false

  /**
   * @param options - the coding root, clock, and report sink.
   */
  constructor(options: WorkspaceStoreOptions) {
    this.root = options.root
    this.#now = options.now ?? (() => new Date())
    this.#report = options.report ?? (() => {})
  }

  /** Path of the sidecar state file. */
  get statePath(): string {
    return join(this.root, WORKSPACE_STATE_FILE)
  }

  /** The workspaces this node holds, most recently used first. */
  get records(): readonly WorkspaceRecord[] {
    return [...this.#records.values()].sort((left, right) => right.last_used_at.localeCompare(left.last_used_at))
  }

  /** Whether the sidecar state has been read. */
  get loaded(): boolean {
    return this.#loaded
  }

  /**
   * The directory one workspace uses. The id is validated, so the result is always
   * one level below the coding root.
   * @param workspaceId - the platform's workspace id.
   * @returns the directory, whether or not it exists yet.
   */
  directoryOf(workspaceId: string): string {
    return join(this.root, checkedWorkspaceId(workspaceId))
  }

  /**
   * Read the sidecar state once. An unreadable file is reported and left alone: the
   * directories it describes stay where they are, and a later open reuses them.
   */
  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    let text: string
    try {
      text = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) {
        this.#report({
          level: 'warn',
          message: `coding workspace state is unreadable at ${this.statePath}: ${toError(error).message}`,
        })
      }
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      this.#records = new Map(stateRecords(parsed).map(record => [record.workspace_id, record]))
    } catch (error) {
      this.#report({
        level: 'warn',
        message: `coding workspace state at ${this.statePath} is not usable: ${toError(error).message}`,
      })
    }
  }

  /**
   * Resolve the directory an attempt works in, creating it the first time this node
   * holds that workspace, and record the use so the state file survives a restart.
   * @param workspaceId - the platform's workspace id.
   * @param taskId - the task being served.
   * @returns the directory.
   */
  async ensure(workspaceId: string, taskId: string): Promise<string> {
    await this.load()
    const directory = this.directoryOf(workspaceId)
    await mkdir(directory, { recursive: true })
    const previous = this.#records.get(workspaceId)
    this.#records.set(workspaceId, {
      workspace_id: checkedWorkspaceId(workspaceId),
      directory,
      last_used_at: formatRfc3339(this.#now()),
      last_task_id: taskId,
      session: previous?.session,
    })
    await this.save()
    return directory
  }

  /**
   * Record the session serving one workspace, which the platform is told about
   * separately and reads back when a node restarts.
   * @param workspaceId - the platform's workspace id.
   * @param session - the session reference and what it saw.
   */
  async setSession(workspaceId: string, session: WorkspaceSession): Promise<void> {
    const record = this.#records.get(checkedWorkspaceId(workspaceId))
    if (record === undefined) {
      throw new Error(`coding workspace ${workspaceId} is not held by this node`)
    }
    this.#records.set(record.workspace_id, { ...record, session })
    await this.save()
  }

  /**
   * Remove one workspace and forget it, which only a platform release does.
   * @param workspaceId - the platform's workspace id.
   * @returns whether this node held that workspace.
   * @throws Error when the directory does not resolve inside the coding root, so a
   * mistaken record or a symlink cannot make the node remove something else.
   */
  async release(workspaceId: string): Promise<boolean> {
    await this.load()
    const id = checkedWorkspaceId(workspaceId)
    if (!this.#records.has(id)) return false
    const directory = this.directoryOf(id)
    await this.#assertInsideRoot(directory)
    await rm(directory, { recursive: true, force: true })
    this.#records.delete(id)
    await this.save()
    this.#report({ level: 'info', message: `released coding workspace ${id} at ${directory}` })
    return true
  }

  /** Write the sidecar state. */
  async save(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const file: WorkspaceStateFile = { version: WORKSPACE_STATE_VERSION, workspaces: [...this.#records.values()] }
    const temporary = `${this.statePath}.${randomBytes(6).toString('hex')}`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    await rename(temporary, this.statePath)
  }

  /**
   * Refuse a directory that is not inside the coding root once symlinks resolve.
   * @param directory - the directory about to be removed.
   */
  async #assertInsideRoot(directory: string): Promise<void> {
    const root = await realpath(this.root)
    const target = await realpath(directory)
    if (!isInside(root, target)) {
      throw new Error(`refusing to remove ${directory}: it does not resolve inside the coding root ${this.root}`)
    }
  }
}

/**
 * Read the workspace records a sidecar file holds.
 * @param parsed - the parsed file.
 * @returns the records it states.
 * @throws Error when the file is not a state file this node wrote.
 */
function stateRecords(parsed: unknown): WorkspaceRecord[] {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('state file is not an object')
  const file = parsed as { version?: unknown; workspaces?: unknown }
  if (file.version !== WORKSPACE_STATE_VERSION) {
    throw new Error(`state file version ${String(file.version)} is not ${String(WORKSPACE_STATE_VERSION)}`)
  }
  if (!Array.isArray(file.workspaces)) throw new Error('state file carries no workspace list')
  return file.workspaces.filter(isRecord).map(record => ({
    workspace_id: String(record['workspace_id']),
    directory: String(record['directory']),
    session: sessionOf(record['session']),
    last_task_id: typeof record['last_task_id'] === 'string' ? record['last_task_id'] : undefined,
    last_used_at: String(record['last_used_at']),
  }))
}

/**
 * Read the session a record states.
 * @param value - the field's value.
 * @returns the session, or undefined when the record states none.
 */
function sessionOf(value: unknown): WorkspaceSession | undefined {
  if (!isRecord(value)) return undefined
  return {
    ref: String(value['ref']),
    base_commit: String(value['base_commit']),
    last_task_id: String(value['last_task_id']),
  }
}

/**
 * Whether a value is a plain object.
 * @param value - the value to test.
 * @returns true for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
