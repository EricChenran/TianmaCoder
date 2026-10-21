/**
 * The route list the node's deployment form offers: one row per advertised model, grouped
 * by provider, resolved back into the two stored fields. A deployment states one route for
 * the whole node, so these helpers are what keeps a pick from ever being half a pair.
 */

import { describe, expect, it } from 'vitest'
import { routeChoices, routeFields, routeLabel, routeValue } from '../src/client/model-options.ts'

const GROUPS = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  { id: 'acme-gateway', name: 'Acme', models: [{ id: 'acme-1', name: '' }] },
]

describe('the route list behind the deployment form', () => {
  it('offers one row per advertised model, grouped by provider', () => {
    expect(routeChoices(GROUPS)).toEqual([
      {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        value: 'deepseek-official/deepseek-flash',
        label: 'DeepSeek-V4.1-Flash',
        group: 'DeepSeek',
      },
      {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        value: 'deepseek-official/deepseek-v4-pro',
        label: 'DeepSeek-V4-Pro',
        group: 'DeepSeek',
      },
      // A model the catalog names nothing falls back to its id, so the row is still readable.
      { provider: 'acme-gateway', model: 'acme-1', value: 'acme-gateway/acme-1', label: 'acme-1', group: 'Acme' },
    ])
    expect(routeChoices([])).toEqual([])
  })

  it('resolves a picked row back into the two stored fields', () => {
    expect(routeFields('deepseek-official/deepseek-v4-pro')).toEqual({
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-v4-pro',
    })
    // The empty choice is the profile's own default: both fields clear together.
    expect(routeFields('')).toEqual({ agentProvider: '', agentModel: '' })
    expect(routeFields('no-separator')).toEqual({ agentProvider: '', agentModel: '' })
  })

  it('shows a stored pair selected, and half a pair as nothing', () => {
    expect(routeValue('deepseek-official', 'deepseek-flash')).toBe('deepseek-official/deepseek-flash')
    // Half a pair is what the executor refuses at load, so the form never presents it as a
    // route: it shows the default choice and a save writes both fields.
    expect(routeValue('deepseek-official', '')).toBe('')
    expect(routeValue('', 'deepseek-flash')).toBe('')
    expect(routeValue(undefined, undefined)).toBe('')
  })

  it('labels the read-only row, or says the profile default stands', () => {
    expect(routeLabel('deepseek-official', 'deepseek-v4-pro', 'default')).toBe('deepseek-official / deepseek-v4-pro')
    expect(routeLabel('', '', 'default')).toBe('default')
  })
})
