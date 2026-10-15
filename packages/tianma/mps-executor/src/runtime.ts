/**
 * The node runtime: it authenticates with the pre-shared secret, registers this
 * node's identity and capacity, and keeps the heartbeat that carries running
 * tasks, slot capacity, and resource readings up to the management platform
 * while bringing commands back down. It owns the platform session's state, the
 * heartbeat timer, and the running-task list a heartbeat reports; when a runner is
 * composed it also owns the task orchestrator that fills that list.
 * @module @tianma/dsh-mps-executor/runtime
 */

import {
  EXEC_PROTOCOL_VERSION,
  ExecClient,
  ExecResponseError,
  formatRfc3339,
} from '@tianma/dsh-mps-exec-core'
import type {
  ExecCommand,
  ExecHeartbeatResult,
  ExecHttpDownload,
  ExecHttpTransport,
  ExecRegisterResult,
  ExecResources,
  ExecRunningTask,
  ExecSlots,
} from '@tianma/dsh-mps-exec-core'
import { drainingMarker } from './draining.ts'
import type { DrainingMarker } from './draining.ts'
import type { ExecutorSettings } from './config.ts'
import { checkoutAllocator } from './checkout.ts'
import { clientArtifactUploader } from './artifacts.ts'
import { cliGit } from './git.ts'
import { checkoutPublisher } from './publish.ts'
import { checkoutSessionReporter, restoredSessionReports } from './session.ts'
import { TaskOrchestrator } from './orchestrator.ts'
import { toError } from './report.ts'
import type { ExecutorReport } from './report.ts'
import type { TaskRunner, TaskRunnerSource } from './runner.ts'
import { WorkspaceStore, releasableWorkspaces } from './workspace.ts'

export type { ExecutorReport } from './report.ts'

/**
 * Platform configuration this node does not act on: it keeps the values it declared and
 * registered, and says so when the platform states different ones.
 */
const KEPT_CONFIGURATION = [
  'claim_long_poll_seconds',
  'log_batch_max_lines',
  'log_batch_max_bytes',
  'max_artifact_bytes',
  'redaction_rule_version',
  'code_access_mode',
] as const

/** Where this node stands in its relationship with the management platform. */
export type NodeState =
  /** Not authenticated; no request may carry a token. */
  | 'idle'
  /** Holding a token, not yet registered. */
  | 'authenticated'
  /** Registered and heartbeating. */
  | 'online'
  /** Stopped by a failure only operators can clear. */
  | 'halted'

/** Options for {@link MpsExecutorRuntime}. */
export interface ExecutorRuntimeOptions {
  /** The node's resolved settings. */
  settings: ExecutorSettings
  /**
   * Supplies the pre-shared secret. Called when the handshake starts, so a
   * profile loads, prints help, and takes its configuration before the
   * deployment has to provide a credential.
   * @returns the secret.
   */
  secret: () => string
  /**
   * Resolves the runner this node executes with. Read when the node starts
   * claiming; without one the node keeps its platform session and claims nothing,
   * because there is no way to do the work.
   */
  runner?: TaskRunnerSource | undefined
  /** Transport override; defaults to `fetch`. */
  transport?: ExecHttpTransport | undefined
  /** Download override for file responses; defaults to `fetch`. */
  download?: ExecHttpDownload | undefined
  /** Current-time source; injectable for tests. */
  now?: (() => Date) | undefined
  /** Operator-visible event sink; defaults to discarding events. */
  report?: ((report: ExecutorReport) => void) | undefined
  /**
   * How this node learns the agent version it reports. The plugin composes it from the CLI
   * the node runs, so the platform schedules on the build that is really here.
   * @returns the version, or undefined when the CLI could not say.
   */
  probeAgentVersion?: (() => Promise<string | undefined>) | undefined
  /**
   * How this node reads its own resources. The plugin composes it from the machine, so
   * the platform schedules on what this node has rather than on a value it stated.
   * @returns the reading, or a rejection when the machine could not be read.
   */
  probeResources?: (() => Promise<ExecResources>) | undefined
}

/**
 * The node's platform session. One instance drives one configured node against
 * one management platform.
 */
export class MpsExecutorRuntime {
  /** The protocol client bound to this node's id. */
  readonly client: ExecClient
  /** The settings this runtime was resolved with. */
  readonly settings: ExecutorSettings

  readonly #secret: () => string
  readonly #now: () => Date
  readonly #report: (report: ExecutorReport) => void
  #state: NodeState = 'idle'
  #token: string | undefined
  #heartbeatSeconds: number
  /** Agent version this node reported, probed once. */
  #version: string | undefined
  /** How the agent's version is probed, when a deployment composed a CLI to ask. */
  #probeAgentVersion: (() => Promise<string | undefined>) | undefined
  /** The mark this node leaves for the process that replaces it. */
  readonly #draining: DrainingMarker
  /** How this node's resources are read, when a deployment composed a reader. */
  #probeResources: (() => Promise<ExecResources>) | undefined
  /** Platform configuration revision this node has applied; undefined before registration. */
  #configRevision: number | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #runningTasks: ExecRunningTask[] = []
  readonly #taskProgress = new Map<string, { progress: number; stage: string }>()
  #resources: ExecResources = { cpu_percent: 0, mem_percent: 0, disk_free_gb: 0 }
  /** Whether the last reading left room to start another attempt. */
  #hasRoom = true
  #lastError: Error | undefined
  #tasks: TaskOrchestrator | undefined
  #runnerSource: TaskRunnerSource | undefined
  readonly #workspaces: WorkspaceStore

  /**
   * @param options - the resolved settings, the secret, and the optional runner, transport, clock, and report sink.
   */
  constructor(options: ExecutorRuntimeOptions) {
    this.settings = options.settings
    this.#secret = options.secret
    this.#now = options.now ?? (() => new Date())
    this.#report = options.report ?? (() => {})
    this.#heartbeatSeconds = options.settings.heartbeatSeconds
    this.#probeAgentVersion = options.probeAgentVersion
    this.#probeResources = options.probeResources
    this.#draining = drainingMarker(options.settings.codingRoot)
    this.client = new ExecClient({
      endpoint: options.settings.endpoint,
      nodeId: options.settings.nodeId,
      transport: options.transport,
      download: options.download,
      token: () => this.#token,
      requestTimeoutMs: options.settings.requestTimeoutMs,
    })
    if (options.runner !== undefined) {
      this.#runnerSource = options.runner
    }
    this.#workspaces = new WorkspaceStore({
      root: options.settings.codingRoot,
      now: this.#now,
      report: this.#report,
    })
  }

  /**
   * Build the task orchestrator over one runner, wiring its transitions into the
   * running-task list a heartbeat reports.
   * @param runner - the runner that executes claimed attempts.
   * @returns the orchestrator.
   */
  #createOrchestrator(runner: TaskRunner): TaskOrchestrator {
    const git = cliGit()
    return new TaskOrchestrator({
      client: this.client,
      settings: this.settings,
      runner,
      workspaces: checkoutAllocator({ store: this.#workspaces, git }),
      publisher: checkoutPublisher({
        git,
        identity: { name: this.settings.gitUserName, email: this.settings.gitUserEmail },
      }),
      sessions: checkoutSessionReporter({ store: this.#workspaces, client: this.client }),
      artifacts: clientArtifactUploader({ client: this.client, maxBytes: this.settings.maxArtifactBytes }),
      // Claiming stops while the disk is too full to hold another attempt.
      canClaim: () => this.#hasRoom,
      report: this.#report,
      now: this.#now,
      hooks: {
        taskStarted: (task) => { this.#runningTasks = [...this.#runningTasks, task] },
        taskProgress: (taskId, progress, stage) => { this.#taskProgress.set(taskId, { progress, stage }) },
        taskFinished: (taskId) => {
          this.#runningTasks = this.#runningTasks.filter(task => task.task_id !== taskId)
          this.#taskProgress.delete(taskId)
        },
        availableSlots: () => this.availableSlots(),
      },
    })
  }

  /** Where this node stands with the platform. */
  get state(): NodeState {
    return this.#state
  }

  /** The bearer token in force, or `undefined` before authentication. */
  get token(): string | undefined {
    return this.#token
  }

  /** The most recent failure, kept for operator diagnosis. */
  get lastError(): Error | undefined {
    return this.#lastError
  }

  /** The tasks this node reports as running, each carrying its latest progress. */
  get runningTasks(): readonly ExecRunningTask[] {
    return this.#runningTasks.map(task => ({ ...task, ...this.#taskProgress.get(task.task_id) }))
  }

  /** The heartbeat period in force, as the platform most recently assigned it. */
  get heartbeatSeconds(): number {
    return this.#heartbeatSeconds
  }

  /** The task orchestrator, present only when a runner is composed. */
  get tasks(): TaskOrchestrator | undefined {
    return this.#tasks
  }

  /** The coding workspaces this node keeps across tasks. */
  get workspaces(): WorkspaceStore {
    return this.#workspaces
  }

  /**
   * Slots free for a new task.
   * @returns the free-slot count, never below zero.
   */
  availableSlots(): number {
    return Math.max(this.settings.slotsTotal - this.#runningTasks.length, 0)
  }

  /**
   * The slot capacity this node reports.
   * @returns the configured total, the running count, and the free count.
   */
  slots(): ExecSlots {
    return {
      total: this.settings.slotsTotal,
      running: this.#runningTasks.length,
      available: this.availableSlots(),
    }
  }

  /**
   * Replace the running-task list a heartbeat reports. Every task named here has
   * its lease renewed by the platform.
   * @param tasks - the tasks running right now.
   */
  setRunningTasks(tasks: readonly ExecRunningTask[]): void {
    this.#runningTasks = [...tasks]
  }

  /**
   * Replace the resource readings a heartbeat reports.
   * @param resources - the current readings.
   */
  /**
   * Take one reading of this machine. A reading that fails leaves the last one in place:
   * a node that cannot read its disk is not a node that has run out of it.
   * @returns the reading, or undefined when it could not be made.
   */
  async #readResources(): Promise<ExecResources | undefined> {
    if (this.#probeResources === undefined) return undefined
    try {
      return await this.#probeResources()
    } catch (error: unknown) {
      this.#report({
        level: 'warn',
        message: `node ${this.settings.nodeId} could not read its resources: ${toError(error).message}`,
      })
      return undefined
    }
  }

  /**
   * Apply one reading, and stop claiming work while the disk cannot hold another attempt.
   * @param resources - the reading.
   */
  async #applyResources(resources: ExecResources): Promise<void> {
    this.#resources = { ...resources }
    const room = resources.disk_free_gb >= this.settings.diskMinGb
    if (room === this.#hasRoom) return
    this.#hasRoom = room
    if (room) {
      this.#report({
        level: 'info',
        message: `node ${this.settings.nodeId} has ${String(resources.disk_free_gb)}GB free again; claiming work`,
      })
      // The platform stops holding tasks back, which is the half of this the node cannot
      // do by claiming nothing.
      await this.#announce('resume', 'the disk has room for another attempt again')
      return
    }
    this.#report({
      level: 'warn',
      message: `node ${this.settings.nodeId} is below ${String(this.settings.diskMinGb)}GB free (${String(resources.disk_free_gb)}GB); claiming nothing until there is room. Its workspaces are ${releasableWorkspaces(this.#workspaces.records)}`,
    })
    // Claiming nothing leaves the platform dispatching to a node that will not answer;
    // draining is how the protocol says a node stops taking work.
    await this.#announce('drain', `this node is below its ${String(this.settings.diskMinGb)}GB disk floor`)
  }

  /**
   * Tell the platform this node is or is no longer taking work. A platform that cannot
   * hear it still gets the right behaviour locally: the node's own claiming is what it is.
   * @param kind - the maintenance call to make.
   * @param reason - operator-visible reason.
   */
  async #announce(kind: 'drain' | 'resume', reason: string): Promise<void> {
    try {
      if (kind === 'drain') {
        // The mark first: a node that dies between the call and the mark could never be
        // resumed, where a mark the platform never heard about is cleared on the next start.
        this.#draining.keep()
        await this.client.drain(reason)
      } else {
        await this.client.resume(reason)
        this.#draining.clear()
      }
    } catch (error: unknown) {
      this.#report({
        level: 'warn',
        message: `could not tell the platform this node ${kind === 'drain' ? 'is' : 'is no longer'} draining: ${toError(error).message}`,
      })
    }
  }

  /**
   * Exchange the secret for a token and register this node. The platform's
   * answer supplies the heartbeat period, so the node never keeps a hardcoded one.
   * @param signal - caller cancellation.
   * @returns the registration result.
   * @throws the transport, protocol, or envelope error that ended the handshake; a halt-level code moves the node to `halted`.
   */
  async bootstrap(signal?: AbortSignal): Promise<ExecRegisterResult> {
    try {
      const authenticated = await this.client.authToken({
        secret: this.#secret(),
        protocol_version: EXEC_PROTOCOL_VERSION,
        agent_info: { name: 'tianmacoder', version: this.settings.agentVersion },
      }, signal)
      this.#token = authenticated.token
      this.#state = 'authenticated'
      const registered = await this.client.register({
        name: this.settings.nodeName,
        host: this.settings.nodeHost,
        protocol_version: EXEC_PROTOCOL_VERSION,
        agent_version: await this.#agentVersion(),
        slots: this.slots(),
        capabilities: this.settings.capabilities,
        workspace_root: this.settings.workspaceRoot,
        node_time: formatRfc3339(this.#now()),
        labels: this.settings.labels,
      }, signal)
      this.#state = 'online'
      this.#lastError = undefined
      // A node coming up after an upgrade takes work again: the mark its previous process
      // left is what this clears, which is the last step of the upgrade sequence.
      if (this.#draining.kept()) await this.#announce('resume', 'this node has started after draining')
      await this.#reportRestoredSessions(signal)
      const revision = registered.config_revision
      this.#configRevision = typeof revision === 'number' && Number.isFinite(revision) ? revision : undefined
      if (Number.isFinite(registered.heartbeat_interval_seconds) && registered.heartbeat_interval_seconds > 0) {
        this.#heartbeatSeconds = registered.heartbeat_interval_seconds
      }
      this.#report({
        level: 'info',
        message: `node ${this.settings.nodeId} registered at ${this.settings.endpoint.origin} (heartbeat ${String(this.#heartbeatSeconds)}s)`,
      })
      return registered
    } catch (error: unknown) {
      this.#lastError = toError(error)
      if (error instanceof ExecResponseError && error.recovery === 'halt-node') this.#state = 'halted'
      this.#report({ level: 'error', message: `node ${this.settings.nodeId} failed to register: ${this.#lastError.message}` })
      throw error
    }
  }

  /**
   * Send one heartbeat: report running tasks, slots, and resources, and receive
   * this period's commands and lease notices.
   * @param signal - caller cancellation.
   * @returns the heartbeat result.
   * @throws Error when the node has not authenticated yet.
   */
  async heartbeatOnce(signal?: AbortSignal): Promise<ExecHeartbeatResult> {
    if (this.#token === undefined) {
      throw new Error('executor runtime must authenticate before it can heartbeat')
    }
    // A reading for this period: the platform schedules on what this machine has now, and
    // the node stops claiming when the disk cannot hold another attempt.
    const reading = await this.#readResources()
    if (reading !== undefined) await this.#applyResources(reading)
    const heartbeat = await this.client.heartbeat({
      running_tasks: [...this.#runningTasks],
      slots: this.slots(),
      resources: this.#resources,
      node_time: formatRfc3339(this.#now()),
      agent_version: this.settings.agentVersion,
    }, signal)
    await this.#applyCommands(heartbeat.commands)
    if (heartbeat.config_revision !== this.#configRevision) {
      await this.#applyConfiguration(heartbeat.config_revision, signal)
    }
    return heartbeat
  }

  /**
   * The agent version this node reports. A deployment may state one; otherwise the node
   * asks the CLI it runs, so the platform schedules on the build that is really here.
   * @returns the version.
   */
  async #agentVersion(): Promise<string> {
    if (this.#version !== undefined) return this.#version
    const probed = this.#probeAgentVersion === undefined ? undefined : await this.#probeAgentVersion()
    this.#version = probed ?? this.settings.agentVersion
    return this.#version
  }

  /**
   * Fetch and apply the platform's configuration when its revision moves. The node acts on
   * the parameters it owns — the heartbeat interval — and names the ones it keeps at the
   * values it declared, so a platform instruction never disappears silently.
   * @param revision - the revision this heartbeat stated.
   * @param signal - caller cancellation.
   */
  async #applyConfiguration(revision: number, signal?: AbortSignal): Promise<void> {
    let stated: Record<string, unknown>
    try {
      stated = await this.client.configuration(signal)
    } catch (error: unknown) {
      // A configuration this node cannot read is a warning: the values it already holds
      // are the ones it declared, and the next heartbeat asks again.
      this.#report({
        level: 'warn',
        message: `node ${this.settings.nodeId} could not read platform configuration ${String(revision)}: ${toError(error).message}`,
      })
      return
    }
    const applied = stated['config_revision']
    // The heartbeat's revision is recorded either way: a platform that states an unusable
    // one must not make this node ask again on every period.
    this.#configRevision = typeof applied === 'number' && Number.isFinite(applied) ? applied : revision
    const seconds = stated['heartbeat_interval_seconds']
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds !== this.#heartbeatSeconds) {
      this.#heartbeatSeconds = seconds
      this.#arm()
    }
    const kept = KEPT_CONFIGURATION.filter(name => stated[name] !== undefined)
    this.#report({
      level: kept.length === 0 ? 'info' : 'warn',
      message: kept.length === 0
        ? `platform configuration ${String(this.#configRevision)} applied (heartbeat ${String(this.#heartbeatSeconds)}s)`
        : `platform configuration ${String(this.#configRevision)} applied (heartbeat ${String(this.#heartbeatSeconds)}s); this node keeps the values it declared for ${kept.join(', ')}`,
    })
  }

  /**
   * Re-arm the heartbeat timer at the current interval, so a platform that changed the
   * interval takes effect from the next period without dropping the work in flight.
   */
  #arm(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = setInterval(() => { this.#tick() }, this.#heartbeatSeconds * 1000)
  }

  /**
   * Apply this period's commands. Only the commands this node implements are acted
   * on; the rest are reported, so a platform instruction never disappears silently.
   * @param commands - the commands the heartbeat brought down.
   */
  async #applyCommands(commands: readonly ExecCommand[]): Promise<void> {
    for (const command of commands) {
      if (command.command === 'abort') {
        if (command.task_id === undefined) {
          this.#report({ level: 'warn', message: 'the platform aborted without naming a task' })
        } else if (this.#tasks?.abort(command.task_id, command.reason) !== true) {
          this.#report({
            level: 'warn',
            message: `the platform aborted task ${command.task_id}, which is not running here`,
          })
        }
        continue
      }
      if (command.command === 'release_workspace') {
        if (command.workspace_id === undefined) {
          this.#report({ level: 'warn', message: 'the platform released no workspace: the command names none' })
        } else {
          await this.#releaseWorkspace(command.workspace_id)
        }
        continue
      }
      this.#report({
        level: 'warn',
        message: `ignoring the ${command.command} command: this node does not implement it yet`,
      })
    }
  }

  /**
   * Remove one workflow because the platform released it. A release this node
   * cannot carry out is reported against that workspace, never against the
   * heartbeat that carried it.
   * @param workspaceId - the workspace the platform released.
   */
  async #releaseWorkspace(workspaceId: string): Promise<void> {
    // A workspace this node is working in is not a workspace to delete: the tree would go
    // out from under a running attempt. The platform can release it again once that
    // attempt has settled.
    const serving = this.#workspaces.records.find(record => record.workspace_id === workspaceId)?.last_task_id
    if (serving !== undefined && this.#tasks?.runningTaskIds().includes(serving) === true) {
      this.#report({
        level: 'warn',
        message: `the platform released workspace ${workspaceId} while task ${serving} is still working in it; keeping it until that attempt settles`,
      })
      return
    }
    try {
      const released = await this.#workspaces.release(workspaceId)
      if (!released) {
        this.#report({
          level: 'warn',
          message: `the platform released workspace ${workspaceId}, which this node does not hold`,
        })
      }
    } catch (error) {
      this.#report({
        level: 'error',
        message: `could not release workspace ${workspaceId}: ${toError(error).message}`,
      })
    }
  }

  /**
   * Tell the platform which sessions and coding paths this node already holds, so a
   * restart keeps showing them. The reference is for display and troubleshooting
   * only, so a report the platform refuses is a warning rather than a failed
   * handshake.
   * @param signal - caller cancellation.
   */
  async #reportRestoredSessions(signal?: AbortSignal): Promise<void> {
    for (const report of restoredSessionReports(this.#workspaces)) {
      try {
        await this.client.reportSession(report.workspace_id, report.body, signal)
      } catch (error) {
        this.#report({
          level: 'warn',
          message: `could not re-report the session of workspace ${report.workspace_id}: ${toError(error).message}`,
        })
      }
    }
  }

  /**
   * Read the coding workspaces this node kept, so a restarted node reuses the
   * directories and sessions the platform still associates with it. Call it before
   * the handshake; {@link WorkspaceStore} reads its state lazily anyway.
   */
  async restore(): Promise<void> {
    await this.#workspaces.load()
  }

  /**
   * Start the heartbeat timer and, when a runner is composed, start claiming work.
   * The timer holds a reference, so the hosting process stays alive while the node
   * is online.
   */
  start(): void {
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => { this.#tick() }, this.#heartbeatSeconds * 1000)
    }
    if (this.#tasks === undefined && this.#runnerSource !== undefined) {
      const runner = this.#runnerSource()
      if (runner === undefined) {
        this.#report({
          level: 'warn',
          message: `node ${this.settings.nodeId} has no task runner composed; it holds its platform session without claiming work`,
        })
      } else {
        this.#tasks = this.#createOrchestrator(runner)
      }
    }
    this.#tasks?.start()
  }

  /**
   * Stop the heartbeat timer and cancel the running attempts. Each attempt still
   * submits its outcome; {@link TaskOrchestrator.drain} waits for that.
   */
  stop(): void {
    this.#tasks?.stop()
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#state === 'online') this.#state = 'authenticated'
  }

  /**
   * Stop the way the protocol says to: announce the drain so the platform sends nothing
   * new, let the attempts already running finish, and end those still running once the
   * grace is over — an attempt this node ends reports `cancelled`, where an attempt lost
   * with the process leaves the platform waiting for a lease to expire before it is redone.
   * @param graceMs - how long running attempts may take to finish; the configured grace by default.
   */
  async shutdown(graceMs?: number): Promise<void> {
    const grace = graceMs ?? this.settings.shutdownGraceSeconds * 1000
    if (this.#state === 'online') {
      await this.#announce('drain', 'this node is stopping')
    }
    // No new work: the platform stops dispatching to a draining node, which is what the
    // announcement is for. The heartbeat keeps going, because attempts still running have
    // leases to renew while they finish.
    const quiet = this.#tasks?.drain()
    if (quiet !== undefined) await Promise.race([quiet, this.#delay(grace)])
    const running = this.#tasks?.runningTaskIds() ?? []
    if (running.length > 0) {
      this.#report({
        level: 'warn',
        message: `node ${this.settings.nodeId} is stopping with ${String(running.length)} attempt(s) still running; ending them after ${String(Math.round(grace / 1000))}s`,
      })
    }
    for (const taskId of running) this.#tasks?.abort(taskId, 'the node is shutting down')
    // Ended attempts still submit their outcome, which is the point of ending them here.
    await this.#tasks?.drain()
    this.stop()
  }

  /**
   * Wait one interval.
   * @param ms - how long.
   */
  async #delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Send one heartbeat for the timer, applying the recovery its failure requires:
   * a halt-level code stops the node, an expired token triggers a fresh handshake,
   * and anything else waits for the next period.
   */
  #tick(): void {
    this.heartbeatOnce().catch((error: unknown) => { this.#recover(error) })
  }

  /** Apply the recovery one failed heartbeat requires. */
  #recover(error: unknown): void {
    this.#lastError = toError(error)
    const recovery = error instanceof ExecResponseError ? error.recovery : 'retry'
    if (recovery === 'halt-node') {
      this.#state = 'halted'
      this.stop()
      this.#report({ level: 'error', message: `node ${this.settings.nodeId} halted: ${this.#lastError.message}` })
      return
    }
    if (recovery === 'reauthenticate') {
      this.#token = undefined
      this.#report({ level: 'warn', message: `node ${this.settings.nodeId} token expired; re-authenticating` })
      this.bootstrap().catch(() => { /* bootstrap reports its own failure */ })
      return
    }
    this.#report({ level: 'warn', message: `node ${this.settings.nodeId} heartbeat failed: ${this.#lastError.message}` })
  }
}
