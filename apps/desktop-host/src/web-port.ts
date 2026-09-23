/** Desktop Host loopback web port: a fixed packaged default with an explicit override. */

/**
 * The port a packaged or development Desktop Host binds unless overridden. The
 * launch argument carries it, so a profile `webserver.config.port` patch cannot
 * replace it: a second Desktop instance and an installed application need
 * different values, and that choice belongs to the launcher.
 */
const DEFAULT_WEB_PORT = 19387

/**
 * Resolve the loopback web port for the spawned Desktop Host.
 * @param value - Raw `DSH_DESKTOP_WEB_PORT` override; absent, empty, or blank keeps the default.
 * @returns the port handed to `--port` as text; `0` asks the operating system for a free port.
 * @throws Error when the override is not an integer from 0 through 65535, so a typo stops the launch instead of binding another port.
 */
export function desktopWebPort(value: string | undefined): string {
  const configured = value?.trim() ?? ''
  if (configured === '') return String(DEFAULT_WEB_PORT)
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('desktop host: DSH_DESKTOP_WEB_PORT must be an integer from 0 through 65535')
  }
  return String(port)
}
