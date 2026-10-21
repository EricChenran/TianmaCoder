/**
 * The overlay a deployment's model choice resolves to: nothing when the deployment states
 * nothing, the default-model row it chooses, the adapter row when it names a gateway, and
 * a refusal for half a route — which would otherwise fail at the first run instead of at
 * load.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_PATCH_FILENAME, agentModelPatch, writeAgentPatch } from '@tianma/dsh-mps-executor'

describe('stating the model a node runs on', () => {
  it('states nothing when the deployment chose nothing', () => {
    expect(agentModelPatch({})).toBeUndefined()
    expect(agentModelPatch({ provider: '  ', model: '', baseURL: ' ', apiKeyEnv: '' })).toBeUndefined()
  })

  it('writes the default-model row the deployment chose', () => {
    expect(agentModelPatch({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })).toBe([
      '- id: agent-default-model',
      '  config:',
      '    provider: "deepseek-official"',
      '    model: "deepseek-v4-pro"',
      '',
    ].join('\n'))
  })

  it('routes the adapter when the deployment names a gateway or another credential', () => {
    expect(agentModelPatch({ baseURL: 'https://gateway.example/anthropic', apiKeyEnv: 'ACME_KEY' })).toBe([
      '- id: llm-deepseek',
      '  config:',
      '    baseURL: "https://gateway.example/anthropic"',
      '    apiKeyEnv: "ACME_KEY"',
      '',
    ].join('\n'))
  })

  it('refuses half a route, which the default-model row cannot load', () => {
    expect(() => agentModelPatch({ provider: 'deepseek-official' })).toThrow(/both provider and model/u)
    expect(() => agentModelPatch({ model: 'deepseek-v4-pro' })).toThrow(/both provider and model/u)
  })

  it('writes the overlay outside the workspaces, where the run reads it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mps-patch-'))
    try {
      const patch = agentModelPatch({ provider: 'deepseek-official', model: 'deepseek-flash' }) ?? ''

      const path = writeAgentPatch(join(directory, 'logs'), patch)

      expect(path.endsWith(AGENT_PATCH_FILENAME)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(patch)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
