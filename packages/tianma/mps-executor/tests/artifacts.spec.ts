/**
 * Uploading what an attempt produced: what the node reads, what it refuses, and what
 * the platform is asked to store.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { ARTIFACT_CHUNK_THRESHOLD_BYTES, clientArtifactUploader } from '@tianma/dsh-mps-executor'
import { sha256Of } from '@tianma/dsh-mps-exec-core'
import type { ExecArtifactUpload } from '@tianma/dsh-mps-exec-core'

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

/** A platform that records the artifacts it was asked to store. */
class RecordingPlatform {
  readonly uploads: { taskId: string; upload: ExecArtifactUpload }[] = []
  failure: Error | undefined

  async uploadArtifact(taskId: string, upload: ExecArtifactUpload): Promise<void> {
    this.uploads.push({ taskId, upload })
    if (this.failure !== undefined) throw this.failure
  }
}

/** One workspace with one screenshot in it. */
function workspaceWithScreenshot(): { directory: string; bytes: Buffer } {
  const directory = temporary('mps-artifacts-')
  mkdirSync(join(directory, 'shots'), { recursive: true })
  const bytes = Buffer.from('PNG-ish bytes\n', 'utf8')
  writeFileSync(join(directory, 'shots', 'detail.png'), bytes)
  return { directory, bytes }
}

describe('artifact upload', () => {
  it('uploads a file from the workspace with the digest the platform verifies', async () => {
    const { directory, bytes } = workspaceWithScreenshot()
    const platform = new RecordingPlatform()
    const uploader = clientArtifactUploader({ client: platform, maxBytes: 1024 * 1024 })

    const artifact = await uploader.upload({
      taskId: 'tsk_1',
      directory,
      kind: 'screenshot',
      path: 'shots/detail.png',
      meta: { width: 1440, height: 900, route: '/orders/123' },
    })

    expect(artifact).not.toBe('')
    expect(platform.uploads).toHaveLength(1)
    const upload = platform.uploads[0]?.upload
    expect(platform.uploads[0]?.taskId).toBe('tsk_1')
    expect(upload?.artifact_id).toBe(artifact)
    expect(upload?.kind).toBe('screenshot')
    expect(upload?.filename).toBe('detail.png')
    expect(upload?.sha256).toBe(sha256Of(bytes))
    expect(upload?.meta).toBe('{"width":1440,"height":900,"route":"/orders/123"}')
    expect(Buffer.from(upload?.bytes ?? []).equals(bytes)).toBe(true)
  })

  it('uploads without metadata when the caller states none', async () => {
    const { directory } = workspaceWithScreenshot()
    const platform = new RecordingPlatform()
    const uploader = clientArtifactUploader({ client: platform, maxBytes: 1024 * 1024 })

    await uploader.upload({ taskId: 'tsk_1', directory, kind: 'report', path: 'shots/detail.png' })

    expect(platform.uploads[0]?.upload.meta).toBeUndefined()
  })

  it('refuses a path that is not a file in the workspace', async () => {
    const { directory } = workspaceWithScreenshot()
    const uploader = clientArtifactUploader({ client: new RecordingPlatform(), maxBytes: 1024 * 1024 })

    await expect(uploader.upload({ taskId: 'tsk_1', directory, kind: 'log', path: 'shots/missing.txt' }))
      .rejects.toThrow(/not a file in the workspace/)
    await expect(uploader.upload({ taskId: 'tsk_1', directory, kind: 'log', path: 'shots' }))
      .rejects.toThrow(/not a file in the workspace/)
  })

  it('refuses a path outside the workspace', async () => {
    const { directory } = workspaceWithScreenshot()
    const uploader = clientArtifactUploader({ client: new RecordingPlatform(), maxBytes: 1024 * 1024 })

    await expect(uploader.upload({ taskId: 'tsk_1', directory, kind: 'log', path: '../outside.txt' }))
      .rejects.toThrow(/not a path inside the workspace/)
  })

  it('refuses a file over what it uploads in one request', async () => {
    const { directory } = workspaceWithScreenshot()
    const uploader = clientArtifactUploader({ client: new RecordingPlatform(), maxBytes: 4 })

    await expect(uploader.upload({ taskId: 'tsk_1', directory, kind: 'report', path: 'shots/detail.png' }))
      .rejects.toThrow(/over the 4 bytes this node uploads in one request/)
  })

  it('takes the smaller of the deployment limit and one request of bytes', async () => {
    const { directory } = workspaceWithScreenshot()
    const platform = new RecordingPlatform()
    const uploader = clientArtifactUploader({ client: platform, maxBytes: ARTIFACT_CHUNK_THRESHOLD_BYTES * 4 })

    await uploader.upload({ taskId: 'tsk_1', directory, kind: 'report', path: 'shots/detail.png' })

    // The protocol requires chunks above this size, so the node never claims more.
    expect(ARTIFACT_CHUNK_THRESHOLD_BYTES).toBe(100 * 1024 * 1024)
    expect(platform.uploads).toHaveLength(1)
    expect(readFileSync(join(directory, 'shots', 'detail.png'), 'utf8')).toBe('PNG-ish bytes\n')
  })

  it('carries a platform refusal out to the caller', async () => {
    const { directory } = workspaceWithScreenshot()
    const platform = new RecordingPlatform()
    platform.failure = new Error('artifact checksum rejected')
    const uploader = clientArtifactUploader({ client: platform, maxBytes: 1024 * 1024 })

    await expect(uploader.upload({ taskId: 'tsk_1', directory, kind: 'report', path: 'shots/detail.png' }))
      .rejects.toThrow(/artifact checksum rejected/)
  })
})
