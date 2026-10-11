/**
 * Resolve the private workspace packages the Desktop package set has to pack.
 *
 * `release:pack` publishes the public `@deepseek-ai/*` manifests of one family, so
 * a private workspace package supplies no tarball of its own. When the closure walk
 * in `prepare-package-set.ts` reaches one anyway — the product bundle declares the
 * product plugins it mounts as runtime dependencies — the walk fails with
 * `... requires unpacked package ...`. Walking the same roots and manifest sections
 * over workspace manifests instead of packed tarballs names that set first, so the
 * pack stages supply it and the closure is complete.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import {
  dependencyNames,
  DESKTOP_PACKAGE_SET_ROOTS,
  REQUIRED_DEPENDENCY_SECTIONS,
} from './prepare-package-set.ts'

/** One private workspace package `pnpm pack` supplies to the package set. */
export interface UnpackedWorkspacePackage {
  readonly name: string
  /** Repository-relative directory `pnpm pack` runs in. */
  readonly directory: string
}

/** One workspace package the product runtime can reach through manifest declarations. */
interface WorkspacePackage {
  readonly directory: string
  readonly manifest: Readonly<Record<string, unknown>>
}

/** Read a package manifest as a JSON object. */
function readManifest(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Index every workspace manifest by package name, located through the workspace globs. */
function workspacePackages(repositoryRoot: string): Map<string, WorkspacePackage> {
  const workspace = yaml.load(readFileSync(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const packages = new Map<string, WorkspacePackage>()
  const manifests = globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: repositoryRoot })
  for (const manifestPath of manifests) {
    const normalized = manifestPath.replaceAll('\\', '/')
    const manifest = readManifest(resolve(repositoryRoot, normalized))
    const name = manifest.name
    if (typeof name !== 'string' || name === '') continue
    packages.set(name, { directory: normalized.slice(0, normalized.length - '/package.json'.length), manifest })
  }
  return packages
}

/**
 * Select the private workspace packages the package set's closure reaches.
 *
 * The walk follows the same roots and manifest sections as the closure walk it
 * anticipates, because every workspace package reachable there must exist as a
 * tarball: npm resolves everything outside the workspace, and a public
 * `@deepseek-ai/*` package under `packages/*` is already a release-family member.
 * @param repositoryRoot - repository root holding the workspace manifest.
 * @param alreadyPacked - package names an earlier pack stage already emitted.
 * @returns Selected packages sorted by name; empty when the released families already cover the closure.
 */
export function unpackedWorkspacePackages(
  repositoryRoot: string,
  alreadyPacked: readonly string[],
): UnpackedWorkspacePackage[] {
  const workspace = workspacePackages(repositoryRoot)
  const packed = new Set(alreadyPacked)
  const visited = new Set<string>()
  const selected = new Map<string, UnpackedWorkspacePackage>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const candidate = workspace.get(name)
    if (candidate === undefined) return
    if (candidate.manifest.private === true && !packed.has(name)) {
      selected.set(name, { name, directory: candidate.directory })
    }
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(candidate.manifest, section)) visit(dependency)
    }
  }
  for (const root of DESKTOP_PACKAGE_SET_ROOTS) visit(root)
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name))
}
