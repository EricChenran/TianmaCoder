/**
 * The capabilities a node reports are probed from the machine it runs on, because the
 * platform schedules on them: what the node says it can do has to be what it can do.
 */

import { describe, expect, it } from 'vitest'
import { PROBED_TOOLS, probeAgentVersion, probeTools, versionFrom } from '@tianma/dsh-mps-executor'

describe('probing the tools this machine has', () => {
  it('reports the commands that resolve on PATH, in the order they are probed', () => {
    const found = new Set(['git', 'node', 'pnpm'])

    const tools = probeTools({
      path: '/usr/local/bin:/usr/bin',
      exists: candidate => found.has(candidate.split('/').at(-1) ?? ''),
      platform: 'linux',
    })

    expect(tools).toEqual(['git', 'node', 'pnpm'])
  })

  it('accepts the suffixes a Windows host appends', () => {
    const present = new Set(['C:\\tools\\git.exe', 'C:\\tools\\pnpm.cmd'])

    const tools = probeTools({
      path: 'C:\\tools',
      exists: candidate => present.has(candidate),
      platform: 'win32',
    })

    expect(tools).toEqual(['git', 'pnpm'])
  })

  it('skips the empty entries a PATH can carry, and finds nothing on an empty one', () => {
    expect(probeTools({ path: ';;', exists: () => true, platform: 'linux' })).toEqual([])
    expect(probeTools({ path: '', exists: () => true, platform: 'linux' })).toEqual([])
  })

  it('finds nothing when the process carries no PATH at all', () => {
    const saved = process.env['PATH']
    delete process.env['PATH']
    try {
      expect(probeTools({ exists: () => true, platform: 'linux' })).toEqual([])
    } finally {
      process.env['PATH'] = saved ?? ''
    }
  })

  it('probes the tools a coding node is expected to have', () => {
    // The candidate list is fixed; what resolves is what the machine really has.
    expect(PROBED_TOOLS).toContain('git')
    expect(PROBED_TOOLS).toContain('node')
    expect(probeTools({ path: 'C:\\tools', exists: () => false, platform: 'win32' })).toEqual([])
  })
})

describe('reading a version out of a command', () => {
  it('takes the first line a command printed', () => {
    expect(versionFrom('0.2.1-alpha.2\n')).toBe('0.2.1-alpha.2')
    expect(versionFrom('\n  \r\n1.2.3\r\nsecond\n')).toBe('1.2.3')
    expect(versionFrom('   \n')).toBeUndefined()
  })

  it('asks the command for its version and reports what it said', async () => {
    const asked: string[] = []

    const version = await probeAgentVersion({
      bin: 'dsh',
      run: async (bin, args) => {
        asked.push(`${bin} ${args.join(' ')}`)
        return '0.2.1-alpha.2\n'
      },
    })

    expect(version).toBe('0.2.1-alpha.2')
    expect(asked).toEqual(['dsh --version'])
  })

  it('reports nothing when the command cannot answer', async () => {
    const failed = await probeAgentVersion({
      bin: 'dsh',
      run: async () => { throw new Error('not found') },
    })
    const silent = await probeAgentVersion({ bin: 'dsh', run: async () => '\n' })

    // A CLI that cannot report its version leaves the node reporting the stated one.
    expect(failed).toBeUndefined()
    expect(silent).toBeUndefined()
  })
})
