/**
 * Hook trust records: content-hash keyed approval ledger for third-party
 * workspace hooks, persisted as a versioned JSON document under the harness
 * home. Ported from ZCode's hooks trust layer (trust-domain / records /
 * evaluation) in the minimal form dsh needs: a hook command string is hashed
 * at admission time; an identical hash with an `approved` record passes, any
 * change re-opens review.
 *
 * @module @tianma/dsh-hooks-trust/store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Admission decision for one hook command. */
export type TrustDecision = 'approved' | 'denied' | 'review'

/** One persisted trust record. */
export interface TrustRecord {
  readonly state: 'approved' | 'denied'
  /** ISO timestamp of the decision. */
  readonly decidedAt: string
  /** Where the hook came from (project path / config file). */
  readonly source: string
}

/** Persisted document shape. */
export interface TrustStoreDocument {
  readonly version: 1
  readonly records: Readonly<Record<string, TrustRecord>>
}

/**
 * Content hash of one hook command. Identical commands hash identically;
 * any byte change (a new flag, a different interpreter) produces a new hash
 * and therefore a fresh review.
 * @param command - the hook command string.
 * @returns the sha256 hash hex.
 */
export function hookHash(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

/**
 * The trust ledger. Pure state container + explicit I/O; the admission
 * caller (an integrator's hook runner) decides what `review` means.
 */
export class HookTrustStore {
  private readonly records = new Map<string, TrustRecord>()
  private readonly path: string

  /**
   * @param path - ledger file path; created on first persist.
   */
  constructor(path: string) {
    this.path = path
    this.restore()
  }

  /**
   * Evaluate one hook command.
   * @param command - the hook command string.
   * @param source - provenance recorded with the decision.
   * @returns `approved` when an unchanged approval exists, `denied` when a
   *   denial exists, `review` otherwise.
   */
  evaluate(command: string, source: string): TrustDecision {
    void source
    const record = this.records.get(hookHash(command))
    if (record === undefined) return 'review'
    return record.state
  }

  /**
   * Record a decision for one hook command.
   * @param command - the hook command string.
   * @param state - the decision.
   * @param source - provenance recorded with the decision.
   */
  decide(command: string, state: 'approved' | 'denied', source: string): void {
    this.records.set(hookHash(command), {
      state,
      decidedAt: new Date().toISOString(),
      source,
    })
  }

  /**
   * Whether one command has any record at all.
   * @param command - the hook command string.
   * @returns whether a record exists for the command hash.
   */
  has(command: string): boolean {
    return this.records.has(hookHash(command))
  }

  /** Write the ledger to disk. */
  persist(): void {
    const document: TrustStoreDocument = {
      version: 1,
      records: Object.fromEntries(this.records),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(document, null, 2), 'utf8')
  }

  /** Read the ledger from disk, tolerating absence and corruption. */
  private restore(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as TrustStoreDocument
      if (parsed.version !== 1) return
      for (const [hash, record] of Object.entries(parsed.records)) {
        this.records.set(hash, record)
      }
    } catch {
      // A corrupted ledger re-opens review for everything: fail closed.
    }
  }
}
