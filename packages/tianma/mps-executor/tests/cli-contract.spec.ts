/**
 * The contract the runner depends on: the CLI profile it starts by default, and the
 * shape of the command line that profile accepts.
 *
 * The runner spawns `dsh --profile headless <instruction>`; nothing else in the
 * repository pins that this profile exists or that the instruction is positional, so an
 * upstream rename would break every node's first attempt instead of a test. This spec
 * starts the real CLI from source — the same entry the `dsh` script runs — and reads its
 * own usage, which needs no model credentials. The same spec pins the two other contracts
 * the runner reads off the CLI: the event stream a `--json` run prints, and the wording it
 * uses for a session it does not hold.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_CLI_COMMAND } from '@tianma/dsh-mps-executor'

const run = promisify(execFile)

/** Directories this spec created, removed at the end. */
const created: string[] = []

afterAll(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * The repository root, found by the workspace manifest every package sits under.
 * @returns the absolute path.
 */
function repositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current)
    if (parent === current) throw new Error('the repository root was not found above this spec')
    current = parent
  }
  return current
}

/**
 * Ask the real CLI to describe the profile the runner starts.
 * @param args - the arguments to pass after the profile.
 * @returns its exit code and what it printed.
 */
async function askCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'mps-cli-home-'))
  created.push(home)
  const root = repositoryRoot()
  try {
    const result = await run(
      process.execPath,
      ['--import', 'tsx/esm', join(root, 'apps', 'cli', 'src', 'bin.ts'), '--profile', 'headless', ...args],
      {
        cwd: root,
        // A fresh home and no provider key: whatever the host has configured, the CLI
        // either describes itself or says why it cannot run.
        env: withoutProviderCredentials({ ...process.env, DSH_HOME: home }),
        windowsHide: true,
        timeout: 120_000,
      },
    )
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

/** Provider credentials a host may export, which a probe must not inherit. */
const PROVIDER_CREDENTIALS = new Set(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'])

/**
 * Drop the provider credentials a host may export, so a probe either describes the CLI
 * or reports the missing credential instead of calling a model.
 * @param env - the environment to start the CLI with.
 * @returns the environment without provider credentials.
 */
function withoutProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (!PROVIDER_CREDENTIALS.has(name)) cleaned[name] = value
  }
  return cleaned
}

describe('the CLI the node starts', () => {
  it('accepts the profile the node runs by default, with the task as an argument', async () => {
    const profile = DEFAULT_CLI_COMMAND[1] === '--profile' ? DEFAULT_CLI_COMMAND[2] : undefined
    expect(profile).toBe('headless')

    const result = await askCli(['--help'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`--profile ${profile}`)
    // The instruction travels as one argument, so the profile has to take one.
    expect(result.stdout).toContain('[task...]')
    expect(result.stdout).toContain('the task text')
  })

  it('keeps the answer on stdout and the reason on stderr when it cannot run', async () => {
    const result = await askCli(['做一件小事'])

    // Without a model the node's attempt fails; the runner reads the exit code and the
    // last stderr line, so both have to stay where it looks for them.
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('MISSING_CREDENTIAL')
    expect(result.stdout.trim()).toBe('')
  })

  it('prints the event stream the runner reads when it is asked for one', async () => {
    const result = await askCli(['--json', '做一件小事'])

    // The run fails without a model before it does any work, which is enough: the stream
    // opens, states each step, and closes, and every line of it is one event.
    expect(result.code).not.toBe(0)
    const lines = result.stdout.split(/\r?\n/u).filter(line => line.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)

    // The runner reads the session it reports from the opening event.
    const session = events.find(event => event['type'] === 'session')
    expect(typeof session?.['sessionId']).toBe('string')
    // Every line is an event the runner renders: it hands anything else on as it came, so
    // a CLI that started printing prose here would show up as prose in the platform's log.
    for (const event of events) {
      expect(['session', 'status', 'thinking', 'text', 'tool_call', 'tool_result', 'final'])
        .toContain(event['type'])
    }
    const statuses = events.filter(event => event['type'] === 'status')
    expect(statuses.every(event => typeof event['phase'] === 'string')).toBe(true)
  })

  it('names the session it does not hold the way the retry matches it', async () => {
    // The runner retries a run whose exit says the platform's session is gone, and it
    // recognises that answer by this wording: a rename here has to fail this test rather
    // than leave every node failing a task the platform merely outlived.
    const result = await askCli(['--session-id', 'session-00000000-0000-4000-8000-000000000000', '做一件小事'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('does not exist; omit --session-id')
  })
})
