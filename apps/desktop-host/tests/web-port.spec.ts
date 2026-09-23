import { expect, it } from 'vitest'
import { desktopWebPort } from '../src/web-port.ts'

it('keeps the packaged default when the override is absent, empty, or blank', () => {
  expect(desktopWebPort(undefined)).toBe('19387')
  expect(desktopWebPort('')).toBe('19387')
  expect(desktopWebPort('   ')).toBe('19387')
})

it('accepts an explicit port, including the operating system assigned zero', () => {
  expect(desktopWebPort('19388')).toBe('19388')
  expect(desktopWebPort('0')).toBe('0')
  expect(desktopWebPort(' 19388 ')).toBe('19388')
})

it.each(['not-a-number', '-1', '65536', '1.5', '19387x'])('rejects the invalid override %s', (value) => {
  expect(() => desktopWebPort(value)).toThrow('desktop host: DSH_DESKTOP_WEB_PORT must be an integer from 0 through 65535')
})
