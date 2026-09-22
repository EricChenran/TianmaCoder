/**
 * Shared fixtures for the calibration specs: a real token meter and session
 * store on one context, and the event sequences the loop appends for a prompt
 * and for a provider-reported reply.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as calibration from '@tianma/dsh-token-meter-calibration'

/** Non-CJK prompt text. */
export const ASCII = 'Refactor the token meter to price CJK text at its own density.'

/** CJK-heavy prompt text. */
export const CJK = '请把 token 计量改为按中文密度计价，同时保持纯 ASCII 文本逐位一致。'

const stateDir = mkdtempSync(join(tmpdir(), 'tianma-calibration-'))
let sessionCounter = 0
let stateCounter = 0

/** Remove the specs' shared calibration state directory. */
export function removeStateDir(): void {
  rmSync(stateDir, { recursive: true, force: true })
}

/** The specs' shared calibration state directory. */
export function stateDirectory(): string {
  return stateDir
}

/** A unique calibration state path inside the shared directory. */
export function statePath(name: string): string {
  stateCounter += 1
  return join(stateDir, `${name}-${stateCounter}.json`)
}

/** A context with the real token meter and session store, and one session. */
export function base(): { ctx: Context; session: Session } {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const sessions = new SessionStore(ctx)
  sessionCounter += 1
  return { ctx, session: sessions.create(SessionId(`calibration-${sessionCounter}`)) }
}

/** Mount the calibration plugin through its real namespace export. */
export async function mount(ctx: Context, name = 'state', config: calibration.Config = {}): Promise<Fiber> {
  return ctx.plugin(calibration, { statePath: statePath(name), ...config })
}

/** Append one user turn, the way the loop brackets a prompt. */
export function appendUserTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append one user turn with a following provider-reported assistant reply. */
export function appendReportedTurn(
  session: Session,
  turn: number,
  text: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  reply = '收到，正在处理。',
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', {
    header: canonicalHeader({ config: { provider: 'mock', model: 'mock' } }),
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: reply.length === 0 ? [] : [{ type: 'text', text: reply }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Append one step whose only model-visible node is an empty assistant message
 * hosting usage — the max-tokens step that prices to nothing.
 */
export function appendUsageOnlyTurn(
  session: Session,
  turn: number,
  usage: { inputTokens: number; outputTokens: number },
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', {
    header: canonicalHeader({ config: { provider: 'mock', model: 'mock' } }),
    reason: 'initial',
  })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Sum the priced nodes of a measurement. */
export function sumNodeTokens(nodes: readonly { tokens: number }[]): number {
  return nodes.reduce((total, node) => total + node.tokens, 0)
}
