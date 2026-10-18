/**
 * The materials a task carries: what the node brings into the workspace, under what
 * names, and what it refuses.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  ARTIFACT_CHUNK_THRESHOLD_BYTES,
  MATERIALS_DIRECTORY,
  fetchMaterials,
  materialFileName,
  taskMaterials,
} from '@tianma/dsh-mps-executor'
import type { ExecResource, ExecTaskAssignment } from '@tianma/dsh-mps-exec-core'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix for the directory.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/**
 * One assignment as the platform dispatches it.
 * @param payload - the payload to carry.
 * @returns the assignment.
 */
function assignment(payload: Record<string, unknown>): ExecTaskAssignment {
  return {
    task_id: 'tsk_1',
    work_item_id: 'wi_1',
    attempt: 1,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2026-10-15T04:16:00.123+08:00',
    lease_renew_seconds: 30,
    payload,
  }
}

/** A platform that answers material requests from a map. */
class FakeMaterials {
  readonly asked: string[] = []
  readonly contents = new Map<string, Uint8Array>()
  failure: Error | undefined

  async resource(artifactId: string): Promise<ExecResource> {
    this.asked.push(artifactId)
    if (this.failure !== undefined) throw this.failure
    const bytes = this.contents.get(artifactId) ?? new TextEncoder().encode(`# ${artifactId}\n`)
    return { bytes, sha256: `sha-of-${artifactId}` }
  }
}

describe('task materials', () => {
  it('reads the materials the context and its messages state', () => {
    expect(taskMaterials({
      context: {
        resources: ['art_1', 'art_2'],
        chat_transcript: {
          messages: [
            { resources: [{ artifact_id: 'art_2', file_name: '需求说明.pdf' }, { artifact_id: '../escape' }] },
            { resources: [{ artifact_id: 'art_3' }] },
          ],
        },
      },
    })).toEqual(['art_1', 'art_2', 'art_3'])
    expect(taskMaterials({})).toEqual([])
    expect(taskMaterials({ context: { resources: 'art_1' } })).toEqual([])
  })

  it('names a material inside the materials directory whatever the platform states', () => {
    expect(materialFileName('art_1')).toBe('art_1')
    expect(materialFileName('art_1', '需求说明.pdf')).toBe('art_1_需求说明.pdf')
    expect(materialFileName('art_1', '../../etc/passwd')).toBe('art_1_passwd')
    expect(materialFileName('art_1', 'C:\\tmp\\notes.txt')).toBe('art_1_notes.txt')
    expect(materialFileName('art_1', '   ')).toBe('art_1')
    expect(materialFileName('art_1', '..')).toBe('art_1')
    expect(materialFileName('art_1', '"助手介绍.md"')).toBe('art_1_助手介绍.md')
    expect(materialFileName('art_1', 'a<b>c?.png')).toBe('art_1_abc.png')
  })

  it('brings the materials into the workspace and keeps them out of the repository', async () => {
    const workspace = temporary('mps-materials-')
    mkdirSync(join(workspace, '.git', 'info'), { recursive: true })
    writeFileSync(join(workspace, '.git', 'info', 'exclude'), '# local excludes\n', 'utf8')
    const platform = new FakeMaterials()
    platform.contents.set('art_2', new TextEncoder().encode('需求说明的正文'))

    const written = await fetchMaterials({
      directory: workspace,
      assignment: assignment({
        context: {
          resources: ['art_1'],
          chat_transcript: {
            messages: [{
              resources: [
                { artifact_id: 'art_2', file_name: '需求说明.pdf' },
                // An attachment the platform states only one half of names nothing.
                { artifact_id: 'art_3' },
                { file_name: '无编号.png' },
              ],
            }],
          },
        },
      }),
      source: platform,
    })

    expect(platform.asked).toEqual(['art_1', 'art_2', 'art_3'])
    expect(written).toEqual([
      { artifact_id: 'art_1', file_name: undefined, path: join(MATERIALS_DIRECTORY, 'art_1'), sha256: 'sha-of-art_1' },
      {
        artifact_id: 'art_2',
        file_name: '需求说明.pdf',
        path: join(MATERIALS_DIRECTORY, 'art_2_需求说明.pdf'),
        sha256: 'sha-of-art_2',
      },
      {
        artifact_id: 'art_3',
        file_name: undefined,
        path: join(MATERIALS_DIRECTORY, 'art_3'),
        sha256: 'sha-of-art_3',
      },
    ])
    expect(readFileSync(join(workspace, written[1]?.path ?? ''), 'utf8')).toBe('需求说明的正文')
    expect(readFileSync(join(workspace, '.git', 'info', 'exclude'), 'utf8'))
      .toBe(`# local excludes\n${MATERIALS_DIRECTORY}/\n`)
  })

  it('asks for nothing when the task carries no materials', async () => {
    const workspace = temporary('mps-materials-')
    const platform = new FakeMaterials()

    const written = await fetchMaterials({
      directory: workspace,
      assignment: assignment({ spec: { raw_instruction: 'x' } }),
      source: platform,
    })

    expect(written).toEqual([])
    expect(platform.asked).toEqual([])
    expect(existsSync(join(workspace, MATERIALS_DIRECTORY))).toBe(false)
  })

  it('carries a platform refusal out to the caller', async () => {
    const workspace = temporary('mps-materials-')
    const platform = new FakeMaterials()
    platform.failure = new Error('RESOURCE_NOT_IN_SCOPE: not in scope')

    await expect(fetchMaterials({
      directory: workspace,
      assignment: assignment({ context: { resources: ['art_9'] } }),
      source: platform,
    })).rejects.toThrow(/RESOURCE_NOT_IN_SCOPE/)
  })

  it('brings in a material larger than one request', async () => {
    const workspace = temporary('mps-materials-')
    const platform = new FakeMaterials()
    // The client asks the platform for a material this size in byte ranges; this case
    // pins that the node writes what it was handed instead of refusing the size itself.
    platform.contents.set('art_big', new Uint8Array(ARTIFACT_CHUNK_THRESHOLD_BYTES + 1))

    const written = await fetchMaterials({
      directory: workspace,
      assignment: assignment({ context: { resources: ['art_big'] } }),
      source: platform,
    })

    expect(written).toEqual([
      { artifact_id: 'art_big', file_name: undefined, path: join(MATERIALS_DIRECTORY, 'art_big'), sha256: 'sha-of-art_big' },
    ])
    expect(statSync(join(workspace, MATERIALS_DIRECTORY, 'art_big')).size).toBe(ARTIFACT_CHUNK_THRESHOLD_BYTES + 1)
  })
})
