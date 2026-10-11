/** The product Remote assembly mounts every `remote.<ns>` the web roster's modules inject. */
import { describe, expect, it } from 'vitest'
import { webApp } from '../src/assembly/index.ts'
import { loadPluginModules } from '../src/assembly/modules.ts'

const REMOTES_PACKAGE = '@deepseek-ai/dsh-api-remotes'
const PREFIX = 'remote.'

/** Namespace names one module's inject names, in both inject forms. */
function injectedNamespaces(module: { inject?: unknown }): readonly string[] {
  const names = Array.isArray(module.inject) ? module.inject : Object.keys(module.inject ?? {})
  return names.filter((service): service is string => typeof service === 'string' && service.startsWith(PREFIX))
    .map(service => service.slice(PREFIX.length))
    .filter(namespace => namespace !== '')
}

describe('product Remote coverage', () => {
  it('mounts every remote namespace the product roster injects', async () => {
    const modules = await loadPluginModules({ roster: webApp })
    const injected = new Set<string>()
    for (const module of modules.values()) {
      for (const namespace of injectedNamespaces(module)) injected.add(namespace)
    }

    const remotes = await import(/* @vite-ignore */ `${REMOTES_PACKAGE}/client`) as {
      apply: (ctx: unknown) => Promise<void>
    }
    const mounted = new Set<string>()
    await remotes.apply({
      remote: {
        $mount: async (contribution: { descriptors: ReadonlyArray<{ namespace: string }> }) => {
          for (const descriptor of contribution.descriptors) mounted.add(descriptor.namespace)
          return async () => {}
        },
      },
    })

    const missing = [...injected].filter(namespace => !mounted.has(namespace)).sort()
    expect(missing, `the roster injects ${missing.map(name => PREFIX + name).join(', ')} but the assembly mounts only ${[...mounted].sort().join(', ')}`)
      .toEqual([])
  })
})
