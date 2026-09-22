/**
 * Branch coverage for the calibration seams the behavior specs reach only
 * through their common paths: structural and system-prompt block pricing, a
 * surface that prices to zero, a provider-usage baseline, the default state
 * path's three sources, and unusable persisted state.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CalibrationFactor, UsageCalibrator, defaultStatePath, densityRatio, estimateMessageTokens, priceMessages } from '@tianma/dsh-token-meter-calibration'
import * as calibration from '@tianma/dsh-token-meter-calibration'
import {
  CJK,
  appendReportedTurn,
  appendUsageOnlyTurn,
  base,
  mount,
  removeStateDir,
  stateDirectory,
  statePath,
} from './harness.ts'

afterAll(removeStateDir)

/** Restore a process environment variable after one test mutates it. */
function withEnv(name: string, value: string | undefined, body: () => void): void {
  const previous = process.env[name]
  try {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    body()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('message pricing branches', () => {
  it('prices structural blocks and an empty system prompt', () => {
    const structural = createUserMessage({
      content: [{ type: 'tool-addition', toolName: 'read' }],
      source: { kind: 'user' },
    })
    expect(estimateMessageTokens(structural, 'flat')).toBeGreaterThan(0)
    expect(estimateMessageTokens(structural, 'calibrated')).toBeGreaterThan(0)

    expect(estimateMessageTokens(createSystemMessage(''), 'flat')).toBe(0)
    expect(estimateMessageTokens(createSystemMessage(''), 'calibrated')).toBe(0)
  })

  it('prices a non-text system block at its JSON structure', () => {
    const mixedSystem = createMessage({
      role: 'system',
      content: [
        { type: 'text', text: 'prompt' },
        { type: 'tool-addition', toolName: 'read' },
      ],
      source: { kind: 'system-prompt' },
    })
    expect(estimateMessageTokens(mixedSystem, 'flat')).toBeGreaterThan(0)
    expect(estimateMessageTokens(mixedSystem, 'calibrated')).toBeGreaterThan(0)
  })
})

describe('density ratio branches', () => {
  it('treats a surface that prices to zero as an uncorrected ratio', () => {
    const { session } = base()
    expect(priceMessages([])).toEqual({ calibratedTokens: 0, flatTokens: 0 })
    expect(densityRatio(session)).toBe(1)
  })
})

describe('default state path sources', () => {
  it('prefers the explicit home, then the environment, then the OS home', () => {
    const file = 'tianma-calibration.json'
    expect(defaultStatePath('C:/home')).toBe(join('C:/home', file))
    withEnv('DSH_HOME', 'C:/env-home', () => {
      expect(defaultStatePath()).toBe(join('C:/env-home', file))
    })
    withEnv('DSH_HOME', undefined, () => {
      expect(defaultStatePath()).toBe(join(homedir(), '.dsh', file))
    })
  })

  it('falls back to the default path when a calibrator is constructed without one', () => {
    withEnv('DSH_HOME', join(statePath('missing'), 'absent'), () => {
      expect(new UsageCalibrator().factorValue).toBe(1)
    })
  })

  it('persists under the harness home when the plugin is mounted unconfigured', async () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = stateDirectory()
    try {
      const { ctx } = base()
      const plugin = await ctx.plugin(calibration, {})
      await plugin.dispose()
      expect(existsSync(join(stateDirectory(), 'tianma-calibration.json'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('unusable persisted state', () => {
  it('ignores a malformed or unsupported state document', () => {
    const malformed = statePath('malformed')
    writeFileSync(malformed, '{not json', 'utf8')
    expect(new UsageCalibrator(malformed).factorValue).toBe(1)

    const future = statePath('future')
    writeFileSync(future, JSON.stringify({ version: 2, factor: { version: 1, sampleCount: 0, factor: 3 } }), 'utf8')
    expect(new UsageCalibrator(future).factorValue).toBe(1)
  })
})

describe('provider-usage baseline and empty surfaces', () => {
  it('leaves a provider-usage baseline uncorrected', async () => {
    const { ctx, session } = base()
    const plugin = await mount(ctx, 'usage')
    appendReportedTurn(session, 1, CJK, {
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
    })

    const measured = ctx.tokenMeter.measure(session)
    expect(measured.baseline.kind).toBe('usage')
    await plugin.dispose()
  })

  it('skips a reported call whose surface prices to zero', async () => {
    const { ctx, session } = base()
    const plugin = await mount(ctx, 'empty')
    appendUsageOnlyTurn(session, 1, { inputTokens: 10, outputTokens: 5 })

    expect(ctx.tianmaTokenCalibration.sampleCount).toBe(0)
    await plugin.dispose()
  })

  it('skips a reported call that bills no tokens', async () => {
    const { ctx, session } = base()
    const plugin = await mount(ctx, 'unbilled')
    appendReportedTurn(session, 1, CJK, { inputTokens: 0, outputTokens: 0 })

    expect(ctx.tianmaTokenCalibration.sampleCount).toBe(0)
    await plugin.dispose()
  })
})

describe('rolling factor edge cases', () => {
  it('averages the two middle ratios for an even sample count', () => {
    const factor = new CalibrationFactor()
    factor.addSample(100, 100)
    factor.addSample(100, 200)
    expect(factor.factor).toBe(1.5)
  })

  it('falls back to 1 for a non-finite ratio', () => {
    const factor = new CalibrationFactor()
    factor.addSample(Number.NaN, 100)
    expect(factor.factor).toBe(1)
  })
})
