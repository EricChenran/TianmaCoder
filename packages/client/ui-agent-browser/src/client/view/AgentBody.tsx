/** Agent Browser tab body: shows the guest page state once the live view lands. */
import type { ReactElement } from 'react'
import type { AgentBrowserBodyProps } from '../../types.ts'

/** Minimal body; the live guest view replaces this placeholder. */
export function AgentBody(_props: AgentBrowserBodyProps): ReactElement {
  return <div className="dsh-agent-browser-body" />
}
