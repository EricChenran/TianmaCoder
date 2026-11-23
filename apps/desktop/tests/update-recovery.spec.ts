import { describe, expect, it } from 'vitest'
import { resolveStartupUpdateRecovery, STARTUP_UPDATE_RETRY_LIMIT } from '../src/update-recovery.ts'
import type { UpdateJournalRecord } from '../src/update-journal.ts'

const started = (version: string): UpdateJournalRecord => ({ event: 'install-started', targetVersion: version })
const consumed = (): UpdateJournalRecord => ({ event: 'restart-consumed' })

describe('startup update recovery', () => {
  it('does nothing without an outstanding install handoff', () => {
    expect(resolveStartupUpdateRecovery([], '1.1.0')).toEqual({ kind: 'none' })
    expect(resolveStartupUpdateRecovery([{ event: 'started' }, { event: 'quit-requested' }], '1.1.0')).toEqual({ kind: 'none' })
  })

  it('reports a completed install when this launch runs the handed-off version', () => {
    expect(resolveStartupUpdateRecovery([started('1.2.0')], '1.2.0')).toEqual({ kind: 'completed', version: '1.2.0' })
  })

  it('reports an interrupted install while this launch still runs the old version', () => {
    expect(resolveStartupUpdateRecovery([started('1.2.0')], '1.1.0')).toEqual({ kind: 'failed', version: '1.2.0' })
  })

  it('degrades to a manual download once the retry limit is reached', () => {
    const attempts = Array.from({ length: STARTUP_UPDATE_RETRY_LIMIT }, () => started('1.2.0'))
    expect(resolveStartupUpdateRecovery(attempts, '1.1.0')).toEqual({ kind: 'manual', version: '1.2.0' })
  })

  it('keeps retrying below the limit', () => {
    const attempts = Array.from({ length: STARTUP_UPDATE_RETRY_LIMIT - 1 }, () => started('1.2.0'))
    expect(resolveStartupUpdateRecovery(attempts, '1.1.0')).toEqual({ kind: 'failed', version: '1.2.0' })
  })

  it('forgets handoffs a previous launch already reported', () => {
    expect(resolveStartupUpdateRecovery([started('1.2.0'), consumed()], '1.1.0')).toEqual({ kind: 'none' })
  })

  it('counts only attempts after the last report', () => {
    const records = [started('1.2.0'), started('1.2.0'), consumed(), started('1.3.0')]
    expect(resolveStartupUpdateRecovery(records, '1.2.0')).toEqual({ kind: 'failed', version: '1.3.0' })
  })

  it('ignores handoffs that name no target version', () => {
    expect(resolveStartupUpdateRecovery([{ event: 'install-started' }], '1.1.0')).toEqual({ kind: 'none' })
  })
})
