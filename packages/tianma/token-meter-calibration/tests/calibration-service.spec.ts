/**
 * Calibration service: session-usage scanning finds every usage chunk, the
 * calibrator converges on recorded pairs, and persistence round-trips
 * through a temp state file.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageCalibrator, scanSessionUsages } from '@tianma/dsh-token-meter-calibration'

const dir = mkdtempSync(join(tmpdir(), 'tianma-calibration-'))
afterEach(() => {
  try { rmSync(join(dir, 'state.json')) } catch { /* absent */ }
})

function statePath(): string {
  return join(dir, `state-${Math.random().toString(36).slice(2)}.json`)
}

describe('scanSessionUsages', () => {
  it('finds usage chunks in assistant streams and skips the rest', () => {
    const events = [
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: {} },
      { type: 'assistant/message', data: { message: {} } },
      { type: 'assistant/message', data: { message: { stream: [
        { type: 'text-delta', text: 'hi' },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
      ] } } },
      { type: 'assistant/message', data: { message: { stream: [
        { type: 'usage', usage: { totalTokens: 55 } },
      ] } } },
      { type: 'assistant/message', data: { message: { stream: [
        { type: 'usage', usage: {} },
      ] } } },
    ]
    const samples = scanSessionUsages(events)
    expect(samples).toEqual([
      { totalTokens: 120, outputTokens: 20 },
      { totalTokens: 55, outputTokens: undefined },
    ])
  })
})

describe('UsageCalibrator', () => {
  it('converges on repeated pairs and persists a restorable snapshot', () => {
    const path = statePath()
    const calibrator = new UsageCalibrator(path)
    for (let i = 0; i < 50; i += 1) calibrator.record(100, 150)
    expect(calibrator.factorValue).toBeCloseTo(1.5, 5)
    calibrator.persist()
    const revived = new UsageCalibrator(path)
    expect(revived.factorValue).toBeCloseTo(1.5, 5)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('records session usage samples through the scanner', () => {
    const calibrator = new UsageCalibrator(statePath())
    const session = {
      snapshotEvents: () => [
        { type: 'assistant/message', data: { message: { stream: [
          { type: 'usage', usage: { totalTokens: 300 } },
        ] } } },
      ],
    } as never
    const recorded = calibrator.recordSession(session, () => 250)
    expect(recorded).toBe(1)
    expect(calibrator.factorValue).toBeCloseTo(300 / 250, 5)
  })
})
