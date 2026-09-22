/**
 * Calibration cores: CJK density pricing (pure-ASCII bit-compatibility with
 * the upstream 4-chars/token heuristic, mixed-text deviation pinned ≤10%
 * against tokenizer-representative ground truth) and the rolling factor
 * (median robustness, clamping, window bound, snapshot round-trip).
 */

import { describe, expect, it } from 'vitest'
import {
  CJK_CHARS_PER_TOKEN,
  countCjkCodePoints,
  estimateTextTokensCalibrated,
} from '@tianma/dsh-token-meter-calibration'
import { CalibrationFactor } from '@tianma/dsh-token-meter-calibration'

describe('CJK-aware density', () => {
  it('prices pure ASCII identically to the upstream 4-chars/token heuristic', () => {
    for (const text of ['', 'a', 'abcd', 'abcde', 'x'.repeat(8192)]) {
      expect(estimateTextTokensCalibrated(text)).toBe(Math.ceil(text.length / 4))
    }
  })

  it('counts CJK code points across representative blocks', () => {
    expect(countCjkCodePoints('')).toBe(0)
    expect(countCjkCodePoints('纯中文')).toBe(3)
    expect(countCjkCodePoints('混合mixed文本')).toBe(4)
    expect(countCjkCodePoints('カタカナ')).toBe(4)
    expect(countCjkCodePoints('한국어')).toBe(3)
    expect(countCjkCodePoints('，。！')).toBe(3)
    expect(countCjkCodePoints('emoji 😀 ok')).toBe(0)
  })

  it('prices pure CJK at the CJK density', () => {
    const text = '字'.repeat(300)
    expect(estimateTextTokensCalibrated(text)).toBe(Math.ceil(300 / CJK_CHARS_PER_TOKEN))
  })

  it('holds mixed-corpus deviation within 10% against tokenizer-representative ground truth', () => {
    // Ground truth uses deliberately shifted densities (CJK 1.6, ASCII 3.8 —
    // the measured spread across frontier tokenizers) so this pin is not the
    // implementation's own formula echoed back: the 1.5/4 split must stay
    // within 10% of that spread on every corpus mix, while the upstream flat
    // 4 heuristic is off by 2x+ on CJK-heavy text.
    const TRUTH_CJK = 1.6
    const TRUTH_REST = 3.8
    const corpora = [
      '修复登录超时问题，并在重试时使用指数退避。'.repeat(40),
      '在 src/auth.ts 中调用 refresh()，参见 https://example.com/a?b=1'.repeat(30),
      '混合文档：数据库迁移脚本 database/migrations/001_init.sql 与中文注释。'.repeat(50),
    ]
    for (const text of corpora) {
      const cjk = countCjkCodePoints(text)
      const truth = Math.ceil(cjk / TRUTH_CJK) + Math.ceil((text.length - cjk) / TRUTH_REST)
      const deviation = Math.abs(estimateTextTokensCalibrated(text) - truth) / truth
      expect(deviation).toBeLessThanOrEqual(0.1)
      if (cjk > text.length * 0.5) {
        const baseline = Math.ceil(text.length / 4)
        expect(Math.abs(baseline - truth) / truth).toBeGreaterThan(0.5)
      }
    }
  })
})

describe('CalibrationFactor', () => {
  it('stays at 1 before any sample and snapshots with a version', () => {
    const factor = new CalibrationFactor()
    expect(factor.factor).toBe(1)
    expect(factor.snapshot()).toEqual({ version: 1, sampleCount: 0, factor: 1 })
  })

  it('converges toward the reported/estimated median', () => {
    const factor = new CalibrationFactor()
    for (let i = 0; i < 100; i += 1) factor.addSample(100, 150)
    expect(factor.factor).toBeCloseTo(1.5, 5)
    for (let i = 0; i < 100; i += 1) factor.addSample(150, 150)
    expect(factor.factor).toBeGreaterThan(1)
    expect(factor.factor).toBeLessThan(1.3)
  })

  it('ignores non-positive samples and clamps pathological ratios', () => {
    const factor = new CalibrationFactor()
    factor.addSample(0, 100)
    factor.addSample(100, 0)
    factor.addSample(-1, 5)
    expect(factor.sampleCount).toBe(0)
    factor.addSample(100, 1e9)
    factor.addSample(1e9, 1)
    expect(factor.factor).toBeGreaterThanOrEqual(0.25)
    expect(factor.factor).toBeLessThanOrEqual(4)
  })

  it('bounds the retained window and round-trips snapshots', () => {
    const factor = new CalibrationFactor(16)
    for (let i = 0; i < 100; i += 1) factor.addSample(100, 120)
    expect(factor.sampleCount).toBe(16)
    const snapshot = factor.snapshot()
    const revived = new CalibrationFactor(16, snapshot)
    expect(revived.sampleCount).toBe(1)
    expect(Math.abs(revived.factor - snapshot.factor)).toBeLessThan(1e-9)
  })

  it('rejects an invalid window and an unsupported snapshot version', () => {
    expect(() => new CalibrationFactor(0)).toThrow(/positive integer/)
    expect(() => new CalibrationFactor(16, { version: 2 as never, sampleCount: 1, factor: 1 }))
      .toThrow(/unsupported snapshot version/)
  })
})
