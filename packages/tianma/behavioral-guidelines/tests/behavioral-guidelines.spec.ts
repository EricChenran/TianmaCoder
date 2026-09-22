/**
 * Behavioral-guidelines plugin: the named section must register through the
 * system-prompt seam, land after the deployment persona prefix, and carry the
 * ZCode-derived text verbatim (snapshot pins the wording against drift).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '@tianma/dsh-behavioral-guidelines'

async function setup(personaPrefix: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix })
  await ctx.plugin(plugin)
  return ctx
}

describe('@tianma/dsh-behavioral-guidelines', () => {
  it('registers the named section through the system-prompt seam', async () => {
    const ctx = await setup('')
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(candidate => candidate.name === plugin.SECTION_NAME)
    expect(section).toBeDefined()
    expect(section?.text).toBe(plugin.sectionText())
  })

  it('lands after the deployment persona prefix in the rendered prompt', async () => {
    const ctx = await setup('You are the deployment assistant.')
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    const personaAt = rendered.indexOf('You are the deployment assistant.')
    const guidelinesAt = rendered.indexOf('# Communicating with the user')
    expect(personaAt).toBeGreaterThanOrEqual(0)
    expect(guidelinesAt).toBeGreaterThan(personaAt)
  })

  it('carries all three ZCode-derived sections verbatim', async () => {
    const ctx = await setup('')
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered).toContain('# Communicating with the user')
    expect(rendered).toContain('# Context management')
    expect(rendered).toContain('# Code comments')
    expect(rendered).toContain('must be in the final text message of your turn')
    expect(rendered).toContain('End your turn only when the task is complete')
    expect(rendered).toContain("state a constraint the code itself can't show")
  })

  it('exposes a deterministic section text for snapshot pinning', () => {
    expect(plugin.sectionText()).toMatchSnapshot()
  })
})
