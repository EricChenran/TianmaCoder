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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * The sha256 a platform states for the bytes it serves.
 * @param bytes - the bytes.
 * @returns the digest in lower-case hexadecimal.
 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Boot a node on one task of its own, run it, and wait for the result.
 * @param options - the workspace root, the agent mode, and anything the payload adds.
 * @returns the platform stub, for its recorded requests.
 */
async function runOneTask(options: {
  workspaceRoot: string
  logs: string
  mode?: string
  workspaceId: string
  taskId: string
  base: string
  bare: string
  extra?: Record<string, unknown>
}): Promise<PlatformStub> {
  const platform = new PlatformStub({
    task_id: options.taskId,
    work_item_id: `wi_${options.taskId}`,
    attempt: 1,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2030-01-01T00:00:00Z',
    lease_renew_seconds: 30,
    payload: {
      limits: { max_runtime_seconds: 300 },
      spec: { raw_instruction: '一项自带风险的任务' },
      workspace: {
        workspace_id: options.workspaceId,
        access_mode: 'read_write',
        repo: {
          url: options.bare.replace(/\\/gu, '/'),
          base_branch: 'main',
          base_commit: options.base,
          work_branch: `feature/${options.taskId}`,
        },
      },
      constraints: { must_stay_in_workspace: false },
      deliverables: { push_required: true },
      ...options.extra,
    },
  })
  const port = await platform.listen()
  try {
    context = await boot({
      port,
      workspaceRoot: options.workspaceRoot,
      logs: options.logs,
      agentArgs: options.mode === undefined ? [] : [options.mode],
    })
    await waitFor(() => platform.at(`/exec/v1/tasks/${options.taskId}/result`).length > 0)
  } finally {
    await platform.close()
  }
  return platform
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
  #tasks: Record<string, unknown>[]
  #server: Server | undefined
  #port = 0

  #commands: Record<string, unknown>[] = []
  #materials = new Map<string, { bytes: Buffer; digest: string }>()

  constructor(task: Record<string, unknown>) {
    this.#tasks = [task]
  }

  /**
   * Serve one material this task references. The digest is what the platform states in the
   * response header, so a test can state a wrong one on purpose.
   * @param artifactId - the material's artifact id.
   * @param body - the bytes to serve.
   * @param digest - the sha256 the header states; the bytes' own digest by default.
   */
  serveMaterial(artifactId: string, body: string, digest?: string): void {
    const bytes = Buffer.from(body, 'utf8')
    this.#materials.set(artifactId, { bytes, digest: digest ?? sha256Of(bytes) })
  }

  /**
   * Order one command for the next heartbeat, which is how a platform stops an attempt or
   * releases a workspace.
   * @param command - the command the heartbeat carries down.
   */
  order(command: Record<string, unknown>): void {
    this.#commands.push(command)
  }

  /**
   * Offer one more task at the next claim, which is how a platform returns a workspace to
   * the node that already holds it.
   * @param task - the assignment the claim answers with.
   */
  offer(task: Record<string, unknown>): void {
    this.#tasks.push(task)
  }

  /**
   * Start listening on this host, or on the port it used before, which is the address the
   * node was configured with and cannot change.
   * @param port - the port to listen on; the one it last used by default.
   * @returns the port it listens on.
   */
  async listen(port?: number): Promise<number> {
    this.#server = createServer((request, response) => {
      void this.#answer(request, response)
    })
    await new Promise<void>((resolve) => {
      this.#server?.listen(port ?? this.#port, '127.0.0.1', resolve)
    })
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
    if (path === '/exec/v1/register') {
      // A short period keeps an instruction from waiting on the timer in a test.
      return this.#envelope(response, { registered: true, heartbeat_interval_seconds: 1 })
    }
    if (path === '/exec/v1/heartbeat') {
      const commands = this.#commands
      this.#commands = []
      return this.#envelope(response, {
        node_status: 'online',
        commands,
        lease_notices: [],
        config_revision: 1,
        server_time: '2026-10-15T04:00:00Z',
      })
    }
    if (path === '/exec/v1/claim') {
      const next = this.#tasks.shift()
      if (next === undefined) {
        response.writeHead(204).end()
        return
      }
      return this.#envelope(response, { task: next })
    }
    const material = /\/resources\/([^/]+)$/u.exec(path)
    if (material !== null) {
      const served = this.#materials.get(material[1] ?? '')
      if (served === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
          code: 'RESOURCE_NOT_IN_SCOPE', msg: 'no such material', data: null, requestId: 'req_e2e',
        }))
        return
      }
      // The download carries the bytes themselves, with the digest the platform states.
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-artifact-sha256': served.digest,
        'content-length': String(served.bytes.byteLength),
      }).end(served.bytes)
      return
    }
    if (path.endsWith('/result')) {
      const taskId = /\/tasks\/([^/]+)\/result/u.exec(path)?.[1] ?? ''
      return this.#envelope(response, { task_id: taskId, accepted: true, already_final: false, work_item_state: 'done', next: 'verify' })
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
async function boot(options: {
  port: number
  workspaceRoot: string
  logs: string
  agentArgs?: string[]
  command?: string[]
}): Promise<Context> {
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
    ...(options.command ?? [
      process.execPath,
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'node-agent.mjs'),
      ...options.agentArgs ?? [],
    ]).map(argument => `        - '${argument.replace(/\\/gu, '/')}'`),
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
    // Capabilities are a promise: the node declares both access modes because it does both.
    const registered = platform.at('/exec/v1/register')[0]?.body ?? ''
    expect(registered).toContain('"access_modes":["read_only","read_write"]')
    expect(registered).toContain('"supported_protocols":["exec/v1"]')
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

  it('never tells the platform a credential the attempt printed', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = await runOneTask({ workspaceRoot, logs, mode: 'secret', workspaceId: 'ws_secret', taskId: 'tsk_secret', base, bare })

    const reported = platform.at('/exec/v1/tasks/tsk_secret/log').map(request => request.body).join('\n')
    // The lines arrived, with the values the node refused to pass on taken out.
    expect(reported).toContain('DEEPSEEK_API_KEY')
    expect(reported).toContain('[REDACTED]')
    expect(reported).not.toContain('sk-1234567890abcdef')
    expect(reported).not.toContain('sk-live-abcdef123456')
    // The attempt itself still succeeded: redaction is not a failure.
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_secret/result')[0]?.body ?? '{}') as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'success' })
  }, 120_000)

  it('refuses to deliver a tree that carries a credential', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = await runOneTask({ workspaceRoot, logs, mode: 'credential', workspaceId: 'ws_credential', taskId: 'tsk_credential', base, bare })

    // The delivery is refused and the credential stays on the node: nothing was pushed.
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_credential/result')[0]?.body ?? '{}') as Record<string, unknown>
    const evidence = result['evidence'] as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(String(result['summary'])).toContain('refusing to publish credentials in config.txt')
    expect(evidence['pushed']).toBe(false)
    await expect(run('git', ['rev-parse', 'feature/tsk_credential'], { cwd: bare })).rejects.toThrow()
  }, 120_000)

  it('refuses a delivery whose change leaves the workspace', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_escape',
      work_item_id: 'wi_escape',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '把改动指到工作区外面' },
        workspace: {
          workspace_id: 'ws_escape',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_escape' },
        },
        constraints: { must_stay_in_workspace: true },
        deliverables: { push_required: true },
      },
    })
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs, agentArgs: ['escape'] })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_escape/result').length > 0)
    } finally {
      await platform.close()
    }

    // The attempt is reported as failed, and nothing reached the origin: the branch does
    // not exist there, because the node refuses before it commits.
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_escape/result')[0]?.body ?? '{}') as Record<string, unknown>
    const evidence = result['evidence'] as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(String(result['summary'])).toContain('resolves outside the workspace')
    expect(evidence['pushed']).toBe(false)
    expect(evidence['head_commit']).toBe(evidence['base_commit'])
    await expect(run('git', ['rev-parse', 'feature/tsk_escape'], { cwd: bare })).rejects.toThrow()
  }, 120_000)

  it('brings a task material in before the attempt starts', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_material',
      work_item_id: 'wi_material',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '按材料里的要求改' },
        context: { resources: ['art_material'] },
        workspace: {
          workspace_id: 'ws_material',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_material' },
        },
        constraints: { must_stay_in_workspace: false },
        deliverables: { push_required: true },
      },
    })
    platform.serveMaterial('art_material', '# 需求说明：按类型筛选\n')
    const port = await platform.listen()
    let taskBook = ''
    let material = ''
    try {
      context = await boot({ port, workspaceRoot, logs })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_material/result').length > 0)
      // The material and the book that names it are in the workspace the attempt worked in.
      const directory = join(workspaceRoot, 'coding', 'ws_material')
      taskBook = readFileSync(join(directory, 'PROMPT.md'), 'utf8')
      material = readFileSync(join(directory, '.materials', 'art_material'), 'utf8')
    } finally {
      await platform.close()
    }

    expect(platform.at('/exec/v1/tasks/tsk_material/resources/art_material')).toHaveLength(1)
    expect(material).toBe('# 需求说明：按类型筛选\n')
    // The agent is pointed at it, which is how it reads the requirement at all.
    expect(taskBook).toContain('.materials')
    expect(taskBook).toContain('art_material')
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_material/result')[0]?.body ?? '{}') as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'success' })
  }, 120_000)

  it('refuses to start on a material whose bytes do not match the stated digest', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_tampered',
      work_item_id: 'wi_tampered',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '用一份被篡改的材料' },
        context: { resources: ['art_tampered'] },
        workspace: {
          workspace_id: 'ws_tampered',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_tampered' },
        },
        constraints: { must_stay_in_workspace: false },
      },
    })
    // The header states a digest the bytes do not have, which is what tampering looks like.
    platform.serveMaterial('art_tampered', 'changed on the way\n', 'f'.repeat(64))
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_tampered/result').length > 0)
    } finally {
      await platform.close()
    }

    // The attempt is blocked rather than run on material it cannot trust, and the agent
    // never started: no work was done and nothing was delivered.
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_tampered/result')[0]?.body ?? '{}') as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'blocked' })
    expect(String(result['summary'])).toContain('could not bring in the task')
    expect((result['evidence'] as Record<string, unknown>)['changed_files']).toEqual([])
  }, 120_000)

  it('keeps working through an outage, and loses none of the log', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_outage',
      work_item_id: 'wi_outage',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '边做边说，中途平台掉线' },
        workspace: {
          workspace_id: 'ws_outage',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_outage' },
        },
        constraints: { must_stay_in_workspace: false },
        deliverables: { push_required: true },
      },
    })
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs, agentArgs: ['chatty'] })
      // The attempt is under way and the platform has taken its first lines.
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_outage/log').length > 0)

      // The platform goes away for a few seconds: the agent keeps working, the node keeps
      // its lines, and its heartbeat keeps failing until the platform is back.
      await platform.close()
      await new Promise(resolve => setTimeout(resolve, 4_000))
      await platform.listen(port)
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_outage/result').length > 0)
    } finally {
      await platform.close()
    }

    // The task was not lost to the outage, and every line the agent printed arrived: the
    // ones produced while the platform was unreachable were offered again afterwards.
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_outage/result')[0]?.body ?? '{}') as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'success' })
    const reported = platform.at('/exec/v1/tasks/tsk_outage/log').map(request => request.body).join('\n')
    for (const line of ['line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6']) {
      expect(reported).toContain(line)
    }
    // The heartbeat resumed too, since the node was still online afterwards.
    expect(platform.at('/exec/v1/heartbeat').length).toBeGreaterThan(0)
  }, 120_000)

  it('stops an attempt the platform aborts, and says it was cancelled', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_abort',
      work_item_id: 'wi_abort',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '做一半就被叫停' },
        workspace: {
          workspace_id: 'ws_abort',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_abort' },
        },
        constraints: { must_stay_in_workspace: false },
      },
    })
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs, agentArgs: ['slow'] })
      // The attempt is running and will not end on its own; the platform stops it.
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_abort/progress').length > 0)
      platform.order({ command: 'abort', task_id: 'tsk_abort', reason: '需求方要求暂停', issued_at: '2026-10-15T04:00:00Z' })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_abort/result').length > 0)
    } finally {
      await platform.close()
    }

    // The attempt was stopped rather than left running, acknowledged, and reported as
    // cancelled: a run the platform ended did not fail.
    expect(platform.at('/exec/v1/tasks/tsk_abort/abort-ack')).toHaveLength(1)
    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_abort/result')[0]?.body ?? '{}') as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'cancelled' })
  }, 120_000)

  it('releases the workspace the platform releases, and keeps its record clean', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_release',
      work_item_id: 'wi_release',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '做完就被释放' },
        workspace: {
          workspace_id: 'ws_release',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_release' },
        },
        constraints: { must_stay_in_workspace: false },
        deliverables: { push_required: true },
      },
    })
    const port = await platform.listen()
    const coding = join(workspaceRoot, 'coding')
    try {
      context = await boot({ port, workspaceRoot, logs })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_release/result').length > 0)
      expect(existsSync(join(coding, 'ws_release'))).toBe(true)

      // The platform unbinds the workspace; cleanup is its instruction, never the node's.
      platform.order({ command: 'release_workspace', workspace_id: 'ws_release', reason: '工作项关闭', issued_at: '2026-10-15T04:00:00Z' })
      await waitFor(() => !existsSync(join(coding, 'ws_release')))
    } finally {
      await platform.close()
    }

    const state = JSON.parse(readFileSync(join(coding, '.state.json'), 'utf8')) as Record<string, unknown>
    expect(state['workspaces']).toEqual([])
  }, 120_000)

  it('returns a second task in the same workspace to the same session', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_first',
      work_item_id: 'wi_first',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '第一次改动' },
        workspace: {
          workspace_id: 'ws_same',
          access_mode: 'read_write',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/ws_same' },
        },
        constraints: { must_stay_in_workspace: false },
        deliverables: { push_required: true },
      },
    })
    let firstHead: unknown
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_first/result').length > 0)

      const first = JSON.parse(platform.at('/exec/v1/tasks/tsk_first/result')[0]?.body ?? '{}') as Record<string, unknown>
      const firstEvidence = first['evidence'] as Record<string, unknown>
      firstHead = firstEvidence['head_commit']
      const firstSession = JSON.parse(platform.at('/exec/v1/workspaces/ws_same/session')[0]?.body ?? '{}') as Record<string, unknown>
      expect(first['outcome']).toBe('success')

      // The platform hands the same workspace back with the session it was told about.
      platform.offer({
        task_id: 'tsk_second',
        work_item_id: 'wi_second',
        attempt: 1,
        max_attempts: 3,
        kind: 'coding',
        priority: 400,
        lease_expire_at: '2030-01-01T00:00:00Z',
        lease_renew_seconds: 30,
        payload: {
          limits: { max_runtime_seconds: 300, session_hint: { previous_session_ref: firstSession['session_ref'] } },
          spec: { raw_instruction: '第二次改动' },
          workspace: {
            workspace_id: 'ws_same',
            access_mode: 'read_write',
            repo: {
              url: bare.replace(/\\/gu, '/'),
              base_branch: 'main',
              base_commit: String(firstEvidence['head_commit']),
              work_branch: 'feature/ws_same',
            },
          },
          constraints: { must_stay_in_workspace: false },
          deliverables: { push_required: true },
        },
      })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_second/result').length > 0)
    } finally {
      await platform.close()
    }

    const second = JSON.parse(platform.at('/exec/v1/tasks/tsk_second/result')[0]?.body ?? '{}') as Record<string, unknown>
    expect(second).toMatchObject({ outcome: 'success' })
    // The second task was carried out in the workspace the first one left behind: its base
    // commit is the head the first one pushed.
    expect((second['evidence'] as Record<string, unknown>)['base_commit']).toBe(firstHead)
    // Both tasks reported the same session, so the platform can follow one conversation.
    const sessions = platform.at('/exec/v1/workspaces/ws_same/session').map(request => JSON.parse(request.body) as Record<string, unknown>)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    expect(new Set(sessions.map(session => String(session['session_ref']))).size).toBe(1)
    // One coding directory serves both, and the node kept the record across them.
    const state = JSON.parse(readFileSync(join(workspaceRoot, 'coding', '.state.json'), 'utf8')) as Record<string, unknown>
    expect((state['workspaces'] as Record<string, unknown>[]).map(record => record['workspace_id'])).toEqual(['ws_same'])
    expect((state['workspaces'] as Record<string, unknown>[])[0]?.['last_task_id']).toBe('tsk_second')
  }, 120_000)

  it('hands a read_only task back as a bundle without pushing anything', async () => {
    const root = temporary('mps-e2e-')
    const workspaceRoot = join(root, 'node')
    const logs = join(root, 'logs')
    mkdirSync(workspaceRoot, { recursive: true })
    const { bare, base } = await repository(root)
    const platform = new PlatformStub({
      task_id: 'tsk_ro',
      work_item_id: 'wi_ro',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2030-01-01T00:00:00Z',
      lease_renew_seconds: 30,
      payload: {
        limits: { max_runtime_seconds: 300 },
        spec: { raw_instruction: '只读模式交付' },
        workspace: {
          workspace_id: 'ws_ro',
          access_mode: 'read_only',
          repo: { url: bare.replace(/\\/gu, '/'), base_branch: 'main', base_commit: base, work_branch: 'feature/tsk_ro' },
        },
        constraints: { must_stay_in_workspace: true },
      },
    })
    const port = await platform.listen()
    try {
      context = await boot({ port, workspaceRoot, logs })
      await waitFor(() => platform.at('/exec/v1/tasks/tsk_ro/result').length > 0)
    } finally {
      await platform.close()
    }

    const result = JSON.parse(platform.at('/exec/v1/tasks/tsk_ro/result')[0]?.body ?? '{}') as Record<string, unknown>
    const evidence = result['evidence'] as Record<string, unknown>
    expect(result).toMatchObject({ outcome: 'success' })
    expect(evidence['changed_files']).toEqual(['REPORT.md', 'feature.txt'])
    // The platform cannot fetch a branch in this mode, so the work goes back as a bundle.
    expect(evidence['pushed']).toBe(false)
    expect(evidence['patch_artifact_id']).toMatch(/^art-/u)
    await expect(run('git', ['rev-parse', 'feature/tsk_ro'], { cwd: bare })).rejects.toThrow()
    const uploads = platform.at('/exec/v1/tasks/tsk_ro/artifacts')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.body).toContain('bundle')
  }, 120_000)
})
