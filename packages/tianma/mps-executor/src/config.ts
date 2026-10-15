/**
 * Configuration for one executor node: the platform communication address it
 * dials (host and port), its identity, its capacity, and the timing budget it
 * runs with. Every value a deployment varies is a validated field here, so a node
 * is pointed at a different management platform by editing its profile row rather
 * than its code.
 * @module @tianma/dsh-mps-executor/config
 */

import { hostname as hostHostname, platform } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_PLATFORM_BASE_PATH,
  DEFAULT_PLATFORM_PORT,
  EXEC_PROTOCOL_VERSION,
  resolvePlatformEndpoint,
} from '@tianma/dsh-mps-exec-core'
import type { ExecCapabilities, PlatformEndpoint, PlatformScheme } from '@tianma/dsh-mps-exec-core'

/** Environment variable holding the pre-shared node secret when configuration names none. */
export const DEFAULT_SECRET_ENV = 'MPS_NODE_SECRET'

/** Heartbeat period the node starts with before the platform overrides it. */
export const DEFAULT_HEARTBEAT_SECONDS = 10

/** Claim long-poll budget the node starts with before the platform overrides it. */
export const DEFAULT_CLAIM_LONG_POLL_SECONDS = 25

/** Lease renewal period used until a claim states the platform's own. */
export const DEFAULT_LEASE_RENEW_SECONDS = 30

/** Runtime ceiling for one attempt, used when the task payload states none. */
export const DEFAULT_TASK_RUNTIME_SECONDS = 3 * 60 * 60

/** Budget for one ordinary platform request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Largest artifact the node uploads without chunking, in bytes. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 500 * 1024 * 1024

/** Agent version reported before the deployment states the built CLI version. */
export const UNKNOWN_AGENT_VERSION = 'unknown'

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
  /** Concurrent tasks this node accepts. */
  slotsTotal?: number
  /** Heartbeat period in seconds. */
  heartbeatSeconds?: number
  /** Claim long-poll budget in seconds. */
  claimLongPollSeconds?: number
  /** Lease renewal period in seconds, used until a claim states the platform's own. */
  leaseRenewSeconds?: number
  /** Runtime ceiling in seconds for one attempt, used when the task payload states none. */
  taskRuntimeSeconds?: number
  /** Budget for one ordinary platform request in milliseconds. */
  requestTimeoutMs?: number
  /** Work kinds this node accepts. */
  lanes?: string[]
  /** Toolchain names this node detected. */
  tools?: string[]
  /** Agent version the node reports. */
  agentVersion?: string
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
  slotsTotal: z.number().step(1).min(1).default(1),
  heartbeatSeconds: z.number().step(1).min(1).default(DEFAULT_HEARTBEAT_SECONDS),
  claimLongPollSeconds: z.number().step(1).min(1).default(DEFAULT_CLAIM_LONG_POLL_SECONDS),
  leaseRenewSeconds: z.number().step(1).min(1).max(3600).default(DEFAULT_LEASE_RENEW_SECONDS),
  taskRuntimeSeconds: z.number().step(1).min(1).default(DEFAULT_TASK_RUNTIME_SECONDS),
  requestTimeoutMs: z.number().step(1).min(1000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  lanes: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  agentVersion: z.string().default(UNKNOWN_AGENT_VERSION),
  labels: z.dict(z.string()).default({}),
  autoStart: z.boolean().default(true),
})

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
  /** Concurrent task capacity. */
  slotsTotal: number
  /** Heartbeat period in seconds. */
  heartbeatSeconds: number
  /** Claim long-poll budget in seconds. */
  claimLongPollSeconds: number
  /** Lease renewal period in seconds, before a claim states the platform's own. */
  leaseRenewSeconds: number
  /** Runtime ceiling in seconds for one attempt, before a payload states its own. */
  taskRuntimeSeconds: number
  /** Budget for one ordinary request. */
  requestTimeoutMs: number
  /** Capability promise the node registers. */
  capabilities: ExecCapabilities
  /** Agent version reported. */
  agentVersion: string
  /** Operator labels. */
  labels: Record<string, string>
  /** Whether the node starts on load. */
  autoStart: boolean
}

/**
 * Resolve one node's configuration into its runtime settings, filling the host,
 * workspace root, and name from the machine when the deployment states none.
 * @param config - the validated plugin configuration.
 * @param hostname - this machine's host name; injectable for tests.
 * @returns the resolved settings.
 */
export function resolveExecutorSettings(config: Config, hostname: string = hostHostname()): ExecutorSettings {
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
  return {
    endpoint,
    nodeId,
    nodeName: config.nodeName === undefined || config.nodeName.trim() === '' ? nodeId : config.nodeName.trim(),
    nodeHost,
    workspaceRoot,
    codingRoot: config.codingRoot === undefined || config.codingRoot.trim() === ''
      ? join(workspaceRoot, 'coding')
      : config.codingRoot.trim(),
    slotsTotal: config.slotsTotal ?? 1,
    heartbeatSeconds: config.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
    claimLongPollSeconds: config.claimLongPollSeconds ?? DEFAULT_CLAIM_LONG_POLL_SECONDS,
    leaseRenewSeconds: config.leaseRenewSeconds ?? DEFAULT_LEASE_RENEW_SECONDS,
    taskRuntimeSeconds: config.taskRuntimeSeconds ?? DEFAULT_TASK_RUNTIME_SECONDS,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    capabilities: {
      lanes: [...(config.lanes ?? [])],
      tools: [...(config.tools ?? [])],
      os: platform(),
      access_modes: ['read_write'],
      max_artifact_bytes: DEFAULT_MAX_ARTIFACT_BYTES,
      supported_protocols: [EXEC_PROTOCOL_VERSION],
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
