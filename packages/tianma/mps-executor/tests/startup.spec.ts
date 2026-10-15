/**
 * The node profile's command line: it documents the environment a deployment
 * states, and mounting it without arguments leaves the node running rather than
 * failing the invocation.
 */

import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { describeConfig, apply, inject, name, nodeCommand } from '@tianma/dsh-mps-executor/startup'

describe('node command line', () => {
  it('owns the profile help and names the environment a node needs', () => {
    const written: string[] = []
    const program = nodeCommand().configureOutput({ writeOut: (text: string) => { written.push(text) } })
    program.outputHelp()
    const help = written.join('')
    expect(help).toContain('Usage: dsh mps-node')
    expect(help).toContain('-h, --help')
    for (const variable of [
      'MPS_PLATFORM_HOST',
      'MPS_PLATFORM_PORT',
      'MPS_PLATFORM_SCHEME',
      'MPS_PLATFORM_BASE_PATH',
      'MPS_NODE_ID',
      'MPS_NODE_SECRET',
      'MPS_NODE_SLOTS',
      'MPS_NODE_WORKSPACE',
    ]) {
      expect(help).toContain(variable)
    }
    expect(nodeCommand().helpInformation()).toContain('Usage: dsh mps-node')
  })

  it('declares the readout and no other option', () => {
    // The node is configured by its profile row; the one option reports what that row
    // resolves, so a deployment can confirm the address before starting the node.
    expect(nodeCommand().options.map(option => option.long)).toEqual(['--show-config'])
  })

  it('mounts the command line under the launcher adapter', () => {
    const exits: number[] = []
    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: (code: number) => { exits.push(code) } })
    expect(() => { apply(ctx) }).not.toThrow()
    expect(exits).toEqual([])
    expect(name).toBe('mps-executor-startup')
    expect(inject).toEqual(['cmdlineArgs'])
  })
})

describe('asking the command line for the readout', () => {
  it('prints the readout and exits 0 instead of starting the node', () => {
    vi.stubEnv('MPS_PLATFORM_HOST', '10.11.12.13')
    vi.stubEnv('MPS_PLATFORM_PORT', '9443')
    vi.stubEnv('MPS_NODE_ID', 'node-demo')
    vi.stubEnv('MPS_NODE_SECRET', 'super-secret-value')
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    const exits: number[] = []
    try {
      nodeCommand((code) => { exits.push(code) }).parse(['--show-config'], { from: 'user' })
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }

    const text = written.join('')
    expect(text).toContain('http://10.11.12.13:9443/exec/v1/register')
    expect(text).not.toContain('super-secret-value')
    expect(exits).toEqual([0])
  })

  it('reports a missing address through the launcher rather than hanging', () => {
    // Found by running the real profile: a plain throw left the machine sitting there.
    const exits: number[] = []
    expect(() => {
      // exitOverride is what the launcher installs: without it commander would end the
      // process here instead of raising the error the launcher turns into an exit code.
      nodeCommand((code) => { exits.push(code) })
        .exitOverride()
        .parse(['--show-config'], { from: 'user' })
    }).toThrow(/MPS_PLATFORM_HOST is required/u)
  })
})

describe('answering what this machine will dial', () => {
  it('resolves the address and identity from the environment, and names the secret without printing it', () => {
    const lines = describeConfig({
      MPS_PLATFORM_HOST: '10.11.12.13',
      MPS_PLATFORM_PORT: '9443',
      MPS_PLATFORM_SCHEME: 'https',
      MPS_PLATFORM_BASE_PATH: '/exec/v1',
      MPS_NODE_ID: 'node-demo',
      MPS_NODE_NAME: 'demo',
      MPS_NODE_HOST: 'demo-host',
      MPS_NODE_SLOTS: '4',
      MPS_NODE_WORKSPACE: '/srv/node',
      MPS_NODE_SECRET: 'MPS_NODE_SECRET',
    })

    expect(lines).toContain('endpoint             https://10.11.12.13:9443/exec/v1/register')
    expect(lines).toContain('node id              node-demo')
    expect(lines).toContain('node name            demo')
    expect(lines).toContain('node host            demo-host')
    expect(lines).toContain('slots                4')
    expect(lines).toContain('workspace root       /srv/node')
    expect(lines).toContain(`coding root          ${join('/srv/node', 'coding')}`)
    expect(lines).toContain('secret               from MPS_NODE_SECRET (value not printed)')
    expect(lines).not.toContain('super-secret-value')
  })

  it('refuses to resolve an address when the platform or the identity is unstated', () => {
    // The profile row refuses these too: a node must not dial somewhere it was not sent.
    expect(() => describeConfig({ MPS_NODE_ID: 'node-demo' })).toThrow(/MPS_PLATFORM_HOST is required/u)
    expect(() => describeConfig({ MPS_PLATFORM_HOST: '10.11.12.13' })).toThrow(/MPS_NODE_ID is required/u)
  })

  it('takes the defaults a machine that states only the required two would use', () => {
    const lines = describeConfig({ MPS_PLATFORM_HOST: 'platform.example', MPS_NODE_ID: 'node-demo' })

    expect(lines).toContain('endpoint             http://platform.example:8791/exec/v1/register')
    expect(lines).toContain('slots                1')
    expect(lines).toContain('secret               from MPS_NODE_SECRET (value not printed)')
  })
})
