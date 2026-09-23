/**
 * The 商务部 document toolbox: the packaged generation scripts are published to
 * a private directory under the harness home and advertised to model shell
 * calls as one `DSH_*` variable, so the rules text names a variable instead of
 * a filesystem location.
 *
 * @module @tianma/dsh-department-prompts/toolbox
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the `ctx.shellEnv` Context merge into this file's scope.
import type {} from '@deepseek-ai/dsh-shell-env'

/** Script filenames the toolbox publishes, in the order the rules reference them. */
export const BUSINESS_TOOL_FILES: readonly string[] = [
  'gen_doc.py',
  'gen_quote.py',
  'add_watermark.py',
  'to_pdf.py',
  'open_folder.py',
]

/** Managed variable naming the published toolbox directory. */
export const TOOLS_DIR_VARIABLE = 'DSH_DEPARTMENT_TOOLS'

/** Contributor name the registry reports for the toolbox variable. */
export const TOOLS_CONTRIBUTOR_NAME = 'tianma-department-prompts'

/** Where the toolbox scripts are published, and where they are read from. */
export interface BusinessToolboxOptions {
  /** Packaged script directory; defaults to this package's `assets/business/`. */
  assetRoot?: string
  /** Published script directory; defaults to `<harness home>/department/business-tools`. */
  toolsDir?: string
}

/** The installed package's own script directory. */
function packagedAssetRoot(): string {
  return fileURLToPath(new URL('../assets/business/', import.meta.url))
}

/** Whether a published script already carries the packaged bytes. */
function alreadyPublished(path: string, content: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8') === content
}

/**
 * Publish the packaged generation scripts into the toolbox directory.
 * @param options - asset and destination overrides, both optional.
 * @returns the absolute toolbox directory holding the published scripts.
 */
export function materializeBusinessTools(options: BusinessToolboxOptions = {}): string {
  const assetRoot = options.assetRoot ?? packagedAssetRoot()
  const toolsDir = options.toolsDir ?? join(resolveDshHome(), 'department', 'business-tools')
  mkdirSync(toolsDir, { recursive: true })
  for (const filename of BUSINESS_TOOL_FILES) {
    const content = readFileSync(join(assetRoot, filename), 'utf8')
    const destination = join(toolsDir, filename)
    if (!alreadyPublished(destination, content)) writeFileSync(destination, content)
  }
  return toolsDir
}

/**
 * Publish the toolbox and advertise its directory to model shell calls.
 *
 * The registration is skipped when the composition mounts no `shellEnv`
 * registry: the rules text still loads, and its script steps stay inert.
 * @param ctx - plugin context that owns the registration effect.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the toolbox variable was registered.
 */
export function installBusinessToolbox(ctx: Context, options: BusinessToolboxOptions = {}): boolean {
  const shellEnv = ctx.get('shellEnv')
  if (shellEnv === undefined) return false
  const toolsDir = materializeBusinessTools(options)
  ctx.effect(() => shellEnv.register({
    name: TOOLS_CONTRIBUTOR_NAME,
    variables: { DSH_DEPARTMENT_TOOLS: { description: 'Directory holding the 商务部 document-generation scripts.' } },
    resolve: () => ({ DSH_DEPARTMENT_TOOLS: toolsDir }),
  }))
  return true
}
