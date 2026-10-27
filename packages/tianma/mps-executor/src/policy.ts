/**
 * The policy knobs a management platform owns: how much work this node may take, which
 * kinds it serves, the disk floor it keeps, the ceilings its attempts run under, and the
 * model its agent runs start on. A node states its own values as the fallback and reports
 * the facts (hardware, tools); the platform's `/config` states the values that hold. This
 * module holds that boundary: one effective view, the reader that folds a `/config`
 * payload into it, and the snapshot the settings surface reads.
 * @module @tianma/dsh-mps-executor/policy
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentModelChoice } from './agent-patch.ts'
import type { ExecutorSettings } from './config.ts'

/** The policy values in force, however they were sourced. */
export interface EffectivePolicy {
  /** Concurrent coding attempts this node accepts. */
  slotsTotal: number
  /** Work kinds this node claims. */
  lanes: string[]
  /** Free-disk floor in GB below which this node claims nothing. */
  diskMinGb: number
  /** Runtime ceiling for one coding attempt, in seconds. */
  taskRuntimeSeconds: number
  /** Runtime ceiling for one chat-answer attempt, in seconds; zero follows the lease. */
  answerRuntimeSeconds: number
  /** The model this node's agent runs start on, when a policy chose one. */
  agent: AgentModelChoice
}

/** The snapshot this node writes under its operator directory once a policy applies. */
export interface PolicySnapshot {
  /** When the platform stated this policy, as an RFC 3339 string. */
  at: string
  /** The configuration revision the policy arrived under. */
  configRevision: number
  /** The values in force. */
  policy: EffectivePolicy
}

/** File the runtime keeps its applied policy in, inside the operator directory. */
export const POLICY_SNAPSHOT_FILE = 'policy.json'

/**
 * The policy a node starts with: its own configured values, which hold until the platform
 * states others.
 * @param settings - the node's resolved settings.
 * @returns the starting policy.
 */
export function policyFromSettings(settings: ExecutorSettings): EffectivePolicy {
  return {
    slotsTotal: settings.slotsTotal,
    lanes: [...settings.capabilities.lanes],
    diskMinGb: settings.diskMinGb,
    taskRuntimeSeconds: settings.taskRuntimeSeconds,
    answerRuntimeSeconds: settings.answerRuntimeSeconds,
    agent: { ...settings.agent },
  }
}

/** Read one non-empty trimmed string off a payload object, or undefined. */
function textOf(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read one whole-number field bounded below, or undefined when the payload states none usable. */
function intOf(source: Record<string, unknown>, key: string, minimum: number): number | undefined {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) return undefined
  return value
}

/**
 * Fold one `/config` payload into a policy: every key the platform stated usefully
 * replaces the value in force, and the rest — absent keys, unusable values — leaves the
 * node's own value standing.
 * @param policy - the policy in force.
 * @param stated - the `/config` payload.
 * @returns the policy to hold, and the names of the keys that changed it.
 */
export function applyPlatformPolicy(
  policy: EffectivePolicy,
  stated: Record<string, unknown>,
): { policy: EffectivePolicy; applied: string[] } {
  const next: EffectivePolicy = { ...policy, lanes: [...policy.lanes], agent: { ...policy.agent } }
  const applied: string[] = []
  const slots = intOf(stated, 'slots_total', 1)
  if (slots !== undefined && slots !== next.slotsTotal) {
    next.slotsTotal = slots
    applied.push('slots_total')
  }
  const lanes = stated['lanes']
  if (Array.isArray(lanes) && lanes.length > 0 && lanes.every(lane => typeof lane === 'string' && lane.trim() !== '')) {
    const statedLanes = lanes.map(lane => (lane as string).trim())
    if (statedLanes.join('\u0000') !== next.lanes.join('\u0000')) {
      next.lanes = statedLanes
      applied.push('lanes')
    }
  }
  const disk = intOf(stated, 'disk_min_gb', 0)
  if (disk !== undefined && disk !== next.diskMinGb) {
    next.diskMinGb = disk
    applied.push('disk_min_gb')
  }
  const taskRuntime = intOf(stated, 'task_runtime_seconds', 60)
  if (taskRuntime !== undefined && taskRuntime !== next.taskRuntimeSeconds) {
    next.taskRuntimeSeconds = taskRuntime
    applied.push('task_runtime_seconds')
  }
  const answerRuntime = intOf(stated, 'answer_runtime_seconds', 0)
  if (answerRuntime !== undefined && answerRuntime !== next.answerRuntimeSeconds) {
    next.answerRuntimeSeconds = answerRuntime
    applied.push('answer_runtime_seconds')
  }
  const agentDefault = stated['agent_default']
  if (typeof agentDefault === 'object' && agentDefault !== null && !Array.isArray(agentDefault)) {
    const record = agentDefault as Record<string, unknown>
    // The pair is stated together or not at all: half a route cannot be applied, and the
    // node's own value stands until the platform states a whole one.
    const provider = textOf(record, 'provider')
    const model = textOf(record, 'model')
    if (provider !== undefined && model !== undefined
      && (provider !== next.agent.provider || model !== next.agent.model)) {
      next.agent = { ...next.agent, provider, model }
      applied.push('agent_default')
    }
  }
  return { policy: next, applied }
}

/**
 * A one-line summary of one policy, for the report that says a configuration applied.
 * None of these values is a credential.
 * @param policy - the policy in force.
 * @returns the summary.
 */
export function describePolicy(policy: EffectivePolicy): string {
  const agent = policy.agent.provider === undefined || policy.agent.model === undefined
    ? ''
    : ` agent=${policy.agent.provider}/${policy.agent.model}`
  return `slots=${String(policy.slotsTotal)} lanes=${policy.lanes.join('|')} diskFloor=${String(policy.diskMinGb)}GB taskCeiling=${String(policy.taskRuntimeSeconds)}s answerCeiling=${String(policy.answerRuntimeSeconds)}s${agent}`
}

/**
 * Write the policy snapshot the settings surface reads. Best effort: a snapshot this node
 * cannot keep costs the surface its readout, never the node its policy, so a failure is
 * the caller's to report and swallow.
 * @param opsRoot - the operator directory the snapshot lives in.
 * @param snapshot - what to write.
 * @throws the filesystem error that stopped the write.
 */
export function writePolicySnapshot(opsRoot: string, snapshot: PolicySnapshot): void {
  mkdirSync(opsRoot, { recursive: true })
  writeFileSync(join(opsRoot, POLICY_SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

/**
 * Read the policy snapshot a node wrote, when one exists.
 * @param opsRoot - the operator directory the snapshot lives in.
 * @returns the snapshot, or undefined when no readable snapshot is there.
 */
export function readPolicySnapshot(opsRoot: string): PolicySnapshot | undefined {
  let text: string
  try {
    text = readFileSync(join(opsRoot, POLICY_SNAPSHOT_FILE), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const policy = record['policy']
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return undefined
  const values = policy as Record<string, unknown>
  const snapshot: PolicySnapshot = {
    at: typeof record['at'] === 'string' ? record['at'] : '',
    configRevision: typeof record['configRevision'] === 'number' && Number.isFinite(record['configRevision'])
      ? record['configRevision']
      : 0,
    policy: {
      slotsTotal: typeof values['slotsTotal'] === 'number' && Number.isInteger(values['slotsTotal']) && values['slotsTotal'] >= 1
        ? values['slotsTotal']
        : 1,
      lanes: Array.isArray(values['lanes']) && values['lanes'].every(lane => typeof lane === 'string')
        ? values['lanes'].map(lane => lane as string)
        : [],
      diskMinGb: typeof values['diskMinGb'] === 'number' && Number.isFinite(values['diskMinGb']) && values['diskMinGb'] >= 0
        ? values['diskMinGb']
        : 0,
      taskRuntimeSeconds: typeof values['taskRuntimeSeconds'] === 'number' && Number.isInteger(values['taskRuntimeSeconds']) && values['taskRuntimeSeconds'] >= 1
        ? values['taskRuntimeSeconds']
        : 1,
      answerRuntimeSeconds: typeof values['answerRuntimeSeconds'] === 'number' && Number.isInteger(values['answerRuntimeSeconds']) && values['answerRuntimeSeconds'] >= 0
        ? values['answerRuntimeSeconds']
        : 0,
      agent: typeof values['agent'] === 'object' && values['agent'] !== null && !Array.isArray(values['agent'])
        ? {
          provider: textOf(values['agent'] as Record<string, unknown>, 'provider'),
          model: textOf(values['agent'] as Record<string, unknown>, 'model'),
        }
        : {},
    },
  }
  return snapshot
}
