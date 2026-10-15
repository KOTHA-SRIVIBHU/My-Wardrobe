import { LocalNotifications } from '@capacitor/local-notifications'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { ErrorBanner, PageHeader } from '../components/ui'
import * as ai from '../engine/ai'
import { SupabaseBackend } from '../engine/backend'
import { api, downloadBackup } from '../lib/api'
import { activate, deactivate, getService, isNative, projectRef, saveConnection, updateConnection, useConnection } from '../lib/connection'
import {
  DEFAULT_NOTIFY, type NotifyPrefs, loadNotifyPrefs, lockAvailable, lockEnabled, notificationPermission,
  rescheduleNotifications, saveNotifyPrefs, setLockEnabled,
} from '../lib/device'
import { useLoad } from '../lib/format'
import { SETUP_SQL, copyText } from './Setup'

export const APP_VERSION = '1.0.0'
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const mask = (s: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : 'Not set')

function Section({ title, icon, children }: { title: string; icon?: Parameters<typeof Icon>[0]['name']; children: ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        {icon && <Icon name={icon} className="h-5 w-5 text-indigo-500" />}
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Toggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start justify-between gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-indigo-600' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </label>
  )
}

export default function SettingsPage() {
  const { connection } = useConnection()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const say = (m: string) => {
    setError(null)
    setMessage(m)
  }
  const fail = (e: unknown) => {
    setMessage(null)
    setError(errorText(e))
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Settings" subtitle="Everything here can be changed at any time." />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {message && <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}
      {connection && (
        <>
          <VaultSection onMessage={say} onError={fail} />
          <AiSection onMessage={say} onError={fail} />
          <NotificationsSection onMessage={say} onError={fail} />
          <SecuritySection onMessage={say} onError={fail} />
          <DataSection onMessage={say} onError={fail} />
        </>
      )}
      <section className="card p-4 text-sm text-slate-600">
        <p>ClosetIQ {APP_VERSION}</p>
        <Link to="/privacy" className="text-indigo-700 hover:underline">Privacy &amp; data</Link>
      </section>
    </div>
  )
}

type Props = { onMessage: (m: string) => void; onError: (e: unknown) => void }

function VaultSection({ onMessage, onError }: Props) {
  const { connection } = useConnection()
  const [changing, setChanging] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!connection) return null
  const ref = projectRef(connection.supabaseUrl)

  async function changePassphrase(e: FormEvent) {
    e.preventDefault()
    if (!connection) return
    setBusy(true)
    try {
      if (current !== connection.passphrase) throw new Error('The current passphrase is wrong.')
      if (next.length < 10) throw new Error('Use at least 10 characters.')
      if (next !== again) throw new Error("The new passphrases don't match.")
      await new SupabaseBackend(connection.supabaseUrl, connection.anonKey, connection.passphrase).setPassphrase(next)
      const updated = { ...connection, passphrase: next }
      await activate(updated)
      await saveConnection(updated)
      setChanging(false)
      setCurrent('')
      setNext('')
      setAgain('')
      onMessage('Passphrase changed. Other devices will ask for the new one.')
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!confirm('Forget the Supabase details and passphrase on this device? Your wardrobe stays safe in your cloud; you can connect again any time.')) return
    await deactivate()
    window.location.replace('/')
  }

  return (
    <Section title="Your vault (Supabase)" icon="cloud">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Project</dt>
        <dd className="truncate font-mono text-xs leading-5">{connection.supabaseUrl}</dd>
        <dt className="text-slate-500">Key</dt>
        <dd className="font-mono text-xs leading-5">{mask(connection.anonKey)}</dd>
        <dt className="text-slate-500">Status</dt>
        <dd className="text-emerald-700">Connected and unlocked</dd>
      </dl>
      {!changing ? (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => setChanging(true)}>Change passphrase</button>
          <button className="btn btn-secondary" onClick={disconnect}>Switch project / disconnect</button>
        </div>
      ) : (
        <form onSubmit={changePassphrase} className="space-y-2 rounded-lg bg-slate-50 p-3">
          <input type="password" className="input" placeholder="Current passphrase" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <input type="password" className="input" placeholder="New passphrase (10+ characters)" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          <input type="password" className="input" placeholder="New passphrase again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setChanging(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Changing…' : 'Change passphrase'}</button>
          </div>
        </form>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600">Setup script (re-run after app updates if asked)</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn btn-secondary px-2.5 py-1.5 text-xs" onClick={async () => setCopied(await copyText(SETUP_SQL))}>{copied ? '✓ Copied' : 'Copy script'}</button>
          {ref && (
            <a className="btn btn-secondary px-2.5 py-1.5 text-xs" href={`https://supabase.com/dashboard/project/${ref}/sql/new`} target="_blank" rel="noreferrer">
              Open SQL editor
            </a>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Forgot your passphrase on every device? In the SQL editor run <code className="rounded bg-slate-100 px-1">update closetiq_meta set passphrase_hash = null;</code>, then
          connect again and choose a new one. Your data is kept.
        </p>
      </details>
    </Section>
  )
}

function AiSection({ onMessage, onError }: Props) {
  const { connection } = useConnection()
  const [key, setKey] = useState('')
  const [vision, setVision] = useState(connection?.visionModel ?? ai.DEFAULT_VISION_MODEL)
  const [text, setText] = useState(connection?.textModel ?? ai.DEFAULT_TEXT_MODEL)
  const [testing, setTesting] = useState(false)
  if (!connection) return null

  async function test() {
    setTesting(true)
    try {
      await ai.chatJson(text, [{ role: 'user', content: 'Reply with the JSON object {"ok": true}.' }], 200)
      onMessage('Groq key works.')
    } catch (e) {
      onError(e)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Section title="AI (Groq)" icon="sparkle">
      <p className="text-sm text-slate-600">
        Current key: <span className="font-mono text-xs">{mask(connection.groqKey)}</span>. It stays on this device. Get one free at{' '}
        <a className="text-indigo-700 underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com</a>.
      </p>
      <div className="flex gap-2">
        <input type="password" className="input font-mono text-xs" placeholder="New key: gsk_…" autoCapitalize="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
        <button
          className="btn btn-primary"
          disabled={!key.trim()}
          onClick={async () => {
            await updateConnection({ groqKey: key.trim() })
            setKey('')
            onMessage('Groq key saved.')
          }}
        >
          Save
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-slate-600">
          Photo model
          <input className="input mt-1 font-mono text-xs" value={vision} onChange={(e) => setVision(e.target.value)} />
        </label>
        <label className="text-xs text-slate-600">
          Text model
          <input className="input mt-1 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-secondary"
          onClick={async () => {
            await updateConnection({ visionModel: vision.trim() || ai.DEFAULT_VISION_MODEL, textModel: text.trim() || ai.DEFAULT_TEXT_MODEL })
            onMessage('Models saved.')
          }}
        >
          Save models
        </button>
        {connection.groqKey && (
          <>
            <button className="btn btn-secondary" disabled={testing} onClick={test}>{testing ? 'Testing…' : 'Test key'}</button>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await updateConnection({ groqKey: null })
                onMessage('Groq key removed. AI features are off.')
              }}
            >
              Remove key
            </button>
          </>
        )}
      </div>
    </Section>
  )
}

const GROUPS = [
  { key: 'laundry', label: 'Laundry baskets due or overdue' },
  { key: 'ironing', label: 'Clothes to iron' },
  { key: 'plan', label: 'Clothes running short, plan problems' },
  { key: 'events', label: 'Tomorrow’s events' },
] as const

function NotificationsSection({ onMessage, onError }: Props) {
  const [prefs, setPrefs] = useState<NotifyPrefs>(loadNotifyPrefs)
  const [permission, setPermission] = useState<string>('…')
  const settings = useLoad(() => api.settings(), [])
  const groups = { laundry: true, ironing: true, plan: true, events: true, ...(settings.data?.notification_prefs ?? {}) }

  useEffect(() => {
    void notificationPermission().then(setPermission)
  }, [])

  async function update(patch: Partial<NotifyPrefs>) {
    let next = { ...prefs, ...patch }
    if (patch.enabled) {
      const p = await notificationPermission(true)
      setPermission(p)
      if (p !== 'granted') {
        onError(new Error('Notifications are blocked. Allow them for ClosetIQ in your phone’s settings.'))
        next = { ...next, enabled: false }
      }
    }
    setPrefs(next)
    saveNotifyPrefs(next)
    const n = await rescheduleNotifications(getService())
    if (patch.enabled) onMessage(`Reminders are on: ${n} scheduled for the next few days.`)
  }

  async function toggleGroup(key: string, on: boolean) {
    try {
      settings.setData(await api.updateSettings({ notification_prefs: { ...groups, [key]: on } }))
      await rescheduleNotifications(getService())
    } catch (e) {
      onError(e)
    }
  }

  async function sendTest() {
    if ((await notificationPermission(true)) !== 'granted') return onError(new Error('Notifications are blocked for ClosetIQ.'))
    await LocalNotifications.schedule({ notifications: [{ id: 9999, title: 'ClosetIQ', body: 'Notifications work! 👕', schedule: { at: new Date(Date.now() + 3000) } }] })
    onMessage('A test notification arrives in 3 seconds.')
  }

  return (
    <Section title="Notifications" icon="bell">
      {!isNative && <p className="text-sm text-slate-500">Phone notifications work in the Android app. Here you still get the in-app reminders bell.</p>}
      <Toggle on={prefs.enabled && permission === 'granted'} onChange={(v) => void update({ enabled: v })} label="Daily reminders on this phone" hint="A morning briefing (what to wear, what's due) and an evening heads-up for tomorrow." disabled={!isNative} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-600">
          Morning
          <input type="time" className="input mt-1" value={prefs.morningTime} onChange={(e) => void update({ morningTime: e.target.value || DEFAULT_NOTIFY.morningTime })} disabled={!isNative} />
        </label>
        <label className="text-xs text-slate-600">
          Evening
          <input type="time" className="input mt-1" value={prefs.eveningTime} onChange={(e) => void update({ eveningTime: e.target.value || DEFAULT_NOTIFY.eveningTime })} disabled={!isNative} />
        </label>
      </div>
      <p className="pt-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Remind me about (all devices)</p>
      {GROUPS.map((g) => (
        <Toggle key={g.key} on={groups[g.key]} onChange={(v) => void toggleGroup(g.key, v)} label={g.label} />
      ))}
      {isNative && <button className="btn btn-secondary" onClick={sendTest}>Send a test notification</button>}
    </Section>
  )
}

function SecuritySection({ onMessage, onError }: Props) {
  const [on, setOn] = useState(false)
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    void lockEnabled().then(setOn)
    void lockAvailable().then(setAvailable)
  }, [])
  return (
    <Section title="Security" icon="lock">
      <Toggle
        on={on}
        disabled={!available}
        label="App lock"
        hint={available ? 'Ask for your fingerprint, face or phone PIN when opening ClosetIQ.' : isNative ? 'Set a screen lock on your phone to use this.' : 'Available in the Android app.'}
        onChange={async (v) => {
          try {
            if (await setLockEnabled(v)) {
              setOn(v)
              onMessage(v ? 'App lock is on.' : 'App lock is off.')
            }
          } catch (e) {
            onError(e)
          }
        }}
      />
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
        <li>Your Supabase key, passphrase and Groq key are stored encrypted by Android on this phone only.</li>
        <li>Your data can only be read with the vault passphrase; the database checks it on every request.</li>
      </ul>
    </Section>
  )
}

function DataSection({ onMessage, onError }: Props) {
  const [busy, setBusy] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true)
    try {
      await action()
      onMessage(done)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Backup & data" icon="washer">
      <p className="text-sm text-slate-600">Your data already lives in your Supabase project. A backup file is an extra copy you control.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={() => run(downloadBackup, 'Backup ready.')}>Export backup</button>
        <label className="btn btn-secondary cursor-pointer">
          Restore from file…
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f && confirm('Restoring replaces EVERYTHING in your vault with the backup. Continue?')) {
                void run(async () => api.importBackup(f), 'Backup restored.')
              }
            }}
          />
        </label>
      </div>
      <div className="rounded-lg border border-red-200 p-3">
        <p className="mb-2 text-sm font-medium text-red-800">Delete all wardrobe data</p>
        <p className="mb-2 text-xs text-slate-600">Removes every garment, photo, basket, plan and routine from your vault, on all devices. Type DELETE to confirm.</p>
        <div className="flex gap-2">
          <input className="input max-w-36" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" aria-label="Type DELETE to confirm" />
          <button className="btn btn-danger" disabled={busy || confirmText !== 'DELETE'} onClick={() => run(async () => { await api.deleteAccount(); setConfirmText('') }, 'All wardrobe data deleted.')}>
            Delete everything
          </button>
        </div>
      </div>
    </Section>
  )
}
