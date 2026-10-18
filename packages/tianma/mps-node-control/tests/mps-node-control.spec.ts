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

  it('saves what the form stated and reads it back with its sources', async () => {
    isolatedHome()
    const ctx = await control()

    const before = await ctx.mpsNodeControl.config()
    expect(Array.isArray(before.lanAddresses)).toBe(true)
    expect(before.saved).toEqual({})
    expect(before.effective.platformHost).toEqual({ value: '127.0.0.1', source: 'default' })
    // The protocol's own defaults show wherever neither the form nor the
    // environment states a value, so a blank field never reads as missing.
    expect(before.effective.platformPort).toEqual({ value: '8791', source: 'default' })
    expect(before.effective.platformScheme).toEqual({ value: 'http', source: 'default' })
    expect(before.effective.platformBasePath).toEqual({ value: '/exec/v1', source: 'default' })
    expect(before.effective.slotsTotal).toEqual({ value: '1', source: 'default' })

    const after = await ctx.mpsNodeControl.saveConfig({ platformHost: '  mps.example.com ', platformPort: '8791', nodeId: '' })
    expect(after.saved).toEqual({ platformHost: 'mps.example.com', platformPort: 8791 })
    expect(after.effective.platformHost).toEqual({ value: 'mps.example.com', source: 'saved' })
    expect(after.effective.platformPort).toEqual({ value: '8791', source: 'saved' })
    expect(after.effective.nodeId.source).toBe('unset')
  })

  it('stores the secret, reports only whether it is set, and injects it at launch', async () => {
    const home = isolatedHome()
    process.env.MPS_NODE_SECRET = 'env-secret'
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const path = join(directory, 'echo-secret.mjs')
    writeFileSync(path, [
      "console.log((process.env.MPS_NODE_SECRET ?? '-') + ' from=' + (process.env.MPS_PLATFORM_HOST ?? '-'))",
      'setInterval(() => {}, 250)',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MpsNodeControlService, { entry: path, loaders: [] })
    try {
      // The environment's secret shows as set before this page stores one.
      expect((await ctx.mpsNodeControl.config()).secretSet).toBe('environment')

      const saved = await ctx.mpsNodeControl.saveConfig({ nodeSecret: 'stored-secret', platformHost: 'saved.example.com' })
      // The saved copy the form reads back carries no secret value.
      expect(saved.saved.nodeSecret).toBeUndefined()
      expect(saved.secretSet).toBe('saved')
      // The stored file does carry it, and the launch injects it over the environment's.
      const stored = JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8'))
      expect(stored.nodeSecret).toBe('stored-secret')

      await ctx.mpsNodeControl.start()
      await waitFor(async () => (await ctx.mpsNodeControl.logs()).length > 0)
      expect((await ctx.mpsNodeControl.logs())[0]?.text).toBe('stored-secret from=saved.example.com')
      await ctx.mpsNodeControl.stop()

      // Saving the form without restating the secret keeps what is stored:
      // editing another field must never wipe the credential.
      const kept = await ctx.mpsNodeControl.saveConfig({ platformHost: 'other.example.com' })
      expect(kept.secretSet).toBe('saved')
      expect(JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')).nodeSecret)
        .toBe('stored-secret')

      // The explicit instruction alone drops it.
      const dropped = await ctx.mpsNodeControl.saveConfig({ nodeSecret: '', clearNodeSecret: 'true' })
      expect(dropped.secretSet).toBe('environment')
      expect(JSON.parse(readFileSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'), 'utf8')).nodeSecret)
        .toBeUndefined()

      // Saving the field empty clears what this page stored.
      const cleared = await ctx.mpsNodeControl.saveConfig({ nodeSecret: '' })
      expect(cleared.secretSet).toBe('environment')
    } finally {
      delete process.env.MPS_NODE_SECRET
    }
  })

  it('ranks a saved field above the environment, which still beats unset', async () => {
    isolatedHome()
    process.env.MPS_PLATFORM_HOST = 'from-env.example.com'
    process.env.MPS_NODE_ID = 'node-from-env'
    const ctx = await control()
    try {
      const reading = await ctx.mpsNodeControl.config()
      expect(reading.effective.platformHost).toEqual({ value: 'from-env.example.com', source: 'environment' })

      const saved = await ctx.mpsNodeControl.saveConfig({ platformHost: 'saved.example.com' })
      expect(saved.effective.platformHost).toEqual({ value: 'saved.example.com', source: 'saved' })
      expect(saved.effective.nodeId).toEqual({ value: 'node-from-env', source: 'environment' })
    } finally {
      delete process.env.MPS_PLATFORM_HOST
      delete process.env.MPS_NODE_ID
    }
  })

  it('refuses a form whose numbers or scheme cannot be stored', async () => {
    isolatedHome()
    const ctx = await control()

    await expect(ctx.mpsNodeControl.saveConfig({ platformPort: '99999' })).rejects.toThrow(/platformPort/u)
    await expect(ctx.mpsNodeControl.saveConfig({ slotsTotal: '0' })).rejects.toThrow(/slotsTotal/u)
    await expect(ctx.mpsNodeControl.saveConfig({ platformScheme: 'ftp' })).rejects.toThrow(/platformScheme/u)
    // Nothing was stored, so the reading still reports every field unset.
    expect((await ctx.mpsNodeControl.config()).saved).toEqual({})
  })

  it('launches the node with the saved parameters in its environment', async () => {
    const home = isolatedHome()
    const directory = mkdtempSync(join(tmpdir(), 'mps-control-'))
    created.push(directory)
    const path = join(directory, 'echo-env.mjs')
    writeFileSync(path, [
      "console.log(`host=${process.env.MPS_PLATFORM_HOST ?? '-'} port=${process.env.MPS_PLATFORM_PORT ?? '-'}`)",
      'setInterval(() => {}, 250)',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MpsNodeControlService, { entry: path, loaders: [] })

    await ctx.mpsNodeControl.saveConfig({ platformHost: 'mps.example.com', platformPort: '8791' })
    await ctx.mpsNodeControl.start()
    await waitFor(async () => (await ctx.mpsNodeControl.logs()).length > 0)

    const lines = await ctx.mpsNodeControl.logs()
    expect(lines[0]?.text).toBe('host=mps.example.com port=8791')
    // The parameters this test wrote live under the isolated home, removed with it.
    expect(existsSync(join(home, 'profiles', 'mps-node', 'mps-node-control.json'))).toBe(true)
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

      const probe = await ctx.mpsNodeControl.probe({ platformHost: '127.0.0.1', platformPort: String(port) })
      expect(probe.reachable).toBe(true)
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

    const refused = await ctx.mpsNodeControl.probe({ platformHost: '127.0.0.1', platformPort: '1' })
    expect(refused.reachable).toBe(false)
    expect(refused.httpStatus).toBeUndefined()
    expect(refused.detail).toMatch(/could not reach/u)
    expect(refused.loopback).toBe(true)

    // With nothing stated anywhere, the probe dials the node's own fallback
    // address, which is what a launch would dial too.
    const absent = await ctx.mpsNodeControl.probe({ platformPort: '1' })
    expect(absent.reachable).toBe(false)
    expect(absent.detail).toMatch(/127\.0\.0\.1:1/u)
  })
})
