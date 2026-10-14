/** The bundled Web GUI 黑盒测试 skill owns its registry candidate and extracted resource directory. */

import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { registerWebGuiTesterSkill, WEB_GUI_TESTER_SKILL, WEB_GUI_TESTER_SKILL_PROVIDER } from '../src/skill.ts'

describe('bundled Web GUI tester skill', () => {
  it('registers the packaged body and removes the candidate on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin({
        name: 'web-gui-tester-skill-registration',
        inject: ['skills'],
        apply: (inner: Context) => { registerWebGuiTesterSkill(inner) },
      })

      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([WEB_GUI_TESTER_SKILL])
      const entry = catalog[0]!
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeLessThanOrEqual(500)
      expect(entry).toMatchObject({
        source: 'bundled',
        provider: WEB_GUI_TESTER_SKILL_PROVIDER,
        invocation: { modelInvocable: true, userInvocable: true },
      })

      const loaded = await ctx.skills.get(WEB_GUI_TESTER_SKILL)
      expect(loaded?.resourceBase).toMatchObject({ kind: 'directory' })
      if (loaded?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      const resourceDirectory = loaded.resourceBase.path
      // The model receives the body, not the frontmatter the provider parsed.
      expect(loaded?.content.startsWith('# Web GUI 黑盒测试')).toBe(true)
      expect(loaded?.content).not.toContain('name: web-gui-tester')
      expect(loaded?.content).toContain('browser_snapshot')
      expect(loaded?.content).toContain('gui-test-screenshots')

      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
      expect(existsSync(resourceDirectory)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reloads the extracted copy, so an edited body reaches the next load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'web-gui-tester-edited-copy', inject: ['skills'], apply: registerWebGuiTesterSkill })
      const skill = await ctx.skills.get(WEB_GUI_TESTER_SKILL)
      if (skill?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      const edited = readFileSync(join(skill.resourceBase.path, 'SKILL.md'), 'utf8').replace('# Web GUI 黑盒测试', '# Edited')
      writeFileSync(join(skill.resourceBase.path, 'SKILL.md'), edited)
      expect((await ctx.skills.get(WEB_GUI_TESTER_SKILL))?.content.startsWith('# Edited')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['missing frontmatter', '# Invalid skill', 'has no YAML frontmatter'],
    ['non-object metadata', '---\nnull\n---\nBody', 'has no description'],
    ['empty description', '---\ndescription: ""\n---\nBody', 'has no description'],
    ['empty body', '---\nname: web-gui-tester\ndescription: ok\n---\n\n   ', 'has an empty body'],
  ])('rejects an extracted skill with %s', async (_name, raw, message) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'web-gui-tester-invalid-resource', inject: ['skills'], apply: registerWebGuiTesterSkill })
      const skill = await ctx.skills.get(WEB_GUI_TESTER_SKILL)
      if (skill?.resourceBase?.kind !== 'directory') throw new Error('Missing physical skill resource directory')
      writeFileSync(join(skill.resourceBase.path, 'SKILL.md'), raw)
      await expect(ctx.skills.get(WEB_GUI_TESTER_SKILL)).rejects.toThrow(message)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips registration when the composition mounts no skill registry', () => {
    expect(() => { registerWebGuiTesterSkill(new Context()) }).not.toThrow()
  })
})
