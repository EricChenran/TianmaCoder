/** Bridge the desktop shell injects for the language-pack card. */

/** Installation state the shell reports for one pack. */
export type DesktopPackState = 'missing' | 'installed' | 'broken'

/** One catalog pack as the card renders it. */
export interface DesktopPackRow {
  /** Catalog id the install and remove calls accept. */
  readonly id: string
  /** Label shown to the user. */
  readonly label: string
  /** How much of the pack is on disk. */
  readonly state: DesktopPackState
  /** Directory the pack occupies. */
  readonly directory: string
  /** True when the pack needs a JDK on this machine. */
  readonly requiresJava: boolean
  /** Present when the machine cannot install this pack. */
  readonly blocked?: 'java-missing'
}

/** Operations the desktop shell exposes on `dshDesktop.lspPacks`. */
export interface DesktopLspPacksBridge {
  /** Report every catalog pack's state. */
  list(): Promise<readonly DesktopPackRow[]>
  /** Install one pack by catalog id. */
  install(id: string): Promise<DesktopPackRow>
  /** Remove one pack by catalog id. */
  uninstall(id: string): Promise<DesktopPackRow>
}

/**
 * Read the desktop bridge, if this document runs inside the desktop shell.
 * @returns the bridge, or undefined in a browser or an older shell.
 */
export function desktopLspPacks(): DesktopLspPacksBridge | undefined {
  const desktop = (globalThis as { dshDesktop?: { lspPacks?: DesktopLspPacksBridge } }).dshDesktop
  return desktop?.lspPacks
}
