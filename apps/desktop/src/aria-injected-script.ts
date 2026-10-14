import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'

const runtimeRequire = createRequire(import.meta.url)
const GENERATED_SOURCE_ASSIGNMENT = /const source\s*=\s*/
/**
 * Files this loader resolves inside the pinned Playwright package. The Desktop installer
 * copies exactly these into the archive, so the packaging file set and these entries move
 * together.
 */
export const ARIA_INJECTED_SCRIPT_FILES = ['package.json', 'lib/generated/injectedScriptSource.js'] as const

let cachedSource: string | undefined

function readStringLiteralEnd(source: string, start: number): number {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") {
    throw new Error('Playwright injected source assignment is not a string literal')
  }
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === quote) return index + 1
  }
  throw new Error('Playwright injected source string literal is unterminated')
}

/**
 * Playwright 1.59 does not expose the generated injected script as a public export.
 * The DOM snapshot runs the Apache-2.0 licensed Playwright runtime; this loader reads
 * only the string literal from the pinned dependency and caches it, avoiding a
 * hand-written copy of hundreds of kilobytes of generated code.
 * Approach mirrors ZCode's equivalent loader (read-only reference).
 */
export function getAriaInjectedScriptSource(): string {
  if (cachedSource !== undefined) return cachedSource

  const [packageJsonEntry, generatedEntry] = ARIA_INJECTED_SCRIPT_FILES
  const packageJsonPath = runtimeRequire.resolve(`playwright-core/${packageJsonEntry}`)
  const generatedSourcePath = join(dirname(packageJsonPath), generatedEntry)
  const generatedModule = readFileSync(generatedSourcePath, 'utf8')
  const assignment = GENERATED_SOURCE_ASSIGNMENT.exec(generatedModule)
  if (assignment === null) {
    throw new Error('Unable to locate Playwright injected source assignment')
  }
  const literalStart = assignment.index + assignment[0].length
  const literalEnd = readStringLiteralEnd(generatedModule, literalStart)
  const literal = generatedModule.slice(literalStart, literalEnd)
  // Decodes the single string literal from the pinned dependency; the generated module
  // itself is never executed and no web content passes through here.
  const decoded: unknown = runInNewContext(literal, {}, { timeout: 1_000 })
  if (
    typeof decoded !== 'string'
    || !decoded.includes('module.exports = __toCommonJS(injectedScript_exports)')
    || !decoded.includes('incrementalAriaSnapshot')
  ) {
    throw new Error('Playwright injected source failed integrity checks')
  }
  cachedSource = decoded
  return decoded
}
