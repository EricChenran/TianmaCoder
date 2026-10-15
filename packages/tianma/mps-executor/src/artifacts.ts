/**
 * Uploading what an attempt produced. The node owns the parts the platform verifies
 * or constrains: it reads the file only from inside the workspace, computes the
 * digest the platform checks the contents against, mints the idempotency key, and
 * refuses a file beyond the size the protocol allows in one request rather than
 * letting a transfer fail halfway.
 * @module @tianma/dsh-mps-executor/artifacts
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { artifactId, sha256Of } from '@tianma/dsh-mps-exec-core'
import type {
  ExecArtifactKind,
  ExecArtifactUpload,
  ExecArtifactUploadInit,
  ExecArtifactUploadSession,
} from '@tianma/dsh-mps-exec-core'
import { resolveWithinWorkspace } from './paths.ts'

/** Size above which the protocol requires a chunked upload instead of one request. */
export const ARTIFACT_CHUNK_THRESHOLD_BYTES = 100 * 1024 * 1024

/** Size of one chunk in a chunked upload, small enough for one request's budget. */
export const ARTIFACT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024

/** The artifact calls the node makes. */
export interface ArtifactPlatformClient {
  /**
   * Upload one artifact for an attempt.
   * @param taskId - task id.
   * @param upload - the artifact, its contents, and the digest of those contents.
   * @param signal - caller cancellation.
   */
  uploadArtifact(taskId: string, upload: ExecArtifactUpload, signal?: AbortSignal): Promise<void>
  /**
   * Open a chunked upload for an artifact too large for one request.
   * @param taskId - the task the artifact belongs to.
   * @param init - the artifact, its size, its digest, and the chunk size.
   * @param signal - caller cancellation.
   * @returns the upload the platform opened and the chunks it already holds.
   */
  initArtifact(
    taskId: string,
    init: ExecArtifactUploadInit,
    signal?: AbortSignal,
  ): Promise<ExecArtifactUploadSession>
  /**
   * Send one chunk of an open upload.
   * @param taskId - the task the artifact belongs to.
   * @param uploadId - the upload the platform opened.
   * @param index - the chunk's index.
   * @param bytes - the chunk's contents.
   * @param signal - caller cancellation.
   */
  uploadArtifactChunk(
    taskId: string,
    uploadId: string,
    index: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>
  /**
   * Close an open upload, which makes the platform verify the whole artifact.
   * @param taskId - the task the artifact belongs to.
   * @param uploadId - the upload the platform opened.
   * @param signal - caller cancellation.
   */
  completeArtifact(taskId: string, uploadId: string, signal?: AbortSignal): Promise<void>
}

/** What one artifact upload tells the node. */
export interface TaskArtifactRequest {
  /** The task the artifact belongs to. */
  taskId: string
  /** The workspace directory the file lives in. */
  directory: string
  /** What the file is. */
  kind: ExecArtifactKind
  /** Path of the file, relative to the workspace. */
  path: string
  /** What the platform keeps beside the artifact. */
  meta?: Record<string, unknown> | undefined
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/** Uploads what an attempt produced. */
export interface TaskArtifactUploader {
  /**
   * Upload one file from an attempt's workspace.
   * @param request - the task, the workspace, and the file.
   * @returns the artifact id the platform stored it under.
   */
  upload(request: TaskArtifactRequest): Promise<string>
}

/** Options for {@link clientArtifactUploader}. */
export interface ArtifactUploaderOptions {
  /** The authenticated session's client. */
  client: ArtifactPlatformClient
  /** Largest artifact this node uploads, from its own configuration. */
  maxBytes: number
}

/**
 * Send one artifact as chunks: open the upload, send the chunks the platform does not
 * hold yet, then close it, which is when the platform verifies the whole digest. A
 * reopened upload reports the chunks it already has, so a retry sends only the rest.
 * @param client - the artifact calls the node makes.
 * @param upload - the artifact, its contents, and the digest of those contents.
 * @throws Error when the platform refuses a call.
 */
async function uploadInChunks(
  client: ArtifactPlatformClient,
  upload: {
    taskId: string
    artifact_id: string
    kind: ExecArtifactKind
    bytes: Uint8Array
    sha256: string
    meta?: string | undefined
    signal?: AbortSignal | undefined
  },
): Promise<void> {
  const total = Math.ceil(upload.bytes.byteLength / ARTIFACT_CHUNK_SIZE_BYTES)
  const session = await client.initArtifact(upload.taskId, {
    artifact_id: upload.artifact_id,
    kind: upload.kind,
    total_size: upload.bytes.byteLength,
    chunk_size: ARTIFACT_CHUNK_SIZE_BYTES,
    sha256: upload.sha256,
    meta: upload.meta,
  }, upload.signal)
  const held = new Set(session.uploaded_chunks)
  for (let index = 0; index < total; index += 1) {
    if (held.has(index)) continue
    const start = index * ARTIFACT_CHUNK_SIZE_BYTES
    await client.uploadArtifactChunk(
      upload.taskId,
      session.upload_id,
      index,
      upload.bytes.subarray(start, start + ARTIFACT_CHUNK_SIZE_BYTES),
      upload.signal,
    )
  }
  await client.completeArtifact(upload.taskId, session.upload_id, upload.signal)
}

/**
 * The node's artifact uploader: workspace-confined reads, the platform's digest, and
 * a size the node can actually transfer.
 * @param options - the platform client and this node's artifact limit.
 * @returns the uploader the orchestrator hands to a runner.
 */
export function clientArtifactUploader(options: ArtifactUploaderOptions): TaskArtifactUploader {
  return {
    async upload(request: TaskArtifactRequest): Promise<string> {
      const path = await resolveWithinWorkspace(request.directory, request.path)
      const details = await stat(path).catch(() => undefined)
      if (details === undefined || !details.isFile()) {
        throw new Error(`refusing to upload ${request.path}: it is not a file in the workspace`)
      }
      // The node's own ceiling is the smaller of what the platform and this node declared;
      // above the protocol's threshold the upload has to be sent in chunks.
      if (details.size > options.maxBytes) {
        throw new Error(
          `refusing to upload ${request.path}: it is ${String(details.size)} bytes, over the ${String(options.maxBytes)} bytes this node uploads`,
        )
      }
      const bytes = await readFile(path)
      const artifact = artifactId()
      const sha256 = sha256Of(bytes)
      const meta = request.meta === undefined ? undefined : JSON.stringify(request.meta)
      if (details.size > ARTIFACT_CHUNK_THRESHOLD_BYTES) {
        await uploadInChunks(options.client, {
          taskId: request.taskId,
          artifact_id: artifact,
          kind: request.kind,
          bytes,
          sha256,
          meta,
          signal: request.signal,
        })
        return artifact
      }
      await options.client.uploadArtifact(request.taskId, {
        artifact_id: artifact,
        kind: request.kind,
        filename: basename(path),
        bytes,
        sha256,
        meta,
      }, request.signal)
      return artifact
    },
  }
}
