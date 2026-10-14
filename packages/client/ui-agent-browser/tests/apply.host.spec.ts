/** The Agent Browser Host companion is inert: the Client loader mounts the browser half. */

import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('keeps the Agent Browser Host Loader entry inert', () => {
  expect(apply).not.toThrow()
})
