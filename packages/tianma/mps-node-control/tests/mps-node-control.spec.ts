/**
 * What the GUI's node entry can ask of the supervised process: that it starts, that
 * it stops when told, what it printed, and that disposing the plugin leaves no node
 * behind. The child these specs supervise is a real Node process running a stub
 * script, so the launch, the pipes, and the kill are the ones a deployment gets.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MpsNodeControlService from '@tianma/dsh-mps-node-control'

/** Directories one test created, removed after it. */
const created: string[] = []

/** Contexts one test created, disposed after it. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A script that stands in for the node: it prints on both streams and stays alive
 * until it is killed. Extra arguments are ignored, so the service may pass the
 * profile flag the real node takes.
 * @returns the script's path.
 */
function nodeStub(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
  created.push(directory)
  const path = join(directory, 'node-stub.mjs')
  writeFileSync(path, [
    "console.log('mps node listening')",
    "console.error('mps node warning')",
    'setInterval(() => {}, 250)',
    '',
  ].join('\n'))
  return path
}

/**
 * Wait for a condition the child satisfies asynchronously.
 * @param condition - the condition to poll.
 * @param timeoutMs - how long to keep polling.
 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the condition was not met before the deadline')
}

/**
 * Whether a process id still names a live process.
 * @param pid - the process id to probe.
 * @returns true while the process exists.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One host carrying the control service over a stub node script. */
async function control(options: { entry?: string } = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MpsNodeControlService, {
    entry: options.entry ?? nodeStub(),
    // The loaders this spec runs under belong to the test runner, not to the node.
    loaders: [],
  })
  return ctx
}

describe('supervising the executor node', () => {
  it('starts the node, reads what it printed, and stops it', async () => {
    const ctx = await control()

    expect(await ctx.mpsNodeControl.status()).toMatchObject({ phase: 'stopped', profile: 'mps-node' })

    const started = await ctx.mpsNodeControl.start()
    // The launch is confirmed by the operating system, so the first reading is
    // `starting` and the process is not claimed to run before it does.
    expect(started.phase).toBe('starting')
    await waitFor(async () => (await ctx.mpsNodeControl.status()).phase === 'running')
    const running = await ctx.mpsNodeControl.status()
    expect(running.pid).toBeGreaterThan(0)
    expect(running.startedAt).toBeDefined()

    const pid = running.pid as number
    await waitFor(async () => (await ctx.mpsNodeControl.logs()).length >= 2)
    const lines = await ctx.mpsNodeControl.logs()
    expect(lines.map(line => `${line.stream}:${line.text}`)).toEqual(expect.arrayContaining([
      'stdout:mps node listening',
      'stderr:mps node warning',
    ]))
    expect(lines.every(line => line.at !== '')).toBe(true)

    const stopped = await ctx.mpsNodeControl.stop()
    expect(stopped.phase).toBe('stopped')
    expect(stopped.pid).toBeUndefined()
    expect(stopped.exit?.code).toBeDefined()
    expect(alive(pid)).toBe(false)
  })

  it('leaves the running node alone when it is asked to start again', async () => {
    const ctx = await control()
    const started = await ctx.mpsNodeControl.start()

    const again = await ctx.mpsNodeControl.start()

    expect(again.pid).toBe(started.pid)
    expect(again.startedAt).toBe(started.startedAt)
  })

  it('keeps only the most recent lines it was told to keep', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const path = join(directory, 'chatty.mjs')
    writeFileSync(path, [
      'for (let index = 0; index < 20; index += 1) console.log(`line ${index}`)',
      'setInterval(() => {}, 250)',
      '',
    ].join('\n'))
    await ctx.plugin(MpsNodeControlService, { entry: path, loaders: [], logLines: 3 })

    await ctx.mpsNodeControl.start()
    await waitFor(async () => (await ctx.mpsNodeControl.logs()).length > 0)
    await waitFor(async () => {
      const lines = await ctx.mpsNodeControl.logs()
      return lines.length === 3 && lines[2]?.text === 'line 19'
    })

    const lines = await ctx.mpsNodeControl.logs()
    expect(lines.map(line => line.text)).toEqual(['line 17', 'line 18', 'line 19'])
  })

  it('reports a node that started and then died, with what it said', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const ctx = new Context()
    contexts.push(ctx)
    // The binary is fine but the entry is not there, so the node runs and exits
    // instead of failing to launch: the reading has to tell those apart.
    await ctx.plugin(MpsNodeControlService, { entry: join(directory, 'missing.mjs'), loaders: [] })

    await ctx.mpsNodeControl.start()
    await waitFor(async () => (await ctx.mpsNodeControl.status()).exit !== undefined)

    const reading = await ctx.mpsNodeControl.status()
    expect(reading.phase).toBe('stopped')
    expect(reading.error).toBeUndefined()
    expect(typeof reading.exit?.code).toBe('number')
    expect(reading.exit?.code).not.toBe(0)
    expect((await ctx.mpsNodeControl.logs()).some(line => line.stream === 'stderr')).toBe(true)
  })

  it('reports a launch that failed outright', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const ctx = new Context()
    contexts.push(ctx)
    // A binary that is not there is the one failure that produces no process at all,
    // so no exit can account for it; the reading carries the launch error instead.
    await ctx.plugin(MpsNodeControlService, {
      nodeBinary: join(directory, 'missing-node'),
      entry: nodeStub(),
      loaders: [],
    })

    await ctx.mpsNodeControl.start()
    await waitFor(async () => (await ctx.mpsNodeControl.status()).phase === 'failed')

    const reading = await ctx.mpsNodeControl.status()
    expect(reading.error).toBeDefined()
    expect(reading.exit).toBeUndefined()
  })

  it('stops the node when the GUI disposes the plugin', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const fiber = await ctx.plugin(MpsNodeControlService, { entry: nodeStub(), loaders: [] })
    const started = await ctx.mpsNodeControl.start()
    const pid = started.pid as number

    await fiber.dispose()

    await waitFor(async () => !alive(pid))
  })

  it('refuses a composition that names nothing to launch', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(MpsNodeControlService, { entry: '', loaders: [] }))
      .rejects.toThrow(/nothing to launch/u)
  })
})

describe('the deployment parameters the Settings form owns', () => {
  /** Saved/deployment state a test isolated in its own home; restored after. */
  let previousHome: string | undefined

  afterEach(() => {
    if (previousHome !== undefined) process.env.DSH_HOME = previousHome
  })

  /**
   * Point the service's home at one throwaway directory, so every test owns
   * the profile directory its saved parameters land in.
   * @returns the isolated home's path.
   */
  function isolatedHome(): string {
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-home-'))
    created.push(directory)
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = directory
    return directory
  }

  /** A join string a test can save as-is, with a secret a leak would name. */
  const JOIN = 'http://mps.example.com:8791/exec/v1#node=node-7&secret=join-secret-value'

  it('saves a join string and reads back its summary, never its value', async () => {
    const home = isolatedHome()
    const ctx = await control()

    const before = await ctx.mpsNodeControl.config()
    expect(Array.isArray(before.lanAddresses)).toBe(true)
    expect(before.saved).toEqual({})
    expect(before.joinSet).toBe('unset')
    expect(before.joinSummary).toBeUndefined()
    expect(before.secretSet).toBe('unset')
    expect(before.platformPolicy).toEqual({})

    const after = await ctx.mpsNodeControl.saveConfig({ join: ` ${JOIN} ` })
    expect(after.joinSet).toBe('saved')
    expect(after.joinSummary).toEqual({ url: 'http://mps.example.com:8791/exec/v1', nodeId: 'node-7' })
    // The credential rides the join string, so the reading reports it as stored here.
    expect(after.secretSet).toBe('saved')
    // The copy the form reads back carries neither the join string nor its secret.
    expect(JSON.stringify(after.saved)).not.toContain('join-secret-value')
    // The stored file holds the whole join string, and nothing else it replaced.
    const stored = JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')) as { join?: string }
    expect(stored).toEqual({ join: JOIN })
  })

  it('refuses a join string it cannot parse, storing nothing', async () => {
    isolatedHome()
    const ctx = await control()

    await expect(ctx.mpsNodeControl.saveConfig({ join: 'http://mps.example.com:8791/exec/v1' }))
      .rejects.toThrow(/"#"/u)
    await expect(ctx.mpsNodeControl.saveConfig({ join: 'http://mps.example.com:8791/exec/v1#node=node-7' }))
      .rejects.toThrow(/secret/u)
    await expect(ctx.mpsNodeControl.saveConfig({ join: 'not a url#node=n&secret=s' }))
      .rejects.toThrow(/address/u)
    expect((await ctx.mpsNodeControl.config()).saved).toEqual({})
  })

  it('keeps the stored join when the form edits other fields', async () => {
    const home = isolatedHome()
    const ctx = await control()
    await ctx.mpsNodeControl.saveConfig({ join: JOIN })

    const kept = await ctx.mpsNodeControl.saveConfig({ networkProxy: 'http://127.0.0.1:7897' })
    expect(kept.joinSet).toBe('saved')
    expect((JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')) as { join?: string }).join)
      .toBe(JOIN)
  })

  it('stores the legacy secret, reports only whether it is set, and injects it at launch', async () => {
    const home = isolatedHome()
    process.env.MPS_NODE_SECRET = 'env-secret'
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const path = join(directory, 'echo-secret.mjs')
    writeFileSync(path, [
      "console.log((process.env.MPS_NODE_SECRET ?? '-') + ' join=' + (process.env.MPS_JOIN ? 'set' : '-'))",
      'setInterval(() => {}, 250)',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MpsNodeControlService, { entry: path, loaders: [] })
    try {
      // The environment's secret shows as set before this page stores one.
      expect((await ctx.mpsNodeControl.config()).secretSet).toBe('environment')

      const saved = await ctx.mpsNodeControl.saveConfig({ nodeSecret: 'stored-secret' })
      // The saved copy the form reads back carries no secret value.
      expect(saved.saved.nodeSecret).toBeUndefined()
      expect(saved.secretSet).toBe('saved')
      // The stored file does carry it, and the launch injects it over the environment's.
      const stored = JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')) as { nodeSecret?: string }
      expect(stored.nodeSecret).toBe('stored-secret')

      await ctx.mpsNodeControl.start()
      await waitFor(async () => (await ctx.mpsNodeControl.logs()).length > 0)
      expect((await ctx.mpsNodeControl.logs())[0]?.text).toBe('stored-secret join=-')
      await ctx.mpsNodeControl.stop()

      // Saving the form without restating the secret keeps what is stored:
      // editing another field must never wipe the credential.
      const kept = await ctx.mpsNodeControl.saveConfig({ workspaceRoot: 'D:/work' })
      expect(kept.secretSet).toBe('saved')
      expect((JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')) as { nodeSecret?: string }).nodeSecret)
        .toBe('stored-secret')

      // The explicit instruction alone drops it.
      const dropped = await ctx.mpsNodeControl.saveConfig({ clearNodeSecret: 'true' })
      expect(dropped.secretSet).toBe('environment')
      expect((JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')) as { nodeSecret?: string }).nodeSecret)
        .toBeUndefined()
    } finally {
      delete process.env.MPS_NODE_SECRET
    }
  })

  it('ranks a saved local field above the environment, which still beats unset', async () => {
    isolatedHome()
    process.env.MPS_NODE_WORKSPACE = 'C:/from-env'
    const ctx = await control()
    try {
      const reading = await ctx.mpsNodeControl.config()
      expect(reading.effective.workspaceRoot).toEqual({ value: 'C:/from-env', source: 'environment' })
      expect(reading.effective.networkProxy).toEqual({ source: 'unset' })

      const saved = await ctx.mpsNodeControl.saveConfig({ workspaceRoot: 'D:/saved' })
      expect(saved.effective.workspaceRoot).toEqual({ value: 'D:/saved', source: 'saved' })
    } finally {
      delete process.env.MPS_NODE_WORKSPACE
    }
  })

  it('refuses a proxy the form cannot store', async () => {
    isolatedHome()
    const ctx = await control()

    await expect(ctx.mpsNodeControl.saveConfig({ networkProxy: 'socks7://x' })).rejects.toThrow(/networkProxy/u)
    expect((await ctx.mpsNodeControl.config()).saved).toEqual({})
  })

  it('launches the node with the join string in its environment', async () => {
    const home = isolatedHome()
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const path = join(directory, 'echo-join.mjs')
    writeFileSync(path, [
      "console.log(`join=${process.env.MPS_JOIN ? 'set' : '-'} host=${process.env.MPS_PLATFORM_HOST ?? '-'} id=${process.env.MPS_NODE_ID ?? '-'}`)",
      'setInterval(() => {}, 250)',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MpsNodeControlService, { entry: path, loaders: [] })

    await ctx.mpsNodeControl.saveConfig({ join: JOIN })
    await ctx.mpsNodeControl.start()
    await waitFor(async () => (await ctx.mpsNodeControl.logs()).length > 0)

    // The join string reaches the child whole: it carries the address and the identity,
    // and the executor's own precedence folds it over the row's placeholders.
    const lines = await ctx.mpsNodeControl.logs()
    expect(lines[0]?.text).toBe('join=set host=- id=-')
    expect(existsSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'))).toBe(true)
    await ctx.mpsNodeControl.stop()
  })

  it('launches the node with the proxy the deployment states, the platform off it', async () => {
    isolatedHome()
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const path = join(directory, 'echo-proxy.mjs')
    writeFileSync(path, [
      "console.log(`proxy=${process.env.HTTPS_PROXY ?? '-'} noproxy=${process.env.NO_PROXY ?? '-'}`)",
      'setInterval(() => {}, 250)',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MpsNodeControlService, { entry: path, loaders: [] })

    // A workspace fetch has to leave this machine through the proxy; the platform
    // itself sits on this LAN, so dialing it through the proxy would fail instead.
    // Its host comes out of the join string, which is where a deployment states it.
    await ctx.mpsNodeControl.saveConfig({
      networkProxy: 'http://127.0.0.1:7897',
      join: 'http://mps.lan:8791/exec/v1#node=node-7&secret=s',
    })
    await ctx.mpsNodeControl.start()
    await waitFor(async () => (await ctx.mpsNodeControl.logs()).length > 0)

    const lines = await ctx.mpsNodeControl.logs()
    expect(lines[0]?.text).toBe('proxy=http://127.0.0.1:7897 noproxy=localhost,127.0.0.1,::1,172.17.0.1,mps.lan')
    await ctx.mpsNodeControl.stop()
  })

  it('fails loudly over a deployment file it cannot read as its own', async () => {
    const home = isolatedHome()
    const directory = join(home, 'profiles', 'mps-node')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'mps-node-control.json'), '{ not json')
    const ctx = await control()

    await expect(ctx.mpsNodeControl.config()).rejects.toThrow(/mps-node-control\.json/u)
    await expect(ctx.mpsNodeControl.start()).rejects.toThrow(/mps-node-control\.json/u)
  })

  it('reads the task ledger and leaves a cancel for the node to take', async () => {
    const home = isolatedHome()
    // One claim still running and one settled task, as the node writes them.
    const { taskLedger } = await import('@tianma/dsh-mps-executor')
    const ledger = taskLedger(join(home, 'profiles', 'mps-node', 'ops'))
    ledger.append({ at: '2026-10-18T04:00:00.000Z', event: 'claimed', task_id: 'wi_run', kind: 'answer', attempt: 1 })
    ledger.append({ at: '2026-10-18T04:00:05.000Z', event: 'settled', task_id: 'wi_done', kind: 'coding', attempt: 2, outcome: 'success', summary: 'done', session: 's_1', workspace: 'C:/ws' })
    const ctx = await control()

    const tasks = await ctx.mpsNodeControl.tasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ task_id: 'wi_done', running: false, outcome: 'success', session: 's_1' })
    expect(tasks[1]).toMatchObject({ task_id: 'wi_run', running: true })

    await ctx.mpsNodeControl.taskCommand({ action: 'cancel', task_id: 'wi_run' })
    const { operatorCommands } = await import('@tianma/dsh-mps-executor')
    const pending = operatorCommands(join(home, 'profiles', 'mps-node', 'ops')).take()
    expect(pending).toMatchObject([{ action: 'cancel', task_id: 'wi_run' }])

    await expect(ctx.mpsNodeControl.taskCommand({ action: 'cancel', task_id: '' }))
      .rejects.toThrow(/name its task/u)
  })

  it('reports the policy the node snapshot recorded', async () => {
    const home = isolatedHome()
    const { writePolicySnapshot } = await import('@tianma/dsh-mps-executor')
    writePolicySnapshot(join(home, 'profiles', 'mps-node', 'ops'), {
      at: '2026-10-27T10:00:00.000Z',
      configRevision: 7,
      policy: {
        slotsTotal: 3,
        lanes: ['coding'],
        diskMinGb: 8,
        taskRuntimeSeconds: 7200,
        answerRuntimeSeconds: 0,
        agent: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      },
    })
    const ctx = await control()

    const reading = await ctx.mpsNodeControl.config()
    expect(reading.platformPolicy).toMatchObject({
      slotsTotal: 3,
      lanes: ['coding'],
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-v4-pro',
      configRevision: 7,
    })

    // A node that never applied a policy reads as one the platform has not stated.
    isolatedHome()
    const bare = await control()
    expect((await bare.mpsNodeControl.config()).platformPolicy).toEqual({})
  })

  it('reports a platform that answers the probe, whatever status it answers with', async () => {
    const server = createServer((request, response) => {
      // The platform's own note: a 401 on a deliberately wrong credential is the
      // healthy shape of the token endpoint.
      response.statusCode = request.url === '/exec/v1/auth/token' ? 401 : 404
      response.end()
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    try {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      isolatedHome()
      const ctx = await control()

      const probe = await ctx.mpsNodeControl.probe({ join: `http://127.0.0.1:${String(port)}/exec/v1#node=p&secret=s` })
      expect(probe.reachable).toBe(true)
      expect(probe.kind).toBe('answered')
      expect(probe.httpStatus).toBe(401)
      expect(probe.latencyMs).toBeDefined()
      expect(probe.detail).toMatch(/401/u)
      // The test server sits on this machine's loopback, so the probe says so.
      expect(probe.loopback).toBe(true)
      expect(probe.detail).toMatch(/loopback/u)
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('reports a platform it cannot dial, and an address it was not given', async () => {
    isolatedHome()
    const ctx = await control()

    const refused = await ctx.mpsNodeControl.probe({ join: 'http://127.0.0.1:49001/exec/v1#node=p&secret=s' })
    expect(refused.reachable).toBe(false)
    expect(refused.kind).toBe('refused')
    expect(refused.httpStatus).toBeUndefined()
    expect(refused.detail).toMatch(/could not reach/u)
    expect(refused.loopback).toBe(true)

    // With nothing stated anywhere, there is no address to dial and the probe says so.
    const absent = await ctx.mpsNodeControl.probe({})
    expect(absent.reachable).toBe(false)
    expect(absent.kind).toBe('unreachable')
    expect(absent.detail).toMatch(/no platform address/u)

    // A join string that cannot be parsed is a result in the parser's own words.
    const unusable = await ctx.mpsNodeControl.probe({ join: 'http://x/exec/v1' })
    expect(unusable.reachable).toBe(false)
    expect(unusable.detail).toMatch(/"#"/u)
  })
})
