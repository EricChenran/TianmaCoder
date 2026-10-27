/**
 * Configuration for one executor node: the platform communication address it
 * dials (host and port), its identity, its capacity, and the timing budget it
 * runs with. Every value a deployment varies is a validated field here, so a node
 * is pointed at a different management platform by editing its profile row rather
 * than its code.
 * @module @tianma/dsh-mps-executor/config
 */

import { existsSync } from 'node:fs'
import { hostname as hostHostname, platform } from 'node:os'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { AgentModelChoice } from './agent-patch.ts'
import {
  DEFAULT_PLATFORM_BASE_PATH,
  DEFAULT_PLATFORM_PORT,
  resolvePlatformEndpoint,
  WORK_KIND_CHAT_ANSWER,
  WORK_KIND_CODING,
} from '@tianma/dsh-mps-exec-core'
import type { ExecCapabilities, PlatformEndpoint, PlatformScheme } from '@tianma/dsh-mps-exec-core'
import { probeTools } from './capabilities.ts'

/** Environment variable holding the pre-shared node secret when configuration names none. */
export const DEFAULT_SECRET_ENV = 'MPS_NODE_SECRET'

/**
 * Free disk space below which this node stops claiming work, in gigabytes. Five gigabytes
 * is roughly one dependency install plus one workspace build: below it an attempt is
 * likely to fail halfway and leave the disk full.
 */
export const DEFAULT_DISK_MIN_GB = 5

/**
 * Lines the operator's copy of a run log keeps. Everything a run prints is reported to the
 * platform as it arrives; this bounds only the copy the node keeps on disk, which a chatty
 * run would otherwise grow without end. Both ends of the run are kept, which is where a
 * failure is read from.
 */
export const DEFAULT_RAW_LOG_MAX_LINES = 5000

/**
 * How long a stopping node lets its running attempts finish before it ends them, in
 * seconds. Sixty is the grace the plan names, and sits well inside the lease a platform
 * grants, so a stop still reports each attempt's outcome instead of costing a lease timeout.
 */
export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 60

/** Heartbeat period the node starts with before the platform overrides it. */
export const DEFAULT_HEARTBEAT_SECONDS = 10

/** Claim long-poll budget the node starts with before the platform overrides it. */
export const DEFAULT_CLAIM_LONG_POLL_SECONDS = 25

/** Lease renewal period used until a claim states the platform's own. */
export const DEFAULT_LEASE_RENEW_SECONDS = 30

/** Runtime ceiling for one attempt, used when the task payload states none. */
export const DEFAULT_TASK_RUNTIME_SECONDS = 3 * 60 * 60

/**
 * Runtime ceiling for one chat-answer attempt, used when its payload states none. Zero
 * follows the lease: the ceiling the claim's `lease_expire_at` states minus the margin
 * that keeps room for the result, capped at ten minutes, and re-armed by each renewal.
 * The platform no longer answers over a node that is online, so nothing shorter may end
 * an answer attempt early.
 */
export const DEFAULT_ANSWER_RUNTIME_SECONDS = 0

/** Budget for one ordinary platform request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Largest artifact the node uploads without chunking, in bytes. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 500 * 1024 * 1024

/** `user.name` a node commits under until a deployment names its robot. */
/**
 * The command the node runs one attempt with when a deployment states none: the
 * headless profile of the CLI, which prints its answer and exits. A deployment
 * points this at an absolute executable path so a node never depends on `PATH`.
 */
export const DEFAULT_CLI_COMMAND: readonly string[] = ['dsh', '--profile', 'headless']

/** `user.name` a node commits under until a deployment names its robot. */
export const DEFAULT_GIT_USER_NAME = 'tianma-mps-node'

/** `user.email` a node commits under until a deployment names its robot. */
export const DEFAULT_GIT_USER_EMAIL = 'mps-node@localhost'

/** Agent version reported before the deployment states the built CLI version. */
export const UNKNOWN_AGENT_VERSION = 'unknown'

/** The CLI runner a node falls back to, as configuration states it. */
export interface CliRunnerConfig {
  /** Command and its leading arguments; the instruction is appended. */
  command: string[]
  /** Directory the runner keeps one raw log per attempt under; blank means beside the workspace root. */
  logsDirectory: string
  /** `DSH_HOME` the run uses, so a node's profile directory stays its own; blank inherits the environment. */
  dshHome: string
  /** Whether the run is asked for its event stream instead of its final answer alone. */
  jsonEvents: boolean
}

/** The executor node's plugin configuration. */
export interface Config {
  /** Management-platform host or address the node dials: an IPv4 address, a host name, or an IPv6 address. */
  platformHost: string
  /** Management-platform TCP port the node dials. */
  platformPort?: number
  /** Transport scheme for the platform connection. */
  platformScheme?: PlatformScheme
  /** Path prefix the protocol endpoints hang off. */
  platformBasePath?: string
  /** Node id the platform knows this node by. */
  nodeId: string
  /** Display name shown in the console. */
  nodeName?: string
  /** Host address the node reports to the platform. */
  nodeHost?: string
  /** Name of the environment variable holding the pre-shared secret. */
  secretEnv?: string
  /** Directory the node works under and reports as its workspace root. */
  workspaceRoot?: string
  /** Directory the node keeps its coding workspaces under; defaults to `coding` inside the workspace root. */
  codingRoot?: string
  /** Operator directory for the task ledger and operator commands. */
  opsDir?: string
  /** `user.name` the node commits under; the host's global git configuration is never touched. */
  gitUserName?: string
  /** `user.email` the node commits under. */
  gitUserEmail?: string
  /** Largest artifact the node uploads in one request. */
  maxArtifactBytes?: number
  /**
   * The CLI runner the node falls back to when no runner is composed under
   * `mpsTaskRunner`; composing one there takes precedence.
   */
  cliRunner?: CliRunnerConfig
  /** Concurrent tasks this node accepts. */
  slotsTotal?: number
  /** Free disk floor in GB; below it the node drains and claims nothing. */
  diskMinGb?: number
  /**
   * Lines the operator's copy of a run log keeps. The platform receives every line either
   * way; this is what the node keeps on disk.
   */
  rawLogMaxLines?: number
  /** Seconds a stopping node waits for running attempts and child processes before it exits. */
  shutdownGraceSeconds?: number
  /** Heartbeat period in seconds. */
  heartbeatSeconds?: number
  /** Claim long-poll budget in seconds. */
  claimLongPollSeconds?: number
  /** Lease renewal period in seconds, used until a claim states the platform's own. */
  leaseRenewSeconds?: number
  /** Runtime ceiling in seconds for one attempt, used when the task payload states none. */
  taskRuntimeSeconds?: number
  /**
   * Runtime ceiling in seconds for one chat-answer attempt, before its payload states
   * one. Zero follows the lease (capped at ten minutes); a stated value is the ceiling
   * as stated.
   */
  answerRuntimeSeconds?: number
  /** Budget for one ordinary platform request in milliseconds. */
  requestTimeoutMs?: number
  /** Work kinds this node accepts. */
  lanes?: string[]
  /** Toolchain names this node detected. */
  tools?: string[]
  /** Agent version the node reports. */
  agentVersion?: string
  /**
   * Provider route a node's agent runs start on, such as `deepseek-official`. Stated
   * together with {@link Config.agentModel}, it overrides the profile's default for every
   * task on this node; left blank, the profile's own default stands.
   */
  agentProvider?: string
  /** Model id those runs start on, such as `deepseek-v4-pro`. */
  agentModel?: string
  /**
   * Messages-compatible endpoint those runs use, when the deployment routes through a
   * gateway instead of the official root.
   */
  agentBaseURL?: string
  /**
   * Environment variable the adapter reads the credential from, when it is not its own
   * default. The key itself is never stated here: it stays in the environment or in the
   * shared credential store, which is what lets a node and a workstation share one.
   */
  agentApiKeyEnv?: string
  /** Operator labels shown in the console. */
  labels?: Record<string, string>
  /** Whether the node authenticates, registers, and heartbeats as soon as its profile loads. */
  autoStart?: boolean
}

/** The validated configuration schema. */
export const Config: z<Config> = z.object({
  platformHost: z.string().required(),
  platformPort: z.number().step(1).min(1).max(65535).default(DEFAULT_PLATFORM_PORT),
  platformScheme: z.union(['http', 'https'] as const).default('http'),
  platformBasePath: z.string().default(DEFAULT_PLATFORM_BASE_PATH),
  nodeId: z.string().required(),
  nodeName: z.string().default(''),
  nodeHost: z.string().default(''),
  secretEnv: z.string().default(DEFAULT_SECRET_ENV),
  workspaceRoot: z.string().default(''),
  codingRoot: z.string().default(''),
  opsDir: z.string().default(''),
  gitUserName: z.string().default(DEFAULT_GIT_USER_NAME),
  gitUserEmail: z.string().default(DEFAULT_GIT_USER_EMAIL),
  maxArtifactBytes: z.number().step(1).min(1).default(DEFAULT_MAX_ARTIFACT_BYTES),
  cliRunner: z.object({
    command: z.array(z.string()).default([]),
    logsDirectory: z.string().default(''),
    dshHome: z.string().default(''),
    jsonEvents: z.boolean().default(false),
  }).default({ command: [], logsDirectory: '', dshHome: '', jsonEvents: false }),
  slotsTotal: z.number().step(1).min(1).default(1),
  diskMinGb: z.number().min(0).default(DEFAULT_DISK_MIN_GB),
  rawLogMaxLines: z.number().step(1).min(0).default(DEFAULT_RAW_LOG_MAX_LINES),
  shutdownGraceSeconds: z.number().min(0).default(DEFAULT_SHUTDOWN_GRACE_SECONDS),
  heartbeatSeconds: z.number().step(1).min(1).default(DEFAULT_HEARTBEAT_SECONDS),
  claimLongPollSeconds: z.number().step(1).min(1).default(DEFAULT_CLAIM_LONG_POLL_SECONDS),
  leaseRenewSeconds: z.number().step(1).min(1).max(3600).default(DEFAULT_LEASE_RENEW_SECONDS),
  taskRuntimeSeconds: z.number().step(1).min(1).default(DEFAULT_TASK_RUNTIME_SECONDS),
  answerRuntimeSeconds: z.number().step(1).min(0).default(DEFAULT_ANSWER_RUNTIME_SECONDS),
  requestTimeoutMs: z.number().step(1).min(1000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  lanes: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  agentVersion: z.string().default(UNKNOWN_AGENT_VERSION),
  agentProvider: z.string().default(''),
  agentModel: z.string().default(''),
  agentBaseURL: z.string().default(''),
  agentApiKeyEnv: z.string().default(''),
  labels: z.dict(z.string()).default({}),
  autoStart: z.boolean().default(true),
})

/** The CLI runner one node row resolves to. */
export interface ResolvedCliRunner {
  /** Command and its leading arguments. */
  command: string[]
  /** The executable those arguments run, captured where the command was checked. */
  bin: string
  /** Directory the runner keeps one raw log per attempt under. */
  logsDirectory: string
  /** `DSH_HOME` the run uses, or undefined to inherit the node's environment. */
  dshHome?: string | undefined
  /** The command that answers `--version`, which is not always `command[0]`. */
  versionCommand: string[]
  /** Whether the run is asked for its event stream instead of its final answer alone. */
  jsonEvents: boolean
}

/** The configuration resolved into the values the node runtime runs with. */
export interface ExecutorSettings {
  /** Platform address the node dials. */
  endpoint: PlatformEndpoint
  /** Node id. */
  nodeId: string
  /** Display name. */
  nodeName: string
  /** Host address reported to the platform. */
  nodeHost: string
  /** Workspace root the node reports. */
  workspaceRoot: string
  /** Directory the node keeps its coding workspaces under. */
  codingRoot: string
  /** Directory the task ledger and operator commands live under. */
  opsRoot: string
  /** `user.name` injected into every commit the node makes. */
  gitUserName: string
  /** `user.email` injected into every commit the node makes. */
  gitUserEmail: string
  /** Largest artifact the node uploads in one request. */
  maxArtifactBytes: number
  /** The CLI runner the node falls back to when no runner is composed. */
  cliRunner: ResolvedCliRunner
  /** Concurrent task capacity. */
  slotsTotal: number
  /** Free disk space below which the node stops claiming work; see {@link DEFAULT_DISK_MIN_GB}. */
  diskMinGb: number
  /** How long a stopping node lets running attempts finish; see {@link DEFAULT_SHUTDOWN_GRACE_SECONDS}. */
  shutdownGraceSeconds: number
  /** Heartbeat period in seconds. */
  heartbeatSeconds: number
  /** Claim long-poll budget in seconds. */
  claimLongPollSeconds: number
  /** Lease renewal period in seconds, before a claim states the platform's own. */
  leaseRenewSeconds: number
  /** Runtime ceiling in seconds for one attempt, before a payload states its own. */
  taskRuntimeSeconds: number
  /**
   * Runtime ceiling in seconds for one chat-answer attempt, before its payload states
   * one. Zero follows the lease, capped at ten minutes.
   */
  answerRuntimeSeconds: number
  /** Budget for one ordinary request. */
  requestTimeoutMs: number
  /** Capability promise the node registers. */
  capabilities: ExecCapabilities
  /** Agent version reported. */
  agentVersion: string
  /**
   * The model this node's agent runs start on, when the deployment chose one. Blank keeps
   * the profile's own default, and the choice applies to every task the node runs.
   */
  agent: AgentModelChoice
  /** Operator labels. */
  labels: Record<string, string>
  /** Whether the node starts on load. */
  autoStart: boolean
}

/**
 * Resolve the CLI runner a node falls back to. A command that names no executable is
 * refused here, when the profile loads, rather than when the first attempt starts.
 * @param stated - the block a node row states, if any.
 * @param workspaceRoot - the directory a node's own files live under.
 * @returns the resolved runner configuration.
 */
function resolveCliRunner(stated: CliRunnerConfig | undefined, workspaceRoot: string): ResolvedCliRunner {
  const statedCommand = stated?.command ?? []
  const command = executableCommand(statedCommand.length === 0 ? [...DEFAULT_CLI_COMMAND] : statedCommand)
  const logs = (stated?.logsDirectory ?? '').trim()
  const home = (stated?.dshHome ?? '').trim()
  return {
    command,
    bin: command[0] as string,
    versionCommand: versionProbeCommand(command),
    logsDirectory: logs === '' ? join(workspaceRoot, 'logs') : logs,
    dshHome: home === '' ? undefined : home,
    jsonEvents: stated?.jsonEvents === true,
  }
}

/**
 * The permission mode every agent run starts with. A node's runs have no person to
 * answer an approval, and the base profile pairs its sandbox presets with `ask`, so a
 * run that needs an approval is refused mid-task — a deterministic failure nothing in
 * the task caused. Full access with approvals off is the only mode an unattended run
 * can settle in; the workspace the agent writes in stays the node's own boundary.
 */
export const AGENT_PERMISSION_MODE = 'danger-full-access'

/**
 * The environment one agent run starts with: its own profile directory, when the
 * configuration states one, and the permission mode above.
 * @param dshHome - the `DSH_HOME` the configuration stated, if any.
 * @returns the extra environment for the run.
 */
export function agentRunEnv(dshHome: string | undefined): Record<string, string> {
  return {
    ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
    DSH_PERMISSION_MODE: AGENT_PERMISSION_MODE,
  }
}

/**
 * The command one run starts, taken as stated when it names a path or a name
 * the PATH holds. A bare name nothing resolves — the packaged GUI's node, a clean
 * machine without the CLI on its PATH — falls back to the dsh CLI shipped beside
 * this package, started with this process's own binary: the same interpreter that
 * started the node, so an ABI or PATH mismatch cannot occur.
 * @param stated - the command the configuration stated.
 * @returns the command to run.
 */
function executableCommand(stated: string[]): string[] {
  const [bin, ...args] = stated
  if (bin === undefined || bin === '') {
    throw new TypeError('the CLI runner needs the command it starts, such as dsh --profile headless')
  }
  if (bin.includes('/') || bin.includes('\\') || isAbsolute(bin) || onPath(bin)) return stated
  try {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
    return [process.execPath, entry, ...args]
  } catch {
    // No bundled CLI either: keep the stated name, so the failure names it.
    return stated
  }
}

/**
 * Whether one bare name is on the PATH, with the Windows executable extensions.
 * @param bin - the bare name.
 * @returns true when some PATH directory holds it.
 */
function onPath(bin: string): boolean {
  const extensions = platform() === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      if (existsSync(join(directory, bin + extension))) return true
    }
  }
  return false
}

/**
 * The command that answers `--version`: the stated executable when it is one, or
 * the interpreter plus the CLI entry when the run command was rewritten.
 * @param command - the resolved run command.
 * @returns the command the version probe starts.
 */
function versionProbeCommand(command: string[]): string[] {
  const entry = command.find(part => part.endsWith('lib\\bin.js') || part.endsWith('lib/bin.js'))
  if (entry === undefined || command[0] === undefined) return [command[0] as string]
  return command.slice(0, command.indexOf(entry) + 1)
}

/**
 * Resolve one node's configuration into its runtime settings, filling the host,
 * workspace root, and name from the machine when the deployment states none.
 * @param config - the validated plugin configuration.
 * @param hostname - this machine's host name; injectable for tests.
 * @returns the resolved settings.
 */
/**
 * The environment variables a deployment states the node's address and identity in. The node
 * profile's own row reads these too; naming them here is what lets `--show-config` answer with
 * the same values the row would use.
 */
export const EXECUTOR_ENV = {
  platformHost: 'MPS_PLATFORM_HOST',
  platformPort: 'MPS_PLATFORM_PORT',
  platformScheme: 'MPS_PLATFORM_SCHEME',
  platformBasePath: 'MPS_PLATFORM_BASE_PATH',
  nodeId: 'MPS_NODE_ID',
  nodeName: 'MPS_NODE_NAME',
  nodeHost: 'MPS_NODE_HOST',
  nodeSlots: 'MPS_NODE_SLOTS',
  workspaceRoot: 'MPS_NODE_WORKSPACE',
  opsDir: 'MPS_NODE_OPS_DIR',
  secret: 'MPS_NODE_SECRET',
  dshBin: 'MPS_DSH_BIN',
  dshHome: 'MPS_DSH_HOME',
  agentVersion: 'MPS_AGENT_VERSION',
  agentProvider: 'MPS_AGENT_PROVIDER',
  agentModel: 'MPS_AGENT_MODEL',
  agentBaseURL: 'MPS_AGENT_BASE_URL',
  agentApiKeyEnv: 'MPS_AGENT_API_KEY_ENV',
} as const

/**
 * Read a configuration out of an environment, the way the node profile's row reads it.
 * @param env - the environment to read, defaults to this process's.
 * @returns the configuration to resolve; absent values are left to the resolver's defaults.
 */
export function executorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  // The two the resolver refuses to default, refused here for the same reason: a node that
  // does not know which platform it belongs to must not resolve an address at all.
  const host = env[EXECUTOR_ENV.platformHost]?.trim() ?? ''
  if (host === '') throw new Error(`${EXECUTOR_ENV.platformHost} is required: the node has to be told which platform it belongs to`)
  const requiredNodeId = env[EXECUTOR_ENV.nodeId]?.trim() ?? ''
  if (requiredNodeId === '') throw new Error(`${EXECUTOR_ENV.nodeId} is required: the platform identifies this machine by it`)
  const config: Config = { platformHost: host, nodeId: requiredNodeId }
  const port = env[EXECUTOR_ENV.platformPort]
  if (port !== undefined && port !== '') config.platformPort = Number(port)
  const scheme = env[EXECUTOR_ENV.platformScheme]
  // The value arrives as text, so this is the boundary that decides whether it is one the node
  // connects with. Skipping anything else silently left the schema to exchange it for its
  // default, and the node dialled a scheme nobody asked for.
  if (scheme !== undefined && scheme !== '') {
    if (scheme !== 'http' && scheme !== 'https') {
      throw new TypeError(`${EXECUTOR_ENV.platformScheme} must be "http" or "https", got ${JSON.stringify(scheme)}`)
    }
    config.platformScheme = scheme
  }
  const basePath = env[EXECUTOR_ENV.platformBasePath]
  if (basePath !== undefined && basePath !== '') config.platformBasePath = basePath
  const nodeName = env[EXECUTOR_ENV.nodeName]
  if (nodeName !== undefined && nodeName !== '') config.nodeName = nodeName
  const nodeHost = env[EXECUTOR_ENV.nodeHost]
  if (nodeHost !== undefined && nodeHost !== '') config.nodeHost = nodeHost
  const slots = env[EXECUTOR_ENV.nodeSlots]
  if (slots !== undefined && slots !== '') {
    const count = Number(slots)
    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError(`${EXECUTOR_ENV.nodeSlots} must be a whole number of 1 or more, got ${JSON.stringify(slots)}`)
    }
    config.slotsTotal = count
  }
  const workspace = env[EXECUTOR_ENV.workspaceRoot]
  if (workspace !== undefined && workspace !== '') config.workspaceRoot = workspace
  const secretEnv = env[EXECUTOR_ENV.secret]
  if (secretEnv !== undefined && secretEnv !== '') config.secretEnv = secretEnv
  const agentVersion = env[EXECUTOR_ENV.agentVersion]
  if (agentVersion !== undefined && agentVersion !== '') config.agentVersion = agentVersion
  // The model a deployment runs its agents on. Stated as a pair, like the profile row the
  // overlay targets; a lone half is left for the resolver to refuse rather than guessed at.
  const agentProvider = env[EXECUTOR_ENV.agentProvider]
  if (agentProvider !== undefined && agentProvider.trim() !== '') config.agentProvider = agentProvider.trim()
  const agentModel = env[EXECUTOR_ENV.agentModel]
  if (agentModel !== undefined && agentModel.trim() !== '') config.agentModel = agentModel.trim()
  const agentBaseURL = env[EXECUTOR_ENV.agentBaseURL]
  if (agentBaseURL !== undefined && agentBaseURL.trim() !== '') config.agentBaseURL = agentBaseURL.trim()
  const agentApiKeyEnv = env[EXECUTOR_ENV.agentApiKeyEnv]
  if (agentApiKeyEnv !== undefined && agentApiKeyEnv.trim() !== '') config.agentApiKeyEnv = agentApiKeyEnv.trim()
  return config
}

/**
 * Resolve a configuration into the settings the node runs with: the endpoint, identity, roots,
 * limits, and the runner it falls back to. Absent values take this package's defaults, and the
 * two a node cannot invent — its platform and its id — are refused at the schema.
 * @param config - the configuration a profile row or an environment states.
 * @param hostname - this machine's name, used when the configuration names no host.
 * @returns the resolved settings.
 */
export function resolveExecutorSettings(config: Config, hostname: string = hostHostname()): ExecutorSettings {
  // A capacity that is not a whole number of one or more leaves a node that looks online and
  // takes nothing, or reports garbage; the schema's own bound does not reach a row a patch
  // inserts, which is where the machine's evidence came from.
  if (config.slotsTotal !== undefined && (!Number.isInteger(config.slotsTotal) || config.slotsTotal < 1)) {
    throw new TypeError(`the node's capacity must be a whole number of 1 or more, got ${String(config.slotsTotal)}`)
  }
  const endpoint = resolvePlatformEndpoint({
    host: config.platformHost,
    port: config.platformPort,
    scheme: config.platformScheme,
    basePath: config.platformBasePath,
  })
  const nodeId = config.nodeId.trim()
  if (nodeId === '') throw new TypeError('executor node id must not be blank')
  const nodeHost = config.nodeHost === undefined || config.nodeHost.trim() === '' ? hostname : config.nodeHost.trim()
  const workspaceRoot = config.workspaceRoot === undefined || config.workspaceRoot.trim() === ''
    ? process.cwd()
    : config.workspaceRoot.trim()
  const codingRoot = config.codingRoot === undefined || config.codingRoot.trim() === ''
    ? join(workspaceRoot, 'coding')
    : config.codingRoot.trim()
  // The supervised GUI points the node at its profile directory, so both
  // halves share one operator directory; a standalone node keeps it beside
  // its coding workspaces.
  const opsRoot = config.opsDir?.trim()
    || process.env[EXECUTOR_ENV.opsDir]?.trim()
    || join(codingRoot, '.ops')
  return {
    endpoint,
    nodeId,
    nodeName: config.nodeName === undefined || config.nodeName.trim() === '' ? nodeId : config.nodeName.trim(),
    nodeHost,
    workspaceRoot,
    codingRoot,
    opsRoot,
    gitUserName: config.gitUserName ?? DEFAULT_GIT_USER_NAME,
    gitUserEmail: config.gitUserEmail ?? DEFAULT_GIT_USER_EMAIL,
    maxArtifactBytes: config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    cliRunner: resolveCliRunner(config.cliRunner, workspaceRoot),
    agent: {
      provider: config.agentProvider,
      model: config.agentModel,
      baseURL: config.agentBaseURL,
      apiKeyEnv: config.agentApiKeyEnv,
    },
    slotsTotal: config.slotsTotal ?? 1,
    diskMinGb: config.diskMinGb ?? DEFAULT_DISK_MIN_GB,
    shutdownGraceSeconds: config.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS,
    heartbeatSeconds: config.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
    claimLongPollSeconds: config.claimLongPollSeconds ?? DEFAULT_CLAIM_LONG_POLL_SECONDS,
    leaseRenewSeconds: config.leaseRenewSeconds ?? DEFAULT_LEASE_RENEW_SECONDS,
    taskRuntimeSeconds: config.taskRuntimeSeconds ?? DEFAULT_TASK_RUNTIME_SECONDS,
    answerRuntimeSeconds: config.answerRuntimeSeconds ?? DEFAULT_ANSWER_RUNTIME_SECONDS,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    capabilities: {
      // The platform does not dispatch a task whose `required_capabilities` the node's
      // lanes do not cover, so a node that states none promises both work kinds it
      // ships runners for.
      lanes: config.lanes === undefined || config.lanes.length === 0
        ? [WORK_KIND_CODING, WORK_KIND_CHAT_ANSWER]
        : [...config.lanes],
      // A capability is a promise: the tools are the ones this machine has, unless a
      // deployment states the set it wants to be scheduled for.
      tools: config.tools === undefined || config.tools.length === 0 ? probeTools() : [...config.tools],
      os: platform(),
      access_modes: ['read_only', 'read_write'],
      max_artifact_bytes: DEFAULT_MAX_ARTIFACT_BYTES,
    },
    agentVersion: config.agentVersion ?? UNKNOWN_AGENT_VERSION,
    labels: { ...(config.labels ?? {}) },
    autoStart: config.autoStart ?? true,
  }
}

/**
 * Read the pre-shared node secret the configured environment variable holds.
 * @param config - the validated plugin configuration.
 * @param environment - the environment to read; defaults to the process environment.
 * @returns the secret.
 * @throws Error when the variable is unset or blank, so a node never registers with an empty credential.
 */
export function readNodeSecret(config: Config, environment: NodeJS.ProcessEnv = process.env): string {
  const name = config.secretEnv === undefined || config.secretEnv.trim() === '' ? DEFAULT_SECRET_ENV : config.secretEnv
  const value = environment[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`executor node secret is missing: set the ${name} environment variable`)
  }
  return value.trim()
}
