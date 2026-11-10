/**
 * Language packs card, node half. The empty apply lets the plugin appear in the
 * host Loader; the browser half owns the card through `exports["./client"]`,
 * discovered from the package.json `dsh.client` declaration.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
