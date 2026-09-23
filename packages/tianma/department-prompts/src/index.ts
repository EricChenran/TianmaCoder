/**
 * Department rules as one named system-prompt contribution.
 *
 * A department mode is a preset that mounts this row with the department it
 * speaks for. The rules travel as compiled text — never as a skill, a
 * markdown file, or a path the model could read or cite — and the 商务部
 * toolbox scripts are published to a private directory whose location reaches
 * the model only as the `DSH_DEPARTMENT_TOOLS` variable.
 *
 * @module @tianma/dsh-department-prompts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `ctx.systemPrompt` Context merge into this file's scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { type Department, departmentPrompt } from './prompts/index.ts'
import { type BusinessToolboxOptions, installBusinessToolbox } from './toolbox.ts'

export { departmentPrompt, DEPARTMENTS, DEPARTMENT_PROMPTS, type Department } from './prompts/index.ts'
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
export interface Config extends BusinessToolboxOptions {
  /** Department identifier; also the preset it belongs to. */
  department: Department
}

/** Runtime schema for the department row. */
export const Config: z<Config> = z.object({
  department: z.union(['tech', 'business'] as const).required(),
  assetRoot: z.string(),
  toolsDir: z.string(),
})

/**
 * Register the selected department's rules, and for 商务部 publish its toolbox.
 * @param ctx - the preset scope context this row mounts in.
 * @param config - the department selection and optional toolbox overrides.
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
  if (config.department === 'business') {
    const { assetRoot, toolsDir } = config
    installBusinessToolbox(ctx, { ...assetRoot === undefined ? {} : { assetRoot }, ...toolsDir === undefined ? {} : { toolsDir } })
  }
}
