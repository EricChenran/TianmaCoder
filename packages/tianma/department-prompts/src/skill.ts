/**
 * The bundled 公文 (official document) skill and the bundled 无头演示视频 skill.
 *
 * The 商务部 and 技术部 presets are the only rows that mount
 * `@tianma/dsh-department-prompts`, and a provider registers into the calling
 * context's layer, so registering here scopes a skill to exactly those modes.
 * The 公文 skill serves both departments; the 演示视频 skill is registered only
 * by the 技术部 row, through its own provider name.
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

/** One bundled skill: what the model addresses, what ships, and where it lives in the package. */
interface BundledSkill {
  /** Skill name the model addresses, and the directory name it publishes under. */
  readonly name: string
  /** Relative paths the published copy must carry, checked before anything is published. */
  readonly assetFiles: readonly string[]
  /** The installed package's own directory for this skill. */
  readonly packagedRoot: string
}

/** The 公文 skill, carried by both department modes. */
const OFFICIAL_DOC_SKILL: BundledSkill = {
  name: 'official-doc',
  assetFiles: [
    'SKILL.md',
    'scripts/gen_doc.py',
    'assets/logo_light.png',
  ],
  packagedRoot: fileURLToPath(new URL('../skills/official-doc/', import.meta.url)),
}

/** The 无头 Web 演示视频 skill, carried by the 技术部 mode only. */
const WEB_DEMO_VIDEO_SKILL: BundledSkill = {
  name: 'web-demo-video',
  assetFiles: [
    'SKILL.md',
    'CHANGELOG.md',
    'references/environment-matrix.md',
    'references/pitfalls.md',
    'references/plan-example-13steps.json',
    'references/plan-example.json',
    'references/step-dsl.md',
    'scripts/lib/capture.mjs',
    'scripts/lib/cdp.mjs',
    'scripts/lib/env.mjs',
    'scripts/lib/media.mjs',
    'scripts/lib/page.mjs',
    'scripts/webdemo.mjs',
  ],
  packagedRoot: fileURLToPath(new URL('../skills/web-demo-video/', import.meta.url)),
}

/** Skill name the model addresses, and the directory name it publishes under. */
export const SKILL_NAME = OFFICIAL_DOC_SKILL.name

/** Provider name the 公文 skill registers on the skill registry. */
export const SKILL_PROVIDER_NAME = 'tianma-department'

/** Relative paths the 公文 skill's published copy must carry. */
export const SKILL_ASSET_FILES = OFFICIAL_DOC_SKILL.assetFiles

/** Skill name the 技术部-only 演示视频 skill publishes under. */
export const WEB_DEMO_VIDEO_SKILL_NAME = WEB_DEMO_VIDEO_SKILL.name

/**
 * Provider name the 演示视频 skill registers on the skill registry. It differs
 * from `SKILL_PROVIDER_NAME` because one registry layer rejects a second
 * provider under a name it already holds.
 */
export const WEB_DEMO_VIDEO_SKILL_PROVIDER_NAME = 'tianma-department-web-demo-video'

/** Relative paths the 演示视频 skill's published copy must carry. */
export const WEB_DEMO_VIDEO_SKILL_ASSET_FILES = WEB_DEMO_VIDEO_SKILL.assetFiles

/** Where a bundled skill is published from, and where it is published to. */
export interface DepartmentSkillOptions {
  /** Packaged skill directory; defaults to this package's own directory for the skill. */
  assetRoot?: string
  /** Published skill directory; defaults to `<harness home>/department/skills/<name>`. */
  skillDir?: string
}

/** Fail loud when the packaged copy cannot serve the documented workflow. */
function assertPackagedSkill(skill: BundledSkill, assetRoot: string): void {
  for (const relativePath of skill.assetFiles) {
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

/** Publish one packaged skill into a directory the model's interpreter can read. */
function materializeSkill(skill: BundledSkill, options: DepartmentSkillOptions): string {
  const assetRoot = options.assetRoot ?? skill.packagedRoot
  const skillDir = options.skillDir ?? join(resolveDshHome(), 'department', 'skills', skill.name)
  assertPackagedSkill(skill, assetRoot)
  copySkillTree(assetRoot, skillDir)
  return skillDir
}

/**
 * Publish the packaged 公文 skill into a directory the model's interpreter can read.
 * @param options - asset and destination overrides, both optional.
 * @returns the absolute published skill directory.
 */
export function materializeDepartmentSkill(options: DepartmentSkillOptions = {}): string {
  return materializeSkill(OFFICIAL_DOC_SKILL, options)
}

/**
 * Publish the packaged 演示视频 skill into a directory the model's interpreter can read.
 * @param options - asset and destination overrides, both optional.
 * @returns the absolute published skill directory.
 */
export function materializeWebDemoVideoSkill(options: DepartmentSkillOptions = {}): string {
  return materializeSkill(WEB_DEMO_VIDEO_SKILL, options)
}

/** Description and body read from one skill document's frontmatter. */
interface SkillDocument {
  name: string
  description: string
  content: string
}

/** Parse the frontmatter contract a bundled skill must satisfy. */
function readSkillDocument(skill: BundledSkill, raw: string, path: string): SkillDocument {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`department-prompts: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const record = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}
  const { name, description } = record
  if (name !== skill.name) throw new Error(`department-prompts: ${path} names the skill ${String(name)}`)
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`department-prompts: ${path} has no description`)
  }
  return { name, description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Publish one bundled skill and register it on the skill registry.
 *
 * The registration is skipped when the composition mounts no skill registry:
 * the department rules still load, and the skill stays absent.
 */
function installSkill(ctx: Context, skill: BundledSkill, providerName: string, options: DepartmentSkillOptions): boolean {
  const skills = ctx.get('skills')
  if (skills === undefined) return false
  const directory = materializeSkill(skill, options)
  const instructionPath = join(directory, 'SKILL.md')
  const document = readSkillDocument(skill, readFileSync(instructionPath, 'utf8'), instructionPath)
  const candidate: SkillCandidate = {
    name: document.name,
    description: document.description,
    path: instructionPath,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: providerName,
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
    locator: instructionPath,
  }
  const provider: SkillProvider = {
    name: providerName,
    list: () => Promise.resolve([candidate]),
    async get(loaded: SkillCandidate, lookup: SkillLookupOptions) {
      const { rank: _rank, locator, ...summary } = loaded
      const path = locator as string
      // The published copy is the one the model reads; re-read it so an edited
      // body reaches the next load without a restart.
      const raw = await readFile(path, { encoding: 'utf8', signal: lookup.signal })
      return { ...summary, content: readSkillDocument(skill, raw, path).content }
    },
  }
  // `registerProvider` returns the exact Cordis effect disposer; yielding it
  // here keeps the registration tied to this row's fiber.
  ctx.effect(() => skills.registerProvider(() => provider))
  return true
}

/**
 * Publish the bundled 公文 skill and register it on the skill registry.
 * @param ctx - plugin context that owns the publication and the provider registration.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the provider was registered.
 */
export function installDepartmentSkill(ctx: Context, options: DepartmentSkillOptions = {}): boolean {
  return installSkill(ctx, OFFICIAL_DOC_SKILL, SKILL_PROVIDER_NAME, options)
}

/**
 * Publish the bundled 演示视频 skill and register it on the skill registry.
 *
 * Only the 技术部 row calls this, so no other mode's model sees the skill.
 * @param ctx - plugin context that owns the publication and the provider registration.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the provider was registered.
 */
export function installWebDemoVideoSkill(ctx: Context, options: DepartmentSkillOptions = {}): boolean {
  return installSkill(ctx, WEB_DEMO_VIDEO_SKILL, WEB_DEMO_VIDEO_SKILL_PROVIDER_NAME, options)
}
