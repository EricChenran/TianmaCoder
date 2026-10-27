/** Settings section: the node process this GUI supervises, and what it printed. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MpsNodeConfigEntry } from '@tianma/dsh-mps-node-control/types'
import type { MpsNodeFormInput, MpsNodeInjected } from './contract.ts'
import type { MpsNodeKey } from './locales.ts'
import css from './Node.module.css'

/** Composed node section props. */
export type MpsNodeSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.mpsNode'> & InjectFace<MpsNodeInjected>

/** The local fields the edit form holds beside the join string. */
const FIELDS = [
  { key: 'workspaceRoot', label: 'fieldWorkspaceRoot' },
  { key: 'networkProxy', label: 'fieldNetworkProxy' },
] as const

/** The join string as the paste box previews it: what it states, or why it cannot be read. */
type JoinPreview =
  | { kind: 'empty' }
  | { kind: 'ok'; url: string; nodeId: string }
  | { kind: 'invalid'; message: string }

/**
 * Read one join string the way the Host's own parser will, so the preview under the
 * paste box and the save that follows cannot disagree about what a paste means. The
 * identity rides the fragment on purpose — a fragment never reaches a server.
 * @param value - what the paste box holds.
 * @returns the preview.
 */
function previewJoin(value: string): JoinPreview {
  const text = value.trim()
  if (text === '') return { kind: 'empty' }
  const hash = text.indexOf('#')
  if (hash < 0) {
    return { kind: 'invalid', message: 'it carries no "#" fragment: expected node=<id>&secret=<secret> after the platform address' }
  }
  let parsed: URL
  try {
    parsed = new URL(text.slice(0, hash))
  } catch {
    return { kind: 'invalid', message: 'its platform address is not a usable absolute URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', message: 'its platform address must be http or https' }
  }
  const fragment = new URLSearchParams(text.slice(hash + 1))
  const nodeId = (fragment.get('node') ?? '').trim()
  if (nodeId === '') return { kind: 'invalid', message: 'it carries no node id: expected node=<id> after "#"' }
  if ((fragment.get('secret') ?? '').trim() === '') {
    return { kind: 'invalid', message: 'it carries no secret: expected secret=<secret> after "#"' }
  }
  return {
    kind: 'ok',
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}`,
    nodeId,
  }
}

/**
 * @param props - the localized copy, the node snapshot, and the node operations.
 * @returns the execution-node settings section.
 */
export function MpsNodeSection(
  {
    useMpsNode, start, stop, refresh, saveConfig, probePlatform, browse,
    cancelTask, taskCommand, openSession, t,
  }: MpsNodeSectionProps,
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
  const [restarting, setRestarting] = useState(false)
  const [savedWhileRunning, setSavedWhileRunning] = useState(false)
  const pasteBox = useRef<HTMLTextAreaElement>(null)
  // A refused credential is a journey this page can finish on its own: the banner tells
  // the operator what happened, and the join area opens with the paste box ready.
  const credentialTrouble = useMemo(
    () => node.lines.some(line => line.stream === 'stderr' && /NODE_SECRET_INVALID|NODE_DISABLED/u.test(line.text)),
    [node.lines],
  )
  useEffect(() => {
    if (!credentialTrouble || editing) return
    setEditing(true)
  }, [credentialTrouble, editing])
  // The paste box takes focus whenever the form opens, whichever way it opened.
  useEffect(() => {
    if (editing) pasteBox.current?.focus()
  }, [editing])
  const joinPreview = previewJoin(form.join ?? '')
  const beginEdit = (): void => {
    const saved: MpsNodeFormInput = {}
    for (const field of FIELDS) {
      const value = config?.saved[field.key]
      if (value !== undefined) saved[field.key] = value
    }
    // The join box starts empty on purpose: what it would replace is named in its
    // placeholder, and a paste is the only way to state one.
    setForm(saved)
    setEditing(true)
  }
  const submit = (): void => {
    const wasRunning = running
    void saveConfig(form).then((ok) => {
      if (!ok) return
      setEditing(false)
      setSavedWhileRunning(wasRunning)
    })
  }
  // The probe reads the form as it stands, so a join string can be tested before it
  // is saved; outside editing it reads whatever is stored.
  const probeNow = (): void => {
    void probePlatform(editing ? form : {})
  }
  const restartNow = (): void => {
    setRestarting(true)
    void stop().then(() => start()).finally(() => { setRestarting(false); setSavedWhileRunning(false) })
  }
  const pasteFromClipboard = (): void => {
    void navigator.clipboard.readText().then(
      (text) => { setForm({ ...form, join: text, clearNodeSecret: '' }) },
      () => pasteBox.current?.focus(),
    )
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
    {credentialTrouble && <p className={css.error} role="alert">{t('credentialExpired')}</p>}
    <div className={css.group}>
      <span className={css.groupTitle}>{t('joinTitle')}</span>
      <p className={css.notice}>{t('joinDescription')}</p>
      {config !== undefined && (config.lanAddresses.length > 0
        ? <p className={css.notice}>{t('lanNotice', { addresses: config.lanAddresses.join(', ') })}</p>
        : <p className={css.notice}>{t('lanNone')}</p>)}
      {config === undefined
        ? <span className={css.notice}>{t('sourceUnset')}</span>
        : editing
          ? <div className={css.fields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('joinTitle')}</span>
              <div className={css.fieldRow}>
                <textarea
                  ref={pasteBox}
                  className={css.pasteBox}
                  value={form.join ?? ''}
                  placeholder={config.joinSet === 'saved' ? t('joinKeepHint') : t('joinPlaceholder')}
                  onChange={(event) => { setForm({ ...form, join: event.target.value, clearNodeSecret: '' }) }}
                  rows={2}
                  spellCheck={false}
                  autoComplete='off'
                />
                <Button variant='outline' onClick={pasteFromClipboard}>{t('joinPaste')}</Button>
              </div>
            </label>
            {joinPreview.kind === 'ok' && <div className={css.summary}>
              <span>✓ {t('joinParsedUrl')} {joinPreview.url}</span>
              <span>✓ {t('joinParsedNode')} {joinPreview.nodeId}</span>
              <span>✓ {t('joinParsedSecret')}</span>
            </div>}
            {joinPreview.kind === 'invalid'
              && <span className={css.error} role='alert'>{t('joinInvalid', { message: joinPreview.message })}</span>}
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
            {config.secretSet === 'saved' && config.joinSet === 'unset' && <label className={css.field}>
              <span className={css.fieldLabel}>{t('fieldNodeSecret')}</span>
              <div className={css.fieldRow}>
                <Input
                  type='password'
                  value={form.nodeSecret ?? ''}
                  placeholder={t('secretKeepHint')}
                  onChange={(event) => { setForm({ ...form, nodeSecret: event.target.value, clearNodeSecret: '' }) }}
                  autoComplete='new-password'
                />
              </div>
              <Checkbox
                checked={form.clearNodeSecret === 'true'}
                label={t('secretClear')}
                onChange={(next) => { setForm({ ...form, clearNodeSecret: next ? 'true' : '' }) }}
              />
            </label>}
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
            {config.joinSummary === undefined
              ? <span className={css.notice}>{t('joinSteps')}</span>
              : <span className={css.notice}>{t('joinStored', {
                node: config.joinSummary.nodeId,
                url: config.joinSummary.url,
              })} · {sourceOf(config.joinSet, t)}</span>}
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
          : <span className={css.error} role="status">{t('probeUnreachable')} — {node.probe.detail} · {probeKindNote(node.probe.kind, t)}</span>)}
      </div>
    </div>
    <div className={css.group}>
      <span className={css.groupTitle}>{t('policyTitle')}</span>
      <p className={css.notice}>{t('policyDescription')}</p>
      {config === undefined || (config.platformPolicy.slotsTotal === undefined && config.platformPolicy.lanes === undefined) ? (
        <span className={css.notice}>{t('policyNone')}</span>
      ) : <div className={css.fields}>
        {config.platformPolicy.slotsTotal !== undefined
          && <Row label={t('policySlots')} value={String(config.platformPolicy.slotsTotal)} />}
        {config.platformPolicy.lanes !== undefined
          && <Row label={t('policyLanes')} value={config.platformPolicy.lanes.join(', ') || t('unknown')} />}
        {config.platformPolicy.agentProvider !== undefined && config.platformPolicy.agentModel !== undefined
          && <Row label={t('policyAgent')} value={`${config.platformPolicy.agentProvider}/${config.platformPolicy.agentModel}`} />}
        {config.platformPolicy.configRevision !== undefined
          && <Row label={t('policyRevision')} value={`r${String(config.platformPolicy.configRevision)}`} />}
      </div>}
    </div>
    {savedWhileRunning && !editing && <div className={css.actions}>
      <span className={css.notice}>{t('restartNotice')}</span>
      <Button variant="primary" onClick={restartNow} disabled={node.busy || restarting}>
        {restarting ? t('restarting') : t('restartNow')}
      </Button>
    </div>}
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
 * The next step one probe failure kind names for the operator.
 * @param kind - how the probe ended.
 * @param t - the namespace's translation seat.
 * @returns the localized next step, empty for the kinds that need no extra word.
 */
function probeKindNote(kind: string, t: (key: MpsNodeKey) => string): string {
  if (kind === 'dns-failed') return t('probeKindDns')
  if (kind === 'refused') return t('probeKindRefused')
  if (kind === 'timeout') return t('probeKindTimeout')
  return ''
}

/**
 * The placeholder one empty field shows: the value the next launch would take
 * from elsewhere, so "blank" reads as "keep whatever is in effect".
 * @param entry - the field's effective reading.
 * @param t - the namespace's translation seat.
 * @returns the placeholder text.
 */
function placeholder(entry: MpsNodeConfigEntry | undefined, t: (key: MpsNodeKey) => string): string {
  if (entry === undefined) return t('sourceUnset')
  return entry.value === undefined ? t('sourceUnset') : `${entry.value} · ${sourceOf(entry.source, t)}`
}

/**
 * The read-only rendering of one effective field: its value plus its origin.
 * @param entry - the field's effective reading.
 * @param t - the namespace's translation seat.
 * @returns the row value text.
 */
function sourceOf(source: 'saved' | 'environment' | 'default' | 'unset', t: (key: MpsNodeKey) => string): string {
  if (source === 'saved') return t('sourceSaved')
  if (source === 'environment') return t('sourceEnvironment')
  if (source === 'default') return t('sourceDefault')
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
