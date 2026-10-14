import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { ErrorBanner } from '../components/ui'
import { supabase } from '../lib/auth'

type Mode = 'signin' | 'signup' | 'forgot'

const TITLES: Record<Mode, string> = {
  signin: 'Sign in to your wardrobe',
  signup: 'Create your free account',
  forgot: 'Reset your password',
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-indigo-50 via-slate-50 to-violet-50 px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow">
          <Icon name="hanger" className="h-6 w-6" />
        </span>
        <span className="text-2xl font-bold tracking-tight">
          Closet<span className="text-indigo-600">IQ</span>
        </span>
      </div>
      {children}
      <Link to="/privacy" className="mt-6 text-xs text-slate-500 hover:underline">Privacy &amp; data</Link>
    </div>
  )
}

export default function Login() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    setInfo(null)
    const origin = window.location.origin
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setError(error.message)
    } else if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: origin } })
      if (error) setError(error.message)
      else if (!data.session) setInfo('Almost done: check your email and click the confirmation link, then sign in.')
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: origin })
      if (error) setError(error.message)
      else setInfo('If an account exists for that email, a reset link is on its way.')
    }
    setBusy(false)
  }

  const switchTo = (m: Mode) => {
    setMode(m)
    setError(null)
    setInfo(null)
  }

  return (
    <Shell>
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <h1 className="text-lg font-semibold">{TITLES[mode]}</h1>
        <ErrorBanner message={error} />
        {info && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{info}</p>}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        {mode !== 'forgot' && (
          <div>
            <div className="flex items-baseline justify-between">
              <label className="label" htmlFor="password">Password</label>
              {mode === 'signin' && (
                <button type="button" className="text-xs text-indigo-700 hover:underline" onClick={() => switchTo('forgot')}>
                  Forgot password?
                </button>
              )}
            </div>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
            {mode === 'signup' && <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>}
          </div>
        )}
        {mode === 'signup' && (
          <p className="text-xs text-slate-500">
            By creating an account you agree to how your data is handled, described in{' '}
            <Link to="/privacy" className="text-indigo-700 hover:underline">Privacy &amp; data</Link>.
          </p>
        )}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </button>
        <div className="text-center text-sm">
          {mode === 'signin' ? (
            <button type="button" className="text-indigo-700 hover:underline" onClick={() => switchTo('signup')}>
              New here? Create an account
            </button>
          ) : (
            <button type="button" className="text-indigo-700 hover:underline" onClick={() => switchTo('signin')}>
              Back to sign in
            </button>
          )}
        </div>
      </form>
    </Shell>
  )
}

/** Shown after following a password-reset link. */
export function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <Shell>
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <h1 className="text-lg font-semibold">Choose a new password</h1>
        <ErrorBanner message={error} />
        <div>
          <label className="label" htmlFor="new-password">New password</label>
          <input id="new-password" type="password" className="input" minLength={8} required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn btn-primary w-full" disabled={busy}>Save password</button>
      </form>
    </Shell>
  )
}
