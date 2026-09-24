/**
 * Department prompts: the selected department's rules must register as one
 * literal system-prompt section, the packaged toolbox must publish its scripts
 * without exposing their location to the model, the bundled 公文 skill must
 * publish where the model's interpreter can read it and reach only the modes
 * that mount this row, and neither rule set may carry the source documents' own
 * mechanism vocabulary.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as plugin from '@tianma/dsh-department-prompts'

const PERSONA = 'You are the deployment assistant.'
const ASSET_ROOT = fileURLToPath(new URL('../assets/business/', import.meta.url))
const SKILL_ASSET_ROOT = fileURLToPath(new URL('../skills/official-doc/', import.meta.url))
const temporaryDirectories: string[] = []

/** The contributor shape a stubbed shell-env registry captures from the plugin. */
interface CapturedContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

/** A directory this spec owns and removes after each case. */
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'department-prompts-'))
  temporaryDirectories.push(directory)
  return directory
}

/** Mount the prompt registry, an optional shell-env registry, and the row. */
async function setup(
  department: plugin.Department,
  options: { withShellEnv?: boolean; assetRoot?: string; toolsDir?: string } = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
  if (options.withShellEnv === true) await ctx.plugin(ShellEnv, {})
  await ctx.plugin(plugin, {
    department,
    ...options.assetRoot === undefined ? {} : { assetRoot: options.assetRoot },
    ...options.toolsDir === undefined ? {} : { toolsDir: options.toolsDir },
  })
  return ctx
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('@tianma/dsh-department-prompts', () => {
  it.each(plugin.DEPARTMENTS)('registers the %s rules as one named section', async (department) => {
    const ctx = await setup(department)
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(candidate => candidate.name === plugin.SECTION_NAME)
    expect(section).toBeDefined()
    expect(section?.text).toBe(plugin.departmentPrompt(department))
  })

  it('lands after the deployment persona prefix in the rendered prompt', async () => {
    const ctx = await setup('tech')
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered.indexOf(PERSONA)).toBeGreaterThanOrEqual(0)
    expect(rendered.indexOf('# 技术部工作规范')).toBeGreaterThan(rendered.indexOf(PERSONA))
  })

  it('carries the 商务部 JSON examples literally', async () => {
    const ctx = await setup('business')
    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered).toContain('"system_name": "必填：系统名"')
    expect(rendered).toContain('"actor": "客户", "action": "选择规格与数量", "rule": "库存不足时禁止下单"')
    expect(rendered).toContain('DSH_DEPARTMENT_TOOLS')
  })

  it('requires complete business workflows as text beside the generated diagram', () => {
    const text = plugin.departmentPrompt('business')
    expect(text).toContain('### 业务工作流（图文并存，必须完整）')
    expect(text).toContain('步骤表（序号｜执行角色｜操作内容｜业务规则与输出）')
    expect(text).toContain('**不得只给图不给文**')
  })

  it('ships a same-content Markdown copy for the 技术部 handoff', () => {
    const text = plugin.departmentPrompt('business')
    expect(text).toContain('需求文档-<系统名>.md')
    expect(text).toContain('不是技术方案文档')
    // The quotation stays Word + PDF only.
    expect(text).toContain('报价单不出 Markdown')
  })

  it('publishes every packaged script without naming where the model reads it', () => {
    const toolsDir = join(temporaryDirectory(), 'tools')
    expect(plugin.materializeBusinessTools({ assetRoot: ASSET_ROOT, toolsDir })).toBe(toolsDir)
    expect(readdirSync(toolsDir).sort()).toEqual([...plugin.BUSINESS_TOOL_FILES].sort())
    for (const filename of plugin.BUSINESS_TOOL_FILES) {
      expect(readFileSync(join(toolsDir, filename), 'utf8'))
        .toBe(readFileSync(join(ASSET_ROOT, filename), 'utf8'))
    }
    // A repeated mount keeps the published bytes and reports the same directory.
    expect(plugin.materializeBusinessTools({ assetRoot: ASSET_ROOT, toolsDir })).toBe(toolsDir)
    // A published script that drifted from the packaged copy is rewritten.
    const drifted = join(toolsDir, 'to_pdf.py')
    writeFileSync(drifted, 'print("stale")\n')
    plugin.materializeBusinessTools({ assetRoot: ASSET_ROOT, toolsDir })
    expect(readFileSync(drifted, 'utf8')).toBe(readFileSync(join(ASSET_ROOT, 'to_pdf.py'), 'utf8'))
  })

  it('reads its own packaged scripts when no asset directory is configured', () => {
    const toolsDir = join(temporaryDirectory(), 'tools')
    plugin.materializeBusinessTools({ toolsDir })
    expect(readdirSync(toolsDir).sort())
      .toEqual(['add_watermark.py', 'gen_doc.py', 'gen_quote.py', 'open_folder.py', 'to_pdf.py'])
  })

  it('publishes under the harness home when no directory is configured', () => {
    const home = temporaryDirectory()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const published = plugin.materializeBusinessTools()
      expect(published).toBe(join(home, 'department', 'business-tools'))
      expect(readdirSync(published).sort()).toEqual([...plugin.BUSINESS_TOOL_FILES].sort())
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('skips the toolbox when the composition mounts no shell environment', () => {
    const toolsDir = join(temporaryDirectory(), 'tools')
    expect(plugin.installBusinessToolbox(new Context(), { assetRoot: ASSET_ROOT, toolsDir })).toBe(false)
    expect(existsSync(toolsDir)).toBe(false)
  })

  it('advertises the toolbox directory as a managed shell variable', async () => {
    const toolsDir = join(temporaryDirectory(), 'tools')
    const ctx = await setup('business', { withShellEnv: true, assetRoot: ASSET_ROOT, toolsDir })
    const declared = ctx.shellEnv.list().find(variable => variable.key === plugin.TOOLS_DIR_VARIABLE)
    expect(declared?.contributor).toBe(plugin.TOOLS_CONTRIBUTOR_NAME)
    expect(declared?.description.length).toBeGreaterThan(0)
  })

  it('resolves the toolbox variable to the directory it published', () => {
    const toolsDir = join(temporaryDirectory(), 'tools')
    const captured: CapturedContribution[] = []
    const ctx = new Context()
    ctx.provide('shellEnv', {
      register: (contribution: CapturedContribution) => {
        captured.push(contribution)
        return () => {}
      },
    } as never)
    expect(plugin.installBusinessToolbox(ctx, { assetRoot: ASSET_ROOT, toolsDir })).toBe(true)
    expect(captured[0]?.name).toBe(plugin.TOOLS_CONTRIBUTOR_NAME)
    expect(captured[0]?.variables).toHaveProperty(plugin.TOOLS_DIR_VARIABLE)
    expect(captured[0]?.resolve()).toEqual({ [plugin.TOOLS_DIR_VARIABLE]: toolsDir })
  })

  it.each(plugin.DEPARTMENTS)('keeps %s free of the source documents mechanism vocabulary', (department) => {
    const text = plugin.departmentPrompt(department)
    for (const forbidden of ['SKILL.md', '<本技能目录>', 'zcode-file-citation', '::zcode', 'document-skills',
      'browser-use', 'modao.cc', 'department-prompts', 'assets/business', 'DSH_HOME']) {
      expect(text).not.toContain(forbidden)
    }
    expect(text).not.toMatch(/[A-Za-z]:\\/u)
  })

  it.each(plugin.DEPARTMENTS)('states the department the model is acting for', (department) => {
    expect(plugin.departmentPrompt(department)).toContain(department === 'tech' ? '# 技术部工作规范' : '# 商务部工作规范')
  })

  it('publishes the bundled 公文 skill byte for byte where the interpreter reads it', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.materializeDepartmentSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    for (const relativePath of plugin.SKILL_ASSET_FILES) {
      expect(readFileSync(join(skillDir, relativePath))).toEqual(readFileSync(join(SKILL_ASSET_ROOT, relativePath)))
    }
    // A repeated mount keeps the published bytes and reports the same directory.
    expect(plugin.materializeDepartmentSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(skillDir)
    // A published script that drifted from the packaged copy is rewritten.
    const drifted = join(skillDir, 'scripts', 'gen_doc.py')
    writeFileSync(drifted, 'print("stale")\n')
    plugin.materializeDepartmentSkill({ assetRoot: SKILL_ASSET_ROOT, skillDir })
    expect(readFileSync(drifted)).toEqual(readFileSync(join(SKILL_ASSET_ROOT, 'scripts', 'gen_doc.py')))
  })

  it('publishes the skill under the harness home when no directory is configured', () => {
    const home = temporaryDirectory()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const published = plugin.materializeDepartmentSkill()
      expect(published).toBe(join(home, 'department', 'skills', plugin.SKILL_NAME))
      expect(readdirSync(join(published, 'scripts'))).toEqual(['gen_doc.py'])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('fails loud when the packaged skill is incomplete', () => {
    expect(() => plugin.materializeDepartmentSkill({
      assetRoot: temporaryDirectory(), skillDir: join(temporaryDirectory(), 'skill'),
    })).toThrow(/missing SKILL\.md/u)
  })

  it('registers the bundled skill against the directory it published', async () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    try {
      expect(plugin.installDepartmentSkill(ctx, { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(true)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([plugin.SKILL_NAME])
      expect(catalog[0]).toMatchObject({
        source: 'bundled',
        provider: plugin.SKILL_PROVIDER_NAME,
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: skillDir },
      })
      expect(catalog[0]?.description.length).toBeLessThanOrEqual(500)
      const loaded = await ctx.skills.get(plugin.SKILL_NAME)
      expect(loaded?.path).toBe(join(skillDir, 'SKILL.md'))
      expect(loaded?.content).toContain('宜春天码信息集团')
      expect(loaded?.content.startsWith('# 企业公文生成')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(plugin.DEPARTMENTS)('gives the %s mode the skill and drops it with the row', async (department) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
    await ctx.plugin(SkillRegistry)
    try {
      const fiber = await ctx.plugin(plugin, {
        department, skillAssetRoot: SKILL_ASSET_ROOT, skillDir: join(temporaryDirectory(), 'skill'),
      })
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual([plugin.SKILL_NAME])
      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips the skill when the composition mounts no skill registry', () => {
    const skillDir = join(temporaryDirectory(), 'skill')
    expect(plugin.installDepartmentSkill(new Context(), { assetRoot: SKILL_ASSET_ROOT, skillDir })).toBe(false)
    expect(existsSync(skillDir)).toBe(false)
  })

  it('ships a skill body free of foreign harness syntax and host paths', () => {
    const raw = readFileSync(join(SKILL_ASSET_ROOT, 'SKILL.md'), 'utf8')
    expect(raw.startsWith('---\nname: official-doc\n')).toBe(true)
    for (const forbidden of ['zcode-file-citation', '::zcode', 'document-skills', '<本技能目录>',
      'DSH_DEPARTMENT_TOOLS', 'assets/business']) {
      expect(raw).not.toContain(forbidden)
    }
    expect(raw).not.toMatch(/[A-Za-z]:\\/u)
    expect(raw).toContain('scripts/gen_doc.py')
    expect(raw).toContain('present')
  })
})
