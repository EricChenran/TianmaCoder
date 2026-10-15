/**
 * Uploading what an attempt produced: what the node reads, what it refuses, and what
 * the platform is asked to store.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  ARTIFACT_CHUNK_THRESHOLD_BYTES,
  clientArtifactUploader,
} from '@tianma/dsh-mps-executor'
import { sha256Of } from '@tianma/dsh-mps-exec-core'
import type {
  ExecArtifactUpload,
  ExecArtifactUploadInit,
  ExecArtifactUploadSession,
} from '@tianma/dsh-mps-exec-core'

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
  readonly inits: ExecArtifactUploadInit[] = []
  readonly chunks: { index: number; bytes: Uint8Array }[] = []
  readonly completed: string[] = []
  /** Chunks the platform claims to hold already, so a resumed upload sends the rest. */
  held: number[] = []
  failure: Error | undefined

  async uploadArtifact(taskId: string, upload: ExecArtifactUpload): Promise<void> {
    this.uploads.push({ taskId, upload })
    if (this.failure !== undefined) throw this.failure
  }

  async initArtifact(_taskId: string, init: ExecArtifactUploadInit): Promise<ExecArtifactUploadSession> {
    this.inits.push(init)
    return { upload_id: 'upload-1', uploaded_chunks: this.held }
  }

  async uploadArtifactChunk(_taskId: string, _uploadId: string, index: number, bytes: Uint8Array): Promise<void> {
    this.chunks.push({ index, bytes })
  }

  async completeArtifact(_taskId: string, uploadId: string): Promise<void> {
    this.completed.push(uploadId)
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

  it('sends an artifact over the threshold in chunks and closes the upload', async () => {
    const directory = temporary('mps-artifacts-')
    const large = join(directory, 'large.bundle')
    writeFileSync(large, new Uint8Array(ARTIFACT_CHUNK_THRESHOLD_BYTES + 1))
    const platform = new RecordingPlatform()
    // The platform already holds the first chunk, so a resumed upload sends the rest.
    platform.held = [0]
    const uploader = clientArtifactUploader({ client: platform, maxBytes: ARTIFACT_CHUNK_THRESHOLD_BYTES * 2 })

    const artifact = await uploader.upload({
      taskId: 'tsk_1',
      directory,
      kind: 'bundle',
      path: 'large.bundle',
      meta: { branch: 'feature/tsk_1' },
    })

    expect(artifact).toMatch(/^art-/u)
    expect(platform.inits).toHaveLength(1)
    expect(platform.inits[0]).toMatchObject({
      artifact_id: artifact,
      kind: 'bundle',
      total_size: ARTIFACT_CHUNK_THRESHOLD_BYTES + 1,
      chunk_size: ARTIFACT_CHUNK_SIZE_BYTES,
      sha256: sha256Of(readFileSync(large)),
      meta: '{"branch":"feature/tsk_1"}',
    })
    const expected = Math.ceil((ARTIFACT_CHUNK_THRESHOLD_BYTES + 1) / ARTIFACT_CHUNK_SIZE_BYTES)
    expect(platform.chunks.map(chunk => chunk.index)).toEqual(
      Array.from({ length: expected - 1 }, (_unused, position) => position + 1),
    )
    // Every chunk but the last is full, and the last carries what is left of the file.
    expect(platform.chunks[0]?.bytes.byteLength).toBe(ARTIFACT_CHUNK_SIZE_BYTES)
    expect(platform.chunks.at(-1)?.bytes.byteLength)
      .toBe(ARTIFACT_CHUNK_THRESHOLD_BYTES + 1 - (expected - 1) * ARTIFACT_CHUNK_SIZE_BYTES)
    expect(platform.completed).toEqual(['upload-1'])
    // Nothing went through the single-request upload.
    expect(platform.uploads).toEqual([])
  })

  it('refuses a file over the node ceiling', async () => {
    const { directory } = workspaceWithScreenshot()
    const uploader = clientArtifactUploader({ client: new RecordingPlatform(), maxBytes: 4 })

    await expect(uploader.upload({ taskId: 'tsk_1', directory, kind: 'report', path: 'shots/detail.png' }))
      .rejects.toThrow(/over the 4 bytes this node uploads/)
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
