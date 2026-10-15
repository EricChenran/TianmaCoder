/**
 * The node runtime: it authenticates with the pre-shared secret, registers this
 * node's identity and capacity, and keeps the heartbeat that carries running
 * tasks, slot capacity, and resource readings up to the management platform
 * while bringing commands back down. It owns the platform session's state and the
 * heartbeat timer; task execution is not part of it.
 * @module @tianma/dsh-mps-executor/runtime
 */

import {
  EXEC_PROTOCOL_VERSION,
  ExecClient,
  ExecResponseError,
  formatRfc3339,
} from '@tianma/dsh-mps-exec-core'
import type {
  ExecHeartbeatResult,
  ExecHttpTransport,
  ExecRegisterResult,
  ExecResources,
  ExecRunningTask,
  ExecSlots,
} from '@tianma/dsh-mps-exec-core'
import type { ExecutorSettings } from './config.ts'

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

/** One operator-visible event the runtime reports. */
export interface ExecutorReport {
  /** Severity. */
  level: 'info' | 'warn' | 'error'
  /** Message text. */
  message: string
}

/** Options for {@link MpsExecutorRuntime}. */
export interface ExecutorRuntimeOptions {
  /** The node's resolved settings. */
  settings: ExecutorSettings
  /** The pre-shared secret. */
  secret: string
  /** Transport override; defaults to `fetch`. */
  transport?: ExecHttpTransport | undefined
  /** Current-time source; injectable for tests. */
  now?: (() => Date) | undefined
  /** Operator-visible event sink; defaults to discarding events. */
  report?: ((report: ExecutorReport) => void) | undefined
}

/** Coerce an unknown rejection into an error. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
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

  readonly #secret: string
  readonly #now: () => Date
  readonly #report: (report: ExecutorReport) => void
  #state: NodeState = 'idle'
  #token: string | undefined
  #heartbeatSeconds: number
  #timer: ReturnType<typeof setInterval> | undefined
  #runningTasks: ExecRunningTask[] = []
  #resources: ExecResources = { cpu_percent: 0, mem_percent: 0, disk_free_gb: 0 }
  #lastError: Error | undefined

  /**
   * @param options - the resolved settings, the secret, and the optional transport, clock, and report sink.
   */
  constructor(options: ExecutorRuntimeOptions) {
    this.settings = options.settings
    this.#secret = options.secret
    this.#now = options.now ?? (() => new Date())
    this.#report = options.report ?? (() => {})
    this.#heartbeatSeconds = options.settings.heartbeatSeconds
    this.client = new ExecClient({
      endpoint: options.settings.endpoint,
      nodeId: options.settings.nodeId,
      transport: options.transport,
      token: () => this.#token,
      requestTimeoutMs: options.settings.requestTimeoutMs,
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

  /** The tasks this node reports as running. */
  get runningTasks(): readonly ExecRunningTask[] {
    return this.#runningTasks
  }

  /** The heartbeat period in force, as the platform most recently assigned it. */
  get heartbeatSeconds(): number {
    return this.#heartbeatSeconds
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
  setResources(resources: ExecResources): void {
    this.#resources = { ...resources }
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
        secret: this.#secret,
        protocol_version: EXEC_PROTOCOL_VERSION,
        agent_info: { name: 'tianmacoder', version: this.settings.agentVersion },
      }, signal)
      this.#token = authenticated.token
      this.#state = 'authenticated'
      const registered = await this.client.register({
        name: this.settings.nodeName,
        host: this.settings.nodeHost,
        protocol_version: EXEC_PROTOCOL_VERSION,
        agent_version: this.settings.agentVersion,
        slots: this.slots(),
        capabilities: this.settings.capabilities,
        workspace_root: this.settings.workspaceRoot,
        node_time: formatRfc3339(this.#now()),
        labels: this.settings.labels,
      }, signal)
      this.#state = 'online'
      this.#lastError = undefined
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
    return await this.client.heartbeat({
      running_tasks: [...this.#runningTasks],
      slots: this.slots(),
      resources: this.#resources,
      node_time: formatRfc3339(this.#now()),
      agent_version: this.settings.agentVersion,
    }, signal)
  }

  /**
   * Start the heartbeat timer. The timer holds a reference, so the hosting process
   * stays alive while the node is online.
   */
  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { this.#tick() }, this.#heartbeatSeconds * 1000)
  }

  /** Stop the heartbeat timer. */
  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#state === 'online') this.#state = 'authenticated'
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
