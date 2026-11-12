/** Language-pack card rendered on the Plugins page. */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { desktopLspPacks, type DesktopPackRow } from './bridge.ts'
import styles from './LspPacks.module.css'

/** Props the renderer binds for this card. */
export type LspPacksCardProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.lsp-packs'>

/**
 * Read a caught value's message.
 * @param error - caught value.
 * @returns a human-readable message.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the language packs the desktop shell can install.
 * @param props - locale copy bound by the renderer.
 * @returns the card, or nothing outside the desktop shell.
 */
export function LspPacksCard(props: LspPacksCardProps) {
  const { t } = props
  const bridge = desktopLspPacks()
  const [rows, setRows] = useState<readonly DesktopPackRow[]>()
  const [busy, setBusy] = useState<string>()
  const [failure, setFailure] = useState<string>()

  const load = useCallback(async () => {
    if (bridge === undefined) return
    try {
      setRows(await bridge.list())
    } catch (error: unknown) {
      setFailure(message(error))
    }
  }, [bridge])

  useEffect(() => { void load() }, [load])

  if (bridge === undefined) return undefined

  const act = async (id: string, action: 'install' | 'uninstall'): Promise<void> => {
    setBusy(id)
    setFailure(undefined)
    try {
      if (action === 'install') await bridge.install(id)
      else await bridge.uninstall(id)
      await load()
    } catch (error: unknown) {
      setFailure(message(error))
    } finally {
      setBusy(undefined)
    }
  }

  const stateLabel = (row: DesktopPackRow): string => {
    if (row.state === 'installed') return t('stateInstalled')
    if (row.blocked === 'java-missing') return t('jdkMissing')
    if (row.blocked === 'java-too-old') return t('jdkTooOld')
    if (row.state === 'broken') return t('stateBroken')
    return t('stateMissing')
  }

  const canInstall = (row: DesktopPackRow): boolean => row.state === 'installed' || row.blocked === undefined

  return (
    <section className={styles.card}>
      <p className={styles.description}>{t('description')}</p>
      {failure === undefined ? null : (
        <p className={styles.error} role="alert">{t('failed')} {failure}</p>
      )}
      {rows === undefined
        ? <p className={styles.working}>{t('working')}</p>
        : (
          <ul className={styles.list}>
            {rows.map(row => (
              <li key={row.id} className={styles.row}>
                <span className={styles.label}>{row.label}</span>
                <span className={styles.state}>{stateLabel(row)}</span>
                <span className={styles.actions}>
                  {busy === row.id ? <span className={styles.working}>{t('working')}</span> : (
                    <Button
                      variant={row.state === 'installed' ? 'ghost' : 'outline'}
                      size="sm"
                      disabled={busy !== undefined || !canInstall(row)}
                      onClick={() => { void act(row.id, row.state === 'installed' ? 'uninstall' : 'install') }}
                    >
                      {row.state === 'installed' ? t('uninstall') : t('install')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      {rows?.some(row => row.state === 'installed') === true
        ? <p className={styles.hint}>{t('restartHint')}</p>
        : null}
    </section>
  )
}
