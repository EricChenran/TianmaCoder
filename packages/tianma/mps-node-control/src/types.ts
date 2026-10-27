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
 * The deployment parameters the Settings form edits. Every field is optional: an unset
 * field falls back to the environment this GUI was started with, and the node's own
 * bundle patch supplies the last-resort defaults.
 *
 * The join string is the one a deployment normally states: a single value from the
 * platform console that carries the address and this node's identity, secret included.
 * The older single-purpose fields remain readable so a saved file from before the join
 * string keeps working, but the form no longer edits them.
 */
export interface MpsNodeDeployment {
  /**
   * Join string from the platform console, such as
   * `http://mps.example.com:8791/exec/v1#node=node-3f2a&secret=…`; injected as
   * `MPS_JOIN` at the next launch. Stating one replaces the address, the node id,
   * and the stored secret in a single value.
   */
  join?: string | undefined
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
  /**
   * Provider route the node's agent runs start on, such as `deepseek-official`, injected
   * as `MPS_AGENT_PROVIDER` at the next launch. Stated together with
   * {@link MpsNodeDeployment.agentModel}, it gives every task on this node its own default
   * instead of the profile's, while the credential stays shared with the same home.
   */
  agentProvider?: string | undefined
  /** Model id those runs start on, such as `deepseek-v4-pro`; injected as `MPS_AGENT_MODEL`. */
  agentModel?: string | undefined
  /** How many workspaces the node can hold at once; at least 1. */
  slotsTotal?: number | undefined
  /**
   * Proxy the node's own git and network calls go through, such as
   * `http://127.0.0.1:7897`; injected as `HTTPS_PROXY`/`HTTP_PROXY` at the next
   * launch, with the platform's own host kept off the proxy.
   */
  networkProxy?: string | undefined
  /**
   * The node's platform secret, injected as `MPS_NODE_SECRET` at the next
   * launch. Stored beside the profile and never echoed back to the settings
   * surface: reads report only whether it is set.
   */
  nodeSecret?: string | undefined
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

/** The policy the platform stated over `/config`, as the node's snapshot recorded it. */
export interface MpsNodePlatformPolicy {
  /** Concurrent coding attempts the platform allows this node; absent until a snapshot exists. */
  slotsTotal?: number | undefined
  /** Work kinds the platform allows this node to claim. */
  lanes?: string[] | undefined
  /** Provider route the platform stated for this node's agent runs. */
  agentProvider?: string | undefined
  /** Model id the platform stated for those runs. */
  agentModel?: string | undefined
  /** Configuration revision the policy arrived under; 0 when the snapshot states none. */
  configRevision?: number | undefined
  /** When the node applied this policy, as an RFC 3339 string. */
  at?: string | undefined
}

/** The deployment-parameter reading the Settings form renders. */
export interface MpsNodeConfig {
  /**
   * What this page has saved, each field possibly unset. The join string's secret and
   * the stored node secret are never part of this copy: they are reported only as
   * {@link secretSet}.
   */
  saved: MpsNodeDeployment
  /** Whether a join string is stored for the next launch, and where it comes from. */
  joinSet: MpsNodeConfigSource
  /**
   * What the stored join string states, with the secret left out: the address the node
   * will dial and the id it will use. Absent when no join string is stored.
   */
  joinSummary?: { url: string; nodeId: string } | undefined
  /** Whether a secret is stored for the next launch, and where it comes from. */
  secretSet: MpsNodeConfigSource
  /**
   * This machine's LAN IPv4 addresses, so the operator can see which subnet
   * the node sits on and check it against the platform's address.
   */
  lanAddresses: string[]
  /** The policy the platform stated, as the node's own snapshot recorded it. */
  platformPolicy: MpsNodePlatformPolicy
  /** What the next launch would run with, per field the form edits. */
  effective: {
    workspaceRoot: MpsNodeConfigEntry
    networkProxy: MpsNodeConfigEntry
  }
}

/**
 * What the form submits: one text field per deployment parameter the form edits, so a
 * number arrives as the string the input held and an empty string means "clear this
 * field". Plain optional members rather than a `Record` over the deployment keys: the
 * Remote wire schema is generated from this shape.
 */
export interface MpsNodeForm {
  join?: string | undefined
  workspaceRoot?: string | undefined
  networkProxy?: string | undefined
  nodeSecret?: string | undefined
  /**
   * Explicit instruction to drop the stored secret. A blank `nodeSecret` on
   * its own keeps what is stored, so saving unrelated fields never wipes the
   * credential; only `'true'` here does.
   */
  clearNodeSecret?: string | undefined
}

/** How the connectivity probe failed, when it did; each kind names its own next step. */
export type MpsNodeProbeKind = 'dns-failed' | 'refused' | 'timeout' | 'answered' | 'unreachable'

/** What one connectivity probe found, in the form's own words to show. */
export interface MpsNodeProbeResult {
  /** Whether the platform answered at all; any HTTP status means it did. */
  reachable: boolean
  /** How the attempt ended, so the surface can word the next step per kind. */
  kind: MpsNodeProbeKind
  /** HTTP status the platform answered with, when it answered. */
  httpStatus?: number | undefined
  /** How long the answer took, in milliseconds, when one arrived. */
  latencyMs?: number | undefined
  /** What happened, as the settings surface shows it. */
  detail: string
  /**
   * Whether the probed address is this machine's own loopback, which in a
   * production deployment means the node is dialing itself, not the platform.
   */
  loopback?: boolean | undefined
}

/** One task the node took, as the settings surface reads it back. */
export interface MpsNodeTaskView {
  /** Protocol task id, which is the platform's work-item id. */
  task_id: string
  /** Work-item kind as the platform dispatched it. */
  kind: string
  /** Attempt number of the latest line. */
  attempt: number
  /** Whether the latest line is a claim still running here. */
  running: boolean
  /** Whether the latest line says an operator holds the task. */
  held: boolean
  /** When the latest line was written, as an RFC 3339 string. */
  at: string
  /** Outcome of a settled attempt. */
  outcome?: string | undefined
  /** Operator-visible summary of a settled attempt. */
  summary?: string | undefined
  /** Session reference the attempt used, once one was reported. */
  session?: string | undefined
  /** Directory the attempt worked in, when it worked in one. */
  workspace?: string | undefined
}

/** What one operator command asked for. */
export interface MpsNodeTaskCommand {
  /** The command: cancel the task, take it over, or finish a held one. */
  action: 'cancel' | 'takeover' | 'complete'
  /** The task it addresses. */
  task_id: string
  /** What a completed takeover wants the result to say. */
  summary?: string | undefined
}
