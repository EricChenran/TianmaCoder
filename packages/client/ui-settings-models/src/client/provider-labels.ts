/**
 * Friendly display labels for catalog provider routes whose directory
 * `displayName` is still the raw route id. The host directory names a catalog
 * provider by its id (`zai-coding-cn`); this map gives the ids a user-facing
 * wording without waiting on every upstream catalog entry carrying a name.
 */

/** Catalog route ids the Models page labels in user-facing wording. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  'zai-coding-cn': '智谱 GLM Coding Plan',
  zai: 'Z.AI（智谱国际）',
  'commandcode-goat': 'Command Code GOAT 计划',
}

/**
 * The label a provider row shows: the host-supplied display name when it
 * already differs from the route id, the friendly label when one exists, and
 * the raw id otherwise.
 * @param provider - the provider route id.
 * @param displayName - the display name the host directory supplied.
 * @returns the user-facing label for the provider.
 */
export function providerLabel(provider: string, displayName: string): string {
  if (displayName !== provider) return displayName
  return PROVIDER_LABELS[provider] ?? provider
}
