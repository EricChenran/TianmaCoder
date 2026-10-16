/** Ambient declarations for the CSS Modules this package's components import. */
declare module '*.module.css' {
  /** Class names exported by one CSS Module. */
  const classes: Readonly<Record<string, string>>
  export default classes
}
