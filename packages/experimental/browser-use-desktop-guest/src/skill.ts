/**
 * Registers the bundled Web GUI 黑盒测试 skill beside the desktop guest's browser
 * tools: a tool family ships its own usage guidance.
 *
 * The provider owns a private filesystem copy of the packaged asset, so the
 * resource base it reports is a real path even when the package lives inside an
 * ASAR archive. The description and body are read from that copy on every load,
 * so a broken package fails loud at registration and an edited copy reaches the
 * next load without a restart.
 *
 * @module @deepseek-ai/dsh-experimental-browser-use-desktop-guest/skill
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Bundled skill that tests web frontends through the guest browser tools. */
export const WEB_GUI_TESTER_SKILL = 'web-gui-tester'

/** Provider name this module registers the skill under. */
export const WEB_GUI_TESTER_SKILL_PROVIDER = 'dsh-browser-use-desktop-guest'

/** Read the routing description and instruction body out of one skill document. */
function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`browser-use-desktop-guest: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description
    : undefined
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`browser-use-desktop-guest: ${path} has no description`)
  }
  const content = raw.slice(frontmatter[0].length).trim()
  if (content.length === 0) throw new Error(`browser-use-desktop-guest: ${path} has an empty body`)
  return { description, content }
}

/**
 * Register the bundled Web GUI 黑盒测试 skill on the calling context's layer.
 *
 * A composition that mounts no skill registry still gets the browser tools; the
 * skill stays absent instead of failing the row.
 * @param ctx - Context that may carry the optional skill registry.
 */
export function registerWebGuiTesterSkill(ctx: Context): void {
  const skills = ctx.get('skills')
  if (skills === undefined) return
  const packaged = fileURLToPath(new URL('../assets/web-gui-tester/', import.meta.url))
  ctx.effect(function* () {
    const directory = mkdtempSync(join(tmpdir(), `dsh-${WEB_GUI_TESTER_SKILL}-skill-`))
    yield async () => { await rm(directory, { recursive: true, force: true }) }
    const locator = join(directory, 'SKILL.md')
    writeFileSync(locator, readFileSync(join(packaged, 'SKILL.md')), { flag: 'wx', mode: 0o600 })
    const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
    const candidate: SkillCandidate = {
      name: WEB_GUI_TESTER_SKILL,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: WEB_GUI_TESTER_SKILL_PROVIDER,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator,
    }
    const provider: SkillProvider = {
      name: WEB_GUI_TESTER_SKILL_PROVIDER,
      list: () => Promise.resolve([candidate]),
      async get(entry, options) {
        const { rank: _rank, locator: entryPath, ...summary } = entry
        const raw = await readFile(entryPath as string, { encoding: 'utf8', signal: options.signal })
        return { ...summary, content: parseSkill(raw, entryPath as string).content }
      },
    }
    yield skills.registerProvider(() => provider)
  }, 'Web GUI tester skill resources')
}
