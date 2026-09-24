/**
 * Friendly display labels for catalog provider routes whose directory
 * `displayName` is still the raw route id. The host directory names a catalog
 * provider by its id (`zai-coding-cn`); this map names the copy key that gives
 * the id a user-facing wording without waiting on every upstream catalog entry
 * carrying a name. The wording itself lives in this section's dictionaries, so
 * it follows the active UI language.
 */
import type { ModelsKey } from './locales.ts'

/** Catalog route ids this section labels in its own words. */
const PROVIDER_LABEL_KEYS: Readonly<Record<string, ModelsKey>> = {
  'zai-coding-cn': 'provider.zai-coding-cn',
  zai: 'provider.zai',
  'commandcode-goat': 'provider.commandcode-goat',
}

/**
 * The label a provider row shows: the host-supplied display name when it
 * already differs from the route id, this section's own wording when it names
 * one, and the raw id otherwise.
 * @param provider - the provider route id.
 * @param displayName - the display name the host directory supplied.
 * @param translate - this section's translator, so the wording follows the UI language.
 * @returns the user-facing label for the provider.
 */
export function providerLabel(
  provider: string,
  displayName: string,
  translate: (key: ModelsKey) => string,
): string {
  if (displayName !== provider) return displayName
  const key = PROVIDER_LABEL_KEYS[provider]
  return key === undefined ? provider : translate(key)
}
