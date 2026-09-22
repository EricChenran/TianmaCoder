/**
 * Architecture-policy verifier for the Tianma group: every @tianma package's
 * static imports must stay inside its declared upstream seams, and relative
 * imports may not escape the module root. Fails CI on any violation, so
 * layering erodes nowhere silently.
 *
 * @module scripts/verify-architecture
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { load } from 'js-yaml'

interface ModulePolicy {
  id: string
  roots: readonly string[]
  requires?: readonly string[]
  upstreamSeams?: readonly string[]
}

export interface Policy {
  version: number
  modules: ModulePolicy[]
}

/** One import violation found in a module root. */
export interface ArchitectureViolation {
  readonly file: string
  readonly message: string
}

/** Parse architecture-policy.yaml's modules block (`!!js` tags stripped). */
export function parsePolicy(source: string): Policy {
  const parsed = load(source.replace(/!!js\s+/g, '')) as Policy
  if (parsed.version !== 1 || !Array.isArray(parsed.modules)) {
    throw new Error('architecture-policy.yaml: expected version 1 and a modules list')
  }
  return parsed
}

/** Extract static import specifiers from one TypeScript source. */
export function importSources(source: string): string[] {
  const from = /import\s+(?:type\s+\{\}|type\s+[^'";\n]+|\{[^}]*\}|[\w$*\s,]+?)\s+from\s+['"]([^'"]+)['"]/g
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  return [
    ...[...source.matchAll(from)].map(match => match[1]!),
    ...[...source.matchAll(bare)].map(match => match[1]!),
  ]
}

/** Seam specifier → policy key (cordis, schemastery, dsh-<name>). */
export function seamKey(specifier: string): string | undefined {
  if (specifier === '@deepseek-ai/cordis') return 'cordis'
  if (specifier === '@deepseek-ai/schemastery') return 'schemastery'
  const match = specifier.match(/^@deepseek-ai\/(dsh-[\w-]+)/)
  return match === null ? undefined : match[1]!
}

/**
 * Audit one module's sources against its declared policy.
 * @param absoluteRoot - absolute path of the module's src root.
 * @param modulePolicy - the module's declared seams.
 * @returns violations found in this root.
 */
export function auditModule(
  absoluteRoot: string,
  modulePolicy: ModulePolicy,
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []
  const declared = new Set(modulePolicy.upstreamSeams ?? [])
  for (const name of readdirSync(absoluteRoot).filter(entry => entry.endsWith('.ts'))) {
    const file = join(absoluteRoot, name)
    for (const specifier of importSources(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.')) {
        const target = resolve(absoluteRoot, specifier)
        if (!target.startsWith(absoluteRoot + sep) && target !== absoluteRoot) {
          violations.push({ file: join(modulePolicy.roots[0] ?? '', name), message: `relative import "${specifier}" escapes the module root` })
        }
        continue
      }
      if (specifier.startsWith('@tianma/')) {
        violations.push({ file: join(modulePolicy.roots[0] ?? '', name), message: `cross-package import "${specifier}" — tianma packages compose via the bundle` })
        continue
      }
      const seam = seamKey(specifier)
      if (seam === undefined || !declared.has(seam)) {
        violations.push({
          file: join(modulePolicy.roots[0] ?? '', name),
          message: `import "${specifier}" outside declared upstreamSeams (${[...declared].join(', ') || 'none'})`,
        })
      }
    }
  }
  return violations
}

/** Run the repository audit from architecture-policy.yaml. */
export function auditRepository(root: string): ArchitectureViolation[] {
  const policy = parsePolicy(readFileSync(join(root, 'architecture-policy.yaml'), 'utf8'))
  const violations: ArchitectureViolation[] = []
  for (const modulePolicy of policy.modules) {
    for (const moduleRoot of modulePolicy.roots) {
      const relativeRoot = join(moduleRoot, '')
      violations.push(...auditModule(resolve(root, moduleRoot), {
        ...modulePolicy,
        roots: [relativeRoot],
      }))
    }
  }
  return violations
}

/** CLI entry: `tsx scripts/verify-architecture.ts [root]`. */
function main(argv: readonly string[]): number {
  const root = argv[0] ?? process.cwd()
  const violations = auditRepository(root)
  for (const violation of violations) {
    process.stderr.write(`verify-architecture: ${violation.file}: ${violation.message}\n`)
  }
  if (violations.length > 0) return 1
  process.stdout.write('verify-architecture: tianma modules conform to architecture-policy.yaml\n')
  return 0
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/verify-architecture.ts')) {
  process.exitCode = main(process.argv.slice(2))
}
