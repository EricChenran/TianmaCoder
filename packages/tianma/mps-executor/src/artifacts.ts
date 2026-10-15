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
import type { ExecArtifactKind, ExecArtifactUpload } from '@tianma/dsh-mps-exec-core'
import { resolveWithinWorkspace } from './paths.ts'

/** Size above which the protocol requires a chunked upload instead of one request. */
export const ARTIFACT_CHUNK_THRESHOLD_BYTES = 100 * 1024 * 1024

/** The artifact call the node makes. */
export interface ArtifactPlatformClient {
  /**
   * Upload one artifact for an attempt.
   * @param taskId - task id.
   * @param upload - the artifact, its contents, and the digest of those contents.
   * @param signal - caller cancellation.
   */
  uploadArtifact(taskId: string, upload: ExecArtifactUpload, signal?: AbortSignal): Promise<void>
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
      // The node uploads at most one request's worth: the protocol requires a chunked
      // upload above that, and this node does not implement one.
      const limit = Math.min(options.maxBytes, ARTIFACT_CHUNK_THRESHOLD_BYTES)
      if (details.size > limit) {
        throw new Error(
          `refusing to upload ${request.path}: it is ${String(details.size)} bytes, over the ${String(limit)} bytes this node uploads in one request`,
        )
      }
      const bytes = await readFile(path)
      const artifact = artifactId()
      await options.client.uploadArtifact(request.taskId, {
        artifact_id: artifact,
        kind: request.kind,
        filename: basename(path),
        bytes,
        sha256: sha256Of(bytes),
        meta: request.meta === undefined ? undefined : JSON.stringify(request.meta),
      }, request.signal)
      return artifact
    },
  }
}
