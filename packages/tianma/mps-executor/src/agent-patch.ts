/**
 * The model a node's agent runs start on, and the overlay that states it. A profile's
 * default lives in its `agent-default-model` row; a deployment that runs agents on its own
 * machine states a provider and model here, and the node hands each run an overlay applied
 * after the profile layer — so one node's choice holds whatever a person selected in
 * another surface that shares the same home.
 * @module @tianma/dsh-mps-executor/agent-patch
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What a deployment states about the model its agent runs start on. */
export interface AgentModelChoice {
  /** Registered provider route, such as `deepseek-official`. */
  provider?: string | undefined
  /** Provider-owned model id, such as `deepseek-v4-pro`. */
  model?: string | undefined
  /** Messages-compatible endpoint, when the deployment routes through a gateway. */
  baseURL?: string | undefined
  /** Environment variable the credential is read from, when it is not the adapter's default. */
  apiKeyEnv?: string | undefined
}

/** File the node writes its overlay to, beside the raw logs and outside every workspace. */
export const AGENT_PATCH_FILENAME = 'agent-model.patch.yml'

/**
 * The overlay one deployment's choice resolves to.
 * @param choice - the provider, model, endpoint, and credential reference stated.
 * @returns the patch-list overlay, or undefined when the deployment states nothing and the
 * profile's own default stands.
 * @throws TypeError when only one of provider and model is stated, because the
 * default-model row requires the pair and half a route would fail at the first run.
 */
export function agentModelPatch(choice: AgentModelChoice): string | undefined {
  const provider = text(choice.provider)
  const model = text(choice.model)
  const baseURL = text(choice.baseURL)
  const apiKeyEnv = text(choice.apiKeyEnv)
  if (provider === undefined && model === undefined && baseURL === undefined && apiKeyEnv === undefined) {
    return undefined
  }
  if ((provider === undefined) !== (model === undefined)) {
    throw new TypeError('a node that chooses its agent model states both provider and model: the default-model row requires the pair')
  }
  const rows: string[] = []
  if (provider !== undefined && model !== undefined) {
    rows.push([
      '- id: agent-default-model',
      '  config:',
      `    provider: ${scalar(provider)}`,
      `    model: ${scalar(model)}`,
    ].join('\n'))
  }
  // The endpoint and the credential reference belong to the adapter row, which is where a
  // gateway deployment names them; without them the profile's own adapter settings stand.
  const adapter: string[] = []
  if (baseURL !== undefined) adapter.push(`    baseURL: ${scalar(baseURL)}`)
  if (apiKeyEnv !== undefined) adapter.push(`    apiKeyEnv: ${scalar(apiKeyEnv)}`)
  if (adapter.length > 0) rows.push(['- id: llm-deepseek', '  config:', ...adapter].join('\n'))
  return `${rows.join('\n')}\n`
}

/**
 * Write the overlay where the node keeps its own files and answer the path the run gets.
 * @param directory - the directory the node keeps its raw logs under.
 * @param patch - the overlay text.
 * @returns the overlay's path.
 */
export function writeAgentPatch(directory: string, patch: string): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, AGENT_PATCH_FILENAME)
  writeFileSync(path, patch, 'utf8')
  return path
}

/**
 * One stated value, or undefined when it says nothing.
 * @param value - the stated value.
 * @returns the trimmed value, or undefined.
 */
function text(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * One YAML scalar. A JSON string is also a YAML double-quoted scalar, so a value carrying a
 * colon, a quote, or a leading indicator character is written as itself.
 * @param value - the value to write.
 * @returns the scalar as YAML.
 */
function scalar(value: string): string {
  return JSON.stringify(value)
}
