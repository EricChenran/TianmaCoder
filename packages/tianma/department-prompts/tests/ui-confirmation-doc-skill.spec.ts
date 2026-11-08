/**
 * The bundled UI 界面确认单 skill: the packaged tree must publish byte for byte
 * where the model's interpreter can read it, reach the 技术部 mode only, and
 * carry no machine-specific default that a packaged install would break on.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '@tianma/dsh-department-prompts'

const PERSONA = 'You are the rollout assistant.'
const SKILL_ASSET_ROOT = fileURLToPath(new URL('../skills/ui-confirmation-doc/', import.meta.url))
const temporaryDirectories: string[] = []

/** A directory this spec owns and removes after each case. */
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ui-confirmation-doc-skill-'))
  temporaryDirectories.push(directory)
  return directory
}

/** Every file under one directory, as skill-relative POSIX paths. */
function listFiles(root: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...listFiles(root, relative))
    else found.push(relative)
  }
  return found.sort()
}

/** Run one case with the harness home redirected into a directory this spec owns. */
async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporaryDirectory()
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('@tianma/dsh-department-prompts ui-confirmation-doc skill', () => {
  it('ships exactly the files the manifest lists', () => {
    expect(listFiles(SKILL_ASSET_ROOT)).toEqual([...plugin.UI_CONFIRMATION_DOC_SKILL_ASSET_FILES].sort())
  })

  it('publishes the skill byte for byte where the interpreter reads it', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.materializeUiConfirmationDocSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    for (const relativePath of plugin.UI_CONFIRMATION_DOC_SKILL_ASSET_FILES) {
      expect(readFileSync(join(skillDir, relativePath))).toEqual(readFileSync(join(SKILL_ASSET_ROOT, relativePath)))
    }
    // A repeated mount keeps the published bytes and reports the same directory.
    expect(plugin.materializeUiConfirmationDocSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    // A published script that drifted from the packaged copy is rewritten.
    const drifted = join(skillDir, 'scripts', 'web-capture.mjs')
    writeFileSync(drifted, 'console.log("stale")\n')
    plugin.materializeUiConfirmationDocSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })
    expect(readFileSync(drifted))
      .toEqual(readFileSync(join(SKILL_ASSET_ROOT, 'scripts', 'web-capture.mjs')))
  })

  it('publishes under the harness home when no directory is configured', () => {
    const home = temporaryDirectory()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const published = plugin.materializeUiConfirmationDocSkill()
      expect(published).toBe(join(home, 'department', 'skills', plugin.UI_CONFIRMATION_DOC_SKILL_NAME))
      expect(listFiles(published)).toEqual([...plugin.UI_CONFIRMATION_DOC_SKILL_ASSET_FILES].sort())
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('fails loud when the packaged skill is incomplete', () => {
    expect(() => plugin.materializeUiConfirmationDocSkill({
      assetRoot: temporaryDirectory(), skillDir: join(temporaryDirectory(), 'skill'),
    })).toThrow(/missing SKILL\.md/u)
  })

  it('registers the skill against the directory it published', async () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    try {
      expect(plugin.installUiConfirmationDocSkill(ctx, { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(true)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([plugin.UI_CONFIRMATION_DOC_SKILL_NAME])
      expect(catalog[0]).toMatchObject({
        source: 'bundled',
        provider: plugin.UI_CONFIRMATION_DOC_SKILL_PROVIDER_NAME,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: skillDir },
      })
      // The catalog line the model reads is capped at 500 characters by the tool
      // that publishes it; a longer description would lose its trigger words.
      expect(catalog[0]?.description.length).toBeGreaterThan(0)
      expect(catalog[0]?.description.length).toBeLessThanOrEqual(500)
      const loaded = await ctx.skills.get(plugin.UI_CONFIRMATION_DOC_SKILL_NAME)
      expect(loaded?.path).toBe(join(skillDir, 'SKILL.md'))
      expect(loaded?.content.startsWith('# UI 界面确认单')).toBe(true)
      expect(loaded?.content).toContain('scripts/web-capture.mjs')
      expect(loaded?.content).toContain('scripts/build_docx.py')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('gives the 技术部 mode the skill and drops it with the row', async () => {
    await withTemporaryHome(async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
      await ctx.plugin(SkillRegistry)
      try {
        const fiber = await ctx.plugin(plugin, { department: 'tech' })
        expect((await ctx.skills.list()).map(skill => skill.name))
          .toContain(plugin.UI_CONFIRMATION_DOC_SKILL_NAME)
        await fiber.dispose()
        expect(await ctx.skills.list()).toEqual([])
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it.each(['business', 'bid'] as const)('keeps the %s mode free of the confirmation-doc skill', async (department) => {
    await withTemporaryHome(async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
      await ctx.plugin(SkillRegistry)
      try {
        await ctx.plugin(plugin, { department })
        expect((await ctx.skills.list()).map(skill => skill.name))
          .not.toContain(plugin.UI_CONFIRMATION_DOC_SKILL_NAME)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('skips the skill when the composition mounts no skill registry', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.installUiConfirmationDocSkill(new Context(), { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(false)
    expect(existsSync(skillDir)).toBe(false)
  })

  it('ships a body and scripts free of machine-specific locations', () => {
    const raw = readFileSync(join(SKILL_ASSET_ROOT, 'SKILL.md'), 'utf8')
    expect(raw.startsWith('---\nname: ui-confirmation-doc\n')).toBe(true)
    for (const file of listFiles(SKILL_ASSET_ROOT)) {
      const content = readFileSync(join(SKILL_ASSET_ROOT, file), 'utf8')
      expect(content).not.toMatch(/[A-Za-z]:\\/u)
      expect(content).not.toContain('Administrator')
    }
    // Every path the body hands the model is skill-relative, so the published
    // directory — not a build machine — is what the scripts resolve against.
    expect(raw).toContain('scripts/mp-capture.cjs')
    expect(raw).toContain('references/scope-policy.md')
  })
})
