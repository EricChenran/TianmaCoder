/**
 * The node's own report file: what an operator reads when a deployment shows nothing.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_LOG_DIRECTORY, appendNodeLog } from '@tianma/dsh-mps-executor'
import type { NodeLogRecord } from '@tianma/dsh-mps-executor'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('the node keeping its own report file', () => {
  it('writes one line per report under the day it was made', () => {
    const root = mkdtempSync(join(tmpdir(), 'mps-nodelog-'))
    created.push(root)
    const at = new Date('2026-10-16T01:30:00.000Z')

    appendNodeLog(root, { level: 'warn', message: 'the platform dispatched tsk_1 with no room' }, at)
    appendNodeLog(root, { level: 'info', message: 'node node-1 registered' }, at)

    const lines = readFileSync(join(root, NODE_LOG_DIRECTORY, 'node-2026-10-16.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map(line => JSON.parse(line) as NodeLogRecord)).toEqual([
      { at: '2026-10-16T01:30:00.000Z', level: 'warn', message: 'the platform dispatched tsk_1 with no room' },
      { at: '2026-10-16T01:30:00.000Z', level: 'info', message: 'node node-1 registered' },
    ])
  })

  it('stops at its ceiling and says so once', () => {
    const root = mkdtempSync(join(tmpdir(), 'mps-nodelog-'))
    created.push(root)
    const at = new Date('2026-10-16T03:00:00.000Z')

    // A ceiling of two, so the third report is the one that stops it.
    appendNodeLog(root, { level: 'info', message: 'one' }, at, 2)
    appendNodeLog(root, { level: 'info', message: 'two' }, at, 2)
    appendNodeLog(root, { level: 'warn', message: 'three' }, at, 2)
    appendNodeLog(root, { level: 'warn', message: 'four' }, at, 2)

    const lines = readFileSync(join(root, NODE_LOG_DIRECTORY, 'node-2026-10-16.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map(line => (JSON.parse(line) as NodeLogRecord).message)).toEqual([
      'one',
      'two',
      'further reports are dropped from this file: it holds its ceiling of 2 lines for 2026-10-16',
    ])
  })

  it('never writes a credential-shaped value', () => {
    const root = mkdtempSync(join(tmpdir(), 'mps-nodelog-'))
    created.push(root)

    appendNodeLog(root, { level: 'error', message: 'failed with api_key=sk-abcdefghijklmnop' }, new Date('2026-10-16T02:00:00.000Z'))

    const text = readFileSync(join(root, NODE_LOG_DIRECTORY, 'node-2026-10-16.jsonl'), 'utf8')
    expect(text).not.toContain('sk-abcdefghijklmnop')
    expect(text).toContain('api_key=')
  })
})
