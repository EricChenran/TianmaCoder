/**
 * Plugin wiring against a real token meter: a CJK surface reads heavier than
 * the meter's fixed density while a non-CJK surface stays bit-identical,
 * reported usage feeds the rolling factor, disposal restores the meter and
 * unregisters the service, and the persisted factor round-trips.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createSystemMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as calibration from '@tianma/dsh-token-meter-calibration'
import { ASCII, CJK, appendReportedTurn, appendUserTurn, base, mount, removeStateDir, statePath, sumNodeTokens } from './harness.ts'

afterAll(removeStateDir)

describe('flat pricing parity with the meter', () => {
  it('reproduces the meter heuristic for every message shape', () => {
    const { ctx } = base()
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: ASCII }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: CJK }], source: { kind: 'user' } }),
      createSystemMessage('short'),
      createSystemMessage(CJK),
      createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: ASCII },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"path":"a.ts"}' },
        ],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    ]
    for (const message of messages) {
      expect(calibration.estimateMessageTokens(message, 'flat'))
        .toBe(ctx.tokenMeter.estimateMessage(message))
    }
  })

  it('prices CJK text heavier than the flat density', () => {
    const { ctx } = base()
    const message = createUserMessage({ content: [{ type: 'text', text: CJK }], source: { kind: 'user' } })
    expect(calibration.estimateMessageTokens(message, 'calibrated'))
      .toBeGreaterThan(ctx.tokenMeter.estimateMessage(message))
  })
})

describe('plugin export form', () => {
  it('is a namespace plugin with no default export', () => {
    // A default export makes the Loader discard `inject` and `name`.
    expect(Object.hasOwn(calibration, 'default')).toBe(false)
    expect(calibration.name).toBe('tianma-token-calibration')
    expect(calibration.inject).toEqual(['tokenMeter'])
  })
})

describe('measurement correction', () => {
  it('leaves a non-CJK surface bit-identical to the uncalibrated meter', async () => {
    const { ctx, session } = base()
    appendUserTurn(session, 1, ASCII)
    const plain = ctx.tokenMeter.measure(session)

    const plugin = await mount(ctx)
    expect(ctx.tokenMeter.measure(session)).toEqual(plain)
    await plugin.dispose()
  })

  it('reads a CJK surface heavier and keeps the measure invariants', async () => {
    const { ctx, session } = base()
    appendUserTurn(session, 1, CJK)
    const plain = ctx.tokenMeter.measure(session)

    const plugin = await mount(ctx)
    const calibrated = ctx.tokenMeter.measure(session)

    expect(calibrated.totalTokens).toBeGreaterThan(plain.totalTokens)
    expect(calibrated.surfaceTokens).toBe(sumNodeTokens(calibrated.nodes))
    expect(calibrated.totalTokens).toBe(calibrated.baseline.tokens + calibrated.surfaceDeltaTokens)
    await plugin.dispose()
  })

  it('exposes the correction through ctx.tianmaTokenCalibration', async () => {
    const { ctx, session } = base()
    const plugin = await mount(ctx)
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage(CJK),
    }, { surfaceOp: 'append' })

    expect(ctx.tianmaTokenCalibration.factorValue).toBe(1)
    expect(ctx.tianmaTokenCalibration.sessionMultiplier(session)).toBeGreaterThan(1)
    await plugin.dispose()
  })
})

describe('usage sampling and persistence', () => {
  it('records reported usage into the rolling factor and persists on dispose', async () => {
    const { ctx, session } = base()
    const path = statePath('recorded')
    const plugin = await mount(ctx, 'recorded', { statePath: path })
    expect(ctx.tianmaTokenCalibration.sampleCount).toBe(0)

    appendReportedTurn(session, 1, CJK, { inputTokens: 900, outputTokens: 300 })
    expect(ctx.tianmaTokenCalibration.sampleCount).toBe(1)
    const recorded = ctx.tianmaTokenCalibration.factorValue
    expect(recorded).toBeGreaterThan(1)
    expect(recorded).toBeLessThanOrEqual(4)

    await plugin.dispose()
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      factor: { version: number; sampleCount: number; factor: number }
    }
    expect(persisted.version).toBe(1)
    expect(persisted.factor.version).toBe(1)
    expect(persisted.factor.sampleCount).toBe(1)
    expect(persisted.factor.factor).toBeCloseTo(recorded, 10)
  })

  it('restores a persisted factor into a fresh mount', async () => {
    const path = statePath('restored')
    writeFileSync(path, JSON.stringify({
      version: 1,
      factor: { version: 1, sampleCount: 4, factor: 2.5 },
    }), 'utf8')

    const { ctx } = base()
    const plugin = await mount(ctx, 'restored', { statePath: path })
    expect(ctx.tianmaTokenCalibration.factorValue).toBeCloseTo(2.5, 10)
    await plugin.dispose()
  })

  it('ignores assistant messages without reported usage', async () => {
    const { ctx, session } = base()
    const plugin = await mount(ctx)
    appendUserTurn(session, 1, CJK)
    expect(ctx.tianmaTokenCalibration.sampleCount).toBe(0)
    await plugin.dispose()
  })
})

describe('plugin lifecycle', () => {
  it('restores the meter and unregisters the service on dispose', async () => {
    const { ctx, session } = base()
    appendUserTurn(session, 1, CJK)
    const plain = ctx.tokenMeter.measure(session)

    const plugin = await mount(ctx)
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(plain.totalTokens)
    await plugin.dispose()

    expect(ctx.get('tianmaTokenCalibration')).toBeUndefined()
    expect(ctx.tokenMeter.measure(session)).toEqual(plain)
  })

  it('rejects an unknown config key', async () => {
    const { ctx } = base()
    await expect(ctx.plugin(calibration, { nope: true } as never))
      .rejects.toThrow(/unknown key "nope"/)
  })

  it('rejects an empty state path', async () => {
    // A bare context has no injected meter; the config check runs before any
    // service access, so the rejection is the config error.
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    await expect(ctx.plugin(calibration, { statePath: '' }))
      .rejects.toThrow(/statePath must be a non-empty string/)
  })
})
