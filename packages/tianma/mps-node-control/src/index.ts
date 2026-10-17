/**
 * Tianma MPS executor-node control at `ctx.mpsNodeControl`: the Web GUI's entry to
 * the node. The node is an application of its own (`dsh --profile mps-node`) with
 * its own home, coding root, and credentials, so this service supervises that
 * process instead of mounting the node into the GUI's profile.
 *
 * The child is launched the way this process itself was launched — the same Node
 * binary and the same loaders — but through the `dsh` CLI entry shipped beside
 * this package, so a source launch and a packaged launch both work without a
 * deployment stating paths. Each of the three is overridable for a composition
 * that runs the node from somewhere else.
 *
 * The GUI owns the lifecycle: disposing this plugin stops the process, because a
 * node left running behind a closed window is a node nobody is watching. The
 * deployment's own parameters (platform address, node id, secret environment,
 * coding root) reach the child through the environment this process was given.
 *
 * @module @tianma/dsh-mps-node-control
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { MpsNodeExit, MpsNodeLogLine, MpsNodePhase, MpsNodeStatus } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mpsNodeControl: MpsNodeControlService
  }
}

/** One supervised node process, with the two pipes this service reads. */
type NodeProcess = ChildProcessByStdio<null, Readable, Readable>

/** Plugin configuration. */
export interface Config {
  /**
   * Entry that starts a dsh process; defaults to the `dsh` CLI shipped beside
   * this package, so the node runs the same build as the GUI it was started
   * from. The process's own entry is only the fallback: the packaged desktop
   * host takes positional argv, so relaunching it with `--profile` would read
   * the flag as a path.
   */
  entry?: string | undefined
  /** Node binary to launch it with; defaults to the running process's own. */
  nodeBinary?: string | undefined
  /**
   * Loaders to pass before the entry, such as the TS source loader; defaults to
   * the loaders this process was launched with.
   */
  loaders?: string[] | undefined
  /** Profile the entry boots. */
  profile: string
  /** How many recent lines the status surface can read back. */
  logLines: number
  /** How long a stop waits for the process to end before it is killed. */
  stopGraceMs: number
}

/** How many recent node lines are kept by default. */
export const DEFAULT_LOG_LINES = 200

/** How long a stop waits for the node to end by default, in milliseconds. */
export const DEFAULT_STOP_GRACE_MS = 10_000

/**
 * The `dsh` CLI entry this package was installed beside, or the entry that
 * started this process when no such CLI is resolvable (a source tree whose CLI
 * build has not run yet). Only a profile-taking entry can boot the node: the
 * packaged desktop host reads positional argv, so relaunching it with
 * `--profile` makes it read the flag as a path.
 */
function defaultDshEntry(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch {
    return process.argv[1]
  }
}

/**
 * Starts, stops, and reports on the executor node this GUI supervises. The node's
 * own deployment parameters are not this service's business: the child inherits
 * the environment, and the node reports what a deployment still has to state
 * through its own log.
 *
 * State is held in TypeScript-private fields rather than ECMAScript `#private`
 * ones: callers reach a service method through the Cordis Service proxy, whose
 * receiver is not the instance, so a `#private` field would be invisible to the
 * method body.
 */
export class MpsNodeControlService extends TypertRemoteService {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config = z.object({
    entry: z.string(),
    nodeBinary: z.string(),
    loaders: z.array(z.string()),
    profile: z.string().default('mps-node'),
    logLines: z.number().default(DEFAULT_LOG_LINES),
    stopGraceMs: z.number().default(DEFAULT_STOP_GRACE_MS),
  })

  private readonly entry: string
  private readonly nodeBinary: string
  private readonly loaders: readonly string[]
  private readonly profile: string
  private readonly logLines: number
  private readonly stopGraceMs: number
  private readonly now: () => Date
  private child: NodeProcess | undefined
  private phase: MpsNodePhase = 'stopped'
  private startedAt: string | undefined
  private exit: MpsNodeExit | undefined
  private error: string | undefined
  private lines: MpsNodeLogLine[] = []

  /**
   * @param ctx - Host carrying this service.
   * @param config - what to launch, and how much of its output to keep.
   * @throws {Error} when nothing names an entry to launch.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mpsNodeControl')
    const entry = config.entry ?? defaultDshEntry()
    if (entry === undefined || entry === '') {
      throw new Error('mps-node-control: nothing to launch; state the dsh entry in the plugin config')
    }
    this.entry = entry
    this.nodeBinary = config.nodeBinary === undefined || config.nodeBinary === '' ? process.execPath : config.nodeBinary
    this.loaders = config.loaders ?? process.execArgv
    this.profile = config.profile
    this.logLines = config.logLines
    this.stopGraceMs = config.stopGraceMs
    this.now = () => new Date()
  }

  /**
   * Take the process down with this plugin, so closing the GUI closes the node.
   */
  [Service.init](): void {
    this.ctx.effect(() => () => {
      // Disposal cannot wait, so the process is killed as it is taken down;
      // `stop()` is what a caller uses when it wants to await the end.
      this.child?.kill()
    })
  }

  /**
   * Where the node stands now.
   * @returns the current reading.
   */
  @Remote
  async status(): Promise<MpsNodeStatus> {
    return this.reading()
  }

  /**
   * Start the node unless one is already running.
   * @returns the reading after the launch was requested.
   */
  @Remote
  async start(): Promise<MpsNodeStatus> {
    if (this.child !== undefined) return this.reading()
    this.phase = 'starting'
    this.error = undefined
    this.exit = undefined
    this.startedAt = undefined
    const child = spawn(this.nodeBinary, [...this.loaders, this.entry, '--profile', this.profile], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.follow(child)
    return this.reading()
  }

  /**
   * Stop the node and wait for it to end, killing it when the grace period passes.
   * @returns the reading after the process ended.
   */
  @Remote
  async stop(): Promise<MpsNodeStatus> {
    const child = this.child
    if (child === undefined) return this.reading()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL') }, this.stopGraceMs)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
    return this.reading()
  }

  /**
   * The lines the node printed, oldest first.
   * @returns a copy, so a caller cannot disturb the ring this service keeps.
   */
  @Remote
  async logs(): Promise<MpsNodeLogLine[]> {
    return [...this.lines]
  }

  /**
   * Read the current fields into one status.
   * @returns the reading this service reports.
   */
  private reading(): MpsNodeStatus {
    const pid = this.child?.pid
    return {
      phase: this.phase,
      profile: this.profile,
      ...(pid === undefined ? {} : { pid }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.exit === undefined ? {} : { exit: this.exit }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  /**
   * Read one process's two streams and its end into this service's state.
   * @param child - the process this service just started.
   */
  private follow(child: NodeProcess): void {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.record('stdout', chunk) })
    child.stderr.on('data', (chunk: string) => { this.record('stderr', chunk) })
    child.on('spawn', () => {
      if (this.child !== child) return
      this.phase = 'running'
      this.startedAt = this.now().toISOString()
    })
    child.on('error', (error: Error) => {
      if (this.child !== child) return
      this.child = undefined
      this.phase = 'failed'
      this.error = error.message
      this.startedAt = undefined
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // A process this service stopped following — because a later launch replaced
      // it — must not overwrite the reading of the one that is current.
      if (this.child !== child) return
      this.child = undefined
      this.phase = 'stopped'
      this.startedAt = undefined
      this.exit = { code, signal, at: this.now().toISOString() }
    })
  }

  /**
   * Keep the most recent lines one process printed.
   * @param stream - the stream the text arrived on.
   * @param chunk - one read's worth of text, which may hold several lines.
   */
  private record(stream: 'stdout' | 'stderr', chunk: string): void {
    const at = this.now().toISOString()
    for (const text of chunk.split(/\r?\n/u)) {
      if (text === '') continue
      this.lines.push({ stream, at, text })
    }
    const excess = this.lines.length - this.logLines
    if (excess > 0) this.lines.splice(0, excess)
  }
}

export default MpsNodeControlService
