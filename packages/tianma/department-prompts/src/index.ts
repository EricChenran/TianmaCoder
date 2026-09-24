/**
 * Department rules as one named system-prompt contribution.
 *
 * A department mode is a preset that mounts this row with the department it
 * speaks for. The rules travel as compiled text — never as a skill, a
 * markdown file, or a path the model could read or cite — and the 商务部
 * toolbox scripts are published to a private directory whose location reaches
 * the model only as the `DSH_DEPARTMENT_TOOLS` variable.
 *
 * Both department modes also carry the bundled 公文 skill: the row is the only
 * thing both presets mount, so registering its provider here keeps the skill
 * out of every other mode. The bundled 无头演示视频 skill is 技术部-only, so the
 * 技术部 row registers it and the 商务部 row does not.
 *
 * @module @tianma/dsh-department-prompts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `ctx.systemPrompt` Context merge into this file's scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { type Department, departmentPrompt } from './prompts/index.ts'
import {
  installDepartmentSkill,
  installWebDemoVideoSkill,
  type DepartmentSkillOptions,
} from './skill.ts'
import { type BusinessToolboxOptions, installBusinessToolbox } from './toolbox.ts'

export { departmentPrompt, DEPARTMENTS, DEPARTMENT_PROMPTS, type Department } from './prompts/index.ts'
export {
  installDepartmentSkill,
  installWebDemoVideoSkill,
  materializeDepartmentSkill,
  materializeWebDemoVideoSkill,
  SKILL_ASSET_FILES,
  SKILL_NAME,
  SKILL_PROVIDER_NAME,
  WEB_DEMO_VIDEO_SKILL_ASSET_FILES,
  WEB_DEMO_VIDEO_SKILL_NAME,
  WEB_DEMO_VIDEO_SKILL_PROVIDER_NAME,
  type DepartmentSkillOptions,
} from './skill.ts'
export {
  BUSINESS_TOOL_FILES,
  installBusinessToolbox,
  materializeBusinessTools,
  TOOLS_CONTRIBUTOR_NAME,
  TOOLS_DIR_VARIABLE,
  type BusinessToolboxOptions,
} from './toolbox.ts'

/** Cordis plugin name. */
export const name = 'tianma-department-prompts'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** The stable contribution name the section registers under. */
export const SECTION_NAME = 'tianma:department'

/** Sorts after `tianma:behavioral-guidelines` (100), before `PLAN_POLICY` (500). */
export const SECTION_ORDER = 150

/** Plugin config: the department whose rules this row contributes. */
export interface Config extends BusinessToolboxOptions, DepartmentSkillOptions {
  /** Department identifier; also the preset it belongs to. */
  department: Department
  /** Packaged skill directory, for a deployment that ships its own copy. */
  skillAssetRoot?: string
}

/** Runtime schema for the department row. */
export const Config: z<Config> = z.object({
  department: z.union(['tech', 'business'] as const).required(),
  assetRoot: z.string(),
  toolsDir: z.string(),
  skillAssetRoot: z.string(),
  skillDir: z.string(),
})

/**
 * Register the selected department's rules and its bundled 公文 skill; for
 * 技术部 add the bundled 演示视频 skill, and for 商务部 publish its toolbox.
 * @param ctx - the preset scope context this row mounts in.
 * @param config - the department selection and optional publication directories.
 */
export function apply(ctx: Context, config: Config): void {
  const text = departmentPrompt(config.department)
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text,
      // The rules are literal text: a brace pair in an example must never be
      // read as a prompt-variable reference.
      interpolate: false,
    })
  })
  installDepartmentSkill(ctx, {
    ...config.skillAssetRoot === undefined ? {} : { assetRoot: config.skillAssetRoot },
    ...config.skillDir === undefined ? {} : { skillDir: config.skillDir },
  })
  if (config.department === 'tech') installWebDemoVideoSkill(ctx)
  if (config.department === 'business') {
    const { assetRoot, toolsDir } = config
    installBusinessToolbox(ctx, { ...assetRoot === undefined ? {} : { assetRoot }, ...toolsDir === undefined ? {} : { toolsDir } })
  }
}
