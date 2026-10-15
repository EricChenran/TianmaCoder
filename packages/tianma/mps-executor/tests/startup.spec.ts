/**
 * The node profile's command line: it documents the environment a deployment
 * states, and mounting it without arguments leaves the node running rather than
 * failing the invocation.
 */

import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { describe, expect, it } from 'vitest'
import { apply, inject, name, nodeCommand } from '@tianma/dsh-mps-executor/startup'

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

  it('declares no options of its own', () => {
    expect(nodeCommand().options).toEqual([])
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
