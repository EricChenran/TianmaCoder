/**
 * The bundled 无头 Web 演示视频 skill: the packaged tree must publish byte for
 * byte where the model's interpreter can read it, reach the 技术部 mode alone,
 * and carry a body free of foreign harness syntax and host paths.
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

const PERSONA = 'You are the deployment assistant.'
const SKILL_ASSET_ROOT = fileURLToPath(new URL('../skills/web-demo-video/', import.meta.url))
const temporaryDirectories: string[] = []

/** A directory this spec owns and removes after each case. */
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'web-demo-video-skill-'))
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

describe('@tianma/dsh-department-prompts web-demo-video skill', () => {
  it('ships exactly the files the manifest lists', () => {
    expect(listFiles(SKILL_ASSET_ROOT)).toEqual([...plugin.WEB_DEMO_VIDEO_SKILL_ASSET_FILES].sort())
  })

  it('publishes the skill byte for byte where the interpreter reads it', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.materializeWebDemoVideoSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    for (const relativePath of plugin.WEB_DEMO_VIDEO_SKILL_ASSET_FILES) {
      expect(readFileSync(join(skillDir, relativePath))).toEqual(readFileSync(join(SKILL_ASSET_ROOT, relativePath)))
    }
    // A repeated mount keeps the published bytes and reports the same directory.
    expect(plugin.materializeWebDemoVideoSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    // A published script that drifted from the packaged copy is rewritten.
    const drifted = join(skillDir, 'scripts', 'lib', 'cdp.mjs')
    writeFileSync(drifted, 'export const stale = true\n')
    plugin.materializeWebDemoVideoSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })
    expect(readFileSync(drifted)).toEqual(readFileSync(join(SKILL_ASSET_ROOT, 'scripts', 'lib', 'cdp.mjs')))
  })

  it('publishes under the harness home when no directory is configured', () => {
    const home = temporaryDirectory()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const published = plugin.materializeWebDemoVideoSkill()
      expect(published).toBe(join(home, 'department', 'skills', plugin.WEB_DEMO_VIDEO_SKILL_NAME))
      expect(listFiles(published)).toEqual([...plugin.WEB_DEMO_VIDEO_SKILL_ASSET_FILES].sort())
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('fails loud when the packaged skill is incomplete', () => {
    expect(() => plugin.materializeWebDemoVideoSkill({
      assetRoot: temporaryDirectory(), skillDir: join(temporaryDirectory(), 'skill'),
    })).toThrow(/missing SKILL\.md/u)
  })

  it('registers the skill against the directory it published', async () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    try {
      expect(plugin.installWebDemoVideoSkill(ctx, { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(true)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([plugin.WEB_DEMO_VIDEO_SKILL_NAME])
      expect(catalog[0]).toMatchObject({
        source: 'bundled',
        provider: plugin.WEB_DEMO_VIDEO_SKILL_PROVIDER_NAME,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: skillDir },
      })
      expect(catalog[0]?.description.length).toBeGreaterThan(0)
      expect(catalog[0]?.description.length).toBeLessThanOrEqual(500)
      const loaded = await ctx.skills.get(plugin.WEB_DEMO_VIDEO_SKILL_NAME)
      expect(loaded?.path).toBe(join(skillDir, 'SKILL.md'))
      expect(loaded?.content.startsWith('# 无头 Web 演示视频制作')).toBe(true)
      expect(loaded?.content).toContain('scripts/webdemo.mjs')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(plugin.DEPARTMENTS)('gives the %s mode the skill only where the row registers it', async (department) => {
    await withTemporaryHome(async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
      await ctx.plugin(SkillRegistry)
      try {
        const fiber = await ctx.plugin(plugin, { department })
        const names = (await ctx.skills.list()).map(skill => skill.name)
        expect(names.includes(plugin.WEB_DEMO_VIDEO_SKILL_NAME)).toBe(department === 'tech')
        expect(names.includes(plugin.SKILL_NAME)).toBe(true)
        await fiber.dispose()
        expect(await ctx.skills.list()).toEqual([])
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('skips the skill when the composition mounts no skill registry', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.installWebDemoVideoSkill(new Context(), { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(false)
    expect(existsSync(skillDir)).toBe(false)
  })

  it('ships a skill body free of foreign harness syntax and host paths', () => {
    const raw = readFileSync(join(SKILL_ASSET_ROOT, 'SKILL.md'), 'utf8')
    expect(raw.startsWith('---\nname: web-demo-video\n')).toBe(true)
    for (const forbidden of ['zcode-file-citation', '::zcode', 'document-skills', '<本技能目录>',
      'DSH_DEPARTMENT_TOOLS', 'assets/business']) {
      expect(raw).not.toContain(forbidden)
    }
    expect(raw).not.toMatch(/[A-Za-z]:\\/u)
    expect(raw).toContain('scripts/webdemo.mjs')
    expect(raw).toContain('plan.json')
  })
})
