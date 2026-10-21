/**
 * External Session discovery: a Session stored by another process (an MPS
 * executor node, a second CLI run) becomes a list addition on an already-open
 * sidebar. The scan seeds existing history silently, publishes only stored
 * Sessions this process does not own, and withdraws rows whose artifact is
 * gone.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogFilename, sessionDir } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalSessionWatch, type ExternalSessionSource } from '../src/discovery.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

const rev = (value: string): SessionPersistenceRevision => SessionPersistenceRevision(value)

function header(value: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(value),
    createdAt: 1,
    cwd: '/workspace',
    isSeeded: false,
    ...overrides,
  }
}

function stored(value: string, revision: string, overrides: Partial<SessionHeader> = {}): SessionPersistenceSnapshot {
  return { header: header(value, overrides), revision: rev(revision) }
}

function summaryOf(record: SessionPersistenceSnapshot): SessionSummary {
  return {
    sessionId: record.header.id,
    updatedAt: record.header.createdAt,
    agentAvailable: false,
    running: false,
    blank: true,
    ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
  }
}

interface FakeSource extends ExternalSessionSource {
  records: readonly SessionPersistenceSnapshot[]
  readonly live: Set<string>
  readonly announced: SessionSummary[]
  readonly touched: Array<{ sessionId: string; updatedAt: number }>
  readonly removed: string[]
  readonly warnings: string[]
  failNext: unknown
  pending: Promise<void> | undefined
}

function source(records: readonly SessionPersistenceSnapshot[] = []): FakeSource {
  const fake: FakeSource = {
    records,
    live: new Set<string>(),
    announced: [],
    touched: [],
    removed: [],
    warnings: [],
    failNext: undefined,
    pending: undefined,
    async list(signal?: AbortSignal) {
      if (fake.pending !== undefined) await fake.pending
      signal?.throwIfAborted()
      if (fake.failNext !== undefined) {
        const error = fake.failNext
        fake.failNext = undefined
        throw error
      }
      return fake.records
    },
    isLive: sessionId => fake.live.has(String(sessionId)),
    summarize: summaryOf,
    announce: (summary) => { fake.announced.push(summary) },
    touch: (sessionId, updatedAt) => { fake.touched.push({ sessionId: String(sessionId), updatedAt }) },
    remove: (sessionId) => { fake.removed.push(String(sessionId)) },
    warn: (message) => { fake.warnings.push(message) },
  }
  return fake
}

describe('external Session discovery', () => {
  it('seeds stored history silently and announces a later materialization', async () => {
    const seed = stored('old', 'r1')
    const fake = source([seed])
    const watch = new ExternalSessionWatch(fake, 1_000)

    await watch.scan()
    expect(fake.announced).toEqual([])
    expect(fake.touched).toEqual([])

    const fresh = stored('task-session', 'r1', { createdAt: 2 })
    fake.records = [seed, fresh]
    await watch.scan()
    expect(fake.announced).toEqual([summaryOf(fresh)])
    expect(fake.touched).toEqual([])
  })

  it('publishes a changed stored revision as an upsert and advances recency', async () => {
    const first = stored('task-session', 'r1')
    const fake = source([first])
    const watch = new ExternalSessionWatch(fake, 1_000)
    await watch.scan()

    const second = stored('task-session', 'r2', { createdAt: 9 })
    fake.records = [second]
    await watch.scan()

    expect(fake.announced).toEqual([summaryOf(second)])
    expect(fake.touched).toEqual([{ sessionId: 'task-session', updatedAt: 9 }])
  })

  it('leaves live Sessions to their own lifecycle events', async () => {
    const first = stored('live', 'r1')
    const fake = source([first])
    fake.live.add('live')
    const watch = new ExternalSessionWatch(fake, 1_000)
    await watch.scan()

    fake.records = [stored('live', 'r2')]
    await watch.scan()
    expect(fake.announced).toEqual([])
    expect(fake.touched).toEqual([])

    // The revision known while the Session was live needs no second
    // announcement once its ownership ends.
    fake.live.delete('live')
    await watch.scan()
    expect(fake.announced).toEqual([])
  })

  it('omits Sessions without a working directory, matching the Host list', async () => {
    const withoutCwd = (revision: string): SessionPersistenceSnapshot => ({
      header: {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('no-cwd'),
        createdAt: 1,
        isSeeded: false,
      },
      revision: rev(revision),
    })
    const fake = source([withoutCwd('r1')])
    const watch = new ExternalSessionWatch(fake, 1_000)
    await watch.scan()

    fake.records = [withoutCwd('r2')]
    await watch.scan()
    expect(fake.announced).toEqual([])
  })

  it('removes a row whose stored artifact disappeared but not a live one', async () => {
    const gone = stored('gone', 'r1')
    const live = stored('live', 'r1')
    const fake = source([gone, live])
    fake.live.add('live')
    const watch = new ExternalSessionWatch(fake, 1_000)
    await watch.scan()

    fake.records = []
    fake.live.delete('live')
    fake.live.add('live')
    await watch.scan()
    expect(fake.removed).toEqual(['gone'])
  })

  it('warns and retries after a failed scan', async () => {
    const fake = source([])
    fake.failNext = new Error('storage unavailable')
    const watch = new ExternalSessionWatch(fake, 1_000)

    await watch.scan()
    expect(fake.warnings).toEqual(['external Session scan failed: storage unavailable'])

    await watch.scan()
    fake.records = [stored('late', 'r1')]
    await watch.scan()
    expect(fake.announced).toEqual([summaryOf(stored('late', 'r1'))])
  })

  it('reports a non-Error storage failure and keeps scanning', async () => {
    const fake = source([])
    fake.failNext = 'storage offline'
    const watch = new ExternalSessionWatch(fake, 1_000)

    await watch.scan()
    expect(fake.warnings).toEqual(['external Session scan failed: storage offline'])
  })

  it('starts once and tolerates repeated stops', () => {
    const fake = source([])
    const watch = new ExternalSessionWatch(fake, 1_000_000)
    watch.start()
    watch.start()
    watch.stop()
    watch.stop()
  })

  it('coalesces overlapping scans', async () => {
    const fake = source([])
    const listing = Promise.withResolvers<undefined>()
    fake.pending = listing.promise
    const watch = new ExternalSessionWatch(fake, 1_000)

    const first = watch.scan()
    const second = watch.scan()
    listing.resolve(undefined)
    await Promise.all([first, second])
    expect(fake.warnings).toEqual([])
  })

  it('publishes nothing from a listing that finishes after stop', async () => {
    const fake = source([])
    const listing = Promise.withResolvers<undefined>()
    fake.pending = listing.promise
    const watch = new ExternalSessionWatch(fake, 1_000)
    watch.start()

    const scan = watch.scan()
    watch.stop()
    fake.records = [stored('late', 'r1')]
    listing.resolve(undefined)
    await scan
    expect(fake.announced).toEqual([])
  })

  it('rejects a non-positive scan interval', () => {
    const fake = source([])
    expect(() => new ExternalSessionWatch(fake, 0)).toThrow(/positive integer/)
  })
})

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

describe('external Session discovery in the assembled Host', () => {
  it('announces a log another process writes under the same home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-external-sessions-'))
    const ctx = new Context()
    cleanup.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const listing = vi.spyOn(ctx.sessionPersistence, 'list')
    const added: SessionSummary[] = []
    ctx.on('api-session/added', (summary) => { added.push(summary) })
    createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: root,
      externalSessionScanMs: 20,
    })
    // A completed first listing means the baseline seed is behind us; the
    // Session written next is a post-start materialization, not history.
    await vi.waitFor(() => { expect(listing.mock.calls.length).toBeGreaterThan(1) }, { timeout: 2_000 })

    const sessionId = SessionId('external-task')
    const header = {
      type: 'session' as const,
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: Date.now(),
      cwd: root,
      isSeeded: false,
      delegationDepth: 0,
    }
    const path = join(
      sessionDir(join(root, 'logs'), root, sessionId),
      generationLogFilename(SESSION_FORMAT_VERSION, 'none'),
    )
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(header)}\n`)

    await vi.waitFor(() => {
      expect(added.map(summary => summary.sessionId)).toContain(sessionId)
    }, { timeout: 3_000 })
    expect(added.find(summary => summary.sessionId === sessionId)?.cwd).toBe(root)
  })
})
