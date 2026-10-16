/** Settings section: the node process this GUI supervises, and what it printed. */
import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MpsNodeInjected } from './contract.ts'
import type { MpsNodeKey } from './locales.ts'
import css from './Node.module.css'

/** Composed node section props. */
export type MpsNodeSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.mpsNode'> & InjectFace<MpsNodeInjected>

/**
 * @param props - localized copy, the node snapshot, and the node operations.
 * @returns the execution-node settings section.
 */
export function MpsNodeSection({ useMpsNode, start, stop, refresh, t }: MpsNodeSectionProps) {
  const node = useMpsNode(state => state)
  const phase = node.status?.phase
  const running = phase === 'running' || phase === 'starting'
  // The page is a window onto a process that changes on its own, so it re-reads
  // while it is open and stops reading once it is closed.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => { clearInterval(timer) }
  }, [refresh])
  return <div className={css.section}>
    <p className={css.notice}>{t('description')}</p>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('title')}</span>
      <Row label={t('phase')} value={phaseLabel(phase, t)} />
      <Row label={t('profile')} value={node.status?.profile ?? t('unknown')} />
      <Row label={t('pid')} value={node.status?.pid === undefined ? t('unknown') : String(node.status.pid)} />
      <Row label={t('startedAt')} value={node.status?.startedAt ?? t('unknown')} />
      {node.status?.error !== undefined && <Row label={t('phaseFailed')} value={node.status.error} />}
      <div className={css.row}>
        <span className={css.rowLabel}>{t('lastExit')}</span>
        <span className={css.rowValue}>{exitLabel(node.status, t)}</span>
      </div>
      <div className={css.actions}>
        <Button variant="primary" onClick={() => { void start() }} disabled={running || node.busy}>{t('start')}</Button>
        <Button variant="outline" onClick={() => { void stop() }} disabled={!running || node.busy}>{t('stop')}</Button>
        <Button variant="ghost" onClick={() => { void refresh() }}>{t('refresh')}</Button>
        {node.unreadable && <span className={css.error} role="alert">{t('readFailed')}</span>}
        {node.error !== undefined && !node.unreadable
          && <span className={css.error} role="alert">{node.error === '' ? t('startFailed') : node.error}</span>}
      </div>
    </div>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('logs')}</span>
      {node.lines.length === 0
        ? <span className={css.notice}>{t('noLogs')}</span>
        : <div className={css.logs}>
          {node.lines.map((line, index) => <div key={`${line.at}-${String(index)}`} className={css.logLine}>
            <span className={line.stream === 'stderr' ? css.logStreamError : css.logStream}>{line.stream}</span>
            <span className={css.logText}>{line.text}</span>
          </div>)}
        </div>}
    </div>
  </div>
}

/**
 * @param props - the row label and its value.
 * @returns one definition row.
 */
function Row({ label, value }: { label: string; value: string }) {
  return <div className={css.row}>
    <span className={css.rowLabel}>{label}</span>
    <span className={css.rowValue}>{value}</span>
  </div>
}

/**
 * Map a status phase onto localized copy.
 * @param phase - the phase the Host reported, if it reported one.
 * @param t - the namespace's translation seat.
 * @returns the localized phase name.
 */
function phaseLabel(phase: string | undefined, t: (key: MpsNodeKey) => string): string {
  if (phase === 'running') return t('phaseRunning')
  if (phase === 'starting') return t('phaseStarting')
  if (phase === 'failed') return t('phaseFailed')
  if (phase === 'stopped') return t('phaseStopped')
  return t('unknown')
}

/**
 * Describe how the last node process ended.
 * @param status - the latest reading, if one arrived.
 * @param t - the namespace's translation seat.
 * @returns the localized exit description.
 */
function exitLabel(
  status: { exit?: { code: number | null; signal: string | null; at: string } | undefined } | undefined,
  t: (key: MpsNodeKey) => string,
): string {
  const exit = status?.exit
  if (exit === undefined) return t('unknown')
  const code = exit.code === null ? t('unknown') : String(exit.code)
  const signal = exit.signal === null ? '' : ` ${exit.signal}`
  return `${t('exitCode')} ${code}${signal} · ${exit.at}`
}
