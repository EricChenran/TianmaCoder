/** Desktop first-run presentation; the credential write stays in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

type Page = 'entry' | 'key'

/**
 * Render the standalone first-run flow using shell-owned operations and localized copy.
 * @param props.api - isolated preload API; the entered key is written, never read back.
 * @returns first-run pages with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [page, setPage] = useState<Page>('entry')
  const pageRef = useRef<Page>('entry')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const input = useRef<HTMLInputElement>(null)
  const keyButton = useRef<HTMLButtonElement>(null)
  const focusEntry = useRef(false)

  function navigate(next: Page) {
    pageRef.current = next
    setPage(next)
  }

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    return () => { mounted.current = false }
  }, [api, m.welcomeTitle])

  useEffect(() => {
    if (page === 'key') input.current?.focus()
    else if (page === 'entry' && focusEntry.current) {
      focusEntry.current = false
      keyButton.current?.focus()
    }
  }, [page])

  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    const value = draft.trim()
    if (!/^[\x21-\x7e]+$/.test(value) || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)
      || ((value.startsWith('"') || value.startsWith("'") || value.charCodeAt(0) === 96) && value.at(-1) === value[0])) {
      setError(value === '' ? m.welcomeKeyBlank : m.welcomeKeyInvalid)
      input.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.saveApiKey(value)
      if (!mounted.current) return
      if (result.ok) setDraft('')
      else setError(m.welcomeKeyFailed)
    } catch {
      if (mounted.current) setError(m.welcomeKeyFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function skip() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await api.skip()
      if (mounted.current) setDraft('')
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="welcome-heading">
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
        <p id="welcome-account-note" className="welcome-note">{m.welcomeAccountNote}</p>
      </div>
      <form id="key-form" className="key-form" hidden={page !== 'key'} noValidate onSubmit={(event) => { void saveKey(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="key-title">{m.welcomeKeyTitle}</h1><p id="key-description">{m.welcomeKeyDescription}</p></header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeKeyPlaceholder}</label>
          <input ref={input} id="key-input" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={error !== ''} placeholder={m.welcomeKeyPlaceholder}
            value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError('') }} />
          <p id="key-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button ref={keyButton} id="api-key" className="primary" type="button" onClick={() => { navigate('key') }}>{m.welcomeApiKey}</button>
        <button id="skip-entry" className="secondary" type="button" disabled={busy} onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
      </div>
      <div id="key-actions" className="actions" hidden={page !== 'key'}>
        <button id="save-key" className="primary" type="submit" form="key-form" disabled={busy || draft.trim() === ''}>{m.welcomeKeySave}</button>
        <button id="skip-key" className="secondary" type="button" disabled={busy} onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
        <button id="back-to-entry" className="back" type="button" disabled={busy} onClick={() => {
          if (busyRef.current) return
          setDraft(''); setError(''); focusEntry.current = true; navigate('entry')
        }}>{m.welcomeKeyBack}</button>
      </div>
    </main>
  </>
}
