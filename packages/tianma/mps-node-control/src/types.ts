/**
 * The vocabulary the node-control surface renders: where the supervised process
 * stands, how its last run ended, and the lines it printed.
 *
 * Every field crosses the Host/Client boundary through the generated Typert
 * Remote projection, so all of them are JSON-representable.
 *
 * @module @tianma/dsh-mps-node-control/types
 */

/** Where the supervised node process stands. */
export type MpsNodePhase =
  /** No process is running. */
  | 'stopped'
  /** A launch is in flight. */
  | 'starting'
  /** The process is running. */
  | 'running'
  /** The launch itself failed, so the process never ran. */
  | 'failed'

/** How one node process ended. */
export interface MpsNodeExit {
  /** Exit code the host reported; null when a signal ended it. */
  code: number | null
  /** Signal that ended it, when one did. */
  signal: string | null
  /** When it ended, as an RFC 3339 string. */
  at: string
}

/** One reading of the supervised node process. */
export interface MpsNodeStatus {
  /** Where the process stands now. */
  phase: MpsNodePhase
  /** Profile this entry launches. */
  profile: string
  /** Process id while one is running. */
  pid?: number | undefined
  /** When the running process started, as an RFC 3339 string. */
  startedAt?: string | undefined
  /** How the last process ended, once one has. */
  exit?: MpsNodeExit | undefined
  /**
   * Why the last launch failed, when it could not start at all. The process
   * that never ran has no exit to report, so this is the only account of it.
   */
  error?: string | undefined
}

/** One line the node printed. */
export interface MpsNodeLogLine {
  /** Stream the line arrived on. */
  stream: 'stdout' | 'stderr'
  /** When the node received it, as an RFC 3339 string. */
  at: string
  /** The line itself, without its terminator. */
  text: string
}

/**
 * The deployment parameters the Settings form edits. Every field is optional:
 * an unset field falls back to the environment this GUI was started with, and
 * the node's own bundle patch supplies the last-resort defaults. The node
 * secret is deliberately absent — it rides the `MPS_NODE_SECRET` environment
 * variable a deployment states, never a file this page writes.
 */
export interface MpsNodeDeployment {
  /** Platform host the node registers with, such as `mps.example.com`. */
  platformHost?: string | undefined
  /** Platform port; 1–65535. */
  platformPort?: number | undefined
  /** Platform scheme. */
  platformScheme?: 'http' | 'https' | undefined
  /** Platform base path of the exec API. */
  platformBasePath?: string | undefined
  /** Node id the platform knows this node by. */
  nodeId?: string | undefined
  /** Node name shown on the platform. */
  nodeName?: string | undefined
  /** Host the platform dials this node on, when it dials the node directly. */
  nodeHost?: string | undefined
  /** Root directory the node works its tasks in. */
  workspaceRoot?: string | undefined
  /** How many workspaces the node can hold at once; at least 1. */
  slotsTotal?: number | undefined
}

/** Where one effective deployment value came from. */
export type MpsNodeConfigSource =
  /** Written through the Settings form, stored beside the profile. */
  | 'saved'
  /** Inherited from the environment this GUI was started with. */
  | 'environment'
  /** The protocol's own default, shown so a blank field never reads as missing. */
  | 'default'
  /** Neither: the node falls back to its own bundle defaults. */
  | 'unset'

/** One effective deployment value: a display string plus its origin. */
export interface MpsNodeConfigEntry {
  /** The value as the settings surface shows it, or nothing when unset. */
  value?: string | undefined
  /** Where the value comes from. */
  source: MpsNodeConfigSource
}

/** The deployment-parameter reading the Settings form renders. */
export interface MpsNodeConfig {
  /** What this page has saved; each field may be unset. */
  saved: MpsNodeDeployment
  /** What the next launch would run with, per field. */
  effective: {
    platformHost: MpsNodeConfigEntry
    platformPort: MpsNodeConfigEntry
    platformScheme: MpsNodeConfigEntry
    platformBasePath: MpsNodeConfigEntry
    nodeId: MpsNodeConfigEntry
    nodeName: MpsNodeConfigEntry
    nodeHost: MpsNodeConfigEntry
    workspaceRoot: MpsNodeConfigEntry
    slotsTotal: MpsNodeConfigEntry
  }
}

/**
 * What the form submits: one text field per deployment parameter, so a number
 * arrives as the string the input held and an empty string means "clear this
 * field". Plain optional members rather than a `Record` over the deployment
 * keys: the Remote wire schema is generated from this shape.
 */
export interface MpsNodeForm {
  platformHost?: string | undefined
  platformPort?: string | undefined
  platformScheme?: string | undefined
  platformBasePath?: string | undefined
  nodeId?: string | undefined
  nodeName?: string | undefined
  nodeHost?: string | undefined
  workspaceRoot?: string | undefined
  slotsTotal?: string | undefined
}

/** What one connectivity probe found, in the form's own words to show. */
export interface MpsNodeProbeResult {
  /** Whether the platform answered at all; any HTTP status means it did. */
  reachable: boolean
  /** HTTP status the platform answered with, when it answered. */
  httpStatus?: number | undefined
  /** How long the answer took, in milliseconds, when one arrived. */
  latencyMs?: number | undefined
  /** What happened, as the settings surface shows it. */
  detail: string
}
