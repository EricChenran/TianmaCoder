/**
 * Host half of the Tianma OA account UI plugin. Every surface lives in the
 * browser half, so this entry carries no Host behavior; the account service
 * itself ships in `@tianma/dsh-oa-account`. The empty apply is still required:
 * a module without one is not a valid plugin shape, so the Loader would leave
 * the entry fiber-less and the dsh.client row would never reach the browser
 * roster.
 *
 * @module @tianma/dsh-oa-account-ui
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
