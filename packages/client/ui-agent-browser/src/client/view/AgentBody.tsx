/** Agent tab body: reports its pane rectangle so the shell places the agent guest here. */
import { useEffect, useRef, type ReactElement } from 'react'
import type { AgentBrowserBodyProps } from '../../types.ts'

/**
 * Reports the pane the guest should occupy. The shell owns the guest and draws it
 * over this rectangle; the body itself only measures, so the component holds no
 * Electron access and subscribes to no external data.
 * @param props - slot shares; `present` is absent outside the Desktop shell.
 * @returns the measured pane placeholder.
 */
export function AgentBody(props: AgentBrowserBodyProps): ReactElement {
  const host = useRef<HTMLDivElement | null>(null)
  const present = useRef(props.present)
  present.current = props.present
  useEffect(() => {
    const element = host.current
    if (element === null || present.current === undefined) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      present.current?.({
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      present.current?.(null)
    }
  }, [])
  return <div className="dsh-agent-browser-body" ref={host} />
}
