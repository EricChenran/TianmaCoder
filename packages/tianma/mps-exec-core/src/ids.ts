/**
 * Identifier minting for the protocol's idempotency keys: log batch ids and
 * artifact ids are strings the node generates, and the protocol keeps every id
 * a string so no consumer loses precision. The form is a ULID — a 48-bit
 * millisecond timestamp in Crockford base32 followed by 80 random bits — which
 * sorts by creation time and needs no coordination between nodes.
 * @module @tianma/dsh-mps-exec-core/ids
 */

import { randomBytes } from 'node:crypto'

/** The alphabet a ULID uses. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Characters the encoded timestamp occupies. */
const TIME_CHARS = 10

/** Characters the encoded randomness occupies. */
const RANDOM_CHARS = 16

/** Bytes of randomness a ULID carries. */
const RANDOM_BYTES = 10

/** A source of random bytes; injectable so tests are deterministic. */
export type RandomByteSource = (size: number) => Uint8Array

/**
 * Encode a millisecond timestamp into the ULID's time prefix.
 * @param timestampMs - milliseconds since the Unix epoch, within 48 bits.
 * @returns the ten-character prefix.
 */
function encodeTime(timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
    throw new TypeError(`ULID timestamp must be an integer within 48 bits, got ${String(timestampMs)}`)
  }
  const characters = new Array<string>(TIME_CHARS)
  let remaining = timestampMs
  for (let index = TIME_CHARS - 1; index >= 0; index -= 1) {
    characters[index] = CROCKFORD[remaining % 32] as string
    remaining = Math.floor(remaining / 32)
  }
  return characters.join('')
}

/**
 * Encode the shared randomness into the ULID's suffix.
 * @param bytes - exactly {@link RANDOM_BYTES} bytes.
 * @returns the sixteen-character suffix.
 */
function encodeRandomness(bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_BYTES) {
    throw new TypeError(`ULID randomness must be ${String(RANDOM_BYTES)} bytes, got ${String(bytes.length)}`)
  }
  let bits = 0n
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
  const characters = new Array<string>(RANDOM_CHARS)
  for (let index = RANDOM_CHARS - 1; index >= 0; index -= 1) {
    characters[index] = CROCKFORD[Number(bits & 31n)] as string
    bits >>= 5n
  }
  return characters.join('')
}

/**
 * Mint one identifier: a 48-bit millisecond timestamp in Crockford base32
 * followed by 80 random bits.
 * @param timestampMs - creation time in milliseconds; defaults to now.
 * @param random - random-byte source; defaults to the platform CSPRNG.
 * @returns a 26-character identifier.
 */
export function ulid(
  timestampMs: number = Date.now(),
  random: RandomByteSource = size => randomBytes(size),
): string {
  return encodeTime(timestampMs) + encodeRandomness(random(RANDOM_BYTES))
}

/**
 * Mint the idempotency key for one log batch.
 * @param timestampMs - creation time in milliseconds; defaults to now.
 * @param random - random-byte source; defaults to the platform CSPRNG.
 * @returns the batch id.
 */
export function logBatchId(timestampMs?: number, random?: RandomByteSource): string {
  return `log-${ulid(timestampMs, random)}`
}

/**
 * Mint the idempotency key for one uploaded artifact.
 * @param timestampMs - creation time in milliseconds; defaults to now.
 * @param random - random-byte source; defaults to the platform CSPRNG.
 * @returns the artifact id.
 */
export function artifactId(timestampMs?: number, random?: RandomByteSource): string {
  return `art-${ulid(timestampMs, random)}`
}
