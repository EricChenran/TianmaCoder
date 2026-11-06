/**
 * The bundled 方案书/投标文件 skill: the packaged tree must publish byte for byte
 * where the model's interpreter can read it, reach the 商务部 mode alone, and
 * carry a body free of foreign harness syntax and host paths.
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
const SKILL_ASSET_ROOT = fileURLToPath(new URL('../skills/proposal-doc/', import.meta.url))
const temporaryDirectories: string[] = []

/** A directory this spec owns and removes after each case. */
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-doc-skill-'))
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

describe('@tianma/dsh-department-prompts proposal-doc skill', () => {
  it('ships exactly the files the manifest lists', () => {
    expect(listFiles(SKILL_ASSET_ROOT)).toEqual([...plugin.PROPOSAL_DOC_SKILL_ASSET_FILES].sort())
  })

  it('publishes the skill byte for byte where the interpreter reads it', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.materializeProposalDocSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    for (const relativePath of plugin.PROPOSAL_DOC_SKILL_ASSET_FILES) {
      expect(readFileSync(join(skillDir, relativePath))).toEqual(readFileSync(join(SKILL_ASSET_ROOT, relativePath)))
    }
    // A repeated mount keeps the published bytes and reports the same directory.
    expect(plugin.materializeProposalDocSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    // A published script that drifted from the packaged copy is rewritten.
    const drifted = join(skillDir, 'scripts', 'docbuild.py')
    writeFileSync(drifted, '# stale\n')
    plugin.materializeProposalDocSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })
    expect(readFileSync(drifted)).toEqual(readFileSync(join(SKILL_ASSET_ROOT, 'scripts', 'docbuild.py')))
  })

  it('publishes under the harness home when no directory is configured', () => {
    const home = temporaryDirectory()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const published = plugin.materializeProposalDocSkill()
      expect(published).toBe(join(home, 'department', 'skills', plugin.PROPOSAL_DOC_SKILL_NAME))
      expect(listFiles(published)).toEqual([...plugin.PROPOSAL_DOC_SKILL_ASSET_FILES].sort())
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('fails loud when the packaged skill is incomplete', () => {
    expect(() => plugin.materializeProposalDocSkill({
      assetRoot: temporaryDirectory(), skillDir: join(temporaryDirectory(), 'skill'),
    })).toThrow(/missing SKILL\.md/u)
  })

  it('registers the skill against the directory it published', async () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    try {
      expect(plugin.installProposalDocSkill(ctx, { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(true)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([plugin.PROPOSAL_DOC_SKILL_NAME])
      expect(catalog[0]).toMatchObject({
        source: 'bundled',
        provider: plugin.PROPOSAL_DOC_SKILL_PROVIDER_NAME,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: skillDir },
      })
      expect(catalog[0]?.description.length).toBeGreaterThan(0)
      expect(catalog[0]?.description.length).toBeLessThanOrEqual(500)
      const loaded = await ctx.skills.get(plugin.PROPOSAL_DOC_SKILL_NAME)
      expect(loaded?.path).toBe(join(skillDir, 'SKILL.md'))
      expect(loaded?.content.startsWith('# 方案书与投标文件')).toBe(true)
      expect(loaded?.content).toContain('scripts/docbuild.py')
      expect(loaded?.content).toContain('references/bid-playbook.md')
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
        expect(names.includes(plugin.PROPOSAL_DOC_SKILL_NAME)).toBe(department === 'business' || department === 'bid')
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
    expect(plugin.installProposalDocSkill(new Context(), { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(false)
    expect(existsSync(skillDir)).toBe(false)
  })

  it('ships a skill body free of foreign harness syntax and host paths', () => {
    const raw = readFileSync(join(SKILL_ASSET_ROOT, 'SKILL.md'), 'utf8')
    expect(raw.startsWith('---\nname: proposal-doc\n')).toBe(true)
    for (const forbidden of ['zcode-file-citation', '::zcode', 'document-skills', '<本技能目录>',
      'DSH_DEPARTMENT_TOOLS', 'assets/business']) {
      expect(raw).not.toContain(forbidden)
    }
    expect(raw).not.toMatch(/[A-Za-z]:\\/u)
    expect(raw).toContain('scripts/docbuild.py')
    expect(raw).toContain('content_template_bid.py')
  })

  it('ships a bid playbook the mode can actually follow', () => {
    const playbook = readFileSync(join(SKILL_ASSET_ROOT, 'references', 'bid-playbook.md'), 'utf8')
    expect(playbook).toContain('废标红线清单')
    expect(playbook).toContain('偏离表')
    expect(playbook).toContain('应答核对表')
    expect(playbook).not.toMatch(/[A-Za-z]:\\/u)
  })
})
