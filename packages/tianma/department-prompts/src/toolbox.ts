/**
 * The department toolboxes: each department's packaged generation scripts are
 * published to a private directory under the harness home and advertised to
 * model shell calls as one `DSH_*` variable, so the rules text names a variable
 * instead of a filesystem location.
 *
 * 商务部 publishes the document generators (requirement documents, quotations,
 * change work orders); 技术部 publishes the work-order disposition scripts. A
 * session runs one department, so both share the variable name.
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

/** One department's script set: what ships, and where both copies live. */
interface DepartmentToolbox {
  /** Script filenames the toolbox publishes, in the order the rules reference them. */
  readonly files: readonly string[]
  /** Directory under this package's `assets/` holding the packaged copies. */
  readonly assetDirectory: string
  /** Directory under `<harness home>/department/` receiving the published copies. */
  readonly publishedDirectory: string
}

/** The 商务部 document generators. */
const BUSINESS_TOOLBOX: DepartmentToolbox = {
  files: [
    'gen_doc.py',
    'gen_quote.py',
    'gen_workorder.py',
    'add_watermark.py',
    'to_pdf.py',
    'open_folder.py',
  ],
  assetDirectory: 'business',
  publishedDirectory: 'business-tools',
}

/** The 技术部 work-order disposition scripts. */
const TECH_TOOLBOX: DepartmentToolbox = {
  files: ['read_workorder.py', 'build_disposition.py'],
  assetDirectory: 'tech',
  publishedDirectory: 'tech-tools',
}

/** Script filenames the 商务部 toolbox publishes, in the order the rules reference them. */
export const BUSINESS_TOOL_FILES: readonly string[] = BUSINESS_TOOLBOX.files

/** Script filenames the 技术部 toolbox publishes, in the order the rules reference them. */
export const TECH_TOOL_FILES: readonly string[] = TECH_TOOLBOX.files

/** Managed variable naming the published toolbox directory. */
export const TOOLS_DIR_VARIABLE = 'DSH_DEPARTMENT_TOOLS'

/** Contributor name the registry reports for the toolbox variable. */
export const TOOLS_CONTRIBUTOR_NAME = 'tianma-department-prompts'

/** Where a department's toolbox scripts are published, and where they are read from. */
export interface BusinessToolboxOptions {
  /** Packaged script directory; defaults to this package's `assets/<department>/`. */
  assetRoot?: string
  /** Published script directory; defaults to `<harness home>/department/<department>-tools`. */
  toolsDir?: string
}

/** The installed package's own script directory for one toolbox. */
function packagedAssetRoot(toolbox: DepartmentToolbox): string {
  return fileURLToPath(new URL(`../assets/${toolbox.assetDirectory}/`, import.meta.url))
}

/** Whether a published script already carries the packaged bytes. */
function alreadyPublished(path: string, content: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8') === content
}

/** Publish one department's packaged scripts and return the directory holding them. */
function materialize(toolbox: DepartmentToolbox, options: BusinessToolboxOptions): string {
  const assetRoot = options.assetRoot ?? packagedAssetRoot(toolbox)
  const toolsDir = options.toolsDir ?? join(resolveDshHome(), 'department', toolbox.publishedDirectory)
  mkdirSync(toolsDir, { recursive: true })
  for (const filename of toolbox.files) {
    const content = readFileSync(join(assetRoot, filename), 'utf8')
    const destination = join(toolsDir, filename)
    if (!alreadyPublished(destination, content)) writeFileSync(destination, content)
  }
  return toolsDir
}

/**
 * Publish the 商务部 document generators into their toolbox directory.
 * @param options - asset and destination overrides, both optional.
 * @returns the absolute toolbox directory holding the published scripts.
 */
export function materializeBusinessTools(options: BusinessToolboxOptions = {}): string {
  return materialize(BUSINESS_TOOLBOX, options)
}

/**
 * Publish the 技术部 disposition scripts into their toolbox directory.
 * @param options - asset and destination overrides, both optional.
 * @returns the absolute toolbox directory holding the published scripts.
 */
export function materializeTechTools(options: BusinessToolboxOptions = {}): string {
  return materialize(TECH_TOOLBOX, options)
}

/**
 * Publish one department's toolbox and advertise its directory to model shell calls.
 *
 * The registration is skipped when the composition mounts no `shellEnv`
 * registry: the rules text still loads, and its script steps stay inert.
 * @param ctx - plugin context that owns the registration effect.
 * @param toolbox - the department whose scripts this row publishes.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the toolbox variable was registered.
 */
function install(ctx: Context, toolbox: DepartmentToolbox, options: BusinessToolboxOptions): boolean {
  const shellEnv = ctx.get('shellEnv')
  if (shellEnv === undefined) return false
  const toolsDir = materialize(toolbox, options)
  ctx.effect(() => shellEnv.register({
    name: TOOLS_CONTRIBUTOR_NAME,
    variables: { DSH_DEPARTMENT_TOOLS: { description: 'Directory holding the department generation scripts.' } },
    resolve: () => ({ DSH_DEPARTMENT_TOOLS: toolsDir }),
  }))
  return true
}

/**
 * Publish the 商务部 toolbox and advertise its directory to model shell calls.
 * @param ctx - plugin context that owns the registration effect.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the toolbox variable was registered.
 */
export function installBusinessToolbox(ctx: Context, options: BusinessToolboxOptions = {}): boolean {
  return install(ctx, BUSINESS_TOOLBOX, options)
}

/**
 * Publish the 技术部 toolbox and advertise its directory to model shell calls.
 * @param ctx - plugin context that owns the registration effect.
 * @param options - asset and destination overrides, both optional.
 * @returns whether the toolbox variable was registered.
 */
export function installTechToolbox(ctx: Context, options: BusinessToolboxOptions = {}): boolean {
  return install(ctx, TECH_TOOLBOX, options)
}
