/**
 * The materials a task carries, brought into the workspace before an attempt runs.
 *
 * The platform states which artifacts belong to a task and the node fetches them, so
 * an agent works from the files the platform attached instead of from a list of ids.
 * A material the node cannot fetch or hold is a reason to stop rather than to guess:
 * the attempt reports `blocked`, which is what the protocol reserves for missing
 * information, and the platform raises a human confirm.
 * @module @tianma/dsh-mps-executor/materials
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ExecResource, ExecTaskAssignment } from '@tianma/dsh-mps-exec-core'
import { ARTIFACT_CHUNK_THRESHOLD_BYTES } from './artifacts.ts'
import { excludeFromRepository } from './paths.ts'

/** Directory the node keeps a task's materials in, inside its workspace. */
export const MATERIALS_DIRECTORY = '.materials'

/** One material the node brought into the workspace. */
export interface MaterialFile {
  /** Artifact the platform stated. */
  artifact_id: string
  /** File name the platform stated, when it stated one. */
  file_name?: string | undefined
  /** Path relative to the workspace. */
  path: string
  /** Digest the node verified the contents against. */
  sha256: string
}

/** The material call the node makes. */
export interface MaterialSource {
  /**
   * Download one task material, verified against the digest the platform states.
   * @param artifactId - the material.
   * @param signal - caller cancellation.
   * @returns the verified contents and the digest.
   */
  resource(artifactId: string, signal?: AbortSignal): Promise<ExecResource>
}

/** What bringing one task's materials in needs. */
export interface FetchMaterialsOptions {
  /** The workspace directory. */
  directory: string
  /** The assignment a claim returned. */
  assignment: ExecTaskAssignment
  /** Where the materials come from. */
  source: MaterialSource
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/**
 * The materials a payload states: the context's own list plus what its messages
 * reference, deduplicated in the order the payload states them.
 * @param payload - the payload a claim returned.
 * @returns the artifact ids.
 */
export function taskMaterials(payload: Record<string, unknown>): string[] {
  const context = record(payload['context'])
  const ids = strings(context['resources'])
  const transcript = record(context['chat_transcript'])
  for (const message of list(transcript['messages'])) {
    for (const attachment of list(record(message)['resources'])) {
      const id = text(record(attachment)['artifact_id'])
      if (id !== undefined && isUsableId(id)) ids.push(id)
    }
  }
  return [...new Set(ids.filter(isUsableId))]
}

/**
 * The file name one material is written under, with whatever the platform stated
 * reduced to a name inside the materials directory.
 * @param artifactId - the artifact the platform stated.
 * @param fileName - the file name the platform stated, if any.
 * @returns the file name to write.
 */
export function materialFileName(artifactId: string, fileName?: string | undefined): string {
  const stated = fileName === undefined ? '' : basename(fileName).replace(/[/\\:]/gu, '').trim()
  const safe = stated === '' || stated === '.' || stated === '..' ? artifactId : `${artifactId}_${stated}`
  return safe
}

/**
 * Bring one task's materials into its workspace.
 * @param options - the workspace, the assignment, and where materials come from.
 * @returns the materials written, in the order the payload states them.
 * @throws Error on a material the platform refuses, one larger than the node will
 * hold, or one whose name cannot be made safe.
 */
export async function fetchMaterials(options: FetchMaterialsOptions): Promise<MaterialFile[]> {
  const ids = taskMaterials(options.assignment.payload)
  if (ids.length === 0) return []
  const directory = join(options.directory, MATERIALS_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  excludeFromRepository(options.directory, `${MATERIALS_DIRECTORY}/`)
  const names = attachmentNames(options.assignment.payload)
  const written: MaterialFile[] = []
  for (const id of ids) {
    const resource = await options.source.resource(id, options.signal)
    if (resource.bytes.byteLength > ARTIFACT_CHUNK_THRESHOLD_BYTES) {
      throw new Error(
        `material ${id} is ${String(resource.bytes.byteLength)} bytes, over the ${String(ARTIFACT_CHUNK_THRESHOLD_BYTES)} bytes this node fetches in one request`,
      )
    }
    const fileName = materialFileName(id, names.get(id))
    const path = join(MATERIALS_DIRECTORY, fileName)
    writeFileSync(join(options.directory, path), resource.bytes)
    written.push({ artifact_id: id, file_name: names.get(id), path, sha256: resource.sha256 })
  }
  return written
}

/**
 * The file names a payload states for the artifacts its messages reference.
 * @param payload - the payload a claim returned.
 * @returns the names by artifact id.
 */
function attachmentNames(payload: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>()
  const transcript = record(record(payload['context'])['chat_transcript'])
  for (const message of list(transcript['messages'])) {
    for (const attachment of list(record(message)['resources'])) {
      const stated = record(attachment)
      const id = text(stated['artifact_id'])
      const name = text(stated['file_name'])
      if (id !== undefined && name !== undefined) names.set(id, name)
    }
  }
  return names
}

/**
 * Whether an id the platform stated can name a file inside the workspace.
 * @param id - the id.
 * @returns true when it carries no path and no separator.
 */
function isUsableId(id: string): boolean {
  return id !== '.' && id !== '..' && /^[A-Za-z0-9._-]+$/u.test(id)
}

/**
 * Read one value as a record.
 * @param value - the value.
 * @returns the record, or an empty one.
 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Read one value as a non-empty string.
 * @param value - the value.
 * @returns the string, or undefined.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read one value as a list of non-empty strings.
 * @param value - the value.
 * @returns the strings.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/**
 * Read one value as a list.
 * @param value - the value.
 * @returns the list, or an empty one.
 */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
