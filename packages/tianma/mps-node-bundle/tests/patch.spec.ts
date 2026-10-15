/**
 * The bundle patch is the deployment surface: the row it inserts names the plugin, the
 * configuration a deployment states, and the environment variables those values come from.
 * A key misspelled here is dropped by the configuration schema and silently falls back to a
 * default, which a real deployment would show as a node pointed somewhere unintended — so
 * the file is pinned rather than left to a real run to discover.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The patch this bundle ships, as the profile loader receives it. */
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/**
 * Keys one indented block of the patch states.
 * @param indent - number of leading spaces that identify the block's key lines.
 * @param within - the text to read.
 * @returns the key names, in the order they appear.
 */
function keysAt(indent: number, within: string): string[] {
  const pattern = new RegExp(`^ {${String(indent)}}([A-Za-z][A-Za-z0-9]*):`, 'gmu')
  return [...within.matchAll(pattern)].map(match => String(match[1]))
}

/**
 * The config block the executor row states.
 * @returns the block's text.
 */
function executorConfig(): string {
  const start = patch.indexOf('      config:')
  expect(start).toBeGreaterThan(-1)
  return patch.slice(start)
}

describe('the profile bundle patch a deployment runs', () => {
  it('mounts the startup row and the executor row', () => {
    expect(patch).toContain("- id: mps-executor-startup\n      name: '@tianma/dsh-mps-executor/startup'")
    expect(patch).toContain("- id: mps-executor\n      name: '@tianma/dsh-mps-executor'\n      config:")
  })

  it('states the configuration fields a deployment sets, and only those', () => {
    // The set is the deployment's surface: an addition is a decision, and a misspelling is
    // a value that never arrives.
    expect(keysAt(8, executorConfig())).toEqual([
      'platformHost',
      'platformPort',
      'platformScheme',
      'platformBasePath',
      'nodeId',
      'nodeName',
      'nodeHost',
      'secretEnv',
      'workspaceRoot',
      'slotsTotal',
      'lanes',
      'tools',
      'agentVersion',
      'labels',
      'autoStart',
      'cliRunner',
    ])
  })

  it('takes the platform address from the environment, and never starts without one', () => {
    // The address is what this bundle exists to point at, and a node that guessed one would
    // register with a platform nobody meant.
    expect(patch).toContain("platformHost: !!js process.env.MPS_PLATFORM_HOST ?? '127.0.0.1'")
    expect(patch).toContain('platformPort: !!js Number(process.env.MPS_PLATFORM_PORT ?? 8791)')
    expect(patch).toContain("platformScheme: !!js process.env.MPS_PLATFORM_SCHEME ?? 'http'")
    expect(patch).toContain("platformBasePath: !!js process.env.MPS_PLATFORM_BASE_PATH ?? '/exec/v1'")
    expect(patch).toContain('autoStart: !!js Boolean(process.env.MPS_PLATFORM_HOST)')
  })

  it('names every environment variable a deployment is expected to state', () => {
    const named = new Set([...patch.matchAll(/process\.env\.([A-Z0-9_]+)/gu)].map(match => String(match[1])))
    expect([...named].sort()).toEqual([
      'MPS_AGENT_VERSION',
      'MPS_DSH_BIN',
      'MPS_DSH_HOME',
      'MPS_NODE_HOST',
      'MPS_NODE_ID',
      'MPS_NODE_NAME',
      'MPS_NODE_SLOTS',
      'MPS_NODE_WORKSPACE',
      'MPS_PLATFORM_BASE_PATH',
      'MPS_PLATFORM_HOST',
      'MPS_PLATFORM_PORT',
      'MPS_PLATFORM_SCHEME',
    ])
    // The secret is named as the variable to read, never as a value in the file.
    expect(patch).toContain('secretEnv: MPS_NODE_SECRET')
  })

  it('runs the CLI it ships with, as one command the host can start', () => {
    expect(keysAt(10, executorConfig())).toEqual(['command', 'dshHome', 'jsonEvents'])
    expect(patch).toContain("command: !!js [process.env.MPS_DSH_BIN ?? 'dsh', '--profile', 'headless']")
    expect(patch).toContain('jsonEvents: true')
  })
})
