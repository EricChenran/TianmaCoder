/**
 * The bundle patch is the deployment surface: the row it inserts names the plugin, the
 * configuration a deployment states, and the environment variables those values come from.
 * A key misspelled here is dropped by the configuration schema and silently falls back to a
 * default, which a real deployment would show as a node pointed somewhere unintended — so
 * the file is pinned rather than left to a real run to discover.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXECUTOR_ENV } from '@tianma/dsh-mps-executor'

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
      'opsDir',
      'slotsTotal',
      'lanes',
      'tools',
      'agentVersion',
      'labels',
      'autoStart',
      'cliRunner',
    ])
    // The runner's own keys live inside the scripted value, pinned separately below.
  })

  it('takes the platform address from the environment, and never starts without one', () => {
    // The address is what this bundle exists to point at, and a node that guessed one would
    // register with a platform nobody meant.
    expect(patch).toContain("platformHost: !!js process.env.MPS_PLATFORM_HOST ?? '127.0.0.1'")
    expect(patch).toContain('platformPort: !!js Number(process.env.MPS_PLATFORM_PORT ?? 8791)')
    expect(patch).toContain("platformScheme: !!js process.env.MPS_PLATFORM_SCHEME ?? 'http'")
    expect(patch).toContain("platformBasePath: !!js process.env.MPS_PLATFORM_BASE_PATH ?? '/exec/v1'")
    expect(patch).toContain('autoStart: !!js Boolean(process.env.MPS_PLATFORM_HOST || process.env.MPS_JOIN)')
  })

  it('names every environment variable a deployment is expected to state', () => {
    const named = new Set([...patch.matchAll(/process\.env\.([A-Z0-9_]+)/gu)].map(match => String(match[1])))
    expect([...named].sort()).toEqual([
      'MPS_AGENT_VERSION',
      'MPS_DSH_BIN',
      'MPS_DSH_HOME',
      'MPS_JOIN',
      'MPS_NODE_HOST',
      'MPS_NODE_ID',
      'MPS_NODE_NAME',
      'MPS_NODE_OPS_DIR',
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
    expect(patch).toContain('cliRunner: !!js ')
    expect(patch).toContain("command: [process.env.MPS_DSH_BIN ?? 'dsh', '--profile', 'headless']")
    expect(patch).toContain("dshHome: process.env.MPS_DSH_HOME ?? ''")
    expect(patch).toContain('jsonEvents: true')
  })

  it('reads exactly the environment the executor names, so a readout cannot lie', () => {
    // The row and `--show-config` both read these names; a name in one and not the other is
    // how a readout came to report an image's version as unknown.
    const inPatch = [...new Set([...patch.matchAll(/MPS_[A-Z_]+/gu)].map(match => match[0]))].sort()
    expect(inPatch).toEqual([...Object.values(EXECUTOR_ENV)].sort())
  })

  it('writes scripted values the overlay parser accepts', () => {
    // Two ways a node loaded without its executor at all: a scripted value nested inside a
    // nested mapping is refused as an unknown tag, and an unquoted one holding a colon and a
    // space reads as a mapping of its own. Both are shapes this file must never take, and
    // both were found by launching the profile rather than by reading the file.
    const scripted = patch.split('\n').filter(line => line.includes('!!js '))
    expect(scripted.length).toBeGreaterThan(5)
    for (const line of scripted) {
      const indent = line.length - line.trimStart().length
      const value = line.slice(line.indexOf('!!js ') + '!!js '.length)
      expect([8], `scripted value is a direct configuration field: ${line.trim()}`).toContain(indent)
      if (value.includes(': ')) {
        expect(value.startsWith('"'), `scripted value holding a colon is quoted: ${line.trim()}`).toBe(true)
      }
    }
  })
})
