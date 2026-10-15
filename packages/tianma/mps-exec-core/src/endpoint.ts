/**
 * The management-platform communication address: the configured host and port
 * the executor node dials, resolved once into the origin and `exec/v1` base URL
 * every protocol request is built from. A deployment configures the address
 * parts, never a full URL with a scheme buried in the host value.
 * @module @tianma/dsh-mps-exec-core/endpoint
 */

/** The port the management platform serves `exec/v1` on. */
export const DEFAULT_PLATFORM_PORT = 8791

/** Schemes the node accepts for its platform connection. */
export type PlatformScheme = 'http' | 'https'

/** Path prefix the protocol endpoints hang off. */
export const DEFAULT_PLATFORM_BASE_PATH = '/exec/v1'

const SCHEMES: readonly PlatformScheme[] = ['http', 'https']

/** The address parts a deployment configures for one platform. */
export interface PlatformEndpointInput {
  /** Host name, IPv4 address, or IPv6 address. A scheme, path, or port here is rejected. */
  host: string
  /** TCP port; defaults to {@link DEFAULT_PLATFORM_PORT}. */
  port?: number | undefined
  /** Transport scheme; defaults to `http`. */
  scheme?: PlatformScheme | undefined
  /** Path prefix for the protocol endpoints, such as `/exec/v1`. */
  basePath?: string | undefined
}

/** A resolved platform address and the request URLs derived from it. */
export interface PlatformEndpoint {
  /** Transport scheme in force. */
  readonly scheme: PlatformScheme
  /** Host as configured, with IPv6 addresses bracketed. */
  readonly host: string
  /** TCP port in force. */
  readonly port: number
  /** Path prefix in force, without a trailing slash. */
  readonly basePath: string
  /** `scheme://host:port` without the path prefix. */
  readonly origin: string
  /** `origin` plus `basePath`; the prefix every protocol path is appended to. */
  readonly baseUrl: string
  /**
   * Build one absolute request URL under the base path.
   * @param path - protocol path such as `/auth/token`, with or without a leading slash.
   * @returns the absolute URL.
   */
  url(path: string): string
}

/** Whether a scheme is one the node connects with. */
function isScheme(value: string): value is PlatformScheme {
  return SCHEMES.includes(value as PlatformScheme)
}

/** Reject a host value that carries anything but a host. */
function normalizeHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed === '') throw new TypeError('platform host must not be empty')
  if (trimmed.includes('://')) {
    throw new TypeError(`platform host must not carry a scheme, got ${JSON.stringify(host)}`)
  }
  if (/[\s/\\@]/.test(trimmed)) {
    throw new TypeError(`platform host must be a bare host or address, got ${JSON.stringify(host)}`)
  }
  const bracketed = trimmed.startsWith('[')
  if (bracketed) {
    if (!trimmed.endsWith(']') || trimmed.length < 3) {
      throw new TypeError(`platform host has an unterminated IPv6 bracket, got ${JSON.stringify(host)}`)
    }
    const inner = trimmed.slice(1, -1)
    if (!inner.includes(':')) {
      throw new TypeError(`platform host brackets a value that is not an IPv6 address, got ${JSON.stringify(host)}`)
    }
    return `[${inner}]`
  }
  if (trimmed.endsWith(']')) {
    throw new TypeError(`platform host has a closing bracket without an opening one, got ${JSON.stringify(host)}`)
  }
  // A bare colon-bearing value is an unbracketed IPv6 address; every URL built
  // from it needs the brackets, so add them here rather than at each call site.
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed
}

/** Reject a port outside the TCP range. */
function normalizePort(port: number | undefined): number {
  if (port === undefined) return DEFAULT_PLATFORM_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`platform port must be an integer between 1 and 65535, got ${String(port)}`)
  }
  return port
}

/** Reject a base path that is not an absolute, query-free path. */
function normalizeBasePath(basePath: string | undefined): string {
  if (basePath === undefined) return DEFAULT_PLATFORM_BASE_PATH
  if (!basePath.startsWith('/')) {
    throw new TypeError(`platform base path must start with "/", got ${JSON.stringify(basePath)}`)
  }
  if (basePath.includes('?') || basePath.includes('#')) {
    throw new TypeError(`platform base path must not carry a query or fragment, got ${JSON.stringify(basePath)}`)
  }
  const withoutTrailing = basePath.replace(/\/+$/, '')
  return withoutTrailing === '' ? '' : withoutTrailing
}

/**
 * Resolve the configured host, port, scheme, and base path into the request
 * addresses the protocol client uses.
 * @param input - the configured address parts.
 * @returns the resolved endpoint.
 */
export function resolvePlatformEndpoint(input: PlatformEndpointInput): PlatformEndpoint {
  const scheme = input.scheme ?? 'http'
  if (!isScheme(scheme)) {
    throw new TypeError(`platform scheme must be "http" or "https", got ${JSON.stringify(String(scheme))}`)
  }
  const host = normalizeHost(input.host)
  const port = normalizePort(input.port)
  const basePath = normalizeBasePath(input.basePath)
  const origin = `${scheme}://${host}:${String(port)}`
  return {
    scheme,
    host,
    port,
    basePath,
    origin,
    baseUrl: `${origin}${basePath}`,
    url(path: string): string {
      const trimmed = path.trim()
      if (trimmed === '') throw new TypeError('platform request path must not be empty')
      if (trimmed.includes('://') || trimmed.includes('?')) {
        throw new TypeError(`platform request path must be a bare path, got ${JSON.stringify(path)}`)
      }
      return `${origin}${basePath}/${trimmed.replace(/^\/+/, '')}`
    },
  }
}

/**
 * Read a full platform URL — the form a deployment may keep in one environment
 * variable — back into the address parts.
 * @param value - an `http` or `https` URL, optionally with a path prefix.
 * @returns the address parts, with the URL's path as the base path when it has one.
 */
export function platformEndpointFromUrl(value: string): PlatformEndpointInput {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`platform URL is not a valid absolute URL, got ${JSON.stringify(value)}`)
  }
  const protocol = parsed.protocol.replace(/:$/, '')
  if (protocol !== 'http' && protocol !== 'https') {
    throw new TypeError(`platform URL must be http or https, got ${JSON.stringify(value)}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('platform URL must not carry credentials')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('platform URL must not carry a query or fragment')
  }
  const path = normalizeBasePath(parsed.pathname)
  return {
    scheme: protocol,
    host: parsed.hostname,
    port: parsed.port === '' ? DEFAULT_PLATFORM_PORT : Number(parsed.port),
    basePath: path === '' ? DEFAULT_PLATFORM_BASE_PATH : path,
  }
}
