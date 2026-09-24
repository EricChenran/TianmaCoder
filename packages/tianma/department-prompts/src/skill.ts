/**
 * The bundled 公文 (official document) skill for the department modes.
 *
 * The 商务部 and 技术部 presets are the only rows that mount
 * `@tianma/dsh-department-prompts`, and a provider registers into the calling
 * context's layer, so registering here scopes the skill to exactly those two
 * modes.
 *
 * Two locations matter. The packaged skill directory travels inside the
 * application runtime archive, which only the Host process can read — the
 * model's shell interpreter cannot open a path in there. The published copy
 * under the harness home carries the same bytes at a real path, and the
 * resource base reported beside the loaded body tells the model where it is.
 *
 * @module @tianma/dsh-department-prompts/skill
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillLookupOptions, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Skill name the model addresses, and the directory name it publishes under. */
export const SKILL_NAME = 'official-doc'

/** Provider name this row registers on the skill registry. */
export const SKILL_PROVIDER_NAME = 'tianma-department'

/** Relative paths the published copy must carry, checked before anything is published. */
export const SKILL_ASSET_FILES: readonly string[] = [
  'SKILL.md',
  'scripts/gen_doc.py',
  'assets/logo_light.png',
]

/** Where the skill is published from, and where it is published to. */
export interface DepartmentSkillOptions {
  /** Packaged skill directory; defaults to this package's `skills/official-doc/`. */
  assetRoot?: string
  /** Published skill directory; defaults to `<harness home>/department/skills/official-doc`. */
  skillDir?: string
}

/** The installed package's own skill directory. */
function packagedSkillRoot(): string {
  return fileURLToPath(new URL('../skills/official-doc/', import.meta.url))
}

/** Fail loud when the packaged copy cannot serve the documented workflow. */
function assertPackagedSkill(assetRoot: string): void {
  for (const relativePath of SKILL_ASSET_FILES) {
    if (!existsSync(join(assetRoot, relativePath))) {
      throw new Error(`department-prompts: packaged skill is missing ${relativePath} under ${assetRoot}`)
    }
  }
}

/** Copy one packaged skill tree, rewriting only files whose bytes differ. */
function copySkillTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      copySkillTree(from, to)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`department-prompts: packaged skill holds a non-file entry ${from}`)
    }
    const content = readFileSync(from)
    if (!existsSync(to) || !readFileSync(to).equals(content)) writeFileSync(to, content)
  }
}

/**
 * Publish the packaged skill into a directory the model's interpreter can read.
 * @param options - asset and destination overrides, both optional.
 * @returns the absolute published skill directory.
 */
export function materializeDepartmentSkill(options: DepartmentSkillOptions = {}): string {
  const assetRoot = options.assetRoot ?? packagedSkillRoot()
  const skillDir = options.skillDir ?? join(resolveDshHome(), 'department', 'skills', SKILL_NAME)
  assertPackagedSkill(assetRoot)
  copySkillTree(assetRoot, skillDir)
  return skillDir
}

/** Description and body read from one skill document's frontmatter. */
interface SkillDocument {
  name: string
  description: string
  content: string
}

/** Parse the frontmatter contract this package's own skill must satisfy. */
function readSkillDocument(raw: string, path: string): SkillDocument {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`department-prompts: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const record = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}
  const { name, description } = record
  if (name !== SKILL_NAME) throw new Error(`department-prompts: ${path} names the skill ${String(name)}`)
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`department-prompts: ${path} has no description`)
  }
  return { name, description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Publish the bundled skill and register it on the skill registry.
 *
 * The registration is skipped when the composition mounts no skill registry:
 * the department rules still load, and the skill stays absent.
 * @param ctx - plugin context that owns the publication and the provider registration.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the provider was registered.
 */
export function installDepartmentSkill(ctx: Context, options: DepartmentSkillOptions = {}): boolean {
  const skills = ctx.get('skills')
  if (skills === undefined) return false
  const directory = materializeDepartmentSkill(options)
  const instructionPath = join(directory, 'SKILL.md')
  const document = readSkillDocument(readFileSync(instructionPath, 'utf8'), instructionPath)
  const candidate: SkillCandidate = {
    name: document.name,
    description: document.description,
    path: instructionPath,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: SKILL_PROVIDER_NAME,
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
    locator: instructionPath,
  }
  const provider: SkillProvider = {
    name: SKILL_PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    async get(loaded: SkillCandidate, lookup: SkillLookupOptions) {
      const { rank: _rank, locator, ...summary } = loaded
      const path = locator as string
      // The published copy is the one the model reads; re-read it so an edited
      // body reaches the next load without a restart.
      const raw = await readFile(path, { encoding: 'utf8', signal: lookup.signal })
      return { ...summary, content: readSkillDocument(raw, path).content }
    },
  }
  // `registerProvider` returns the exact Cordis effect disposer; yielding it
  // here keeps the registration tied to this row's fiber.
  ctx.effect(() => skills.registerProvider(() => provider))
  return true
}
