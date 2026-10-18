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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {
  MpsNodeConfig, MpsNodeConfigEntry, MpsNodeDeployment, MpsNodeExit,
  MpsNodeForm, MpsNodeLogLine, MpsNodePhase, MpsNodeProbeResult, MpsNodeStatus,
} from './types.ts'

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
 * Filename the Settings form's deployment parameters live in, inside the node
 * profile's own directory. Plain JSON rather than a profile patch row: a patch
 * row replaces its target's whole `config`, so restating every executor key
 * here would silently pin values the deployment never chose.
 */
const DEPLOYMENT_FILENAME = 'mps-node-control.json'

/** How long a connectivity probe waits for the platform's answer. */
const PROBE_TIMEOUT_MS = 8_000

/**
 * The protocol's own defaults, shown wherever neither the form nor the
 * environment states a value, so a blank field reads as "keeps this" rather
 * than "missing". These are the same defaults the node's bundle patch applies.
 */
const FIELD_DEFAULTS: Readonly<Partial<Record<keyof MpsNodeDeployment, string>>> = {
  platformHost: '127.0.0.1',
  platformPort: '8791',
  platformScheme: 'http',
  platformBasePath: '/exec/v1',
  slotsTotal: '1',
}

/** Deployment fields and the environment variables the node reads them from. */
const DEPLOYMENT_ENV: Readonly<Record<keyof MpsNodeDeployment, string>> = {
  platformHost: 'MPS_PLATFORM_HOST',
  platformPort: 'MPS_PLATFORM_PORT',
  platformScheme: 'MPS_PLATFORM_SCHEME',
  platformBasePath: 'MPS_PLATFORM_BASE_PATH',
  nodeId: 'MPS_NODE_ID',
  nodeName: 'MPS_NODE_NAME',
  nodeHost: 'MPS_NODE_HOST',
  workspaceRoot: 'MPS_NODE_WORKSPACE',
  slotsTotal: 'MPS_NODE_SLOTS',
  nodeSecret: 'MPS_NODE_SECRET',
}



/**
 * Read one deployment file. A missing file is simply no saved parameters; a
 * corrupt one is a deployment's own doing and fails loudly.
 * @param profileDir - the node profile's directory.
 * @returns the saved parameters, each field possibly unset.
 */
function readDeployment(profileDir: string): MpsNodeDeployment {
  let text: string
  try {
    text = readFileSync(join(profileDir, DEPLOYMENT_FILENAME), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`mps-node-control: ${DEPLOYMENT_FILENAME} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`mps-node-control: ${DEPLOYMENT_FILENAME} does not hold a deployment object`)
  }
  const result: MpsNodeDeployment = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`mps-node-control: ${DEPLOYMENT_FILENAME} field ${JSON.stringify(key)} is neither text nor a number`)
    }
    if (key === 'platformPort' || key === 'slotsTotal') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`mps-node-control: ${DEPLOYMENT_FILENAME} field ${JSON.stringify(key)} is not an integer`)
      }
      result[key] = value
    } else if (key === 'platformScheme') {
      if (value !== 'http' && value !== 'https') {
        throw new Error(`mps-node-control: ${DEPLOYMENT_FILENAME} field "platformScheme" is neither "http" nor "https"`)
      }
      result.platformScheme = value
    } else if (typeof value === 'string' && value !== '') {
      ;(result as Record<string, string | number>)[key] = value
    }
  }
  return result
}

/**
 * Normalize one form field's text into a deployment value.
 * @param key - the deployment field.
 * @param raw - what the form held; empty or whitespace means "unset".
 * @returns the value to store, or an error message when the text cannot be it.
 */
function parseField(key: keyof MpsNodeDeployment, raw: string): { value?: string | number } | { error: string } {
  const text = raw.trim()
  if (text === '') return {}
  if (key === 'platformPort' || key === 'slotsTotal') {
    const value = Number(text)
    if (!Number.isSafeInteger(value)) return { error: `${key} must be a whole number` }
    if (value < 1 || (key === 'platformPort' && value > 65_535)) {
      return { error: `${key} is out of range` }
    }
    return { value }
  }
  if (key === 'platformScheme' && text !== 'http' && text !== 'https') {
    return { error: 'platformScheme must be "http" or "https"' }
  }
  return { value: text }
}

/**
 * One effective-value reading: saved first, then the environment, then unset.
 * @param key - the deployment field.
 * @param saved - the form's stored parameters.
 * @returns the entry the settings surface shows.
 */
function effectiveEntry(key: keyof MpsNodeDeployment, saved: MpsNodeDeployment): MpsNodeConfigEntry {
  const savedValue = saved[key]
  if (savedValue !== undefined && savedValue !== '') {
    return { value: String(savedValue), source: 'saved' }
  }
  const fromEnv = process.env[DEPLOYMENT_ENV[key]]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { value: fromEnv, source: 'environment' }
  const fallback = FIELD_DEFAULTS[key]
  if (fallback !== undefined) return { value: fallback, source: 'default' }
  return { source: 'unset' }
}

/**
 * The environment the node launches with: this process's own, plus one
 * `MPS_*` variable per saved field, so a saved value outranks an inherited one.
 * @param saved - the form's stored parameters.
 * @returns the child's environment.
 */
function launchEnvironment(saved: MpsNodeDeployment): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(DEPLOYMENT_ENV) as Array<keyof MpsNodeDeployment>) {
    const value = saved[key]
    if (value !== undefined && value !== '') overlay[DEPLOYMENT_ENV[key]] = String(value)
  }
  return { ...process.env, ...overlay }
}

/**
 * This machine's LAN IPv4 addresses: the non-internal ones a platform on the
 * same LAN would dial back, so an operator can check the node sits on the
 * platform's subnet.
 * @returns the addresses, possibly none on an offline machine.
 */
export function lanIpv4Addresses(): string[] {
  const addresses: string[] = []
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return [...new Set(addresses)]
}

/**
 * Whether one dial target is this machine's own loopback — in a production
 * deployment a node dialing it is dialing itself, not the platform.
 * @param host - the address about to be dialed.
 * @returns true for every loopback spelling.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(host)
}

/**
 * One probe failure in a shape a settings page shows.
 * @param error - what the fetch threw.
 * @returns the message, with the timeout named as such.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `no answer within ${String(PROBE_TIMEOUT_MS / 1000)} seconds`
    return error.message
  }
  return String(error)
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
      env: launchEnvironment(readDeployment(this.profileDir())),
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
   * The deployment parameters the Settings form renders: what this page saved
   * and what the next launch would run with, per field.
   * @returns the saved parameters and the effective reading.
   */
  @Remote
  async config(): Promise<MpsNodeConfig> {
    const stored = readDeployment(this.profileDir())
    // The secret never crosses to the settings surface: it is reported only as
    // its source, and the saved copy the form reads back carries no value.
    const { nodeSecret: _secret, ...saved } = stored
    const entries = Object.keys(DEPLOYMENT_ENV) as Array<keyof MpsNodeDeployment>
    const effective = {} as MpsNodeConfig['effective']
    for (const key of entries) {
      if (key === 'nodeSecret') continue
      effective[key] = effectiveEntry(key, stored)
    }
    return {
      saved,
      secretSet: stored.nodeSecret !== undefined ? 'saved'
        : process.env.MPS_NODE_SECRET !== undefined && process.env.MPS_NODE_SECRET !== '' ? 'environment'
          : 'unset',
      lanAddresses: lanIpv4Addresses(),
      effective,
    }
  }

  /**
   * Store the deployment parameters the form submitted and report the new
   * reading. A saved value only reaches the node at its next launch: a running
   * node keeps the environment it was started with.
   * @param form - one text field per edited parameter; empty text clears it.
   * @returns the reading after the save.
   */
  @Remote
  async saveConfig(form: MpsNodeForm): Promise<MpsNodeConfig> {
    const previous = readDeployment(this.profileDir())
    const saved: MpsNodeDeployment = {}
    for (const key of Object.keys(DEPLOYMENT_ENV) as Array<keyof MpsNodeDeployment>) {
      // The secret is kept when the form leaves it blank: a save that edits
      // unrelated fields must never wipe the credential. Only the explicit
      // instruction drops it.
      if (key === 'nodeSecret') {
        const stated = form.nodeSecret?.trim() ?? ''
        if (stated !== '') saved.nodeSecret = stated
        else if (form.clearNodeSecret !== 'true' && previous.nodeSecret !== undefined) {
          saved.nodeSecret = previous.nodeSecret
        }
        continue
      }
      const parsed = parseField(key, form[key] ?? '')
      if ('error' in parsed) {
        throw new Error(`mps-node-control: ${parsed.error}`)
      }
      if (parsed.value !== undefined) {
        ;(saved as Record<string, string | number>)[key] = parsed.value
      }
    }
    const directory = this.profileDir()
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, DEPLOYMENT_FILENAME), `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
    return await this.config()
  }

  /**
   * Probe the platform address the form currently holds, the way the platform's
   * own integration note does: one `POST /auth/token` with deliberately wrong
   * credentials, where any HTTP answer — a 401 above all — means the network
   * path is open. The form's own values are read, not the saved ones, so an
   * address can be tested before it is stored.
   * @param form - the deployment-parameter form as it stands.
   * @returns what the probe found.
   */
  @Remote
  async probe(form: MpsNodeForm): Promise<MpsNodeProbeResult> {
    const saved = await this.config()
    const pick = (formValue: string | undefined, key: keyof MpsNodeConfig['effective']): string | undefined => {
      const text = formValue?.trim()
      if (text !== undefined && text !== '') return text
      const effective = saved.effective[key].value
      return effective
    }
    const host = pick(form.platformHost, 'platformHost')
    if (host === undefined) {
      return { reachable: false, detail: 'no platform address to test; state one in the form or the environment' }
    }
    const scheme = pick(form.platformScheme, 'platformScheme') === 'https' ? 'https' : 'http'
    const portText = pick(form.platformPort, 'platformPort')
    const port = portText === undefined ? 8791 : Number(portText)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return { reachable: false, detail: `the platform port "${portText ?? ''}" is not a usable TCP port` }
    }
    const basePath = (pick(form.platformBasePath, 'platformBasePath') ?? '/exec/v1').replace(/\/+$/u, '')
    const url = `${scheme}://${host}:${String(port)}${basePath}/auth/token`
    // A production platform runs on another machine of this LAN: a loopback
    // target means the node is dialing itself, whatever the answer says.
    const loopback = isLoopbackHost(host)
    const loopbackNote = loopback
      ? ' — this is this machine\'s own loopback; a production platform runs on another machine of this LAN'
      : ''
    const startedAt = Date.now()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node_id: 'connectivity-probe', secret: 'wrong-on-purpose' }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const latencyMs = Date.now() - startedAt
      // Any answer proves the address is dialable and something exec-shaped is
      // listening; the 401 is the documented shape of a healthy endpoint.
      return {
        reachable: true,
        httpStatus: response.status,
        latencyMs,
        ...(loopback ? { loopback: true } : {}),
        detail: (response.status === 401
          ? `the platform answered 401 in ${String(latencyMs)} ms, which is the healthy shape`
          : `the platform answered ${String(response.status)} in ${String(latencyMs)} ms`) + loopbackNote,
      }
    } catch (error) {
      return {
        reachable: false,
        ...(loopback ? { loopback: true } : {}),
        detail: `could not reach ${url}: ${toErrorMessage(error)}${loopbackNote}`,
      }
    }
  }

  /**
   * The node profile's own directory under the shared home, where the saved
   * deployment parameters live.
   * @returns the directory path, which may not exist yet.
   */
  private profileDir(): string {
    return join(resolveDshHome(), 'profiles', this.profile)
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
