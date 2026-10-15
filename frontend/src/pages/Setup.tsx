import { useState, type FormEvent, type ReactNode } from 'react'
import SETUP_SQL from '../../../supabase/closetiq.sql?raw'
import { Icon } from '../components/Icon'
import { ErrorBanner } from '../components/ui'
import { ApiError } from '../engine/errors'
import { SupabaseBackend } from '../engine/backend'
import * as ai from '../engine/ai'
import { type Connection, activate, normalizeUrl, probe, projectRef, saveConnection } from '../lib/connection'

type Step = 'welcome' | 'connect' | 'sql' | 'passphrase' | 'ai'

export { SETUP_SQL }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-gradient-to-br from-indigo-50 via-slate-50 to-violet-50 px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-10">
      <div className="mb-6 flex items-center gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow">
          <Icon name="hanger" className="h-6 w-6" />
        </span>
        <span className="text-2xl font-bold tracking-tight">
          Closet<span className="text-indigo-600">IQ</span>
        </span>
      </div>
      <div className={`card w-full space-y-4 p-5 ${wide ? 'max-w-2xl' : 'max-w-md'}`}>{children}</div>
    </div>
  )
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ['connect', 'sql', 'passphrase', 'ai']
  const i = order.indexOf(step)
  return (
    <div className="flex gap-1.5" aria-hidden>
      {order.map((s, n) => (
        <span key={s} className={`h-1.5 flex-1 rounded-full ${n <= i ? 'bg-indigo-500' : 'bg-slate-200'}`} />
      ))}
    </div>
  )
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** First-run setup: connect your own Supabase project, secure it, optionally add AI. */
export default function Setup({ initial, onDone }: { initial?: Partial<Connection>; onDone: () => void }) {
  const [step, setStep] = useState<Step>(initial?.supabaseUrl ? 'connect' : 'welcome')
  const [url, setUrl] = useState(initial?.supabaseUrl ?? '')
  const [anonKey, setAnonKey] = useState(initial?.anonKey ?? '')
  const [hasPassphrase, setHasPassphrase] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [groqKey, setGroqKey] = useState(initial?.groqKey ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const cleanUrl = normalizeUrl(url)
  const ref = projectRef(cleanUrl)

  async function check(e?: FormEvent) {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const s = await probe(cleanUrl, anonKey.trim())
      setUrl(cleanUrl)
      setHasPassphrase(s.has_passphrase)
      setStep(s.installed ? 'passphrase' : 'sql')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function unlock(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (!hasPassphrase) {
        if (passphrase.length < 10) throw new ApiError(422, 'Use at least 10 characters (a short sentence is easy to remember and hard to guess).')
        if (passphrase !== confirmPass) throw new ApiError(422, "The two passphrases don't match.")
        await new SupabaseBackend(cleanUrl, anonKey.trim(), '').setPassphrase(passphrase)
      }
      const s = await probe(cleanUrl, anonKey.trim(), passphrase)
      if (!s.authorized) throw new ApiError(401, "That passphrase doesn't open this vault.")
      setStep('ai')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function finish(withAi: boolean) {
    setBusy(true)
    setError(null)
    const c: Connection = {
      supabaseUrl: cleanUrl,
      anonKey: anonKey.trim(),
      passphrase,
      groqKey: withAi && groqKey.trim() ? groqKey.trim() : null,
      visionModel: initial?.visionModel || ai.DEFAULT_VISION_MODEL,
      textModel: initial?.textModel || ai.DEFAULT_TEXT_MODEL,
    }
    try {
      await activate(c)
      await saveConnection(c)
      onDone()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  if (step === 'welcome') {
    return (
      <Shell>
        <h1 className="text-xl font-bold">Your wardrobe, in your own cloud</h1>
        <p className="text-sm text-slate-600">
          ClosetIQ keeps your clothes, laundry and plans in <strong>your own free Supabase project</strong>. Nobody else (not even the
          app's maker) can see it. Use the same details on another phone and your wardrobe is there too.
        </p>
        <ul className="space-y-2 text-sm text-slate-700">
          <li className="flex gap-2"><span>☁️</span> A free Supabase project (2 minutes to create)</li>
          <li className="flex gap-2"><span>🔑</span> A vault passphrase you choose: it locks your data</li>
          <li className="flex gap-2"><span>✨</span> Optional: a free Groq key for AI features</li>
        </ul>
        <button className="btn btn-primary w-full" onClick={() => setStep('connect')}>Get started</button>
      </Shell>
    )
  }

  if (step === 'connect') {
    return (
      <Shell>
        <Steps step={step} />
        <h1 className="text-lg font-semibold">Connect your Supabase project</h1>
        <ErrorBanner message={error} />
        <form onSubmit={check} className="space-y-3">
          <div>
            <label className="label" htmlFor="sb-url">Project URL</label>
            <input id="sb-url" className="input" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://abcdefgh.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="sb-key">Anon / publishable key</label>
            <textarea id="sb-key" className="input font-mono text-xs" rows={3} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="eyJhbGciOi… or sb_publishable_…" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} required />
            <p className="mt-1 text-xs text-slate-500">Never use the <em>service_role</em> / <em>secret</em> key here.</p>
          </div>
          <button className="btn btn-primary w-full" disabled={busy || !url.trim() || !anonKey.trim()}>{busy ? 'Checking…' : 'Continue'}</button>
        </form>
        <button className="text-sm text-indigo-700 hover:underline" onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? 'Hide help' : 'Where do I find these?'}
        </button>
        {showHelp && (
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
            <li>Go to <a className="text-indigo-700 underline" href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">supabase.com</a>, sign in, and create a <strong>new project</strong> (free plan, any region near you).</li>
            <li>Open <strong>Project Settings → API</strong> (or <strong>Data API</strong> / <strong>API Keys</strong>).</li>
            <li>Copy the <strong>Project URL</strong> and the <strong>anon public</strong> (or <strong>publishable</strong>) key into the boxes above.</li>
          </ol>
        )}
      </Shell>
    )
  }

  if (step === 'sql') {
    const editor = ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard'
    return (
      <Shell wide>
        <Steps step={step} />
        <h1 className="text-lg font-semibold">One-time setup in Supabase</h1>
        <p className="text-sm text-slate-600">Your project is empty. Run ClosetIQ's setup script once: it creates the tables and locks them behind your passphrase.</p>
        <ErrorBanner message={error} />
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
          <li>
            <button className="btn btn-primary px-3 py-1.5 text-sm" onClick={async () => setCopied(await copyText(SETUP_SQL))}>
              {copied ? '✓ Copied' : 'Copy setup script'}
            </button>
          </li>
          <li>
            Open the <a className="font-medium text-indigo-700 underline" href={editor} target="_blank" rel="noreferrer">SQL Editor of your project</a>, paste, and press <strong>Run</strong>.
          </li>
          <li>Come back here and continue.</li>
        </ol>
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">Show the script</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-snug text-slate-100">{SETUP_SQL}</pre>
        </details>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => setStep('connect')}>Back</button>
          <button className="btn btn-primary flex-1" disabled={busy} onClick={() => check()}>{busy ? 'Checking…' : "I've run it: continue"}</button>
        </div>
      </Shell>
    )
  }

  if (step === 'passphrase') {
    return (
      <Shell>
        <Steps step={step} />
        <h1 className="text-lg font-semibold">{hasPassphrase ? 'Unlock your vault' : 'Choose your vault passphrase'}</h1>
        <p className="text-sm text-slate-600">
          {hasPassphrase
            ? 'This project already has ClosetIQ data. Enter its passphrase to open it on this device.'
            : 'It locks your wardrobe: without it, nobody can read your data, even with your Supabase key. You will need it on every new device.'}
        </p>
        <ErrorBanner message={error} />
        <form onSubmit={unlock} className="space-y-3">
          <div>
            <label className="label" htmlFor="pass">Passphrase</label>
            <input id="pass" type="password" className="input" autoComplete={hasPassphrase ? 'current-password' : 'new-password'} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} required minLength={hasPassphrase ? 1 : 10} />
          </div>
          {!hasPassphrase && (
            <div>
              <label className="label" htmlFor="pass2">Type it again</label>
              <input id="pass2" type="password" className="input" autoComplete="new-password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} required />
              <p className="mt-1 text-xs text-slate-500">Tip: a short sentence, like "blue socks on rainy mondays". Write it down somewhere safe.</p>
            </div>
          )}
          <button className="btn btn-primary w-full" disabled={busy}>{busy ? 'Securing…' : hasPassphrase ? 'Unlock' : 'Lock my vault'}</button>
        </form>
      </Shell>
    )
  }

  return (
    <Shell>
      <Steps step={step} />
      <h1 className="text-lg font-semibold">AI features (optional)</h1>
      <p className="text-sm text-slate-600">
        A free Groq key lets ClosetIQ fill in garment details from a photo, read your routine, and write weekly briefs. Everything else works without it, and you can add it later in Settings.
      </p>
      <ErrorBanner message={error} />
      <div>
        <label className="label" htmlFor="groq">Groq API key</label>
        <input id="groq" type="password" className="input font-mono text-xs" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="gsk_…" value={groqKey} onChange={(e) => setGroqKey(e.target.value)} />
        <p className="mt-1 text-xs text-slate-500">
          Get one at <a className="text-indigo-700 underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>. It stays on this device.
        </p>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-secondary flex-1" disabled={busy} onClick={() => finish(false)}>Skip</button>
        <button className="btn btn-primary flex-1" disabled={busy || !groqKey.trim()} onClick={() => finish(true)}>{busy ? 'Opening…' : 'Save & open'}</button>
      </div>
    </Shell>
  )
}
