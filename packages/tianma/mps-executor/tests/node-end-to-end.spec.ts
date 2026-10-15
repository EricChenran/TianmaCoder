/**
 * The node end to end: the shipped plugin, booted through the Loader, dialing a platform on
 * this host, running one task with a stub agent in a real git workspace, and handing back
 * the delivery, the evidence, and the artifacts the platform checks.
 *
 * Nothing here is mocked except the platform and the agent: the composition is loaded from
 * a `cordis.yml`, the plugin's own configuration is validated, the workspace is a real
 * clone, the commit and push are real, and the evidence commands run for real.
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as executor from '@tianma/dsh-mps-executor'

const run = promisify(execFile)

/** Directories one test created, removed after it. */
const created: string[] = []

/** The node's context, disposed after each test. */
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix for the directory.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** One request the node made. */
interface Recorded {
  path: string
  body: string
  contentType: string | undefined
}

/** The platform the node dials: it answers one task and records everything it was sent. */
class PlatformStub {
  readonly requests: Recorded[] = []
  readonly task: Record<string, unknown>
  #server: Server | undefined
  #port = 0
  #claimed = false

  constructor(task: Record<string, unknown>) {
    this.task = task
  }

  /** Start listening on this host. */
  async listen(): Promise<number> {
    this.#server = createServer((request, response) => {
      void this.#answer(request, response)
    })
    await new Promise<void>((resolve) => { this.#server?.listen(0, '127.0.0.1', resolve) })
    const address = this.#server?.address()
    this.#port = typeof address === 'object' && address !== null ? address.port : 0
    return this.#port
  }

  /** Stop listening. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.#server?.close(() => { resolve() }) })
  }

  /** Everything the node sent to one path. */
  at(path: string): Recorded[] {
    return this.requests.filter(request => request.path === path)
  }

  /**
   * Answer one request the way the protocol states.
   * @param request - the incoming request.
   * @param response - the response to write.
   */
  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const path = (request.url ?? '').split('?')[0] ?? ''
    this.requests.push({
      path,
      body: Buffer.concat(chunks).toString('utf8'),
      contentType: request.headers['content-type'],
    })
    if (path === '/exec/v1/auth/token') return this.#envelope(response, { token: 'tok', expires_at: 'e', node_id: 'node-e2e' })
    if (path === '/exec/v1/register') return this.#envelope(response, { registered: true })
    if (path === '/exec/v1/claim') {
      if (this.#claimed) {
        response.writeHead(204).end()
        return
      }
      this.#claimed = true
      return this.#envelope(response, { task: this.task })
    }
    if (path.endsWith('/result')) {
      return this.#envelope(response, { task_id: 'tsk_e2e', accepted: true, already_final: false, work_item_state: 'done', next: 'verify' })
    }
    if (path.endsWith('/artifacts')) return this.#envelope(response, { artifact_id: 'art_e2e' })
    return this.#envelope(response, null)
  }

  /**
   * Write one protocol envelope.
   * @param response - the response to write.
   * @param data - the payload.
   */
  #envelope(response: ServerResponse, data: unknown): void {
    const body = JSON.stringify({ code: 'OK', msg: '', data, requestId: 'req_e2e', serverTime: '2026-10-15T04:00:00Z' })
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
  }
}

/**
 * A bare repository with one commit, and the commit the node must start from.
 * @param root - the directory to build it under.
 * @returns the bare repository's path and its head commit.
 */
async function repository(root: string): Promise<{ bare: string; base: string }> {
  const bare = join(root, 'origin.git')
  const source = join(root, 'source')
  mkdirSync(source, { recursive: true })
  await run('git', ['init', '--bare', '--quiet', bare])
  await run('git', ['init', '--quiet'], { cwd: source })
  writeFileSync(join(source, 'readme.md'), '# 订单系统\n', 'utf8')
  await run('git', ['add', 'readme.md'], { cwd: source })
  await run('git', ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.invalid', 'commit', '--quiet', '-m', 'base'], { cwd: source })
  const base = (await run('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
  await run('git', ['push', '--quiet', bare, 'HEAD:refs/heads/main'], { cwd: source })
  return { bare, base }
}

/**
 * Boot the shipped plugin through the Loader against one platform.
 * @param options - the platform address, the workspace root, and the agent command.
 * @returns the composed context.
 */
async function boot(options: { port: number; workspaceRoot: string; logs: string }): Promise<Context> {
  const root = temporary('mps-e2e-config-')
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, [
    "- name: '@tianma/dsh-mps-executor'",
    '  config:',
    "    platformHost: '127.0.0.1'",
    `    platformPort: ${String(options.port)}`,
    "    nodeId: 'node-e2e'",
    "    secretEnv: 'MPS_E2E_SECRET'",
    `    workspaceRoot: '${options.workspaceRoot.replace(/\\/gu, '/')}'`,
    '    autoStart: true',
    '    cliRunner:',
    '      command:',
    `        - '${process.execPath.replace(/\\/gu, '/')}'`,
    `        - '${join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'node-agent.mjs').replace(/\\/gu, '/')}'`,
    `      logsDirectory: '${options.logs.replace(/\\/gu, '/')}'`,
    '      jsonEvents: true',
    '',
  ].join('\n'))
  process.env['MPS_E2E_SECRET'] = 'e2e-secret'
  const booted = new Context()
  booted.baseUrl = `${pathToFileURL(root).href}/`
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@tianma/dsh-mps-executor', executor]])
  booted.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const found = modules.get(specifier)
      if (found === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return found
    },
  } as unknown as NonNullable<typeof booted.loader.internal>
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await booted.loader.await()
  return booted
}

/**
 * Wait until one condition holds.
 * @param condition - the condition to poll.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('the node never reached the state this test waited for')
}

describe('the node end to end', () => {
  it('runs one task and hands the platform its delivery and evidence', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_e2e',
      work_item_id: 'wi_e2e',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '增加批量下载' },
        workspace: {
          workspace_id: 'ws_e2e',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_e2e' },
        },
        constraints: { must_stay_in_workspace: true },
        deliverables: {
          require_build: true,
          build_command: 'node --version',
          require_report: true,
          report_filename: 'REPORT.md',
          require_screenshots: true,
          min_screenshots: 1,
          push_required: true,
        },
      },
    })
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_e2e/result').length > 0)
    } finally {
      await platform.close()
    }

    // The node registered with the address it was configured with, then worked one task.
    expect(platform.at('/exec/v1/auth/token')).toHaveLength(1)
    expect(platform.at('/exec/v1/register')).toHaveLength(1)
    expect(platform.at('/exec/v1/claim').length).toBeGreaterThan(0)

    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_e2e/result')[0]?.body ?? '{}') as Record<string, unknown>
    const evidence = result['evidence'] as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'success' })
    // The stub agent changed the workspace, and the node committed and pushed it.
    expect(evidence['changed_files']).toEqual(['REPORT.md', 'feature.txt'])
    expect(evidence['pushed']).toBe(true)
    expect((await run('git', ['rev-parse', 'feature/tsk_e2e'], { cwd: bare })).stdout.trim()).toBe(evidence['head_commit'])
    // The evidence the deliverables require came back with the artifacts the platform reads.
    expect((evidence['build'] as Record<string, unknown>)['exit_code']).toBe(0)
    // The node mints the idempotency key, so the ids are its own ULIDs.
    expect((evidence['build'] as Record<string, unknown>)['log_artifact_id']).toMatch(/^art-/u)
    expect(evidence['report_artifact_id']).toMatch(/^art-/u)
    expect(evidence['screenshots']).toEqual([
      { artifact_id: expect.stringMatching(/^art-/u), route: '/orders', caption: '/orders' },
    ])
    // Three artifacts: the build log, the report, and the screenshot.
    expect(platform.at('/exec/v1/tasks/tsk_e2e/artifacts')).toHaveLength(3)
    // The session the run opened was reported, and the run's events reached the log.
    const sessions = platform.at('/exec/v1/workspaces/ws_e2e/session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.body).toContain('dsh-session-e2e')
    const log = platform.at('/exec/v1/tasks/tsk_e2e/log').map(request => request.body).join('\n')
    expect(log).toContain('已增加批量下载')
    expect(log).toContain('tool write')
  }, 120_000)
})
