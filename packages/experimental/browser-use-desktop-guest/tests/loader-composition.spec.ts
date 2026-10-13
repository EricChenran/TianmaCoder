/** A real Loader and AgentLoop exercise the desktop guest provider end to end through the shell seam. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Provider from '../src/index.ts'

const sent: Array<Record<string, unknown>> = []

const shellClient = {
  request: async (request: Record<string, unknown>) => {
    sent.push(request)
    if (request.op === 'acquire') return { leaseId: 'l-loader' }
    if (request.op === 'execute') return { url: request.args ? (request.args as { url: string }).url : '', title: 'Example Domain' }
    return null
  },
  onEvent: () => {
    return () => undefined
  },
}

class BrowserModel extends LlmAdapter {
  mainRequests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.mainRequests.push(options)
    if (this.mainRequests.length === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('navigate-once'),
        name: 'browser_navigate',
        arguments: '{"url":"https://example.com/"}',
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Navigated the desktop guest.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

it('loads the desktop guest provider from cordis.yml, logs the navigation, and releases the lease on disposal', async () => {
  sent.length = 0
  root = await mkdtemp(join(tmpdir(), 'dsh-desktop-guest-composition-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-browser-use', BrowserUseRegistry],
    ['@deepseek-ai/dsh-experimental-browser-use-desktop-guest', Provider],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: '${name}'`,
    ...name === '@deepseek-ai/dsh-experimental-browser-use-desktop-guest' ? ['  config:', '    workspaceKey: ws-loader'] : [],
  ]).join('\n') + '\n')
  const context = ctx = new Context()
  context.provide('desktopBrowserControl', shellClient as never)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  const model = new BrowserModel()
  context.llm.registerAdapter(['fixture'], model)
  const agent = await context.agentLoop.create(SessionId('desktop-guest-loader'), { provider: 'fixture', model: 'text' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Open example.com in the desktop guest.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(sent.map(message => message.op)).toEqual(['acquire', 'execute'])
  expect(sent[0]!.workspaceKey).toBe('ws-loader')
  expect(sent[1]!.leaseId).toBe('l-loader')
  const events = agent.session.snapshotEvents()
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'navigate-once')
  if (result?.type !== 'tool/result') throw new Error('Missing navigation result')
  expect(JSON.stringify(result)).toContain('https://example.com/')
  expect(JSON.stringify(model.mainRequests.at(-1)?.messages)).toContain('Example Domain')
  await context.fiber.dispose()
  expect(sent.map(message => message.op)).toEqual(['acquire', 'execute', 'release'])
})
