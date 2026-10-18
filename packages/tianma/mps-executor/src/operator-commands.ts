/**
 * The operator command file: the supervised surface's way to reach the node
 * without a socket — the GUI's Settings page writes one JSON document under the
 * operator directory, and the node takes and clears it. Same file convention as
 * the draining mark, so a node started anywhere finds its operator's intent.
 *
 * @module @tianma/dsh-mps-executor/operator-commands
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File under the operator directory holding pending commands. */
export const OPERATOR_COMMANDS_FILE = '.operator-commands.json'

/** One command the operator surface left for the node. */
export interface OperatorCommand {
  /** Which command this is. */
  action: 'cancel' | 'takeover' | 'complete'
  /** The task it addresses. */
  task_id: string
  /** What a completed takeover wants the result to say. */
  summary?: string | undefined
  /** When the operator issued it, as an RFC 3339 string. */
  at?: string | undefined
}

/** Reads and takes the operator commands of one node. */
export interface OperatorCommands {
  /** Read the pending commands without taking them. */
  peek(): OperatorCommand[]
  /** Read the pending commands and clear the file, so each is applied once. */
  take(): OperatorCommand[]
  /** Append commands, merging with whatever is pending. */
  leave(commands: readonly OperatorCommand[]): void
}

/**
 * Build the command channel for one operator directory.
 * @param root - the operator directory, created when a command is left.
 * @returns the channel.
 */
export function operatorCommands(root: string): OperatorCommands {
  const path = join(root, OPERATOR_COMMANDS_FILE)
  const read = (): OperatorCommand[] => {
    if (!existsSync(path)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is OperatorCommand =>
        typeof entry === 'object' && entry !== null && 'action' in entry && 'task_id' in entry)
    } catch {
      // An unreadable command file is dropped: an operator can reissue a
      // command, while a node that refuses everything is worse.
      return []
    }
  }
  return {
    peek: read,
    take(): OperatorCommand[] {
      const commands = read()
      if (commands.length > 0) rmSync(path, { force: true })
      return commands
    },
    leave(commands: readonly OperatorCommand[]): void {
      if (commands.length === 0) return
      mkdirSync(root, { recursive: true })
      writeFileSync(path, `${JSON.stringify([...read(), ...commands])}\n`, 'utf8')
    },
  }
}
