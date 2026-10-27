/**
 * Executor node behavior: the plugin configuration carries the platform host and
 * port a deployment points the node at, the node resolves them into the address
 * it dials, and the runtime authenticates, registers, heartbeats on the period
 * the platform assigns, and applies the recovery each failure requires.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  Config, DEFAULT_ANSWER_RUNTIME_SECONDS, DEFAULT_SECRET_ENV, MpsExecutorRuntime, UNKNOWN_AGENT_VERSION, WORKSPACE_STATE_FILE, WORKSPACE_STATE_VERSION, apply, autoStartNode, createReportSink, TASK_RUNNER_SERVICE, readNodeSecret, registerStopEffect, resolveExecutorSettings, WorkspaceStore, agentRunEnv, executorConfigFromEnv } from '@tianma/dsh-mps-executor'
import type {
  ExecHttpRequest,
  ExecHttpResponse,
  ExecHttpTransport,
  ExecutorReport,
  TaskRunContext,
  TaskRunResult,
  TaskRunner,
} from '@tianma/dsh-mps-executor'
import { formatRfc3339 } from '@tianma/dsh-mps-exec-core'
import type { ExecResources } from '@tianma/dsh-mps-exec-core'

/** One recorded call of the fake transport. */
interface TransportCall {
  request: ExecHttpRequest
}

/**
 * Build a transport answering from a queue and recording every call.
 * @param answers - one answer per call; the last answer repeats once the queue is spent.
 * @returns the transport and its recorded calls.
 */
/**
 * The JSON body of a recorded request.
 * @param request - the recorded request.
 * @returns the body as text, or an empty object when the request carried none.
 */
function jsonBody(request: ExecHttpRequest | undefined): string {
  return typeof request?.body === 'string' ? request.body : '{}'
}

function queueTransport(answers: ExecHttpResponse[]): { transport: ExecHttpTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = []
  const transport: ExecHttpTransport = async (request) => {
    calls.push({ request })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (answer === undefined) throw new Error('no scripted answer left')
    return answer
  }
  return { transport, calls }
}

/**
 * Build one OK envelope response.
 * @param data - payload to carry.
 * @returns the response.
 */
function envelope(data: unknown): ExecHttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify({ code: 'OK', msg: '', data, requestId: 'r', serverTime: 's' }) }
}

/**
 * Build one error envelope response.
 * @param code - envelope code.
 * @returns the response.
 */
function rejection(code: string): ExecHttpResponse {
  return { status: 409, headers: {}, text: JSON.stringify({ code, msg: 'no', data: null, requestId: 'r2' }) }
}

/** A register answer carrying the platform's assigned heartbeat period. */
const REGISTERED = {
  node_id: 'node-1',
  status: 'online',
  heartbeat_interval_seconds: 3,
  claim_long_poll_seconds: 7,
  lease_ttl_seconds: 900,
  lease_renew_seconds: 30,
  config_revision: 1,
  server_time: 's',
}

/** A heartbeat answer carrying no commands. */
const HEARTBEAT = { node_status: 'online', commands: [], lease_notices: [], config_revision: 1, server_time: 's' }

/**
 * Resolve settings for one node configuration.
 * @param overrides - configuration fields to override.
 * @returns the resolved settings.
 */
function settingsFor(overrides: Partial<Parameters<typeof resolveExecutorSettings>[0]> = {}) {
  return resolveExecutorSettings(
    {
      platformHost: '10.0.0.7',
      platformPort: 8791,
      nodeId: 'node-1',
      secretEnv: DEFAULT_SECRET_ENV,
      codingRoot: codingRoot(),
      ...overrides,
    },
    'test-host',
  )
}

/** Coding roots one test created, removed after it. */
const codingRoots: string[] = []

/**
 * A coding root of its own, so a spec never writes into the checkout.
 * @returns the directory.
 */
function codingRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mps-coding-'))
  codingRoots.push(root)
  return root
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const root of codingRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('node configuration', () => {
  it('carries the platform communication address as its own fields', () => {
    const config = Config({ platformHost: '192.168.1.10', nodeId: 'node-1' })
    expect(config.platformHost).toBe('192.168.1.10')
    expect(config.platformPort).toBe(8791)
    expect(config.platformScheme).toBe('http')
    expect(config.platformBasePath).toBe('/exec/v1')
    expect(config.secretEnv).toBe(DEFAULT_SECRET_ENV)
    expect(config.slotsTotal).toBe(1)
    expect(config.heartbeatSeconds).toBe(10)
    expect(config.claimLongPollSeconds).toBe(25)
    expect(config.requestTimeoutMs).toBe(15_000)
    expect(config.lanes).toEqual([])
    expect(config.tools).toEqual([])
    expect(config.agentVersion).toBe(UNKNOWN_AGENT_VERSION)
    expect(config.labels).toEqual({})
    expect(config.autoStart).toBe(true)
  })

  it('promises both work kinds and the answer ceiling when a deployment states neither', () => {
    const settings = settingsFor({})
    // Empty lanes would keep the platform from dispatching anything that states
    // required capabilities, so the resolution names both kinds it has runners for.
    expect(settings.capabilities.lanes).toEqual(['coding', 'chat_answer'])
    expect(settings.answerRuntimeSeconds).toBe(DEFAULT_ANSWER_RUNTIME_SECONDS)
  })

  it('accepts zero as the answer ceiling, which follows the lease, and refuses less', () => {
    expect(settingsFor({ answerRuntimeSeconds: 0 }).answerRuntimeSeconds).toBe(0)
    expect(() => Config({ platformHost: '192.168.1.10', nodeId: 'node-1', answerRuntimeSeconds: -1 })).toThrow()
  })

  it('keeps its operator directory beside the coding root, or where the GUI points it', () => {
    const settings = settingsFor({})
    expect(settings.opsRoot).toBe(join(settings.codingRoot, '.ops'))
    process.env.MPS_NODE_OPS_DIR = 'C:/ops/for-the-gui'
    try {
      expect(settingsFor({}).opsRoot).toBe('C:/ops/for-the-gui')
    } finally {
      delete process.env.MPS_NODE_OPS_DIR
    }
  })

  it('falls back to the CLI shipped beside the node when the PATH holds none', () => {
    const settings = settingsFor({ cliRunner: { command: ['dsh', '--profile', 'headless'], logsDirectory: '', dshHome: '', jsonEvents: false } })
    // On a machine without dsh on its PATH — the packaged GUI's node — the bare
    // name is rewritten to this process's interpreter plus the bundled CLI entry.
    expect(settings.cliRunner.command[0]).toBe(process.execPath)
    expect(settings.cliRunner.command[1]).toContain('bin.js')
    expect(settings.cliRunner.command.slice(2)).toEqual(['--profile', 'headless'])
    // The version probe asks the interpreter plus the entry, then --version.
    expect(settings.cliRunner.versionCommand).toEqual(settings.cliRunner.command.slice(0, 2))
  })

  it('keeps a stated command that names a path', () => {
    const settings = settingsFor({ cliRunner: { command: ['C:/tools/dsh.cmd', '--profile', 'headless'], logsDirectory: '', dshHome: '', jsonEvents: false } })
    expect(settings.cliRunner.command).toEqual(['C:/tools/dsh.cmd', '--profile', 'headless'])
    expect(settings.cliRunner.versionCommand).toEqual(['C:/tools/dsh.cmd'])
  })

  it('keeps the lanes a deployment states', () => {
    const settings = settingsFor({ lanes: ['coding'] })
    expect(settings.capabilities.lanes).toEqual(['coding'])
  })

  it('accepts an explicit port, scheme, and base path', () => {
    const config = Config({
      platformHost: '10.0.0.5',
      platformPort: 9443,
      platformScheme: 'https',
      platformBasePath: '/mps',
      nodeId: 'node-2',
      autoStart: false,
    })
    expect(config.platformPort).toBe(9443)
    expect(config.platformScheme).toBe('https')
    expect(config.platformBasePath).toBe('/mps')
    expect(config.autoStart).toBe(false)
  })

  it('starts every agent run at full access, with approvals off', () => {
    // A node's runs have no person to answer an approval, so the base profile's
    // workspace-write + ask pairing would refuse a run mid-task.
    expect(agentRunEnv(undefined)).toEqual({ DSH_PERMISSION_MODE: 'danger-full-access' })
    expect(agentRunEnv('C:\\node-home')).toEqual({ DSH_HOME: 'C:\\node-home', DSH_PERMISSION_MODE: 'danger-full-access' })
  })

  it('resolves the address, identity, and capacity the node runs with', () => {
    const settings = settingsFor({ lanes: ['frontend'], tools: ['node'], labels: { owner: 'ops' } })
    expect(settings.endpoint.origin).toBe('http://10.0.0.7:8791')
    expect(settings.endpoint.url('/register')).toBe('http://10.0.0.7:8791/exec/v1/register')
    expect(settings.nodeId).toBe('node-1')
    expect(settings.nodeName).toBe('node-1')
    expect(settings.nodeHost).toBe('test-host')
    expect(settings.workspaceRoot).toBe(process.cwd())
    expect(settings.capabilities.lanes).toEqual(['frontend'])
    expect(settings.capabilities.tools).toEqual(['node'])
    expect(settings.capabilities.os).toBe(process.platform)
    expect(settings.capabilities.access_modes).toEqual(['read_only', 'read_write'])
    // Version negotiation is the top-level `protocol_version`, so the capability is gone.
    expect('supported_protocols' in settings.capabilities).toBe(false)
    expect(settings.labels).toEqual({ owner: 'ops' })
  })

  it('keeps every value a deployment states', () => {
    const settings = settingsFor({
      nodeId: ' node-3 ',
      nodeName: 'build box',
      nodeHost: '10.0.0.9',
      workspaceRoot: 'D:\\mps',
      slotsTotal: 3,
      heartbeatSeconds: 5,
      claimLongPollSeconds: 20,
      requestTimeoutMs: 9000,
      agentVersion: '0.2.1-alpha.2',
      autoStart: false,
    })
    expect(settings.nodeId).toBe('node-3')
    expect(settings.nodeName).toBe('build box')
    expect(settings.nodeHost).toBe('10.0.0.9')
    expect(settings.workspaceRoot).toBe('D:\\mps')
    expect(settings.slotsTotal).toBe(3)
    expect(settings.heartbeatSeconds).toBe(5)
    expect(settings.claimLongPollSeconds).toBe(20)
    expect(settings.requestTimeoutMs).toBe(9000)
    expect(settings.agentVersion).toBe('0.2.1-alpha.2')
    expect(settings.autoStart).toBe(false)
  })

  it('rejects a blank node id', () => {
    expect(() => settingsFor({ nodeId: '   ' })).toThrow(/must not be blank/)
  })

  it('reads the secret from the configured environment variable', () => {
    expect(readNodeSecret({ platformHost: 'h', nodeId: 'n' }, { [DEFAULT_SECRET_ENV]: 's3cret' })).toBe('s3cret')
    expect(readNodeSecret({ platformHost: 'h', nodeId: 'n' }, { MPS_NODE_SECRET: '  padded  ' })).toBe('padded')
    expect(readNodeSecret({ platformHost: 'h', nodeId: 'n', secretEnv: 'OTHER' }, { OTHER: 'value' })).toBe('value')
    expect(readNodeSecret({ platformHost: 'h', nodeId: 'n', secretEnv: '  ' }, { [DEFAULT_SECRET_ENV]: 'v' })).toBe('v')
  })

  it('reports the missing variable by name', () => {
    expect(() => readNodeSecret({ platformHost: 'h', nodeId: 'n' }, {})).toThrow(/set the MPS_NODE_SECRET environment variable/)
    expect(() => readNodeSecret({ platformHost: 'h', nodeId: 'n', secretEnv: 'OTHER' }, { OTHER: '   ' })).toThrow(/set the OTHER/)
  })
})

describe('node runtime', () => {
  /**
   * Build a runtime over a queued transport.
   * @param answers - the scripted answers.
   * @param overrides - settings overrides.
   * @returns the runtime, its transport calls, and the reports it made.
   */
  function runtime(
    answers: ExecHttpResponse[],
    overrides: Partial<Parameters<typeof resolveExecutorSettings>[0]> = {},
    probeResources?: () => Promise<ExecResources>,
  ) {
    const queue = queueTransport(answers)
    const reports: ExecutorReport[] = []
    const instance = new MpsExecutorRuntime({
      settings: settingsFor(overrides),
      secret: () => 's',
      transport: queue.transport,
      probeResources,
      now: () => new Date('2026-10-15T04:03:55.123Z'),
      report: (report) => { reports.push(report) },
    })
    return { runtime: instance, calls: queue.calls, reports }
  }

  it('stops without announcing anything when it never came online', async () => {
    const { runtime: node, calls } = runtime([])

    await node.shutdown()

    // There is no drain to announce and no attempt to end, so nothing is sent at all.
    expect(calls).toEqual([])
    expect(node.state).toBe('idle')
  })

  it('starts idle with its capacity free', () => {
    const { runtime: node } = runtime([], { slotsTotal: 2 })
    expect(node.state).toBe('idle')
    expect(node.token).toBeUndefined()
    expect(node.lastError).toBeUndefined()
    expect(node.runningTasks).toEqual([])
    expect(node.heartbeatSeconds).toBe(10)
    expect(node.availableSlots()).toBe(2)
    expect(node.slots()).toEqual({ total: 2, running: 0, available: 2 })
    expect(node.client.nodeId).toBe('node-1')
    expect(node.client.endpoint.origin).toBe('http://10.0.0.7:8791')
  })

  it('authenticates then registers, adopting the period the platform assigns', async () => {
    const { runtime: node, calls, reports } = runtime([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    const registered = await node.bootstrap()
    expect(registered.heartbeat_interval_seconds).toBe(3)
    // The poll the platform stated is the one this node claims for, not the configured one.
    expect(node.claimLongPollSeconds).toBe(7)
    expect(node.state).toBe('online')
    expect(node.token).toBe('tok')
    expect(node.heartbeatSeconds).toBe(3)
    expect(node.lastError).toBeUndefined()
    expect(calls[0]?.request.url.endsWith('/auth/token')).toBe(true)
    expect(calls[0]?.request.headers.authorization).toBeUndefined()
    expect(calls[1]?.request.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(jsonBody(calls[1]?.request))).toMatchObject({
      node_id: 'node-1',
      name: 'node-1',
      host: 'test-host',
      workspace_root: process.cwd(),
      slots: { total: 1, running: 0, available: 1 },
      node_time: formatRfc3339(new Date('2026-10-15T04:03:55.123Z')),
      labels: {},
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.level).toBe('info')
    expect(reports[0]?.message).toContain('registered at http://10.0.0.7:8791')
  })

  it('keeps the configured period when the platform states none', async () => {
    const { runtime: node } = runtime([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope({ ...REGISTERED, heartbeat_interval_seconds: 0 }),
    ], { heartbeatSeconds: 7 })
    await node.bootstrap()
    expect(node.heartbeatSeconds).toBe(7)
  })

  it('halts on a failure only operators can clear', async () => {
    const { runtime: node, reports } = runtime([rejection('NODE_DISABLED')])
    await expect(node.bootstrap()).rejects.toThrow('NODE_DISABLED')
    expect(node.state).toBe('halted')
    expect(node.token).toBeUndefined()
    expect(node.lastError?.message).toBe('NODE_DISABLED: no (request r2)')
    expect(reports[0]?.level).toBe('error')
  })

  it('stays idle on a retryable registration failure', async () => {
    const { runtime: node } = runtime([envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }), rejection('DB_UNAVAILABLE')])
    await expect(node.bootstrap()).rejects.toThrow('DB_UNAVAILABLE')
    expect(node.state).toBe('authenticated')
    expect(node.lastError?.message).toBe('DB_UNAVAILABLE: no (request r2)')
  })

  it('refuses to heartbeat before it authenticated', async () => {
    const { runtime: node } = runtime([])
    await expect(node.heartbeatOnce()).rejects.toThrow(/must authenticate/)
  })

  it('reports running tasks, resources, and node time in its heartbeat', async () => {
    const { runtime: node, calls } = runtime([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
    ], { slotsTotal: 2, agentVersion: '1.2.3' }, async () => ({ cpu_percent: 62, mem_percent: 71, disk_free_gb: 118 }))
    await node.bootstrap()
    node.setRunningTasks([{ task_id: 'tsk_1', attempt: 1, started_at: 's', progress: 40, stage: 'coding' }])
    const result = await node.heartbeatOnce()
    expect(result.node_status).toBe('online')
    expect(node.availableSlots()).toBe(1)
    expect(JSON.parse(jsonBody(calls[2]?.request))).toMatchObject({
      node_id: 'node-1',
      agent_version: '1.2.3',
      slots: { total: 2, running: 1, available: 1 },
      resources: { cpu_percent: 62, mem_percent: 71, disk_free_gb: 118 },
      running_tasks: [{ task_id: 'tsk_1', attempt: 1, progress: 40, stage: 'coding' }],
    })
  })

  it('never reports a negative free-slot count', () => {
    const { runtime: node } = runtime([], { slotsTotal: 1 })
    node.setRunningTasks([
      { task_id: 'a', attempt: 1, started_at: 's', progress: 0, stage: 'coding' },
      { task_id: 'b', attempt: 1, started_at: 's', progress: 0, stage: 'coding' },
    ])
    expect(node.availableSlots()).toBe(0)
  })

  it('heartbeats on the assigned period and stops when asked', async () => {
    vi.useFakeTimers()
    const { runtime: node, calls } = runtime([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
    ])
    await node.bootstrap()
    node.start()
    node.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toHaveLength(3)
    expect(node.state).toBe('online')
    node.stop()
    expect(node.state).toBe('authenticated')
    node.stop()
    await vi.advanceTimersByTimeAsync(9000)
    expect(calls).toHaveLength(3)
  })

  it('warns and keeps the period on a retryable heartbeat failure', async () => {
    vi.useFakeTimers()
    const { runtime: node, reports } = runtime([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      rejection('DB_UNAVAILABLE'),
    ])
    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(node.state).toBe('online')
    expect(reports.at(-1)?.level).toBe('warn')
    expect(reports.at(-1)?.message).toContain('heartbeat failed')
    node.stop()
  })

  it('re-authenticates when the token expired', async () => {
    vi.useFakeTimers()
    const { runtime: node, calls } = runtime([
      envelope({ token: 'first', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      rejection('NODE_TOKEN_EXPIRED'),
      envelope({ token: 'second', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(node.token).toBe('second')
    expect(node.state).toBe('online')
    expect(calls).toHaveLength(5)
    node.stop()
  })

  it('halts and stops the timer on a halt-level heartbeat failure', async () => {
    vi.useFakeTimers()
    const { runtime: node, calls, reports } = runtime([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      rejection('NODE_SECRET_INVALID'),
    ])
    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(node.state).toBe('halted')
    expect(reports.at(-1)?.level).toBe('error')
    expect(reports.at(-1)?.message).toContain('halted')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toHaveLength(3)
  })

  it('keeps a failed re-authentication from stopping the node timer', async () => {
    vi.useFakeTimers()
    const { runtime: node } = runtime([
      envelope({ token: 'first', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      rejection('NODE_TOKEN_EXPIRED'),
      rejection('NODE_SECRET_INVALID'),
    ])
    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(node.state).toBe('halted')
    node.stop()
  })

  it('falls back to the wall clock and a silent sink when the caller states neither', async () => {
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    const bare = new MpsExecutorRuntime({ settings: settingsFor(), secret: () => 's', transport: queue.transport })
    await bare.bootstrap()
    expect(bare.state).toBe('online')
    expect(bare.token).toBe('tok')
  })

  it('reports a missing secret when the handshake needs it', async () => {
    const queue = queueTransport([])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => { throw new Error('executor node secret is missing: set the MPS_NODE_SECRET environment variable') },
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })
    await expect(node.bootstrap()).rejects.toThrow(/MPS_NODE_SECRET/)
    expect(node.state).toBe('idle')
    expect(node.lastError?.message).toMatch(/MPS_NODE_SECRET/)
    expect(reports[0]?.level).toBe('error')
  })

  it('waits out the period when a heartbeat fails with a plain rejection', async () => {
    vi.useFakeTimers()
    let calls = 0
    const flaky: ExecHttpTransport = async () => {
      calls += 1
      if (calls === 1) return envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' })
      if (calls === 2) return envelope(REGISTERED)
      throw 'boom'
    }
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: flaky,
      now: () => new Date(0),
      report: (report) => { reports.push(report) },
    })
    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(node.state).toBe('online')
    expect(node.lastError?.message).toBe('boom')
    expect(reports.at(-1)?.level).toBe('warn')
    node.stop()
  })
})

describe('plugin wiring', () => {
  it('routes node events to the profile logger by level', () => {
    const seen: string[] = []
    const sink = createReportSink({
      info: message => seen.push(`info:${message}`),
      warn: message => seen.push(`warn:${message}`),
      error: message => seen.push(`error:${message}`),
    })
    sink({ level: 'info', message: 'a' })
    sink({ level: 'warn', message: 'b' })
    sink({ level: 'error', message: 'c' })
    expect(seen).toEqual(['info:a', 'warn:b', 'error:c'])
  })

  it('starts the heartbeat once the handshake succeeds', async () => {
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    const node = new MpsExecutorRuntime({ settings: settingsFor(), secret: () => 's', transport: queue.transport })
    autoStartNode(node)
    await vi.waitFor(() => { expect(node.state).toBe('online') })
    expect(node.token).toBe('tok')
    node.stop()
  })

  it('leaves the node unstarted when the handshake is refused', async () => {
    const queue = queueTransport([rejection('NODE_DISABLED')])
    const node = new MpsExecutorRuntime({ settings: settingsFor(), secret: () => 's', transport: queue.transport })
    autoStartNode(node)
    await vi.waitFor(() => { expect(node.state).toBe('halted') })
    expect(node.token).toBeUndefined()
  })

  it('stops the heartbeat when the mount is disposed', async () => {
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    const node = new MpsExecutorRuntime({ settings: settingsFor(), secret: () => 's', transport: queue.transport })
    await node.bootstrap()
    const ctx = new Context()
    const stop = registerStopEffect(ctx, node)
    node.start()
    expect(node.state).toBe('online')
    // Stopping drains first, which is what the disposer waits for.
    await stop()
    expect(node.state).toBe('authenticated')
  })

  it('mounts the node service with the configured platform address', () => {
    vi.stubEnv(DEFAULT_SECRET_ENV, 's3cret')
    const ctx = new Context()
    apply(ctx, {
      workspaceRoot: codingRoot(),
      platformHost: '192.168.1.31',
      platformPort: 9443,
      platformScheme: 'https',
      platformBasePath: '/exec/v1',
      nodeId: 'node-31',
      autoStart: false,
    })
    const node = ctx.get('mpsExecutor')
    if (node === undefined) throw new Error('the node service was not published')
    expect(node.state).toBe('idle')
    expect(node.settings.nodeId).toBe('node-31')
    expect(node.client.endpoint.origin).toBe('https://192.168.1.31:9443')
    expect(node.client.endpoint.url('/register')).toBe('https://192.168.1.31:9443/exec/v1/register')
  })

  it('resolves the CLI runner it falls back to', () => {
    const defaults = settingsFor()
    // 'dsh' is not on this suite's PATH, so the default falls back to the CLI
    // shipped beside the node, started with this process's interpreter.
    const entry = require.resolve('@tianma/../dsh/lib/bin.js'.replace('@tianma/../', '@deepseek-ai/'))
    expect(defaults.cliRunner).toEqual({
      command: [process.execPath, entry, '--profile', 'headless'],
      bin: process.execPath,
      versionCommand: [process.execPath, entry],
      logsDirectory: join(defaults.workspaceRoot, 'logs'),
      dshHome: undefined,
      jsonEvents: false,
    })

    const stated = settingsFor({
      cliRunner: {
        command: ['C:\\tools\\dsh.exe', '--profile', 'headless'],
        logsDirectory: 'C:\\node-logs',
        dshHome: 'C:\\node-home',
        jsonEvents: true,
      },
    })
    expect(stated.cliRunner).toEqual({
      command: ['C:\\tools\\dsh.exe', '--profile', 'headless'],
      bin: 'C:\\tools\\dsh.exe',
      versionCommand: ['C:\\tools\\dsh.exe'],
      logsDirectory: 'C:\\node-logs',
      dshHome: 'C:\\node-home',
      jsonEvents: true,
    })

    // Blank strings mean "use the default", and a command with no executable is refused.
    const blank = settingsFor({ cliRunner: { command: [], logsDirectory: '   ', dshHome: '  ', jsonEvents: false } })
    expect(blank.cliRunner.logsDirectory).toBe(join(blank.workspaceRoot, 'logs'))
    expect(blank.cliRunner.dshHome).toBeUndefined()
    expect(() => settingsFor({ cliRunner: { command: [''], logsDirectory: '', dshHome: '', jsonEvents: false } }))
      .toThrow(/needs the command it starts/)
  })

  it('dials the configured platform host and port on load', async () => {
    vi.stubEnv(DEFAULT_SECRET_ENV, 's3cret')
    const answers = [
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-31' }),
      envelope(REGISTERED),
    ]
    const urls: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const answer = answers[Math.min(calls, answers.length - 1)]
      calls += 1
      return new Response(answer?.text ?? '', { status: answer?.status ?? 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      const ctx = new Context()
      apply(ctx, {
        workspaceRoot: codingRoot(),
        platformHost: '10.0.0.7',
        platformPort: 9443,
        platformScheme: 'https',
        platformBasePath: '/custom',
        nodeId: 'node-31',
      })
      const node = ctx.get('mpsExecutor')
      if (node === undefined) throw new Error('the node service was not published')
      await vi.waitFor(() => { expect(node.state).toBe('online') })
      expect(node.token).toBe('tok')
      // The handshake comes first; a node that can run work then claims.
      expect(urls.slice(0, 2)).toEqual([
        'https://10.0.0.7:9443/custom/auth/token',
        'https://10.0.0.7:9443/custom/register',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the runner the node falls back to', () => {
  /** One claim answer carrying a task the node can run. */
  const CLAIMED = {
    task: {
      task_id: 'tsk_1',
      work_item_id: 'wi_1',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2026-10-15T04:16:00.123+08:00',
      lease_renew_seconds: 30,
      payload: { limits: { max_runtime_seconds: 60 }, spec: { raw_instruction: '增加批量下载' } },
    },
  }

  it('claims with its own CLI runner when nothing else provides one', async () => {
    vi.stubEnv(DEFAULT_SECRET_ENV, 's3cret')
    const answers = [
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-31' }),
      envelope(REGISTERED),
      envelope(null),
    ]
    const urls: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const answer = answers[Math.min(calls, answers.length - 1)]
      calls += 1
      return new Response(answer?.text ?? '', { status: answer?.status ?? 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      const ctx = new Context()
      // A node with its own DSH_HOME still resolves the runner it falls back to.
      apply(ctx, {
        workspaceRoot: codingRoot(),
        platformHost: '10.0.0.7',
        nodeId: 'node-31',
        cliRunner: {
          command: ['dsh', '--profile', 'headless'],
          logsDirectory: '',
          dshHome: 'C:\\node-home',
          jsonEvents: true,
        },
      })

      // Claiming only happens when the node resolved a runner to execute with.
      await vi.waitFor(() => { expect(urls.some(url => url.endsWith('/claim'))).toBe(true) })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fetches the platform configuration when its revision moves, and applies what it owns', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, config_revision: 2 }),
      envelope({
        config_revision: 2,
        heartbeat_interval_seconds: 7,
        claim_long_poll_seconds: 25,
        max_artifact_bytes: 104857600,
      }),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.start()
    await node.heartbeatOnce()
    // The timer was re-armed at the platform's interval, so the next period follows it.
    await vi.advanceTimersByTimeAsync(7_000)
    node.stop()

    const urls = queue.calls.map(call => call.request.url)
    expect(urls.some(url => url.endsWith('/config'))).toBe(true)
    // The node owns the heartbeat interval, so it follows the platform's value.
    expect(node.heartbeatSeconds).toBe(7)
    // The parameters it keeps at the values it declared are named, never dropped silently.
    // The artifact ceiling is not among them: the platform's own ceiling applies to uploads.
    expect(reports.some(report => report.message.includes(
      'this node keeps the values it declared for claim_long_poll_seconds',
    ))).toBe(true)
    expect(reports.some(report => report.message.includes('max_artifact_bytes'))).toBe(false)
  })

  it('keeps the configuration it holds while the revision stands still', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()

    expect(queue.calls.map(call => call.request.url).some(url => url.endsWith('/config'))).toBe(false)
    expect(reports.some(report => report.message.includes('platform configuration'))).toBe(false)
  })

  it('keeps what it holds when the platform states nothing usable', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, config_revision: 4 }),
      envelope({ config_revision: 'nope', heartbeat_interval_seconds: Number.NaN }),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()

    // The registered interval stands, and the report says the configuration was applied.
    expect(node.heartbeatSeconds).toBe(3)
    expect(reports.some(report => report.message.includes('platform configuration 4 applied (heartbeat 3s)'))).toBe(true)
  })

  it('applies the platform interval even before the heartbeat timer runs', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, config_revision: 6 }),
      envelope({ config_revision: 6, heartbeat_interval_seconds: 9 }),
    ])
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: () => { /* this test reads the interval, not the reports */ },
    })

    await node.bootstrap()
    await node.heartbeatOnce()

    // Nothing is armed yet, so the value is applied and the timer picks it up when it starts.
    expect(node.heartbeatSeconds).toBe(9)
  })

  it('leaves the interval alone when the platform states the one it already uses', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, config_revision: 5 }),
      envelope({ config_revision: 5, heartbeat_interval_seconds: 3, log_batch_max_lines: 200 }),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.start()
    await node.heartbeatOnce()
    node.stop()

    expect(node.heartbeatSeconds).toBe(3)
    // The platform's batch cap is followed rather than kept, so nothing is reported as kept
    // for it; the batching it drives is covered where the batches reach the platform.
    expect(reports.some(report => report.message.includes('keeps the values it declared for log_batch_max_lines'))).toBe(false)
  })

  it('warns instead of breaking the heartbeat when the configuration cannot be read', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, config_revision: 3 }),
      rejection('INTERNAL'),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    // The heartbeat still settles: an unread configuration leaves the declared values in place.
    await node.heartbeatOnce()

    expect(reports.some(report => report.message.includes('could not read platform configuration 3'))).toBe(true)
  })

  it('heartbeats what the machine has, and stops claiming when the disk is nearly full', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ diskMinGb: 5 }),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => ({ cpu_percent: 41, mem_percent: 63, disk_free_gb: 1.2 }),
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()

    const heartbeat = queue.calls.find(call => call.request.url.endsWith('/heartbeat'))
    expect(JSON.parse(jsonBody(heartbeat?.request))).toMatchObject({
      resources: { cpu_percent: 41, mem_percent: 63, disk_free_gb: 1.2 },
    })
    // Below the stated floor the node says so, and names what a human could release.
    expect(reports.some(report => report.message.includes('is below 5GB free (1.2GB)'))).toBe(true)
    expect(reports.some(report => report.message.includes('claiming nothing until there is room'))).toBe(true)
  })

  it('reports the disk once per state change, not once per heartbeat', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    let free = 1.2
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ diskMinGb: 5 }),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => ({ cpu_percent: 0, mem_percent: 0, disk_free_gb: free }),
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()
    // The same reading again says nothing new: whoever reads the report is not spammed.
    await node.heartbeatOnce()
    free = 40
    await node.heartbeatOnce()

    const low = reports.filter(report => report.message.includes('is below 5GB free (1.2GB)'))
    expect(low).toHaveLength(1)
    expect(low[0]?.message).toContain('claiming nothing until there is room')
    expect(reports.some(report => report.message.includes('has 40GB free again; claiming work'))).toBe(true)
  })

  it('tells the platform when a full disk stops it taking work, once per state', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    let free = 1
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ diskMinGb: 5 }),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => ({ cpu_percent: 0, mem_percent: 0, disk_free_gb: free }),
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()
    await node.heartbeatOnce()
    free = 40
    await node.heartbeatOnce()

    const paths = queue.calls.map(call => call.request.url)
    // Draining is how a node stops taking work; claiming nothing leaves the platform
    // dispatching to a node that will not answer.
    expect(paths.filter(path => path.endsWith('/drain'))).toHaveLength(1)
    expect(paths.filter(path => path.endsWith('/resume'))).toHaveLength(1)
    expect(reports.some(report => report.message.includes('is below 5GB free (1GB)'))).toBe(true)
    expect(reports.some(report => report.message.includes('has 40GB free again'))).toBe(true)
    // A node with nothing to release offers no list at all, rather than an empty one.
    const heartbeats = queue.calls
      .filter(call => call.request.url.endsWith('/heartbeat'))
      .map(call => JSON.parse(jsonBody(call.request)) as Record<string, unknown>)
    expect(heartbeats.every(body => !('releasable_workspaces' in body))).toBe(true)
  })

  it('offers the workspaces it could release while the disk stops it taking work', async () => {
    vi.useFakeTimers()
    const root = codingRoot()
    const kept = join(root, 'ws_1')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, 'f.bin'), Buffer.alloc(2 * 1024 * 1024))
    writeFileSync(join(root, WORKSPACE_STATE_FILE), JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [{ workspace_id: 'ws_1', directory: kept, last_used_at: '2026-10-15T04:03:55.123Z' }],
    }))
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
      envelope(HEARTBEAT),
    ])
    let free = 1
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ diskMinGb: 5, codingRoot: root }),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => ({ cpu_percent: 0, mem_percent: 0, disk_free_gb: free }),
      report: () => {},
    })

    // The handshake order the node documents: read what it kept, then talk to the platform.
    await node.restore()
    await node.bootstrap()
    await node.heartbeatOnce()
    free = 40
    await node.heartbeatOnce()

    const heartbeats = queue.calls
      .filter(call => call.request.url.endsWith('/heartbeat'))
      .map(call => JSON.parse(jsonBody(call.request)) as Record<string, unknown>)
    // What the node offers is what the platform chooses from, footprint and all; once there
    // is room again the list goes away rather than staying stale.
    expect(heartbeats[0]?.['releasable_workspaces']).toEqual([
      { workspace_id: 'ws_1', size_mb: 2, last_task_finished_at: '2026-10-15T04:03:55.123Z' },
    ])
    expect(heartbeats[1]).not.toHaveProperty('releasable_workspaces')
  })

  it('carries on when the platform cannot be told about draining', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      rejection('DB_UNAVAILABLE'),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ diskMinGb: 5 }),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => ({ cpu_percent: 0, mem_percent: 0, disk_free_gb: 1 }),
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    // The platform refusing the announcement does not undo the local pause, and the
    // heartbeat that carried the reading still goes.
    await expect(node.heartbeatOnce()).resolves.toMatchObject({ node_status: 'online' })

    expect(reports.some(report => report.message.includes('could not tell the platform this node is draining'))).toBe(true)
  })

  it('carries on when the platform cannot be told the node is working again', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(null),
      envelope(HEARTBEAT),
      rejection('DB_UNAVAILABLE'),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    let free = 1
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ diskMinGb: 5 }),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => ({ cpu_percent: 0, mem_percent: 0, disk_free_gb: free }),
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()
    free = 40
    await expect(node.heartbeatOnce()).resolves.toMatchObject({ node_status: 'online' })

    expect(reports.some(report => report.message.includes('could not tell the platform this node is no longer draining'))).toBe(true)
  })

  it('keeps the last reading when the machine cannot be read, and reports why', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(HEARTBEAT),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      probeResources: async () => { throw new Error('no statfs here') },
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.heartbeatOnce()

    const heartbeat = queue.calls.find(call => call.request.url.endsWith('/heartbeat'))
    expect(JSON.parse(jsonBody(heartbeat?.request))).toMatchObject({
      resources: { cpu_percent: 0, mem_percent: 0, disk_free_gb: 0 },
    })
    expect(reports.some(report => report.message.includes('could not read its resources: no statfs here'))).toBe(true)
  })

  it('registers the agent version it probed from its own CLI', async () => {
    vi.useFakeTimers()
    let probes = 0
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      probeAgentVersion: async () => { probes += 1; return '0.2.1-alpha.2' },
      report: () => { /* this test reads the register body */ },
    })

    await node.bootstrap()

    const registered = queue.calls.find(call => call.request.url.endsWith('/register'))
    expect(JSON.parse(jsonBody(registered?.request))).toMatchObject({ agent_version: '0.2.1-alpha.2' })
    // Probed once: a version does not change while the node runs.
    expect(probes).toBe(1)
  })

  it('reports the stated version when the CLI cannot say which it is', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
    ])
    const node = new MpsExecutorRuntime({
      settings: settingsFor({ agentVersion: '1.0.0-stated' }),
      secret: () => 's',
      transport: queue.transport,
      probeAgentVersion: async () => undefined,
      report: () => { /* this test reads the register body */ },
    })

    await node.bootstrap()

    const registered = queue.calls.find(call => call.request.url.endsWith('/register'))
    expect(JSON.parse(jsonBody(registered?.request))).toMatchObject({ agent_version: '1.0.0-stated' })
  })

  it('lets a composed runner take precedence over its own', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(CLAIMED),
      envelope(null),
      envelope({ task_id: 'tsk_1', accepted: true, already_final: false, work_item_state: 'done', next: 'verify' }),
    ])
    let ran = false
    const composed: TaskRunner = {
      async run(): Promise<TaskRunResult> {
        ran = true
        return { outcome: 'success', summary: 'composed runner' }
      },
    }
    const ctx = new Context()
    ctx.provide(TASK_RUNNER_SERVICE, composed)
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      runner: () => ctx.get(TASK_RUNNER_SERVICE) ?? { run: async () => ({ outcome: 'failed', summary: 'the node own runner' }) },
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    await node.start()
    await vi.advanceTimersByTimeAsync(50)
    node.stop()

    expect(ran).toBe(true)
    expect(reports.some(report => report.message.includes('the node own runner'))).toBe(false)
  })
})

describe('task claiming through the runtime', () => {
  /** One claim answer carrying a task the node can run. */
  const CLAIMED = {
    task: {
      task_id: 'tsk_1',
      work_item_id: 'wi_1',
      attempt: 1,
      max_attempts: 3,
      kind: 'coding',
      priority: 400,
      lease_expire_at: '2026-10-15T04:16:00.123+08:00',
      lease_renew_seconds: 30,
      payload: { limits: { max_runtime_seconds: 60 } },
    },
  }

  it('claims through a composed runner and reports it to the platform', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(CLAIMED),
      envelope(null),
      envelope({ task_id: 'tsk_1', accepted: true, already_final: false, work_item_state: 'done', next: 'verify' }),
    ])
    const reports: ExecutorReport[] = []
    let finish: (() => void) | undefined
    const runner = {
      async run(context: TaskRunContext): Promise<TaskRunResult> {
        await context.reportProgress({ progress: 30, stage: 'coding', message: '3/10' })
        await new Promise<void>((resolve) => { finish = resolve })
        return { outcome: 'success', summary: 'done' }
      },
    }
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      runner: () => runner,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    node.start()
    expect(node.tasks).toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(node.runningTasks).toHaveLength(1)
    expect(node.slots()).toEqual({ total: 1, running: 1, available: 0 })

    finish?.()
    await node.tasks?.drain()
    expect(node.runningTasks).toEqual([])
    expect(node.availableSlots()).toBe(1)
    expect(reports.some(report => report.level === 'error')).toBe(false)

    const bodies = queue.calls.map(call => jsonBody(call.request))
    expect(bodies.some(body => body.includes('"progress":30') && body.includes('"stage":"coding"'))).toBe(true)
    expect(bodies.some(body => body.includes('"outcome":"success"'))).toBe(true)
    node.stop()
    expect(node.tasks?.claiming).toBe(false)
  })

  it('applies an abort command and reports commands it does not implement', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(CLAIMED),
      // The claim loop keeps asking while the one coding slot is busy — an answer
      // task needs none — so the next long poll is answered empty here.
      envelope(null),
      envelope({
        ...HEARTBEAT,
        commands: [
          { command: 'abort', task_id: 'tsk_1', reason: '需求撤销' },
          { command: 'abort', task_id: 'tsk_other' },
          { command: 'abort' },
          { command: 'release_workspace' },
          { command: 'release_workspace', workspace_id: 'ws_unheld' },
          { command: 'collect_diagnostics' },
        ],
      }),
      envelope(null),
      envelope({ task_id: 'tsk_1', accepted: true, already_final: false, work_item_state: 'cancelled', next: 'none' }),
    ])
    const reports: ExecutorReport[] = []
    const runner = {
      async run(context: TaskRunContext): Promise<TaskRunResult> {
        await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
        return { outcome: 'success', summary: 'kept going' }
      },
    }
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      runner: () => runner,
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(node.runningTasks).toHaveLength(1)

    await node.heartbeatOnce()
    expect(reports.some(report => report.message.includes('aborted by the platform'))).toBe(true)
    expect(reports.some(report => report.message.includes('aborted without naming a task'))).toBe(true)
    expect(reports.some(report => report.message.includes('released no workspace'))).toBe(true)
    expect(reports.some(report => report.message.includes('does not hold'))).toBe(true)
    expect(reports.some(report => report.message.includes('does not implement it yet'))).toBe(true)

    await node.tasks?.drain()
    expect(node.runningTasks).toEqual([])
    node.stop()
  })

  it('removes a workspace the platform released', async () => {
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, commands: [{ command: 'release_workspace', workspace_id: 'ws_1' }] }),
    ])
    const node = new MpsExecutorRuntime({ settings: settingsFor(), secret: () => 's', transport: queue.transport })
    await node.bootstrap()
    const directory = await node.workspaces.ensure('ws_1', 'tsk_1')
    expect(existsSync(directory)).toBe(true)

    await node.heartbeatOnce()

    expect(existsSync(directory)).toBe(false)
    expect(node.workspaces.records).toEqual([])
  })

  it('reports a release it cannot carry out', async () => {
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, commands: [{ command: 'release_workspace', workspace_id: 'ws/escape' }] }),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })
    await node.bootstrap()

    await node.heartbeatOnce()

    expect(reports.some(report => report.level === 'error' && report.message.includes('could not release workspace'))).toBe(true)
  })

  it('reports an attempt whose checkout cannot be prepared', async () => {
    vi.useFakeTimers()
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({
        task: {
          ...CLAIMED.task,
          payload: {
            limits: { max_runtime_seconds: 60 },
            workspace: {
              workspace_id: 'ws_1',
              repo: {
                url: join(tmpdir(), 'mps-missing-repository'),
                base_branch: 'main',
                base_commit: 'a1b2c3d',
                work_branch: 'feature/tsk_1',
              },
            },
          },
        },
      }),
      envelope({ task_id: 'tsk_1', accepted: true, already_final: false, work_item_state: 'failed', next: 'retry' }),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      runner: () => ({ async run() { return { outcome: 'success', summary: 'never runs' } } }),
      report: (report) => { reports.push(report) },
    })

    await node.bootstrap()
    node.start()
    await vi.advanceTimersByTimeAsync(0)
    await node.tasks?.drain()

    const results = queue.calls.map(call => jsonBody(call.request)).filter(body => body.includes('"outcome"'))
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('"outcome":"failed"')
    expect(results[0]).toContain('failed')
    expect(reports.some(report => report.level === 'error')).toBe(false)
    node.stop()
  })

  it('re-reports the sessions it restored after a restart', async () => {
    const settings = settingsFor()
    const store = new WorkspaceStore({ root: settings.codingRoot })
    await store.ensure('ws_1', 'tsk_1')
    await store.setSession('ws_1', { ref: 'dsh-session-01H8Z', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(null),
    ])
    const node = new MpsExecutorRuntime({ settings, secret: () => 's', transport: queue.transport })

    await node.restore()
    await node.bootstrap()

    const report = queue.calls.find(call => call.request.url.includes('/workspaces/ws_1/session'))
    expect(report?.request.method).toBe('POST')
    expect(report?.request.body).toContain('dsh-session-01H8Z')
    expect(report?.request.body).toContain('"last_task_id":"tsk_1"')
  })

  it('keeps a refused session re-report from failing the handshake', async () => {
    const settings = settingsFor()
    const store = new WorkspaceStore({ root: settings.codingRoot })
    await store.ensure('ws_1', 'tsk_1')
    await store.setSession('ws_1', { ref: 'dsh-session-01H8Z', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      rejection('WORKSPACE_NOT_BOUND'),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings,
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    await node.restore()
    await expect(node.bootstrap()).resolves.toMatchObject({ node_id: 'node-1' })

    expect(node.state).toBe('online')
    expect(reports.some(report => report.level === 'warn' && report.message.includes('could not re-report the session of workspace ws_1'))).toBe(true)
  })

  it('holds its session when no runner is composed', () => {
    const queue = queueTransport([])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      runner: () => undefined,
      report: (report) => { reports.push(report) },
    })

    node.start()
    expect(node.tasks).toBeUndefined()
    expect(reports.some(report => report.message.includes('no task runner composed'))).toBe(true)
    node.stop()
  })
})

describe('a capacity the node cannot work with', () => {
  it('is refused rather than leaving a node that takes nothing', () => {
    const env = { MPS_PLATFORM_HOST: '10.0.0.7', MPS_NODE_ID: 'node-1', MPS_NODE_WORKSPACE: codingRoot() }

    // The environment boundary names the text it was handed.
    expect(() => executorConfigFromEnv({ ...env, MPS_NODE_SLOTS: 'abc' })).toThrow(/a whole number of 1 or more, got "abc"/u)
    expect(() => executorConfigFromEnv({ ...env, MPS_NODE_SLOTS: '0' })).toThrow(/got "0"/u)
    expect(executorConfigFromEnv({ ...env, MPS_NODE_SLOTS: '3' }).slotsTotal).toBe(3)

    // And the resolution point holds the invariant for a capacity that arrived another way,
    // which is how the machine showed it: a patch row reaches the settings unvalidated.
    const assigned = executorConfigFromEnv(env)
    assigned.slotsTotal = 0
    expect(() => resolveExecutorSettings(assigned)).toThrow(/capacity must be a whole number of 1 or more, got 0/u)
  })
})

describe('a scheme the node does not connect with', () => {
  it('is refused however it was stated, rather than exchanged for the default', () => {
    const env = {
      MPS_PLATFORM_HOST: '10.0.0.7',
      MPS_NODE_ID: 'node-1',
      MPS_NODE_WORKSPACE: codingRoot(),
      MPS_PLATFORM_SCHEME: 'ftp',
    }

    expect(() => executorConfigFromEnv(env)).toThrow(/must be "http" or "https/u)

    // And a scheme the node does connect with is carried through, not dropped.
    expect(executorConfigFromEnv({ ...env, MPS_PLATFORM_SCHEME: 'https' }).platformScheme).toBe('https')
  })
})

describe('a heartbeat the platform keeps failing', () => {
  it('is reported once, not once per interval', async () => {
    vi.useFakeTimers()
    const reports: ExecutorReport[] = []
    // The handshake's two answers come first — authentication, then registration — and only
    // then the heartbeats this case is about. Answering the register with the malformed
    // heartbeat answer is what made an earlier attempt look like a heartbeat defect.
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope(null),
      envelope(null),
      envelope(null),
    ])
    const instance = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })
    await instance.bootstrap()
    instance.start()
    await vi.advanceTimersByTimeAsync(10_000)
    instance.stop()

    // Three heartbeats inside that window at the three-second interval the platform assigned.
    expect(reports.filter(report => report.message.includes('heartbeat failed'))).toHaveLength(1)
  }, 30_000)
})

describe('a registration the platform keeps failing', () => {
  it('is reported once while its wording stays the same', async () => {
    vi.useFakeTimers()
    const reports: ExecutorReport[] = []
    const auth = envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' })
    // A handshake does not retry itself, so the repetition comes from asking it again, which is
    // what the runtime does when a later recovery re-authenticates.
    const queue = queueTransport([auth, rejection('DB_UNAVAIL'), auth, rejection('DB_UNAVAIL'), auth, rejection('DB_UNAVAIL')])
    const instance = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await instance.bootstrap().catch(() => { /* the handshake reports its own failure */ })
    }

    // The case only means something if the registration really was attempted more than once.
    expect(queue.calls.filter(call => call.request.url.endsWith('/register')).length).toBeGreaterThan(1)
    expect(reports.filter(report => report.message.includes('failed to register'))).toHaveLength(1)
  }, 30_000)

  it('forgets the session of a workspace the platform reset', async () => {
    const queue = queueTransport([
      envelope({ token: 'tok', expires_at: 'e', node_id: 'node-1' }),
      envelope(REGISTERED),
      envelope({ ...HEARTBEAT, commands: [{ command: 'reset_session', workspace_id: 'ws_1', reason: '会话被占用' }] }),
    ])
    const reports: ExecutorReport[] = []
    const node = new MpsExecutorRuntime({
      settings: settingsFor(),
      secret: () => 's',
      transport: queue.transport,
      report: (report) => { reports.push(report) },
    })
    await node.bootstrap()
    await node.workspaces.ensure('ws_1', 'tsk_1')
    await node.workspaces.setSession('ws_1', { ref: 'dsh-session-1', base_commit: 'a1b2c3d', last_task_id: 'tsk_1' })

    await node.heartbeatOnce()

    // The reference goes so the next attempt starts a session it can adopt and reports it;
    // the coding directory and the binding stay.
    expect(node.workspaces.records[0]?.session).toBeUndefined()
    expect(existsSync(node.workspaces.directoryOf('ws_1'))).toBe(true)
    expect(reports.some(report => report.message.includes('forgot the session of coding workspace ws_1'))).toBe(true)
  })
})
