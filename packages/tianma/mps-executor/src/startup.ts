/**
 * The node profile's command line: it owns this application's `--help`, and it
 * answers with the environment a deployment must state, so `dsh mps-node` behaves
 * like every other shipped application when a person asks what it needs. The node
 * itself takes no arguments — its settings live in the profile row and the
 * environment the row reads.
 * @module @tianma/dsh-mps-executor/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

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
`

/**
 * This application's command: no arguments of its own, and the help text that
 * names the environment a node needs.
 * @returns a fresh program, so one process can build it more than once.
 */
export function nodeCommand(): Command {
  return new Command()
    .name('dsh mps-node')
    .description('Run the Tianma MPS executor node: register this machine with the management platform and keep its heartbeat.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', HELP_AFTER)
    .action(() => { /* the node is configured by its profile row; it takes no command-line input */ })
}

/**
 * Mount the profile's command line, so `--help` prints this application's help
 * and exits and an unusable invocation reports a usage error, both through the
 * launcher's exit path rather than the process streams.
 * @param ctx - the Cordis context the launcher supplied.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, nodeCommand())
}
