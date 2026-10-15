/**
 * The node profile's command line: it owns this application's `--help`, and it
 * answers with the environment a deployment must state, so `dsh mps-node` behaves
 * like every other shipped application when a person asks what it needs. The node
 * itself takes no arguments — its settings live in the profile row and the
 * environment the row reads.
 * @module @tianma/dsh-mps-executor/startup
 */

import { hostname } from 'node:os'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { EXECUTOR_ENV, executorConfigFromEnv, resolveExecutorSettings } from './config.ts'
import { toError } from './report.ts'

/** Stable Cordis plugin name. */
export const name = 'mps-executor-startup'

/** Services required before the command line can be parsed. */
export const inject = ['cmdlineArgs']

const HELP_AFTER = `
The platform address and this node's identity come from the environment:
  MPS_PLATFORM_HOST       platform host, IPv4, or IPv6 address; required to start
  MPS_PLATFORM_PORT       platform port (default 8791)
  MPS_PLATFORM_SCHEME     http or https (default http)
  MPS_PLATFORM_BASE_PATH  path prefix (default /exec/v1)
  MPS_NODE_ID             node id the platform knows this machine by; required to start
  MPS_NODE_SECRET         pre-shared secret; required to start
  MPS_NODE_SLOTS          concurrent tasks (default 1)
  MPS_NODE_WORKSPACE      workspace root the node reports (default: the process working directory)

Pass --show-config to print the address this machine will dial and the identity it will use,
resolved from the same environment, without registering anywhere.
`

/**
 * The settings this machine would use, as lines a deployment can read.
 *
 * The secret is named, never printed: a readout is a diagnostic, and a diagnostic that leaks
 * the credential is a liability. The values come from {@link executorConfigFromEnv} and the
 * package's own resolver, so they cannot drift from what the profile row resolves.
 * @param env - the environment to read.
 * @returns one line per resolved setting.
 */
export function describeConfig(env: NodeJS.ProcessEnv = process.env): string {
  const settings = resolveExecutorSettings(executorConfigFromEnv(env), hostname())
  return [
    `endpoint             ${settings.endpoint.url('/register')}`,
    `node id              ${settings.nodeId}`,
    `node name            ${settings.nodeName}`,
    `node host            ${settings.nodeHost}`,
    `slots                ${String(settings.slotsTotal)}`,
    `workspace root       ${settings.workspaceRoot}`,
    `coding root          ${settings.codingRoot}`,
    `secret               from ${EXECUTOR_ENV.secret} (value not printed)`,
    `agent CLI            ${settings.cliRunner.command.join(' ')}`,
    `agent version        ${settings.agentVersion}`,
    '',
  ].join('\n')
}

/**
 * This application's command: no arguments of its own, and the help text that
 * names the environment a node needs.
 * @param exit - the launcher's exit path, used by a readout so the node never starts.
 * @returns a fresh program, so one process can build it more than once.
 */
export function nodeCommand(exit?: (code: number) => void): Command {
  return new Command()
    .name('dsh mps-node')
    .description('Run the Tianma MPS executor node: register this machine with the management platform and keep its heartbeat.')
    .helpOption('-h, --help', 'show this help')
    .option('--show-config', 'print the resolved platform address and identity, then exit')
    .addHelpText('after', HELP_AFTER)
    .action((options: { showConfig?: boolean }, command: Command) => {
      // The node is configured by its profile row; the readout below is the only command-line
      // input, and it decides nothing: it reports what the row would resolve.
      if (options.showConfig !== true) return
      let lines: string
      try {
        lines = describeConfig()
      } catch (error: unknown) {
        // A plain throw would leave the action and be swallowed before the launcher's exit
        // path, leaving a misconfigured machine sitting there. This is how help reports.
        command.error(toError(error).message)
        return
      }
      process.stdout.write(lines)
      exit?.(0)
    })
}

/**
 * Mount the profile's command line, so `--help` prints this application's help
 * and exits and an unusable invocation reports a usage error, both through the
 * launcher's exit path rather than the process streams.
 * @param ctx - the Cordis context the launcher supplied.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, nodeCommand(ctx.get('appExit')))
}
