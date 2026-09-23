/**
 * The department rule sets, one compiled-in text per department.
 *
 * Both texts are owned by this module — no file is read, no directory is
 * named, and no skill contributes them — so a department mode carries its
 * rules as part of the composition that selects it.
 *
 * @module @tianma/dsh-department-prompts/prompts
 */

import { BUSINESS_PROMPT } from './business.ts'
import { TECH_PROMPT } from './tech.ts'

/** Department identifier a preset selects. */
export type Department = 'tech' | 'business'

/** Every department this plugin can contribute. */
export const DEPARTMENTS: readonly Department[] = ['tech', 'business']

/** The rule set each department contributes, keyed by identifier. */
export const DEPARTMENT_PROMPTS: Readonly<Record<Department, string>> = {
  tech: TECH_PROMPT,
  business: BUSINESS_PROMPT,
}

/**
 * Read the rule set one department contributes.
 * @param department - department identifier selected by the preset.
 * @returns the department's complete system-prompt text.
 */
export function departmentPrompt(department: Department): string {
  return DEPARTMENT_PROMPTS[department]
}
