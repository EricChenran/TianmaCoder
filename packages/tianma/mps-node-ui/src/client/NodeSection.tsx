/** Settings section: the node process this GUI supervises, and what it printed. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MpsNodeConfig, MpsNodeConfigEntry } from '@tianma/dsh-mps-node-control/types'
import type { MpsNodeFormInput, MpsNodeInjected } from './contract.ts'
import type { MpsNodeKey } from './locales.ts'
import css from './Node.module.css'

/** Composed node section props. */
export type MpsNodeSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.mpsNode'> & InjectFace<MpsNodeInjected>

/** One deployment-parameter field: its storage key and its copy key. */
const FIELDS = [
  { key: 'platformHost', label: 'fieldPlatformHost' },
  { key: 'platformPort', label: 'fieldPlatformPort' },
  { key: 'platformScheme', label: 'fieldPlatformScheme' },
  { key: 'platformBasePath', label: 'fieldPlatformBasePath' },
  { key: 'nodeId', label: 'fieldNodeId' },
  { key: 'nodeName', label: 'fieldNodeName' },
  { key: 'nodeHost', label: 'fieldNodeHost' },
  { key: 'workspaceRoot', label: 'fieldWorkspaceRoot' },
  { key: 'slotsTotal', label: 'fieldSlotsTotal' },
] as const

/**
 * @param props - localized copy, the node snapshot, and the node operations.
 * @returns the execution-node settings section.
 */
export function MpsNodeSection(
  { useMpsNode, start, stop, refresh, saveConfig, probePlatform, browse, cancelTask, taskCommand, openSession, t }: MpsNodeSectionProps,
) {
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
  const config = node.config
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<MpsNodeFormInput>({})
  const [finish, setFinish] = useState<Record<string, string>>({})
  const beginEdit = (): void => {
    const saved: MpsNodeFormInput = {}
    for (const field of FIELDS) {
      const value = config?.saved[field.key]
      if (value !== undefined) saved[field.key] = String(value)
    }
    setForm(saved)
    setEditing(true)
  }
  const submit = (): void => {
    void saveConfig(form).then((ok) => { if (ok) setEditing(false) })
  }
  // The probe reads the form as it stands, so an address can be tested before it
  // is saved; outside editing it reads whatever is in effect.
  const probeNow = (): void => {
    void probePlatform(editing ? form : savedForm(config))
  }
  return <div className={css.section}>
    <p className={css.notice}>{t('description')}</p>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('title')}</span>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('phase')}</span>
        <Tag tone={phaseTone(phase)}>{phaseLabel(phase, t)}</Tag>
      </div>
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
      <span className={css.groupTitle}>{t('configTitle')}</span>
      <p className={css.notice}>{t('configDescription')}</p>
      {config !== undefined && (config.lanAddresses.length > 0
        ? <p className={css.notice}>{t('lanNotice', { addresses: config.lanAddresses.join(', ') })}</p>
        : <p className={css.notice}>{t('lanNone')}</p>)}
      {config === undefined
        ? <span className={css.notice}>{t('sourceUnset')}</span>
        : editing
          ? <div className={css.fields}>
            {FIELDS.map(field => <label key={field.key} className={css.field}>
              <span className={css.fieldLabel}>{t(field.label)}</span>
              <div className={css.fieldRow}>
                <Input
                  value={form[field.key] ?? ''}
                  placeholder={placeholder(config.effective[field.key], t)}
                  onChange={(event) => { setForm({ ...form, [field.key]: event.target.value }) }}
                />
                {field.key === 'workspaceRoot' && <Button
                  variant='ghost'
                  onClick={() => {
                    void browse().then((picked) => {
                      if (picked !== undefined) setForm({ ...form, workspaceRoot: picked })
                    })
                  }}
                >{t('browse')}</Button>}
              </div>
            </label>)}
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('fieldNodeSecret')}</span>
              <div className={css.fieldRow}>
                <Input
                  type='password'
                  value={form.nodeSecret ?? ''}
                  placeholder={secretPlaceholder(config.secretSet, t)}
                  onChange={(event) => { setForm({ ...form, nodeSecret: event.target.value, clearNodeSecret: '' }) }}
                  autoComplete='new-password'
                />
              </div>
              {config.secretSet === 'saved'
                ? <Checkbox
                  checked={form.clearNodeSecret === 'true'}
                  label={t('secretClear')}
                  onChange={(next) => { setForm({ ...form, clearNodeSecret: next ? 'true' : '' }) }}
                />
                : <span className={css.fieldLabel}>{t('secretKeepHint')}</span>}
            </label>
            <div className={css.actions}>
              <Button variant="primary" onClick={submit} disabled={node.configBusy}>
                {node.configBusy ? t('configSaving') : t('configSave')}
              </Button>
              <Button variant="ghost" onClick={() => { setEditing(false) }} disabled={node.configBusy}>{t('configCancel')}</Button>
              {node.configError !== undefined
                && <span className={css.error} role="alert">{node.configError === '' ? t('configSaveFailed') : node.configError}</span>}
            </div>
          </div>
          : <>
            {FIELDS.map(field => <Row
              key={field.key}
              label={t(field.label)}
              value={effectiveLabel(config.effective[field.key], t)}
            />)}
            <Row label={t('fieldNodeSecret')} value={secretPlaceholder(config.secretSet, t)} />
            <div className={css.actions}>
              <Button variant="outline" onClick={beginEdit}>{t('configEdit')}</Button>
              {node.configSaved && <span className={css.notice}>{t('configSaved')}</span>}
              {node.configError !== undefined
                && <span className={css.error} role="alert">{node.configError === '' ? t('configSaveFailed') : node.configError}</span>}
            </div>
          </>}
      <div className={css.actions}>
        <Button variant="outline" onClick={probeNow} disabled={node.probeBusy}>
          {node.probeBusy ? t('probeRunning') : t('probe')}
        </Button>
        {node.probe !== undefined && (node.probe.reachable
          ? <span className={css.notice} role="status">
            {t('probeOk')} — {node.probe.detail}
          </span>
          : <span className={css.error} role="status">{t('probeUnreachable')} — {node.probe.detail}</span>)}
      </div>
      <p className={css.notice}>{t('configSecretNote')}</p>
    </div>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('tasksTitle')}</span>
      {node.tasks === undefined || node.tasks.length === 0
        ? <span className={css.notice}>{t('tasksNone')}</span>
        : <div className={css.tasks}>
          {node.tasks.slice(0, 10).map(task => <div key={task.task_id} className={css.taskRow}>
            <div className={css.taskHead}>
              <StateDot state={taskDot(task)} className={css.taskDot} />
              <span className={css.taskId}>{task.task_id}</span>
              <Tag tone={kindTone(task.kind)}>{kindLabel(task.kind, t)}</Tag>
              <Tag tone={statusTone(task)}>{statusLabel(task, t)}</Tag>
              <span className={css.taskAt} title={task.at}>{task.at}</span>
            </div>
            {task.summary !== undefined
              && <p className={css.taskSummary}>{task.summary}</p>}
            {task.held && <div className={css.taskFinish}>
              <Input
                value={finish[task.task_id] ?? ''}
                placeholder={t('taskFinishSummary')}
                onChange={(event) => { setFinish({ ...finish, [task.task_id]: event.target.value }) }}
              />
              <Button
                variant="primary"
                disabled={node.taskBusy !== undefined}
                onClick={() => {
                  void taskCommand({ action: 'complete', task_id: task.task_id, summary: finish[task.task_id] ?? '' })
                }}
              >{t('taskFinish')}</Button>
            </div>}
            <div className={css.taskActions}>
              {task.running && !task.held && <Button
                variant="outline"
                disabled={node.taskBusy !== undefined}
                onClick={() => { void taskCommand({ action: 'takeover', task_id: task.task_id }) }}
              >{t('taskTakeover')}</Button>}
              {(task.running || task.held) && <Button
                variant="ghost"
                disabled={node.taskBusy !== undefined}
                onClick={() => { void cancelTask(task.task_id) }}
              >{node.taskBusy === task.task_id ? t('taskCancelling') : t('taskCancel')}</Button>}
              {task.session !== undefined && <Button
                variant="ghost"
                onClick={() => { openSession(task.session as string) }}
              >{t('taskOpenSession')}</Button>}
            </div>
          </div>)}
        </div>}
      <p className={css.notice}>{t('tasksNote')}</p>
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
 * @param outcome - the settled outcome, when one was recorded.
 * @param t - the namespace's translation seat.
 * @returns the localized outcome name.
 */
function outcomeLabel(outcome: string | undefined, t: (key: MpsNodeKey) => string): string {
  if (outcome === 'success') return t('taskSuccess')
  if (outcome === 'failed') return t('taskFailed')
  if (outcome === 'blocked') return t('taskBlocked')
  if (outcome === 'cancelled') return t('taskCancelled')
  return t('taskEnded')
}

/** What one task row's status tag and dot read. */
interface TaskStatusReading {
  running: boolean
  held?: boolean | undefined
  outcome?: string | undefined
}

/**
 * @param task - one task row's reading.
 * @param t - the namespace's translation seat.
 * @returns the localized status the row's tag carries: running, held, or the outcome.
 */
function statusLabel(task: TaskStatusReading, t: (key: MpsNodeKey) => string): string {
  if (task.held === true) return t('taskHeld')
  if (task.running) return t('taskRunning')
  return outcomeLabel(task.outcome, t)
}

/** One task row's tag tone: colour says what became of the work. */
function statusTone(task: TaskStatusReading): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (task.held === true) return 'warning'
  if (task.running) return 'info'
  if (task.outcome === 'success') return 'success'
  if (task.outcome === 'failed') return 'danger'
  return 'neutral'
}

/** One task row's state dot: the running one spins, each settled one lands on its colour. */
function taskDot(task: TaskStatusReading): 'ongoing' | 'warning' | 'done' | 'error' | 'idle' {
  if (task.held === true) return 'warning'
  if (task.running) return 'ongoing'
  if (task.outcome === 'success') return 'done'
  if (task.outcome === 'failed') return 'error'
  return 'idle'
}

/** One task row's kind tag tone: classification, not health. */
function kindTone(kind: string): 'neutral' | 'quiet' {
  return kind === 'chat_answer' || kind === 'answer' ? 'quiet' : 'neutral'
}

/**
 * @param kind - the work-item kind the platform dispatched.
 * @param t - the namespace's translation seat.
 * @returns the localized kind name.
 */
function kindLabel(kind: string, t: (key: MpsNodeKey) => string): string {
  if (kind === 'chat_answer' || kind === 'answer') return t('taskKindAnswer')
  return t('taskKindCoding')
}

/**
 * The saved parameters as the probe reads them outside editing: the form the
 * Host would be configured with, as text.
 * @param config - the deployment-parameter reading.
 * @returns the form values, empty when no reading arrived.
 */
function savedForm(config: MpsNodeConfig | undefined): MpsNodeFormInput {
  const saved: MpsNodeFormInput = {}
  if (config === undefined) return saved
  for (const field of FIELDS) {
    const value = config.saved[field.key]
    if (value !== undefined) saved[field.key] = String(value)
  }
  return saved
}

/**
 * The placeholder one empty field shows: the value the next launch would take
 * from elsewhere, so "blank" reads as "keep whatever is in effect".
 * @param entry - the field's effective reading.
 * @param t - the namespace's translation seat.
 * @returns the placeholder text.
 */
function secretPlaceholder(source: 'saved' | 'environment' | 'default' | 'unset' | undefined, t: (key: MpsNodeKey) => string): string {
  if (source === 'saved') return t('secretKeepHint')
  if (source === 'environment') return t('sourceEnvironment')
  return t('sourceUnset')
}

function placeholder(entry: MpsNodeConfigEntry | undefined, t: (key: MpsNodeKey) => string): string {
  if (entry === undefined) return t('sourceUnset')
  return entry.value === undefined ? t('sourceUnset') : `${entry.value} · ${sourceLabel(entry, t)}`
}

/**
 * The read-only rendering of one effective field: its value plus its origin.
 * @param entry - the field's effective reading.
 * @param t - the namespace's translation seat.
 * @returns the row value text.
 */
function effectiveLabel(entry: MpsNodeConfigEntry, t: (key: MpsNodeKey) => string): string {
  return entry.value === undefined ? t('sourceUnset') : `${entry.value} · ${sourceLabel(entry, t)}`
}

/**
 * @param entry - the field's effective reading.
 * @param t - the namespace's translation seat.
 * @returns the localized origin label.
 */
function sourceLabel(entry: MpsNodeConfigEntry, t: (key: MpsNodeKey) => string): string {
  if (entry.source === 'saved') return t('sourceSaved')
  if (entry.source === 'environment') return t('sourceEnvironment')
  if (entry.source === 'default') return t('sourceDefault')
  return t('sourceUnset')
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
/** The node phase as a tag tone: colour says health, not classification. */
function phaseTone(phase: string | undefined): 'success' | 'info' | 'danger' | 'neutral' {
  if (phase === 'running') return 'success'
  if (phase === 'starting') return 'info'
  if (phase === 'failed') return 'danger'
  return 'neutral'
}

function phaseLabel(phase: string | undefined, t: (key: MpsNodeKey) => string): string {  if (phase === 'running') return t('phaseRunning')
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
