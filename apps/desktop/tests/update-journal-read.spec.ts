import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopUpdateJournal, readUpdateJournalRecords } from '../src/update-journal.ts'

const directories: string[] = []

function evidenceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-update-journal-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('update journal reading', () => {
  it('records the install handoff with the version it asked the installer to apply', () => {
    const directory = evidenceDirectory()
    const journal = new DesktopUpdateJournal(directory, '1.1.0')
    journal.installStarted('1.2.0')
    expect(readUpdateJournalRecords(directory).at(-1)).toMatchObject({
      event: 'install-started', targetVersion: '1.2.0', version: '1.1.0',
    })
  })

  it('keeps the newest records under a limit', () => {
    const directory = evidenceDirectory()
    const journal = new DesktopUpdateJournal(directory, '1.1.0')
    journal.action('quit-requested')
    journal.installStarted('1.2.0')
    expect(readUpdateJournalRecords(directory, 1)).toEqual([
      expect.objectContaining({ event: 'install-started', targetVersion: '1.2.0' }),
    ])
  })

  it('skips a missing directory and truncated lines instead of failing startup', () => {
    expect(readUpdateJournalRecords(join(tmpdir(), 'dsh-missing-update-journal'))).toEqual([])
    const directory = evidenceDirectory()
    writeFileSync(join(directory, '0000-partial.jsonl'), '{"event":\n{"event":"install-started","targetVersion":"9.9.9"}\n', 'utf8')
    expect(readUpdateJournalRecords(directory)).toEqual([{ event: 'install-started', targetVersion: '9.9.9' }])
  })
})
