/** The preview drop reads only the sidebar's own drag payload and validates the identity. */
import { expect, it } from 'vitest'
import { previewSessionId } from '../src/client/preview-drop.ts'

const transfer = (types: readonly string[], value: string): Pick<DataTransfer, 'types' | 'getData'> => ({
  types,
  getData: format => format === 'text/plain' ? value : '',
})

const known = (id: string): boolean => id === 's-1'

it('accepts a sidebar row payload that names a known Session', () => {
  expect(previewSessionId(transfer(['text/plain'], 's-1'), known)).toBe('s-1')
})

it('rejects unknown Sessions, other payload types, and blank values', () => {
  expect(previewSessionId(transfer(['text/plain'], 's-2'), known)).toBeUndefined()
  expect(previewSessionId(transfer(['Files'], 's-1'), known)).toBeUndefined()
  expect(previewSessionId(transfer(['text/plain'], '   '), known)).toBeUndefined()
})
