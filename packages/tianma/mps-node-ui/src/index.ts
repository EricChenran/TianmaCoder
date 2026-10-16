/**
 * Host half of the Tianma MPS executor-node UI plugin. Every surface lives in the
 * browser half, and the node control it reads ships in
 * `@tianma/dsh-mps-node-control`. The empty apply is still required: a module
 * without one is not a valid plugin shape, so the Loader would leave the entry
 * fiber-less and the `dsh.client` row would never reach the browser roster.
 *
 * @module @tianma/dsh-mps-node-ui
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
