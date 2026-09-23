/**
 * The Host settings section the Skills page edits: the skill registry's own
 * entry configuration, whose disabled names leave every catalog and lookup.
 *
 * The namespace is the Loader entry id the shipped bundles give
 * `@deepseek-ai/dsh-skill` (`packages/bundle/base/cordis.patch.yml`), the same
 * rule that names the `ui-chat` section. This page never imports the Host
 * package: it names the entry, and the settings mirror reports the section as
 * unavailable in a deployment that composes no skill registry.
 */

/** Loader entry owning the skill registry's settings namespace. */
export const SKILL_REGISTRY_ENTRY = 'skill'

/** Field of that section carrying the disabled skill names. */
export const SKILL_DISABLED_FIELD = 'disabled'

/** The registry section this page reads and writes. */
export interface SkillRegistrySettings {
  /** Names that stay installed but are withheld from people and models. */
  readonly disabled?: readonly string[]
}

/**
 * Read the section's disabled names.
 * @param section - the accepted section, absent before the Host answers.
 * @returns the disabled names, or an empty list when none are declared.
 */
export function disabledNames(section: SkillRegistrySettings | undefined): readonly string[] {
  return section?.disabled ?? []
}
